// SQL Explorer — grid module. Bundled into extension.js by build.mjs.
import { columnHeaderTooltip, ensurePkColumns, shortTypeLabel } from "./columns.js";
import { disposePreviewEditors, renderSqlPreview } from "./dialogs.js";
import { appendIcon, cellText, clearChildren, copyToClipboard, el, makeSearchInput, openContextMenu, safeToast, select, setTooltipAttr, textBtn } from "./dom.js";
import {
  beginCellEdit,
  beginQueryCellEdit,
  deleteRowFromGrid,
  openInsertDialog,
  openStructureDialog,
} from "./gridedit.js";
import { resolveQueryEditContext } from "./query.js";
import { rerender, rerenderMain, setActionSql, setTabState } from "./render.js";
import { GRID_PAGE_SIZE, PAGE_SIZE_OPTIONS, connStatus, ctx, pageSizeFor, panelRoot } from "./runtime.js";
import { fetchJson } from "./sidecar.js";
import { buildInsertSql, buildSelectSql, isReadOnly } from "./sql.js";
import { rowActionBtn } from "./tree.js";


// ----------------------------- Query result grid -----------------------------
// Read-only grid for free-form SELECT results with HeidiSQL-style chrome:
// row-count + duration meta on the left, client-side search input + page
// navigation on the right, divider, then a sticky-header virtualised
// table. Rows are paginated in JS (sidecar already capped to row_limit)
// so the DOM stays small no matter how big the result is.
// (Page-size config + pageSizeFor live in runtime.js.)

export function renderResultGrid(container, opts) {
  const { sql, columns, rows, elapsedMs, truncated, language, session } = opts;
  const grid = {
    query: "",
    page: 0,
    filtered: rows,
  };
  let searchTimer = null;
  // Resolved asynchronously below: non-null once this result is recognised
  // as a single-table SELECT whose rows can be edited in place. redraw()
  // reads it each pass, so a late resolve simply re-wires the live cells.
  let editCtx = null;

  // Meta bar: row count + duration on the left, search on the right.
  // Pagination is no longer crammed into this bar; it lives in a bottom
  // footer so the layout mirrors the table-browse view. Sticky so the
  // controls stay reachable while the result scrolls.
  const metaBar = el("div", { class: "tsql-result-meta tsql-grid-meta tsql-meta--sticky" });
  const leftMeta = el("span", { class: "tsql-grid-meta-left" });
  metaBar.appendChild(leftMeta);

  // Shared search input + HugeIcon clear (X) button: the same component
  // the table-browse view uses, so the reset affordance matches everywhere.
  const { wrap: searchWrap } = makeSearchInput({
    placeholder: "Search rows…",
    ariaLabel: "Search rows on this page",
    inputClass: "tsql-input tsql-grid-search",
    wrapClass: "tsql-search-wrap--grid",
    initialValue: "",
    onInput: (val) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        applyFilter(val.trim());
      }, 160);
    },
  });
  metaBar.appendChild(el("span", { class: "tsql-grid-meta-right" }, searchWrap));
  container.appendChild(metaBar);

  // Executed statement, rendered as a read-only syntax-highlighted editor
  // so the user always sees exactly what produced the rows below.
  container.appendChild(renderSqlPreview(sql, language));

  const gridSlot = el("div", { class: "tsql-grid-slot" });
  container.appendChild(gridSlot);

  // Bottom pager footer: same chrome (.tsql-pager + Prev / label / Next)
  // as renderPager so paginated query results read identically to the
  // table-browse view.
  const pager = el("footer", { class: "tsql-pager" });
  container.appendChild(pager);

  function applyFilter(q) {
    grid.query = q;
    grid.page = 0;
    if (!q) {
      grid.filtered = rows;
    } else {
      const needle = q.toLowerCase();
      grid.filtered = rows.filter((row) => rowMatches(row, needle));
    }
    redraw();
  }

  function redraw() {
    const total = grid.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / GRID_PAGE_SIZE));
    if (grid.page >= totalPages) grid.page = totalPages - 1;
    const start = grid.page * GRID_PAGE_SIZE;
    const slice = grid.filtered.slice(start, start + GRID_PAGE_SIZE);

    leftMeta.replaceChildren();
    const baseInfo = grid.query
      ? `${total.toLocaleString()} of ${rows.length.toLocaleString()} rows match`
      : `${rows.length.toLocaleString()} rows`;
    leftMeta.appendChild(document.createTextNode(`${baseInfo} · ${elapsedMs} ms`));
    if (truncated && !grid.query) {
      leftMeta.appendChild(el("span", { class: "tsql-tag tsql-tag--warn", text: "truncated" }));
    }
    if (editCtx) {
      const tag = el("span", {
        class: "tsql-tag tsql-tag--edit",
        attrs: { title: `Double-click a cell to edit. Changes write to ${editCtx.table}.` },
      });
      appendIcon(tag, "PencilEdit01Icon", { size: 11 });
      tag.appendChild(document.createTextNode("editable"));
      leftMeta.appendChild(tag);
    }

    gridSlot.replaceChildren(buildGridTable(columns, slice, editCtx));

    const hasPrev = grid.page > 0;
    const hasNext = grid.page < totalPages - 1;
    pager.replaceChildren();
    pager.appendChild(
      textBtn("Prev", "ArrowLeft01Icon", {
        title: "Previous page",
        disabled: !hasPrev,
        onClick: () => {
          if (!hasPrev) return;
          grid.page -= 1;
          redraw();
        },
      }),
    );
    pager.appendChild(
      el("span", {
        class: "tsql-pager-label",
        text: `Page ${grid.page + 1} / ${totalPages}`,
      }),
    );
    const nextBtn = textBtn("Next", null, {
      title: "Next page",
      disabled: !hasNext,
      onClick: () => {
        if (!hasNext) return;
        grid.page += 1;
        redraw();
      },
    });
    appendIcon(nextBtn, "ArrowRight01Icon", { size: 13 });
    pager.appendChild(nextBtn);
  }

  redraw();

  // Resolve editability off the main render path. If the statement turns out
  // to be a plain single-table SELECT on a writable connection, wire the
  // cells for inline edit and surface the "editable" pill. Cheap no-op for
  // joins / aggregates / read-only connections (resolves to null).
  if (session) {
    resolveQueryEditContext(session, sql, columns)
      .then((resolved) => {
        if (!resolved || !container.isConnected) return;
        editCtx = resolved;
        redraw();
      })
      .catch((err) => ctx?.logger?.warn?.("query edit resolve failed", err));
  }
}

function rowMatches(row, needle) {
  for (const cell of row) {
    if (cell == null) continue;
    let s;
    if (typeof cell === "string") s = cell;
    else if (typeof cell === "number" || typeof cell === "boolean") s = String(cell);
    else if (typeof cell === "object" && cell.__type === "bytes") continue;
    else s = JSON.stringify(cell);
    if (s.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function buildGridTable(columns, rows, editCtx) {
  const wrap = el("div", { class: `tsql-grid-wrap${editCtx ? " is-editable" : ""}` });
  const table = el("table", { class: "tsql-grid" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of columns) headRow.appendChild(el("th", { text: col }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  // INSERT copy needs a single base table; only editable single-table results
  // expose one. Cell/row copy work regardless.
  const copyTarget = editCtx
    ? { database: editCtx.database, schema: editCtx.schema, table: editCtx.table }
    : null;
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, ci) => {
      const td = renderCellTd(cell);
      // When the result maps to an editable table, columns that correspond
      // to real table columns get the spreadsheet affordance + double-click
      // edit. The backing `row` array is passed (not an index) so edits and
      // PK lookups stay correct across the grid's client-side pagination.
      if (editCtx && editCtx.editableColIdx.has(ci)) {
        td.classList.add("tsql-cell-editable");
        td.addEventListener("dblclick", () => beginQueryCellEdit(editCtx, row, ci, td));
      }
      td.addEventListener("contextmenu", (e) =>
        openContextMenu(
          e,
          gridCopyMenuItems({ columns, row, value: cell, connId: editCtx?.connId, target: copyTarget }),
        ),
      );
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderCellTd(value) {
  const td = el("td");
  td.appendChild(renderCellContent(value));
  setTooltipAttr(td, cellTooltip(value));
  return td;
}

export function renderCellContent(value) {
  if (value === null || value === undefined) {
    return el("span", { class: "tsql-cell-null", text: "NULL" });
  }
  if (typeof value === "boolean") {
    return el("span", { class: "tsql-cell-bool", text: value ? "true" : "false" });
  }
  if (typeof value === "number") return document.createTextNode(String(value));
  if (typeof value === "string") return document.createTextNode(value);
  if (value && typeof value === "object" && value.__type === "bytes") {
    const wrap = el("span", { class: "tsql-cell-bytes" });
    appendIcon(wrap, "CodeIcon", { size: 12 });
    wrap.appendChild(document.createTextNode(` ${value.size ?? "?"} bytes`));
    return wrap;
  }
  return document.createTextNode(JSON.stringify(value));
}

export function cellTooltip(value) {
  if (value && typeof value === "object" && value.__type === "bytes") {
    return `Binary value: ${value.size} bytes (double-click to inspect base64)`;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value == null ? "NULL" : String(value);
}

/**
 * Build the right-click copy menu for a grid cell: copy the cell, the whole
 * row as TSV, or the row as an INSERT statement. `target` (a `{database,
 * schema, table}` descriptor) enables the INSERT item; pass null to omit it
 * (e.g. a non-editable query result that doesn't map to one base table).
 */
function gridCopyMenuItems({ columns, row, value, connId, target }) {
  const items = [
    {
      label: "Copy cell",
      icon: "Copy01Icon",
      onClick: () => copyToClipboard(cellText(value), "Cell copied"),
    },
    {
      label: "Copy row",
      icon: "Copy01Icon",
      onClick: () => copyToClipboard(row.map(cellText).join("\t"), "Row copied"),
    },
  ];
  if (target) {
    items.push({
      label: "Copy row as INSERT",
      icon: "Database01Icon",
      onClick: () => {
        const values = {};
        columns.forEach((c, i) => {
          values[c] = row[i];
        });
        copyToClipboard(buildInsertSql(connId, target, values), "INSERT copied");
      },
    });
  }
  return items;
}
// ----------------------------- Editable table grid ---------------------------


export async function openTable(session, target, scrollIntoView = false) {
  session.activeTable = target;
  // Opening a table also sets the active database context, so a
  // subsequent free-form `SELECT * FROM …` in the query editor
  // resolves against the same DB the user just clicked into.
  session.currentDatabase = target.database;
  session.tableSnapshot = null;
  // Per-table grid state. Cleared on switch so the new table opens
  // unsorted with empty filter, rather than inheriting state from the
  // previous one (which would pass an order_by column that doesn't exist).
  session.orderBy = null;
  session.orderDir = "asc";
  session.gridSearch = "";
  session.gridSearchCol = "";
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
  try {
    // Client-side timing: /table-rows doesn't return elapsed_ms today,
    // so we measure round-trip locally. Captures network + decode, which
    // is the user-visible "how long did the table take to load" anyway.
    const startedAt = performance.now();
    const resp = await fetchJson("/table-rows", { method: "POST", body });
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    session.tableSnapshot = resp.result;
    if (session.tableSnapshot) session.tableSnapshot.elapsed_ms = elapsedMs;
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

export function renderTableGrid(container, session) {
  clearChildren(container);
  disposePreviewEditors();
  const snap = session.tableSnapshot;
  const target = session.activeTable;
  const ro = isReadOnly(session.connId);
  if (!snap) {
    container.appendChild(el("p", { class: "tsql-empty", text: "Loading…" }));
    return;
  }
  // Search + column filter run server-side: every change re-issues
  // `/table-rows` with the new predicate so the LIKE applies across
  // every row in the table, not just the loaded page. The keystroke
  // path is debounced (240 ms) so a fast typist doesn't fire one
  // request per character; the column dropdown reloads immediately
  // since users typically change it rarely. `total` returned by the
  // sidecar reflects the filter, which keeps the pager and "N rows"
  // header consistent.
  const { wrap: searchWrap } = makeSearchInput({
    placeholder: "Search rows…",
    ariaLabel: "Search rows",
    inputClass: "tsql-input tsql-grid-search",
    wrapClass: "tsql-search-wrap--grid",
    initialValue: session.gridSearch ?? "",
    onInput: (val) => {
      session.gridSearch = val;
      scheduleGridSearch(session);
    },
  });

  const colOptions = [
    { value: "", label: "All columns" },
    ...snap.columns.map((c) => ({ value: c, label: c })),
  ];
  const colSelect = select(colOptions, session.gridSearchCol ?? "", (val) => {
    session.gridSearchCol = val;
    loadTableRows(session, 0);
  });
  colSelect.classList.add("tsql-grid-colfilter");

  // HeidiSQL-style meta bar: title + row count + load duration on the
  // left, every filter / action on the right. Sticky to the top of the
  // results body so the controls follow the user when the table scrolls.
  const tableLabel =
    target.database === target.schema ? target.table : `${target.schema}.${target.table}`;
  const rowsLabel = snap.total != null
    ? `${snap.total.toLocaleString()} rows`
    : `${snap.rows.length.toLocaleString()} rows`;
  const elapsedLabel =
    typeof snap.elapsed_ms === "number" ? ` · ${snap.elapsed_ms} ms` : "";
  container.appendChild(
    el(
      "div",
      { class: "tsql-result-meta tsql-grid-meta tsql-meta--sticky" },
      el(
        "span",
        { class: "tsql-grid-meta-left" },
        el("span", { class: "tsql-table-title", text: tableLabel }),
        document.createTextNode(` · ${rowsLabel}${elapsedLabel}`),
      ),
      (() => {
        const right = el("span", { class: "tsql-grid-meta-right" }, searchWrap, colSelect);
        // Insert is a write — hide it on read-only connections.
        if (!ro) {
          right.appendChild(
            textBtn("Row", "Add01Icon", {
              title: "Insert row",
              onClick: () => openInsertDialog(session),
            }),
          );
        }
        // Structure is read-only — always available.
        right.appendChild(
          textBtn("Structure", "TableIcon", {
            title: "View table structure (columns, types, keys)",
            onClick: () => openStructureDialog(session),
          }),
        );
        right.appendChild(
          textBtn("Reload", "Refresh01Icon", {
            title: "Reload current page",
            onClick: () => loadTableRows(session, snap.page),
          }),
        );
        right.appendChild(
          textBtn("Close", "Cancel01Icon", {
            title: "Close table view",
            onClick: () => {
              session.activeTable = null;
              session.tableSnapshot = null;
              rerender();
            },
          }),
        );
        return right;
      })(),
    ),
  );

  // Build the editable grid. PK detection happens lazily on first edit
  // via /columns; we cache it on the snapshot.
  const wrap = el("div", { class: "tsql-grid-wrap is-editable" });
  const table = el("table", { class: "tsql-grid" });
  const thead = el("thead");
  const headRow = el("tr");
  headRow.appendChild(el("th", { class: "tsql-grid-actions-col", text: "" }));
  // Column metadata (type / PK / nullability), eagerly loaded by loadTableRows.
  // Absent only if the /columns fetch failed — headers then show names alone.
  const colMeta = new Map((session._pkCache?.columns ?? []).map((c) => [c.name, c]));
  for (const col of snap.columns) {
    const isSorted = session.orderBy === col;
    const dir = session.orderDir === "desc" ? "desc" : "asc";
    const meta = colMeta.get(col);
    const th = el("th", {
      class: `tsql-grid-th${isSorted ? ` is-sort-${dir}` : ""}`,
      attrs: { title: columnHeaderTooltip(col, meta) },
    });
    const top = el("span", { class: "tsql-th-top" });
    if (meta?.is_primary) top.appendChild(el("span", { class: "tsql-th-pk", text: "PK" }));
    top.appendChild(el("span", { class: "tsql-th-name", text: col }));
    const arrow = el("span", {
      class: "tsql-sort-arrow",
      text: isSorted ? (dir === "asc" ? "▲" : "▼") : "",
    });
    top.appendChild(arrow);
    th.appendChild(top);
    const typeText = shortTypeLabel(meta);
    if (typeText) th.appendChild(el("span", { class: "tsql-th-type", text: typeText }));
    // Three-state cycle: unset -> asc -> desc -> unset. Triggers a
    // server reload so order_by applies across all pages, not just the
    // current snapshot.
    th.addEventListener("click", () => {
      if (session.orderBy === col) {
        if (session.orderDir === "asc") session.orderDir = "desc";
        else {
          session.orderBy = null;
          session.orderDir = "asc";
        }
      } else {
        session.orderBy = col;
        session.orderDir = "asc";
      }
      loadTableRows(session, 0);
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  snap.rows.forEach((row, ri) => {
    const tr = el("tr");
    tr.appendChild(rowActionsCell(session, ri, ro));
    row.forEach((cell, ci) => {
      // Read-only: cells aren't editable (no dblclick, no editable affordance).
      const td = el("td", ro ? {} : { on: { dblclick: () => beginCellEdit(session, ri, ci, td) } });
      td.appendChild(renderCellContent(cell));
      setTooltipAttr(td, cellTooltip(cell));
      if (!ro) td.classList.add("tsql-cell-editable");
      // Right-click copy works on read-only connections too (the only way to
      // extract data when editing/export is unavailable).
      td.addEventListener("contextmenu", (e) =>
        openContextMenu(
          e,
          gridCopyMenuItems({
            columns: snap.columns,
            row,
            value: cell,
            connId: session.connId,
            target: target,
          }),
        ),
      );
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  container.appendChild(renderPager(session, snap));
}

// Debounce holder for the keystroke-driven grid search. Module-level
// because the search input is recreated on every render; the user's
// last keystroke wins per session.
const gridSearchTimers = new Map();
function scheduleGridSearch(session) {
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

function rowActionsCell(session, rowIdx, ro) {
  const cell = el("td", { class: "tsql-grid-actions-col" });
  // Delete is a write — omit the action on read-only connections.
  if (!ro) {
    cell.appendChild(
      rowActionBtn("Delete02Icon", "Delete row", () => deleteRowFromGrid(session, rowIdx), {
        danger: true,
      }),
    );
  }
  return cell;
}

function renderPager(session, snap) {
  const pager = el("footer", { class: "tsql-pager" });
  const hasPrev = snap.page > 0;
  const total = snap.total ?? null;
  const lastPage = total != null ? Math.max(0, Math.ceil(total / snap.page_size) - 1) : null;
  const hasNext = lastPage == null ? snap.rows.length === Number(snap.page_size) : snap.page < lastPage;
  pager.appendChild(
    textBtn("Prev", "ArrowLeft01Icon", {
      title: "Previous page",
      disabled: !hasPrev,
      onClick: () => hasPrev && loadTableRows(session, snap.page - 1),
    }),
  );
  pager.appendChild(
    el("span", { class: "tsql-pager-label", text: `Page ${snap.page + 1}${lastPage != null ? ` / ${lastPage + 1}` : ""}` }),
  );
  const nextBtn = textBtn("Next", null, {
    title: "Next page",
    disabled: !hasNext,
    onClick: () => hasNext && loadTableRows(session, snap.page + 1),
  });
  // Append the arrow icon AFTER the label so it sits on the right.
  appendIcon(nextBtn, "ArrowRight01Icon", { size: 13 });
  pager.appendChild(nextBtn);

  // Rows-per-page selector. Changing it resets to page 0 and reloads (the
  // server applies the new LIMIT), so the pager stays consistent.
  const sizeWrap = el("span", { class: "tsql-pager-size" });
  sizeWrap.appendChild(el("span", { class: "tsql-pager-size-label", text: "Rows" }));
  const current = pageSizeFor(session);
  const sizeSelect = select(
    PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
    String(current),
    (val) => {
      const next = Number(val);
      if (next === pageSizeFor(session)) return;
      session.pageSize = next;
      loadTableRows(session, 0);
    },
  );
  sizeSelect.classList.add("tsql-pager-size-select");
  sizeWrap.appendChild(sizeSelect);
  pager.appendChild(sizeWrap);
  return pager;
}
