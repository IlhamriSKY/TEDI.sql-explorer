// SQL Explorer — render barrel. Bundled into extension.js by build.mjs.
//
// Re-exports the render submodules so callers keep importing from "./render.js".
//   tabState    — setTabState (pane title + lifecycle tone)
//   actionSql   — setActionSql, disposeActionSqlEditor (the middle SQL strip)
//   completions — buildSchemaCompletions (query-editor autocomplete)
//   panel       — renderPanel, rerender, rerenderMain, renderEditorAndResults
export * from "./render/tabState.js";
export * from "./render/actionSql.js";
export * from "./render/completions.js";
export * from "./render/panel.js";
