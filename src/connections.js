// SQL Explorer — connections barrel. Bundled into extension.js by build.mjs.
//
// Re-exports the connection submodules so callers keep importing from
// "./connections.js".
//   store     — persistence (settings), secrets (keychain), session bootstrap
//   lifecycle — connect/test/save/delete + connect-with-retry + select
//   dialog    — the New/Edit connection modal
export * from "./connections/store.js";
export * from "./connections/lifecycle.js";
export * from "./connections/dialog.js";
