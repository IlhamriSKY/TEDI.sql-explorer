// SQL Explorer, grid/resultGrid: read-only grid for free-form SELECT results
// with HeidiSQL-style chrome: row-count + duration meta on the left, client-side
// search input + page navigation on the right, divider, then a sticky-header
// table. Rows are paginated in JS (sidecar already capped to row_limit) so the
// DOM stays small no matter how big the result is. A single-table SELECT on a
// writable connection upgrades to inline-editable cells once resolved.
// Bundled into extension.js by build.mjs.
import { renderSqlPreview } from "../dialogs.js";
import { appendIcon, el, makeSearchInput, openContextMenu, textBtn } from "../dom.js";
import { beginQueryCellEdit } from "../gridedit.js";
import { resolveQueryEditContext } from "../query.js";
import { ctx, pageSizeFor } from "../runtime.js";
import { gridCopyMenuItems, renderCellTd } from "./cells.js";

export function renderResultGrid(container, opts) {
  const { sql, columns, rows, elapsedMs, truncated, truncatedBySize, language, session } = opts;
  const pageSize = pageSizeFor(session);
  const grid = {
    query: "",
    page: 0,
    filtered: rows,
    /** Client-side sort over the fetched rows: column index + direction. */
    sortCol: -1,
    sortDir: "asc",
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
  const metaBar = el("div", { class: "tsql-result-meta tsql-grid-meta tsql-meta--sticky tedi-glass-solid" });
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
    applySort();
    redraw();
  }

  function applySort() {
    if (grid.sortCol < 0) return;
    const ci = grid.sortCol;
    const sign = grid.sortDir === "desc" ? -1 : 1;
    // Copy first: `rows` is the result itself, kept in fetched order.
    grid.filtered = [...grid.filtered].sort((a, b) => sign * compareCells(a[ci], b[ci]));
  }

  /** Header click cycles unsorted -> asc -> desc -> unsorted. */
  function toggleSort(ci) {
    if (grid.sortCol !== ci) {
      grid.sortCol = ci;
      grid.sortDir = "asc";
    } else if (grid.sortDir === "asc") {
      grid.sortDir = "desc";
    } else {
      grid.sortCol = -1;
    }
    applyFilter(grid.query);
  }

  function redraw() {
    const total = grid.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (grid.page >= totalPages) grid.page = totalPages - 1;
    const start = grid.page * pageSize;
    const slice = grid.filtered.slice(start, start + pageSize);

    leftMeta.replaceChildren();
    const baseInfo = grid.query
      ? `${total.toLocaleString()} of ${rows.length.toLocaleString()} rows match`
      : `${rows.length.toLocaleString()} rows`;
    leftMeta.appendChild(document.createTextNode(`${baseInfo} · ${elapsedMs} ms`));
    if (truncated && !grid.query) {
      leftMeta.appendChild(
        el("span", {
          class: "tsql-tag tsql-tag--warn",
          text: "truncated",
          attrs: {
            title: truncatedBySize
              ? "Stopped at the 32 MB result budget before the row limit. Narrow the columns or add a LIMIT to see the rest."
              : "Stopped at the connection's row limit. Add a LIMIT / WHERE, or raise the limit in the connection settings.",
          },
        }),
      );
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

    gridSlot.replaceChildren(buildGridTable(columns, slice, editCtx, grid, toggleSort));

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
    else if (typeof cell === "object" && (cell.__type === "bytes" || cell.__type === "unsupported"))
      continue;
    else s = JSON.stringify(cell);
    if (s.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Order for the client-side sort: NULLs last, numbers numerically, text
 *  with numeric-aware collation, anything else by its JSON. */
function compareCells(a, b) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = typeof a === "object" ? JSON.stringify(a) : String(a);
  const sb = typeof b === "object" ? JSON.stringify(b) : String(b);
  return sa.localeCompare(sb, undefined, { numeric: true });
}

function buildGridTable(columns, rows, editCtx, grid, onSort) {
  const wrap = el("div", { class: `tsql-grid-wrap${editCtx ? " is-editable" : ""}` });
  const table = el("table", { class: "tsql-grid" });
  const thead = el("thead");
  const headRow = el("tr");
  columns.forEach((col, ci) => {
    const sorted = grid.sortCol === ci;
    const th = el("th", {
      class: `tsql-grid-th tedi-glass-solid${sorted ? ` is-sort-${grid.sortDir}` : ""}`,
      attrs: { title: "Sort these rows (the result already fetched, not the database)" },
    });
    const top = el("span", { class: "tsql-th-top" });
    top.appendChild(el("span", { class: "tsql-th-name", text: col }));
    top.appendChild(
      el("span", { class: "tsql-sort-arrow", text: sorted ? (grid.sortDir === "asc" ? "▲" : "▼") : "" }),
    );
    th.appendChild(top);
    th.addEventListener("click", () => onSort(ci));
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  // INSERT copy needs a single base table; only editable single-table results
  // expose one. Cell/row copy work regardless.
  const copyTarget = editCtx
    ? { database: editCtx.database, schema: editCtx.schema, table: editCtx.table }
    : null;
  rows.forEach((row) => {
    const tr = el("tr");
    row.forEach((cell, ci) => {
      const td = renderCellTd(cell);
      // Columns that map to real table columns get the spreadsheet affordance.
      if (editCtx && editCtx.editableColIdx.has(ci)) td.classList.add("tsql-cell-editable");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  // One listener pair for the whole page instead of two per cell. The backing
  // `row` array (not a position) goes to the editor, so edits and PK lookups
  // stay correct under client-side paging and sorting.
  const cellAt = (e) => {
    const td = /** @type {HTMLElement} */ (e.target)?.closest?.("td");
    const tr = td?.parentElement;
    if (!td || !tr || tr.parentElement !== tbody) return null;
    const row = rows[/** @type {HTMLTableRowElement} */ (tr).sectionRowIndex];
    const ci = /** @type {HTMLTableCellElement} */ (td).cellIndex;
    return row ? { td, row, ci } : null;
  };
  tbody.addEventListener("dblclick", (e) => {
    const hit = cellAt(e);
    if (hit && editCtx && editCtx.editableColIdx.has(hit.ci)) {
      beginQueryCellEdit(editCtx, hit.row, hit.ci, hit.td);
    }
  });
  tbody.addEventListener("contextmenu", (e) => {
    const hit = cellAt(e);
    if (!hit) return;
    openContextMenu(
      e,
      gridCopyMenuItems({
        columns,
        row: hit.row,
        value: hit.row[hit.ci],
        connId: editCtx?.connId,
        target: copyTarget,
      }),
    );
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}
