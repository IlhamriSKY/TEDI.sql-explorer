// SQL Explorer — query barrel. Bundled into extension.js by build.mjs.
//
// Re-exports the query submodules so callers keep importing from "./query.js".
//   sqlRefs     — parse table refs + single-table-SELECT test (internal)
//   editContext — resolveQueryEditContext (is a result inline-editable?)
//   results     — renderQueryResult (render a /query response)
//   run         — runActiveQuery, cancelActiveQuery
//   history     — remember what ran + the History dialog
export * from "./query/editContext.js";
export * from "./query/results.js";
export * from "./query/run.js";
export * as history from "./query/history.js";
