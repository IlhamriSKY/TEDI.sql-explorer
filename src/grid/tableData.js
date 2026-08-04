// SQL Explorer — grid/tableData: open a table + load its server-paged snapshot
// (sort + search run server-side via /table-rows) + the debounced search.
// Bundled into extension.js by build.mjs.
import { ensurePkColumns } from "../columns.js";
import { safeToast } from "../dom.js";
import { rerenderMain, setActionSql, setTabState } from "../render.js";
import { connStatus, ctx, pageSizeFor, panelRoot } from "../runtime.js";
import { fetchJson } from "../sidecar.js";
import { buildSelectSql } from "../sql.js";
import { renderTableGrid } from "./tableGrid.js";

export async function openTable(session, target, scrollIntoView = false) {
  session.activeTable = target;
  // Opening a table also sets the active database + schema context, so a
  // subsequent free-form `SELECT * FROM …` in the query editor resolves
  // against the same place the user just clicked into. PostgreSQL needs the
  // SCHEMA specifically — `search_path` holds schemas, so the database name
  // resolves nothing there.
  session.currentDatabase = target.database;
  session.currentSchema = target.schema;
  session.tableSnapshot = null;
  // Per-table grid state. Cleared on switch so the new table opens
  // unsorted with empty filter, rather than inheriting state from the
  // previous one (which would pass an order_by column that doesn't exist).
  session.orderBy = null;
  session.orderDir = "asc";
  session.gridSearch = "";
  session.gridSearchCol = "";
  // Clicking a table is an explicit "show me this now", so re-count rather
  // than trusting a cached total from the last time it was open.
  invalidateRowCount(session);
  // Clicking a table is a GUI action: show the SELECT it runs in the middle
  // strip (loadTableRows refreshes it once the page/sort/filter is known).
  session.actionSql = buildSelectSql(session, target);
  // Rebuild only the main area — the sidebar tree keeps its expansion, so the
  // row the user just clicked stays in place.
  rerenderMain();
  // Refresh the pane tab label to "SQL Explorer · db.table" (keeps the tone).
  setTabState(connStatus[session.connId] ?? "connected");
  await loadTableRows(session, 0);
  if (panelRoot && scrollIntoView) {
    panelRoot.querySelector("[data-results-root]")?.scrollIntoView({ block: "start" });
  }
}

export async function loadTableRows(session, page) {
  if (!session.activeTable) return;
  const body = {
    conn: session.connId,
    database: session.activeTable.database,
    schema: session.activeTable.schema,
    table: session.activeTable.table,
    page,
    page_size: pageSizeFor(session),
  };
  if (session.orderBy) {
    body.order_by = session.orderBy;
    body.order_dir = session.orderDir === "desc" ? "desc" : "asc";
  }
  // Server-side search. The sidecar ORs the LIKE predicate across
  // either the single `search_column` (if set) or the full
  // `search_columns` list. We send the column list from the snapshot
  // so the helper doesn't need an extra introspection round-trip.
  const term = (session.gridSearch || "").trim();
  if (term) {
    body.search = term;
    if (session.gridSearchCol) {
      body.search_column = session.gridSearchCol;
    } else {
      const cols = session.tableSnapshot?.columns;
      if (Array.isArray(cols) && cols.length) body.search_columns = cols;
    }
  }
  // `total` comes from a COUNT(*), which is a full scan on a large InnoDB
  // table. Only the filter can change it, so ask for it when the filter (or
  // the table) changed and reuse the cached number while the user is just
  // paging. Without this, clicking through pages re-ran the count every time.
  const t = session.activeTable;
  const totalKey = `${t.database}.${t.schema}.${t.table}|${term}|${session.gridSearchCol ?? ""}`;
  // Only a NUMBER counts as cached. The sidecar reports `null` when the count
  // query itself failed, and caching that would mean never asking again.
  const reuseTotal =
    session._totalKey === totalKey && typeof session._total === "number"
      ? session._total
      : undefined;
  body.want_total = reuseTotal === undefined;
  try {
    // Client-side timing: /table-rows doesn't return elapsed_ms today,
    // so we measure round-trip locally. Captures network + decode, which
    // is the user-visible "how long did the table take to load" anyway.
    const startedAt = performance.now();
    const resp = await fetchJson("/table-rows", { method: "POST", body });
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    session.tableSnapshot = resp.result;
    if (session.tableSnapshot) {
      session.tableSnapshot.elapsed_ms = elapsedMs;
      // Carry the cached count forward on a page flip; remember a fresh one.
      if (reuseTotal !== undefined) session.tableSnapshot.total = reuseTotal;
      else session._total = session.tableSnapshot.total;
      session._totalKey = totalKey;
    }
    // Update the autocomplete cache with the columns we just learned.
    // Subsequent keystrokes in the query editor immediately see them.
    if (resp.result?.columns?.length) {
      const t = session.activeTable;
      const key = `${t.database}.${t.schema}.${t.table}`;
      const prev = session.schemaCache.get(key);
      session.schemaCache.set(key, {
        database: t.database,
        schema: t.schema,
        table: t.table,
        kind: prev?.kind ?? "table",
        columns: resp.result.columns.slice(),
      });
    }
    // Keep the middle action-SQL strip in sync with the current
    // page / sort / filter.
    setActionSql(session, buildSelectSql(session, session.activeTable));
    // Eagerly load column metadata (types / PK / nullability) so the grid
    // headers can show types and the first inline edit is instant. Cached per
    // table; failure is non-fatal (headers just omit types).
    await ensurePkColumns(session).catch(() => {});
    if (!panelRoot) return;
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) renderTableGrid(root, session);
  } catch (err) {
    safeToast(`Failed to load table: ${err?.message ?? err}`, "error");
  }
}

/** Forget the cached `COUNT(*)` so the next load re-counts. Call after an
 *  insert / delete: the filter is unchanged, but the row count is not. */
export function invalidateRowCount(session) {
  session._totalKey = null;
  session._total = undefined;
}

// Debounce holder for the keystroke-driven grid search. Module-level
// because the search input is recreated on every render; the user's
// last keystroke wins per session.
const gridSearchTimers = new Map();
export function scheduleGridSearch(session) {
  const prev = gridSearchTimers.get(session.connId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    gridSearchTimers.delete(session.connId);
    // Server-side search resets to page 0; the filtered total may be
    // smaller than the current page index pointed into.
    loadTableRows(session, 0).catch((err) =>
      ctx?.logger?.warn?.("grid search failed", err),
    );
  }, 240);
  gridSearchTimers.set(session.connId, t);
}
