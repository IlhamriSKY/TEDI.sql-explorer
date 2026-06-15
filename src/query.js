// SQL Explorer — query module. Bundled into extension.js by build.mjs.
import { fetchTableColumns } from "./columns.js";
import { ensureSession } from "./connections.js";
import { disposePreviewEditors, openConfirmDialog, renderSqlPreview } from "./dialogs.js";
import { clearChildren, el, safeToast } from "./dom.js";
import { renderResultGrid } from "./grid.js";
import { setActionSql } from "./render.js";
import { panelRoot, state } from "./runtime.js";
import { ensureSidecar, fetchJson } from "./sidecar.js";
import { containsDestructive, isReadOnly, sqlLanguageForSession } from "./sql.js";




// --------------------------- SQL reference parsing ---------------------------
// Resolves the table(s) a statement touches (against the session schema cache)
// so the query-result grid knows when a SELECT maps to one editable base table.

/**
 * Extracts table identifiers from the free-form SQL the user is typing.
 * Strips comments and string literals first so a `'-- foo'` or `'INTO bar'`
 * inside a string doesn't fire a false match. Recognises the usual table
 * positions: FROM, JOIN (all variants), UPDATE, INSERT INTO, DELETE FROM,
 * TRUNCATE, CREATE/ALTER/DROP TABLE. Identifiers may be quoted (` " [ ])
 * and may carry up to two qualifiers (`db.schema.table`).
 *
 * Returns `[{ raw, parts: [..lower] }]` — the caller resolves each ref
 * against `session.schemaCache`.
 */
function parseSqlReferences(sql) {
  if (!sql) return [];
  let clean = String(sql);
  // Strip comments before strings; a `--` inside a string literal isn't
  // actually a comment, but stripping strings first would chew up that
  // literal anyway, so order is mostly cosmetic for the regex output.
  clean = clean.replace(/--[^\r\n]*/g, " ");
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Strip string literals so a `WHERE name = 'FROM users'` doesn't trip.
  clean = clean.replace(/'(?:''|[^'])*'/g, "''");
  // Double-quoted strings are ambiguous (Postgres treats them as identifiers,
  // MySQL as strings). We keep them so qualified `"db"."table"` survives.
  // Match keyword(s) + qualified identifier. Identifier tokens accept the
  // four common quoting styles. {0,2} caps qualifier depth at three (db.
  // schema.table).
  const ident = `(?:\`[^\`]+\`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)`;
  const re = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|(?:CREATE|ALTER|DROP)\\s+TABLE)\\b\\s+(${ident}(?:\\s*\\.\\s*${ident}){0,2})`,
    "gi",
  );
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(clean)) !== null) {
    const raw = m[1].trim();
    const parts = raw
      .split(/\s*\.\s*/)
      .map((p) => p.replace(/^[`"[]|[`"\]]$/g, ""))
      .map((p) => p.toLowerCase());
    const key = parts.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, parts });
  }
  return out;
}

/** Resolves a list of parsed references against the session's schema
 *  cache. Returns the best matching cache entry, or `null` if nothing
 *  matches. Preference order:
 *    1. Fully-qualified `db.schema.table` matches the input qualifiers
 *    2. Two-part input matches by `db` OR `schema`
 *    3. Bare table name — first cached entry wins, but with a bias toward
 *       the session's currently-expanded database so a user typing
 *       `users` against an already-expanded `app` DB resolves to `app`'s
 *       users table, not some other DB's. */
function findCachedMatch(session, refs) {
  const cache = session?.schemaCache;
  if (!cache || cache.size === 0) return null;
  const current = (session.currentDatabase || "").toLowerCase();
  for (const ref of refs) {
    const tableName = ref.parts[ref.parts.length - 1];
    if (!tableName) continue;
    const candidates = [];
    for (const entry of cache.values()) {
      if ((entry.table || "").toLowerCase() === tableName) candidates.push(entry);
    }
    if (candidates.length === 0) continue;
    if (ref.parts.length >= 3) {
      const [db, sch] = ref.parts;
      const exact = candidates.find(
        (e) => (e.database || "").toLowerCase() === db && (e.schema || "").toLowerCase() === sch,
      );
      if (exact) return exact;
    }
    if (ref.parts.length === 2) {
      const qual = ref.parts[0];
      const exact = candidates.find(
        (e) => (e.database || "").toLowerCase() === qual || (e.schema || "").toLowerCase() === qual,
      );
      if (exact) return exact;
    }
    if (current) {
      const inCurrent = candidates.find((e) => (e.database || "").toLowerCase() === current);
      if (inCurrent) return inCurrent;
    }
    return candidates[0];
  }
  return null;
}




export function renderQueryResult(container, session) {
  clearChildren(container);
  disposePreviewEditors();
  if (!session.result?.statements?.length) {
    container.appendChild(el("p", { class: "tsql-empty", text: "No statements ran." }));
    return;
  }
  const statements = session.result.statements;
  const language = sqlLanguageForSession(session);
  const content = el("div", { class: "tsql-result-body" });
  // Hide the tab strip for the common single-statement case so the meta
  // line in renderStatementDetail can carry the row count + duration on
  // its own without a redundant tab pill.
  if (statements.length > 1) {
    const tabs = el("div", { class: "tsql-result-tabs" });
    statements.forEach((stmt, idx) => {
      const tab = el("button", {
        class: `tsql-result-tab${idx === 0 ? " is-active" : ""}`,
        text: tabLabel(stmt),
        attrs: { type: "button" },
        on: {
          click: () => {
            tabs.querySelectorAll(".tsql-result-tab").forEach((t) => t.classList.remove("is-active"));
            tab.classList.add("is-active");
            renderStatementDetail(content, stmt, language, session);
          },
        },
      });
      tabs.appendChild(tab);
    });
    container.appendChild(tabs);
  }
  container.appendChild(content);
  renderStatementDetail(content, statements[0], language, session);
}

function tabLabel(stmt) {
  if (stmt.kind === "rows") return `${stmt.rows.length} rows · ${stmt.elapsed_ms} ms`;
  if (stmt.kind === "exec") return `${stmt.rows_affected} affected · ${stmt.elapsed_ms} ms`;
  return `error · ${stmt.elapsed_ms} ms`;
}

function renderStatementDetail(container, stmt, language, session) {
  clearChildren(container);
  // Re-rendering this slot (fresh result or a statement-tab switch) drops
  // the prior preview editor's DOM; destroy the EditorView too so it
  // doesn't linger.
  disposePreviewEditors();
  if (stmt.kind === "rows") {
    renderResultGrid(container, {
      sql: stmt.sql,
      columns: stmt.columns.map((c) => c.name),
      rows: stmt.rows,
      elapsedMs: stmt.elapsed_ms,
      truncated: stmt.truncated,
      language,
      session,
    });
    return;
  }
  if (stmt.kind === "exec") {
    const meta = el("div", { class: "tsql-result-meta" });
    meta.appendChild(
      el("span", { text: `${stmt.rows_affected} affected · ${stmt.elapsed_ms} ms` }),
    );
    container.appendChild(meta);
    container.appendChild(renderSqlPreview(stmt.sql, language));
    return;
  }
  if (stmt.kind === "error") {
    const meta = el("div", { class: "tsql-result-meta" });
    meta.appendChild(
      el("span", { class: "tsql-error-line", text: `Error · ${stmt.elapsed_ms} ms` }),
    );
    container.appendChild(meta);
    container.appendChild(el("pre", { class: "tsql-error-text", text: stmt.error }));
    container.appendChild(renderSqlPreview(stmt.sql, language));
  }
}

// ------------------------- Editable query results ----------------------------
// Free-form query results are normally read-only, but the common case of a
// plain `SELECT ... FROM one_table` maps 1:1 to base-table rows and can be
// edited in place using the same /table-update path as the table-browse grid.
// resolveQueryEditContext figures out whether that mapping is safe; cells then
// reuse mountTypedEditor via beginQueryCellEdit.

/**
 * Decide whether a free-form query result can be edited in place, and if so
 * build its edit context. Editable only when the statement is a plain
 * single-table SELECT against a base table (not a view) on a writable
 * connection, the table has a primary key, and every PK column is present in
 * the result so each row can be uniquely addressed. Returns null (read-only)
 * for joins, aggregates, unions, views, or projections with no real columns.
 */
export async function resolveQueryEditContext(session, sql, columns) {
  if (!session || !isSingleTableSelect(sql)) return null;
  const refs = parseSqlReferences(sql);
  if (refs.length !== 1) return null;
  const match = findCachedMatch(session, refs);
  if (!match || match.kind === "view") return null;
  // Read-only connections (no writes, or SQLite opened read-only) never get inline edit.
  if (isReadOnly(session.connId)) return null;

  // Column metadata, memoised per table on the session so repeated renders
  // (tab switches, re-runs of the same statement) don't re-hit /columns.
  const tkey = `${match.database}.${match.schema}.${match.table}`;
  session._qcols = session._qcols || new Map();
  let info = session._qcols.get(tkey);
  if (!info) {
    try {
      info = await fetchTableColumns(session.connId, match);
    } catch {
      return null;
    }
    session._qcols.set(tkey, info);
  }
  const cols = info?.columns ?? [];
  if (!cols.length) return null;

  // Match identifiers case-insensitively so an upper/lower-case alias in the
  // SELECT still resolves to its base column.
  const byName = new Map(cols.map((c) => [String(c.name).toLowerCase(), c]));
  const pks = cols.filter((c) => c.is_primary).map((c) => c.name);
  if (pks.length === 0) return null;

  // Every PK must be projected so we can build a unique WHERE per row.
  const pkResultIdx = new Map();
  for (const pk of pks) {
    const ri = columns.findIndex((name) => String(name).toLowerCase() === pk.toLowerCase());
    if (ri < 0) return null;
    pkResultIdx.set(pk, ri);
  }

  // Map each result column that corresponds to a real, editable base column.
  const colByIdx = new Map();
  const editableColIdx = new Set();
  columns.forEach((name, ci) => {
    const colInfo = byName.get(String(name).toLowerCase());
    if (colInfo) {
      colByIdx.set(ci, colInfo);
      editableColIdx.add(ci);
    }
  });
  if (editableColIdx.size === 0) return null;

  return {
    connId: session.connId,
    database: match.database,
    schema: match.schema,
    table: match.table,
    pks,
    pkResultIdx,
    colByIdx,
    editableColIdx,
  };
}

/** True for a single-table `SELECT` whose rows map 1:1 to base-table rows.
 *  Comments + string literals are stripped first so keywords inside them
 *  don't trip the guards. Rejects joins (keyword + comma), set operations,
 *  GROUP BY / HAVING, and DISTINCT, which all break the row-to-row mapping
 *  inline editing relies on. */
function isSingleTableSelect(sql) {
  const clean = String(sql || "")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  if (!/^\s*select\b/i.test(clean)) return false;
  if (/\bjoin\b/i.test(clean)) return false;
  if (/\bgroup\s+by\b/i.test(clean)) return false;
  if (/\bhaving\b/i.test(clean)) return false;
  if (/\bdistinct\b/i.test(clean)) return false;
  if (/\b(union|intersect|except)\b/i.test(clean)) return false;
  // Comma (cross) join inside the FROM clause → more than one table.
  const from = /\bfrom\b([\s\S]*?)(\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|\bwindow\b|$)/i.exec(clean);
  if (from && from[1].includes(",")) return false;
  return true;
}

// ----------------------------- Query run / cancel ----------------------------

export async function runActiveQuery() {
  if (!state.active) return;
  const session = ensureSession(state.active);
  if (!session.sql.trim()) return;
  if (containsDestructive(session.sql)) {
    const ok = await openConfirmDialog({
      title: "Run destructive statement?",
      message:
        "This query looks destructive (DROP / TRUNCATE / GRANT). Run it against the connected database?",
      confirmLabel: "Run",
      destructive: true,
    });
    if (!ok) return;
  }
  await ensureSidecar();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session.requestId = requestId;
  session.activeTable = null;
  session.result = null;
  // A typed query isn't a GUI action — clear the middle action-SQL strip
  // (its SQL is already in the editor right above).
  setActionSql(session, null);
  if (panelRoot) {
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) {
      clearChildren(root);
      root.appendChild(el("p", { class: "tsql-empty", text: "Running…" }));
    }
  }
  try {
    const resp = await fetchJson("/query", {
      method: "POST",
      body: {
        conn: session.connId,
        sql: session.sql,
        request_id: requestId,
        // Active database context tracked from the schema tree. Sidecar
        // runs USE <db> (MySQL) / SET search_path (Postgres) on a
        // pinned pool connection so unqualified table names resolve
        // even when the connection has no default_database pinned.
        database: session.currentDatabase ?? undefined,
      },
    });
    session.result = resp;
  } catch (err) {
    session.result = {
      statements: [
        { kind: "error", sql: session.sql, error: err?.message ?? String(err), elapsed_ms: 0 },
      ],
    };
  } finally {
    session.requestId = null;
    if (panelRoot) {
      const root = panelRoot.querySelector("[data-results-root]");
      if (root) renderQueryResult(root, session);
    }
  }
}

export async function cancelActiveQuery() {
  if (!state.active) return;
  const session = state.sessions[state.active];
  if (!session?.requestId) return;
  try {
    await fetchJson("/cancel", { method: "POST", body: { request_id: session.requestId } });
  } catch (err) {
    safeToast(`Cancel failed: ${err?.message ?? err}`, "error");
  }
}
