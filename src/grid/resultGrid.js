// SQL Explorer — grid/resultGrid: read-only grid for free-form SELECT results
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
import { GRID_PAGE_SIZE, ctx } from "../runtime.js";
import { gridCopyMenuItems, renderCellTd } from "./cells.js";

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
    else if (typeof cell === "object" && (cell.__type === "bytes" || cell.__type === "unsupported"))
      continue;
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
