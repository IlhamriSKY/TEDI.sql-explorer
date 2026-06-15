// SQL Explorer — runtime module. Bundled into extension.js by build.mjs.
// Shared mutable singletons + app constants. Other modules import the live
// bindings for reads and call the setters here for writes (esbuild preserves
// ESM live-binding semantics across the bundle).

export const PANEL_ID = "sql-explorer";
export const CMD_TOGGLE = "tedi.sql-explorer.toggle";
export const CMD_RUN = "tedi.sql-explorer.runQuery";

// Table-browse grid paging. Lives here (session/config state, not rendering)
// so both the SQL builder and the grid renderer can read it without the grid
// becoming a dependency of the low-level sql module.
export const GRID_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 500];
/** The active rows-per-page for a session's table-browse grid. */
export function pageSizeFor(session) {
  return session?.pageSize || GRID_PAGE_SIZE;
}

// ----------------------------- Module state ----------------------------------

/** @type {import("./extension.d.ts").ExtensionContext | null} */
export let ctx = null;
export let panelRoot = null;
export const state = {
  connections: [], // [{ id, name, kind, host, port, database, user, allow_writes, sslMode, sqliteReadOnly, url? }]
  active: null, // active connection id
  /** @type {Record<string, SessionState>} */
  sessions: {},
  /** Current CodeMirror editor mount, kept singleton across re-renders so
   *  we can dispose the previous EditorView before mounting a new one. */
  editorHandle: null,
  /** Read-only CodeMirror mounts for the executed-SQL previews shown above
   *  result grids. Tracked so we can destroy them before each re-render
   *  instead of leaking an EditorView per query. */
  previewEditors: [],
  /** Singleton read-only CodeMirror for the middle action-SQL strip. Tracked
   *  SEPARATELY from previewEditors so bottom-grid redraws
   *  (disposePreviewEditors) never destroy it, and each strip rebuild disposes
   *  exactly the prior one (mirrors editorHandle). */
  actionSqlEditor: null,
};

// Host-sidebar section id (the Workspaces-styled connection list the host
// renders in its left sidebar via `ctx.sidebar.setSection`).
export const SIDEBAR_SECTION_ID = "connections";

// Per-connection lifecycle status, used to tint the host-sidebar row (and the
// workbench tab when that connection is active). Keyed by connection id; values
// match the host SidebarSection tone palette via `sidebarToneFor`.
/** @type {Record<string, "connecting"|"connected"|"disconnected"|"error">} */
export const connStatus = {};

export function setCtx(value) {
  ctx = value;
}

export function setPanelRoot(value) {
  panelRoot = value;
}
