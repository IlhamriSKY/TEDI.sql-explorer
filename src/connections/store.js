// SQL Explorer — connections/store: persistence (settings), passwords (OS
// keychain), form validation/normalisation, and per-connection session
// bootstrap. Bundled into extension.js by build.mjs.
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
