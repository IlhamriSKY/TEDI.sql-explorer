// SQL Explorer — grid barrel. Bundled into extension.js by build.mjs.
//
// The grid is split into focused submodules; this barrel re-exports their
// public API so every caller keeps importing from "./grid.js" unchanged.
//   cells      — renderCellContent, cellTooltip (shared cell display + copy menu)
//   resultGrid — renderResultGrid (read-only, client-paged free-form results)
//   tableData  — openTable, loadTableRows (data ops for the browse view)
//   tableGrid  — renderTableGrid (the editable browse view)
export * from "./grid/cells.js";
export * from "./grid/resultGrid.js";
export * from "./grid/tableData.js";
export * from "./grid/tableGrid.js";
