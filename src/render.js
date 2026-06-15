// SQL Explorer — render module. Bundled into extension.js by build.mjs.
import { ensureSession } from "./connections.js";
import { disposePreviewEditors, renderSqlPreview } from "./dialogs.js";
import { appendIcon, clearChildren, closeAllSelectMenus, el, textBtn } from "./dom.js";
import { openExportDialog } from "./export.js";
import { renderTableGrid } from "./grid.js";
import { cancelActiveQuery, renderQueryResult, runActiveQuery } from "./query.js";
import { PANEL_ID, ctx, panelRoot, state } from "./runtime.js";
import { isReadOnly, sqlLanguageForSession } from "./sql.js";


/** Dispose just the middle action-SQL strip's editor. Kept off
 *  disposePreviewEditors so bottom-grid redraws don't kill it. Idempotent. */
export function disposeActionSqlEditor() {
  try {
    state.actionSqlEditor?.dispose?.();
  } catch {
    // ignore
  }
  state.actionSqlEditor = null;
}

/** Label for the pane tab/header: "SQL Explorer · <db>[.<table>]" so it shows
 *  which database (and table) is open — like the title-bar "workspace · …". */
function currentPaneTitle() {
  const id = state.active;
  if (!id) return "SQL Explorer";
  const conn = state.connections.find((c) => c.id === id);
  const session = state.sessions[id];
  let detail = "";
  if (session?.activeTable) {
    const at = session.activeTable;
    detail = at.database ? `${at.database}.${at.table}` : at.table;
  } else {
    detail = session?.currentDatabase || conn?.database || conn?.name || "";
  }
  return detail ? `SQL Explorer · ${detail}` : "SQL Explorer";
}

/**
 * Tints the workspace tab title with a lifecycle tone matching the SSH
 * palette: yellow while connecting, green when connected, red on
 * disconnect/error. Safe no-op on older hosts that predate the API.
 *
 * @param {"idle"|"connecting"|"reconnecting"|"connected"|"disconnected"|"error"|null} state
 */
export function setTabState(state) {
  try {
    ctx?.tabs?.setExtensionTabState?.({
      panelId: PANEL_ID,
      reuseKey: "main",
      state,
      title: currentPaneTitle(),
    });
  } catch (err) {
    ctx?.logger?.warn?.("setExtensionTabState failed", err);
  }
}

// ----------------------------- Top-level render ------------------------------

export function renderPanel(container) {
  // The connection list + schema tree now live in TEDI's left "Databases"
  // sidebar, so the panel itself is just the stacked query-editor + results
  // body — no in-pane sidebar, no own header. That makes it read as a native
  // pane (the host pane frame supplies the title + drag + close). The
  // `.tsql-body` wrapper is kept so `rerenderMain()` can swap `.tsql-main`.
  const root = el("div", { class: "tsql-root" });
  const body = el("div", { class: "tsql-body" });
  body.appendChild(renderMainArea());
  root.appendChild(body);
  container.appendChild(root);
}

export function rerender() {
  if (!panelRoot) return;
  // Modals live on document.body (viewport-centered, immune to pane clipping),
  // so a panel-body rebuild leaves any open dialog untouched.
  clearChildren(panelRoot);
  renderPanel(panelRoot);
}

/**
 * Rebuild only the main area (the stacked query-editor + results), leaving the
 * panel shell in place. Used by table-open and grid refreshes so they don't
 * tear down the whole pane. Falls back to a full rerender if the body layout
 * isn't present yet.
 */
export function rerenderMain() {
  if (!panelRoot) return;
  // A dropdown (e.g. the grid column-filter) may be open over the area we're
  // about to replace; close it so its menu node + document listeners don't
  // orphan when its trigger is detached.
  closeAllSelectMenus();
  const body = panelRoot.querySelector(".tsql-body");
  const oldMain = body?.querySelector(":scope > .tsql-main");
  if (!body || !oldMain) {
    rerender();
    return;
  }
  body.replaceChild(renderMainArea(), oldMain);
}




/**
 * SQL syntax dictionaries fed into the autocomplete source. Split into
 * keywords / functions / types / engine-specific so each can be tagged
 * with the right CodeMirror completion `type` (controls the leading
 * icon glyph) and boost (controls vertical order in the popup).
 *
 * Labels are uppercase by convention; CodeMirror's prefix matcher is
 * case-insensitive against the user-typed word, so a user typing "se"
 * still resolves to "SELECT". The inserted text is the uppercase form
 * which is the usual house style in SQL editors.
 */
const SQL_KEYWORDS_COMMON = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "FULL", "CROSS",
  "ON", "USING", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "BETWEEN",
  "LIKE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "DISTINCT",
  "UNION", "ALL", "EXCEPT", "INTERSECT", "EXISTS", "CREATE", "TABLE",
  "INDEX", "VIEW", "SCHEMA", "DATABASE", "DROP", "ALTER", "ADD", "COLUMN",
  "RENAME", "TO", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE",
  "DEFAULT", "CONSTRAINT", "CHECK", "IF", "ELSE", "ELSIF", "CASE", "WHEN",
  "THEN", "END", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "SAVEPOINT",
  "WITH", "RECURSIVE", "RETURNING", "NATURAL", "TRUE", "FALSE", "ASC",
  "DESC", "CASCADE", "RESTRICT", "GRANT", "REVOKE", "EXPLAIN", "ANALYZE",
  "SHOW", "DESCRIBE", "TRUNCATE", "REPLACE", "MERGE",
];
const SQL_FUNCTIONS_COMMON = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST",
  "CONVERT", "NOW", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME",
  "DATE", "DATETIME", "TIME", "EXTRACT", "CONCAT", "SUBSTRING", "SUBSTR",
  "LENGTH", "CHAR_LENGTH", "TRIM", "LTRIM", "RTRIM", "UPPER", "LOWER",
  "REPLACE", "ROUND", "FLOOR", "CEIL", "CEILING", "ABS", "MOD", "POWER",
  "SQRT", "RANDOM", "RAND", "GREATEST", "LEAST", "ROW_NUMBER", "RANK",
  "DENSE_RANK", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "OVER",
  "PARTITION",
];
const SQL_TYPES_COMMON = [
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE",
  "DECIMAL", "NUMERIC", "REAL", "VARCHAR", "CHAR", "TEXT", "LONGTEXT",
  "MEDIUMTEXT", "BLOB", "BINARY", "VARBINARY", "DATE", "DATETIME",
  "TIMESTAMP", "TIME", "YEAR", "BOOLEAN", "BOOL", "JSON",
];
const SQL_KEYWORDS_BY_ENGINE = {
  mysql: [
    "AUTO_INCREMENT", "UNSIGNED", "ZEROFILL", "ENGINE", "CHARSET", "COLLATE",
    "MEDIUMINT", "LONGBLOB", "MEDIUMBLOB", "TINYBLOB", "ENUM", "DUAL", "USE",
    "LOCK", "UNLOCK", "DELIMITER", "STRAIGHT_JOIN", "STORAGE", "MEMORY",
    "INNODB", "MYISAM",
  ],
  postgres: [
    "SERIAL", "BIGSERIAL", "SMALLSERIAL", "JSONB", "UUID", "ILIKE", "ARRAY",
    "CONFLICT", "INTERVAL", "SIMILAR", "LATERAL", "MATERIALIZED", "FILTER",
    "WINDOW", "TABLESAMPLE", "GENERATED", "ALWAYS", "IDENTITY", "STORED",
  ],
  sqlite: [
    "AUTOINCREMENT", "ROWID", "PRAGMA", "ATTACH", "DETACH", "VACUUM",
    "GLOB", "INDEXED", "ABORT", "FAIL", "IGNORE",
  ],
};
const SQL_FUNCTIONS_BY_ENGINE = {
  mysql: ["DATE_ADD", "DATE_SUB", "DATEDIFF", "TIMESTAMPDIFF", "IFNULL", "IF", "FIND_IN_SET", "GROUP_CONCAT", "JSON_EXTRACT", "JSON_OBJECT", "JSON_ARRAY"],
  postgres: ["TO_CHAR", "TO_DATE", "TO_TIMESTAMP", "AGE", "DATE_TRUNC", "DATE_PART", "STRING_AGG", "ARRAY_AGG", "JSONB_BUILD_OBJECT", "JSONB_AGG"],
  sqlite: ["IFNULL", "IIF", "DATETIME", "STRFTIME", "JULIANDAY", "JSON", "JSON_EXTRACT"],
};

/**
 * Autocomplete source for the query editor. Returns three buckets:
 *  - schema cache entries (tables + columns) populated by the host
 *    sidebar tree (`treeLoadTables`) and `loadTableRows` as the user navigates
 *  - SQL syntax keywords / functions / data types so the editor stays
 *    useful before any table has been opened
 *  - engine-specific syntax for MySQL / PostgreSQL / SQLite, pulled
 *    from the active session's connection kind
 *
 * Boost ordering (higher = closer to top): tables 12, keywords 10,
 * functions 8, columns 5, types 3. Tables outrank keywords because the
 * common case after `FROM ` is a table name; columns sit below so they
 * surface mainly when the user has typed a column-ish prefix.
 *
 * Identical labels collapse (e.g. MySQL where db == schema, the same
 * table can appear as `db.db.table` and `db.table`). Dedup is by label
 * + type so a table and a column sharing a name both stay visible.
 */
function buildSchemaCompletions(session, prefix) {
  const needle = (prefix || "").toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (key, item) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const matches = (label) => !needle || label.toLowerCase().startsWith(needle);

  // Schema cache: tables + columns
  const cache = session?.schemaCache;
  if (cache && cache.size > 0) {
    for (const entry of cache.values()) {
      const tableName = entry.table;
      if (tableName && matches(tableName)) {
        const qualifier =
          entry.database === entry.schema
            ? entry.database
            : `${entry.database}.${entry.schema}`;
        push(`t:${tableName}`, {
          label: tableName,
          detail: qualifier,
          type: entry.kind === "view" ? "interface" : "class",
          boost: 12,
        });
      }
      for (const col of entry.columns) {
        if (matches(col)) {
          push(`c:${col}:${tableName}`, {
            label: col,
            detail: tableName,
            type: "property",
            boost: 5,
          });
        }
      }
    }
  }

  // SQL syntax: keywords, functions, types. Always available so the
  // editor offers help before the schema cache has anything.
  const connKind = state.connections.find((c) => c.id === session?.connId)?.kind;
  const engineKeywords = SQL_KEYWORDS_BY_ENGINE[connKind] ?? [];
  const engineFunctions = SQL_FUNCTIONS_BY_ENGINE[connKind] ?? [];
  for (const kw of SQL_KEYWORDS_COMMON) {
    if (matches(kw)) push(`k:${kw}`, { label: kw, detail: "keyword", type: "keyword", boost: 10 });
  }
  for (const kw of engineKeywords) {
    if (matches(kw)) push(`k:${kw}`, { label: kw, detail: `${connKind} keyword`, type: "keyword", boost: 10 });
  }
  for (const fn of SQL_FUNCTIONS_COMMON) {
    if (matches(fn)) push(`f:${fn}`, { label: fn, detail: "function", type: "function", boost: 8 });
  }
  for (const fn of engineFunctions) {
    if (matches(fn)) push(`f:${fn}`, { label: fn, detail: `${connKind} function`, type: "function", boost: 8 });
  }
  for (const ty of SQL_TYPES_COMMON) {
    if (matches(ty)) push(`y:${ty}`, { label: ty, detail: "type", type: "type", boost: 3 });
  }
  return out;
}

// ----------------------------- Main area -------------------------------------

function renderMainArea() {
  if (!state.active) {
    return el(
      "section",
      { class: "tsql-main tsql-main--empty" },
      el("p", { class: "tsql-empty", text: "Select a connection on the left to start." }),
    );
  }
  return renderEditorAndResults(ensureSession(state.active));
}

/**
 * The pane's main area, stacked top-to-bottom: the query editor (CodeMirror),
 * a drag splitter, the middle action-SQL strip (the SQL a GUI action ran), and
 * the results / table grid under `[data-results-root]`. Opening a table or
 * running a query rebuilds just this area via `rerenderMain`.
 */
export function renderEditorAndResults(session) {
  // The previous CodeMirror mount is detached once this area is rebuilt;
  // dispose it (and any read-only SQL previews) up front so EditorViews don't
  // leak across a connection switch / remount.
  if (state.editorHandle && typeof state.editorHandle.dispose === "function") {
    try {
      state.editorHandle.dispose();
    } catch {
      // ignore
    }
    state.editorHandle = null;
  }
  disposePreviewEditors();
  // If this rebuild has no action-SQL strip, renderActionSqlStrip won't run to
  // self-dispose the prior strip editor — drop it here so it never leaks.
  disposeActionSqlEditor();

  const wrap = el("div", { class: "tsql-main" });

  // --- Top: query editor + toolbar ---
  const toolbar = el(
    "div",
    { class: "tsql-toolbar" },
    textBtn("Run", "PlayIcon", {
      primary: true,
      title: "Run query (Ctrl+Enter)",
      onClick: () => runActiveQuery(),
    }),
    textBtn("Stop", "SquareIcon", {
      title: "Cancel current statement",
      onClick: () => cancelActiveQuery(),
    }),
    textBtn("Export", "Download01Icon", {
      title: "Export current result",
      onClick: () => openExportDialog(),
    }),
  );
  if (isReadOnly(session.connId)) {
    const pill = el("span", {
      class: "tsql-ro-pill",
      attrs: { title: "This connection is read-only — inserts, edits and deletes are disabled." },
    });
    appendIcon(pill, "SquareLock02Icon", { size: 11 });
    pill.appendChild(el("span", { text: "Read only" }));
    toolbar.appendChild(pill);
  }
  wrap.appendChild(toolbar);

  const editorWrap = el("div", { class: "tsql-editor" });
  wrap.appendChild(editorWrap);
  const language = sqlLanguageForSession(session);
  try {
    state.editorHandle = ctx.ui.codeEditor(editorWrap, {
      language,
      value: session.sql ?? "",
      onChange: (v) => {
        session.sql = v;
      },
      onCmdEnter: () => runActiveQuery(),
      completions: (prefix) => buildSchemaCompletions(session, prefix),
    });
  } catch (err) {
    ctx?.logger?.error?.("codeEditor mount failed", err);
    editorWrap.appendChild(
      el("p", { class: "tsql-empty", text: "Code editor unavailable. Update TEDI to >= 0.3.9." }),
    );
  }

  // --- Splitter (resize the editor height; the bottom takes the rest) ---
  const splitter = el("div", {
    class: "tsql-splitter",
    attrs: {
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-label": "Resize query editor",
      tabindex: "0",
    },
  });
  wrap.appendChild(splitter);
  if (session.editorHeightPx) {
    wrap.style.setProperty("--tsql-editor-h", `${session.editorHeightPx}px`);
  }
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const editorEl = wrap.querySelector(".tsql-editor");
    if (!editorEl) return;
    const splitterH = splitter.offsetHeight;
    const minEditor = 80;
    const minResults = 120;
    const onMove = (ev) => {
      const top = editorEl.getBoundingClientRect().top;
      const mainBottom = wrap.getBoundingClientRect().bottom;
      const stripH = wrap.querySelector(".tsql-action-sql")?.offsetHeight ?? 0;
      const maxEditor = mainBottom - top - splitterH - stripH - minResults;
      const clamped = Math.max(minEditor, Math.min(Math.max(minEditor, maxEditor), ev.clientY - top));
      wrap.style.setProperty("--tsql-editor-h", `${clamped}px`);
      session.editorHeightPx = clamped;
    };
    const onUp = () => {
      splitter.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { splitter.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    splitter.classList.add("is-dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    e.preventDefault();
  });
  splitter.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const cur =
      parseFloat(getComputedStyle(wrap).getPropertyValue("--tsql-editor-h")) ||
      wrap.querySelector(".tsql-editor")?.offsetHeight ||
      0;
    const step = e.key === "ArrowUp" ? -16 : 16;
    const next = Math.max(80, cur + step);
    wrap.style.setProperty("--tsql-editor-h", `${next}px`);
    session.editorHeightPx = next;
    e.preventDefault();
  });

  // --- Middle: the SQL a GUI action ran (open table / edit / delete /
  //     insert). Cleared for editor-run queries — their SQL is in the editor. ---
  if (session.actionSql) wrap.appendChild(renderActionSqlStrip(session));

  // --- Bottom: results — the browsed table grid OR a free-form query result. ---
  const results = el("div", { class: "tsql-results", attrs: { "data-results-root": "1" } });
  if (session.activeTable) {
    renderTableGrid(results, session);
  } else if (session.result) {
    renderQueryResult(results, session);
  } else {
    results.appendChild(
      el("p", { class: "tsql-empty", text: "Open a table from the sidebar, or run a query above." }),
    );
  }
  wrap.appendChild(results);
  return wrap;
}

/** The middle strip: a read-only, syntax-highlighted view of the SQL the last
 *  GUI action ran, so a click / edit / delete is as transparent as a typed
 *  query. Disposes the prior strip editor up front (this fn is the single
 *  build path for both full rebuilds and setActionSql's in-place replace). */
function renderActionSqlStrip(session) {
  disposeActionSqlEditor();
  const strip = el("div", { class: "tsql-action-sql" });
  strip.appendChild(el("span", { class: "tsql-action-sql-label", text: "Query:" }));
  strip.appendChild(
    // `track` routes the handle to the singleton + suppresses the hover tooltip
    // (this is the always-visible middle strip, not a one-off preview).
    renderSqlPreview(session.actionSql, sqlLanguageForSession(session), (h) => {
      state.actionSqlEditor = h;
    }),
  );
  return strip;
}

/**
 * Update the middle action-SQL strip in place (no full rebuild, so the grid /
 * editor don't churn). `sql` falsy removes the strip. Used by GUI actions that
 * render in place (edit / delete / table load).
 */
export function setActionSql(session, sql) {
  session.actionSql = sql || null;
  if (!panelRoot) return;
  const main = panelRoot.querySelector(".tsql-main");
  if (!main) return;
  const existing = main.querySelector(":scope > .tsql-action-sql");
  if (!session.actionSql) {
    existing?.remove();
    disposeActionSqlEditor();
    return;
  }
  const fresh = renderActionSqlStrip(session);
  if (existing) {
    main.replaceChild(fresh, existing);
  } else {
    const results = main.querySelector(":scope > .tsql-results");
    if (results) main.insertBefore(fresh, results);
    else main.appendChild(fresh);
  }
}
