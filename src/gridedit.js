// SQL Explorer — gridedit barrel. Bundled into extension.js by build.mjs.
//
// Cell editing + row mutation (update/delete/insert) + the Structure view,
// split out of grid.js so that module stays focused on rendering. This one owns
// the write paths (all gated by the sidecar's allow_writes classifier). The
// barrel re-exports the submodules so callers keep importing from "./gridedit.js".
//   typedEditor — mountTypedEditor (shared typed inline-edit widget)
//   cellEdit    — beginQueryCellEdit, beginCellEdit (inline single-cell UPDATE)
//   rowOps      — deleteRowFromGrid, openInsertDialog, openStructureDialog
export * from "./gridedit/typedEditor.js";
export * from "./gridedit/cellEdit.js";
export * from "./gridedit/rowOps.js";
