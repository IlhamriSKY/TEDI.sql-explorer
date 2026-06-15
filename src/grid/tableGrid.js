// SQL Explorer — grid/tableGrid: render the editable table-browse grid —
// sortable typed headers, inline cell edit, row insert/delete, structure view,
// server-side search/column-filter, and a rows-per-page pager. The data ops
// (open/load/search) live in ./tableData.js. Bundled into extension.js by
// build.mjs.
import { columnHeaderTooltip, shortTypeLabel } from "../columns.js";
import { disposePreviewEditors } from "../dialogs.js";
import {
  appendIcon,
  clearChildren,
  el,
  makeSearchInput,
  openContextMenu,
  select,
  setTooltipAttr,
  textBtn,
} from "../dom.js";
import {
  beginCellEdit,
  deleteRowFromGrid,
  openInsertDialog,
  openStructureDialog,
} from "../gridedit.js";
import { rerender } from "../render.js";
import { PAGE_SIZE_OPTIONS, pageSizeFor } from "../runtime.js";
import { isReadOnly } from "../sql.js";
import { rowActionBtn } from "../tree.js";
import { cellTooltip, gridCopyMenuItems, renderCellContent } from "./cells.js";
import { loadTableRows, scheduleGridSearch } from "./tableData.js";

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
