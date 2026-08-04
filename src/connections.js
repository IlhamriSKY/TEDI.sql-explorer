// SQL Explorer — connections barrel. Bundled into extension.js by build.mjs.
//
// Re-exports the connection submodules so callers keep importing from
// "./connections.js".
//   store     — persistence (settings), secrets (keychain), session bootstrap
//   lifecycle — connect/test/save/delete + connect-with-retry + select
//   tunnel    — SSH port forward for a database behind a bastion
//   dialog    — the New/Edit connection modal
//   backup    — encrypted .tedi-sql export / import of the whole list
export * from "./connections/store.js";
export * from "./connections/lifecycle.js";
export * from "./connections/dialog.js";
export * from "./connections/tunnel.js";
export * from "./connections/backup.js";
export * from "./connections/backupDialog.js";
