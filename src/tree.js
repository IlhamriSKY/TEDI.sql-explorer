// SQL Explorer — tree barrel. Bundled into extension.js by build.mjs.
//
// The host-sidebar "Databases" tree (connection → db → [schema] → table), split
// into focused submodules; this barrel re-exports their public API so callers
// keep importing from "./tree.js".
//   data      — node ids, lazy-tree state sets, sidecar fetchers
//   connState — setConnState, sidebarToneFor (per-connection lifecycle status)
//   items     — buildTreeItems, rowActionBtn (render the sidebar rows)
//   view      — syncSidebarSection, openWorkbenchTab (publish + interaction)
export * from "./tree/connState.js";
export * from "./tree/items.js";
export * from "./tree/view.js";
