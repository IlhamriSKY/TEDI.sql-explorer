// SQL Explorer — connections/store: persistence (settings), passwords (OS
// keychain), form validation/normalisation, and per-connection session
// bootstrap. Bundled into extension.js by build.mjs.
import { getDialect } from "../dialects/index.js";
import { ctx, state } from "../runtime.js";

// ----------------------------- Settings + secrets ----------------------------

export async function loadSavedConnections() {
  try {
    const saved = await ctx.settings.get("connections");
    if (Array.isArray(saved)) state.connections = saved;
  } catch (err) {
    ctx?.logger?.warn?.("load connections failed", err);
  }
}

/** Bumped by every write, so a refresh can tell "the other window saved" from
 *  "we saved while the read was in flight". */
let revision = 0;

/**
 * Persist WHICH connection is open and the SQL in its editor, so the workbench
 * comes back the way you left it. Floating the pane runs a second copy of this
 * extension in the float window: without this it opened on "no connection
 * selected" instead of the database you popped out. The same record restores
 * the editor after a restart.
 *
 * Results are NOT persisted: a grid can be tens of thousands of rows, and it
 * belongs to a query run rather than to the workbench.
 */
export async function saveWorkbenchSession() {
  try {
    const sessions = {};
    for (const [id, s] of Object.entries(state.sessions)) {
      sessions[id] = { sql: s.sql ?? "", activeTable: s.activeTable ?? null };
    }
    await ctx.settings.set("session", { active: state.active ?? null, sessions });
  } catch (err) {
    ctx?.logger?.warn?.("save session failed", err);
  }
}

/**
 * Reopen what was open. Restores the per-connection SQL first so the editor
 * mounts with it, then the active connection, and only for connections that
 * still exist. Selecting is left to the caller: connecting is a network trip
 * and belongs to the pane, not to activate().
 */
export async function restoreWorkbenchSession() {
  let saved;
  try {
    saved = await ctx.settings.get("session");
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object") return null;
  for (const [id, s] of Object.entries(saved.sessions ?? {})) {
    if (!state.connections.some((c) => c.id === id)) continue;
    const session = ensureSession(id);
    if (typeof s?.sql === "string") session.sql = s.sql;
    if (s?.activeTable) session.activeTable = s.activeTable;
  }
  if (saved.active && state.connections.some((c) => c.id === saved.active)) {
    state.active = saved.active;
  }
  return state.active;
}

export async function persistConnections() {
  revision += 1;
  try {
    await ctx.settings.set("connections", state.connections);
  } catch (err) {
    ctx?.logger?.warn?.("save connections failed", err);
  }
}

/**
 * Re-read the saved list. Floating the workbench runs a second copy of this
 * extension in the float window against the same settings, so the copy that
 * takes over has to pick up connections the other one added rather than write
 * its own memory back over them. Returns true when the list actually changed.
 *
 * Drops its result if this window wrote while the read was in flight: then the
 * read is the stale one, not our memory.
 */
export async function refreshSavedConnections() {
  const before = revision;
  let saved;
  try {
    saved = await ctx.settings.get("connections");
  } catch {
    return false;
  }
  if (revision !== before || !Array.isArray(saved)) return false;
  if (JSON.stringify(saved) === JSON.stringify(state.connections)) return false;
  state.connections = saved;
  return true;
}

export async function setSecret(connId, password) {
  if (password == null || password === "") {
    return;
  }
  try {
    await ctx.secrets.set(`conn:${connId}`, password);
  } catch (err) {
    ctx?.logger?.warn?.("save secret failed", err);
  }
}

export async function getSecret(connId) {
  try {
    return await ctx.secrets.get(`conn:${connId}`);
  } catch {
    return null;
  }
}

/**
 * Best-effort wipe of a connection's stored password from the OS keychain.
 * Uses `ctx.secrets.delete` when the host exposes it (newer builds); on older
 * hosts it falls back to overwriting the entry with an empty string so the
 * credential no longer lingers in the keychain. Never throws — deletion is a
 * cleanup step, not a gate.
 */
export async function deleteSecret(connId) {
  const key = `conn:${connId}`;
  try {
    if (typeof ctx?.secrets?.delete === "function") {
      await ctx.secrets.delete(key);
    } else {
      await ctx.secrets.set(key, "");
    }
  } catch (err) {
    ctx?.logger?.warn?.("delete secret failed", err);
  }
}

// ----------------------------- Form helpers ----------------------------------

/**
 * Databases the tree should show for `conn`, parsed from the connection's
 * `database` field. Empty = show everything the server reports.
 *
 * The field carries TWO different meanings depending on the engine, which is
 * why this is a function and not a property read:
 *  - PostgreSQL binds ONE database per connection, so there the field is the
 *    connect TARGET and a list would be meaningless. `databaseIsConnectTarget`
 *    marks that, and the scope is left empty so the tree lists every database.
 *  - MySQL / SQLite reach every database over one connection, so there the
 *    field is a FILTER, and it may now name several, comma separated. Pinning a
 *    single one used to be the only option, which also meant a database created
 *    afterwards could never appear in the tree no matter how often it was
 *    refreshed.
 */
export function scopedDatabases(conn) {
  if (!conn || getDialect(conn.kind).databaseIsConnectTarget) return [];
  return String(conn.database ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What to hand the sidecar as `default_database`. A scope list must never reach
 * it verbatim: it becomes the connection's default schema, so "a,b" would open
 * a connection against a database of that name and fail. The first entry is a
 * sensible default schema; a connect-target engine passes its single value.
 */
export function connectTargetDatabase(form) {
  if (!form) return null;
  if (getDialect(form.kind).databaseIsConnectTarget) return form.database || null;
  return scopedDatabases(form)[0] || null;
}

export function validateForm(form) {
  if (!form.name && !form.id) throw new Error("Name is required");
  if (form.kind === "sqlite" && !form.sqlitePath) throw new Error("SQLite file path is required");
  if (form.kind !== "sqlite" && !form.host) throw new Error("Host is required");
}

export function formToPersistable(form) {
  const { password: _p, ...rest } = form;
  if (rest.kind === "sqlite") {
    // SQLite has no host/port/user/database — the file lives in `sqlitePath`.
    // Clear the irrelevant fields so the record can't carry the host default
    // (e.g. "127.0.0.1") that reconnect/edit/subtitle would otherwise mistake
    // for the file path.
    return { ...rest, host: "", port: "", user: "", database: "" };
  }
  return rest;
}

export function ensureSession(id) {
  if (!state.sessions[id]) {
    state.sessions[id] = {
      connId: id,
      sql: "SELECT 1;",
      result: null,
      activeTable: null,
      tableSnapshot: null,
      requestId: null,
      // Cache for the autocomplete source in the query editor. Keyed by
      // `database.schema.table` so MySQL (db == schema) and PostgreSQL
      // (db > schema) both collapse to a stable identifier. `columns` is
      // populated lazily when the user opens the table grid; tables alone
      // are populated when their parent DB / schema is expanded in the
      // tree. The completion provider walks every entry on every keystroke.
      schemaCache: new Map(),
    };
  }
  return state.sessions[id];
}
