// SQL Explorer — connections/lifecycle: open/test a pool, save, delete, and
// select (lazy connect-with-retry). Bundled into extension.js by build.mjs.
import { buildConnectionUrl, getDialect } from "../dialects/index.js";
import { releaseTunnel, resolveEndpoint } from "./tunnel.js";
import { openConfirmDialog } from "../dialogs.js";
import { safeToast } from "../dom.js";
import { history } from "../query.js";
import { rerender, setTabState } from "../render.js";
import { connStatus, ctx, state } from "../runtime.js";
import { ensureSidecar, fetchJson, sleep } from "../sidecar.js";
import { setConnState, syncSidebarSection } from "../tree.js";
import {
  deleteSecret,
  ensureSession,
  formToPersistable,
  getSecret,
  persistConnections,
  saveWorkbenchSession,
  setSecret,
  validateForm,
} from "./store.js";

export async function connectFromForm(form, { test = false } = {}) {
  await ensureSidecar();
  // A tunnelled connection reaches the database through a loopback port the
  // host forwards over SSH, so the URL is built against that, not the real
  // host. No-op for a direct connection.
  const endpoint = await resolveEndpoint(form);
  const body = {
    id: test ? `__test_${form.id}` : form.id,
    kind: form.kind,
    url: buildConnectionUrl(getDialect(form.kind), { ...form, ...endpoint }),
    allow_writes: form.allow_writes,
    query_timeout_ms: form.query_timeout_ms || 30000,
    row_limit: form.row_limit || 10000,
    default_database: form.database || null,
    sqlite_read_only: !!form.sqliteReadOnly,
  };
  await fetchJson("/connect", { method: "POST", body });
  if (test) {
    await fetchJson("/disconnect", { method: "POST", body: { id: body.id } }).catch(() => {});
  }
}

export async function saveAndConnect(form) {
  validateForm(form);
  const persistable = formToPersistable(form);
  const existingIdx = state.connections.findIndex((c) => c.id === form.id);
  if (existingIdx >= 0) state.connections[existingIdx] = persistable;
  else state.connections.push(persistable);
  await persistConnections();
  if (form.kind !== "sqlite") await setSecret(form.id, form.password);
  await connectFromForm(form, { test: false });
  state.active = form.id;
  setConnState(form.id, "connected");
  syncSidebarSection();
  rerender();
}

export async function confirmAndDeleteConnection(conn) {
  const label = conn.name || conn.id;
  const message =
    conn.kind === "sqlite"
      ? `"${label}" will be removed from the connection list.`
      : `"${label}" will be removed and its stored password wiped from the keychain.`;
  const ok = await openConfirmDialog({
    title: "Delete connection?",
    message,
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  await deleteConnection(conn.id);
}

async function deleteConnection(id) {
  const conn = state.connections.find((c) => c.id === id);
  state.connections = state.connections.filter((c) => c.id !== id);
  await persistConnections();
  // Wipe the stored password from the keychain (SQLite never stores one).
  if (conn && conn.kind !== "sqlite") await deleteSecret(id);
  // Its query history is unreachable once the connection is gone; drop it so
  // the setting doesn't grow a tail of orphaned entries.
  await history.forgetConnection(id);
  try {
    await fetchJson("/disconnect", { method: "POST", body: { id } });
  } catch {
    /* silent: pool may not be open */
  }
  // Drop the SSH forward too; otherwise the jump-host session outlives the
  // connection that needed it.
  if (conn) await releaseTunnel(conn);
  if (state.active === id) {
    state.active = null;
    setTabState("disconnected");
  }
  delete connStatus[id];
  delete state.sessions[id];
  syncSidebarSection();
  rerender();
}

/** How many times a connection attempt is retried before giving up. */
const MAX_CONNECT_ATTEMPTS = 3;

/**
 * Open a connection's sidecar pool, retrying up to MAX_CONNECT_ATTEMPTS times
 * (the server may be briefly unreachable). On the final failure it marks the
 * row red (error state) and shows a single failure toast, then throws an error
 * flagged `handled` so callers don't double-report it.
 */
export async function connectWithRetry(connId) {
  const conn = state.connections.find((c) => c.id === connId);
  if (!conn) throw new Error("connection not found");
  const password = conn.kind === "sqlite" ? "" : (await getSecret(connId)) ?? "";
  const form = {
    ...conn,
    password,
    // Canonical SQLite path is `sqlitePath`; fall back to host/database only
    // for records saved by older builds that stored the path there.
    sqlitePath: conn.sqlitePath || conn.host || conn.database || "",
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    setConnState(connId, attempt === 1 ? "connecting" : "reconnecting");
    try {
      await connectFromForm(form);
      setConnState(connId, "connected");
      return;
    } catch (err) {
      lastErr = err;
      ctx?.logger?.warn?.(`connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed`, err);
      if (attempt < MAX_CONNECT_ATTEMPTS) await sleep(400 * attempt);
    }
  }
  setConnState(connId, "error");
  safeToast(
    `Failed to connect to "${conn.name || connId}" after ${MAX_CONNECT_ATTEMPTS} attempts: ${lastErr?.message ?? lastErr}`,
    "error",
  );
  const wrapped = new Error(
    `connect failed after ${MAX_CONNECT_ATTEMPTS} attempts: ${lastErr?.message ?? lastErr}`,
  );
  wrapped.handled = true;
  throw wrapped;
}

export async function selectConnection(id) {
  state.active = id;
  // Which connection is open is the first thing a float window (or the next
  // launch) needs; without it the popped-out pane opens on "no connection".
  void saveWorkbenchSession();
  // Lazy connect on selection so the sidecar pool isn't held open for
  // every saved connection on startup.
  await ensureSidecar();
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) {
    setConnState(id, "disconnected");
    return;
  }
  const conns = await fetchJson("/connections").catch(() => null);
  const alreadyOpen = conns?.connections?.some((c) => c.id === id);
  if (alreadyOpen) {
    setConnState(id, "connected");
  } else {
    try {
      await connectWithRetry(id);
    } catch {
      return; // connectWithRetry already surfaced the failure (toast + red row).
    }
  }
  ensureSession(id);
  rerender();
}
