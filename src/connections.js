// SQL Explorer — connections module. Bundled into extension.js by build.mjs.
import { openCenteredDialog, openConfirmDialog } from "./dialogs.js";
import { checkbox, clearChildren, cryptoId, el, input, numberInput, safeToast, select } from "./dom.js";
import { rerender, setTabState } from "./render.js";
import { connStatus, ctx, state } from "./runtime.js";
import { ensureSidecar, fetchJson, sleep } from "./sidecar.js";
import { setConnState, syncSidebarSection } from "./tree.js";


// ----------------------------- Settings + secrets ----------------------------

export async function loadSavedConnections() {
  try {
    const saved = await ctx.settings.get("connections");
    if (Array.isArray(saved)) state.connections = saved;
  } catch (err) {
    ctx?.logger?.warn?.("load connections failed", err);
  }
}

async function persistConnections() {
  try {
    await ctx.settings.set("connections", state.connections);
  } catch (err) {
    ctx?.logger?.warn?.("save connections failed", err);
  }
}

async function setSecret(connId, password) {
  if (password == null || password === "") {
    return;
  }
  try {
    await ctx.secrets.set(`conn:${connId}`, password);
  } catch (err) {
    ctx?.logger?.warn?.("save secret failed", err);
  }
}

async function getSecret(connId) {
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
async function deleteSecret(connId) {
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

// ----------------------------- Connection dialog -----------------------------

export async function openConnectionDialog(existing) {
  const isEdit = Boolean(existing?.id);
  // Prefetch the password from the OS keychain BEFORE rendering the
  // dialog so the form is fully populated on first paint. The old
  // async-then-set-input flow had a window where a quick "Test" click
  // would fire with an empty password and fail before the secret
  // resolved.
  let prefetchedPassword = "";
  if (isEdit && existing?.kind !== "sqlite") {
    try {
      prefetchedPassword = (await getSecret(existing.id)) ?? "";
    } catch (err) {
      ctx?.logger?.warn?.("password prefetch failed", err);
    }
  }

  // Centered modal over a dimmed backdrop, like the Settings dialog. Esc /
  // backdrop-click / the X button close it.
  const { body, close } = openCenteredDialog({
    title: isEdit ? "Edit connection" : "New connection",
  });
  const form = {
    id: existing?.id ?? cryptoId(),
    name: existing?.name ?? "",
    kind: existing?.kind ?? "mysql",
    host: existing?.host ?? "127.0.0.1",
    port: existing?.port ?? "",
    user: existing?.user ?? "",
    database: existing?.database ?? "",
    password: prefetchedPassword,
    allow_writes: existing?.allow_writes ?? false,
    sslMode: existing?.sslMode ?? "none",
    sqliteReadOnly: existing?.sqliteReadOnly ?? false,
    sqlitePath:
      existing?.kind === "sqlite"
        ? (existing?.sqlitePath ?? existing?.host ?? existing?.database ?? "")
        : "",
    query_timeout_ms: existing?.query_timeout_ms ?? 30000,
    row_limit: existing?.row_limit ?? 10000,
  };

  const grid = el("div", { class: "tsql-form-grid" });

  function field(label, control, full = false) {
    const wrap = el("label", { class: `tsql-field${full ? " is-full" : ""}` });
    wrap.appendChild(el("span", { class: "tsql-label", text: label }));
    wrap.appendChild(control);
    return wrap;
  }

  const nameInput = input({ value: form.name, onInput: (v) => (form.name = v) });
  const kindSelect = select(
    [
      { value: "mysql", label: "MySQL / MariaDB" },
      { value: "postgres", label: "PostgreSQL" },
      { value: "sqlite", label: "SQLite" },
    ],
    form.kind,
    (v) => {
      form.kind = v;
      rerenderDialog();
    },
  );

  function renderHostFields() {
    if (form.kind === "sqlite") {
      const filePath = input({
        value: form.sqlitePath,
        onInput: (v) => (form.sqlitePath = v),
        placeholder: "C:/data/app.db or :memory:",
      });
      return [
        field("File path", filePath, true),
        field(
          "Read-only",
          checkbox(form.sqliteReadOnly, (v) => (form.sqliteReadOnly = v)),
        ),
      ];
    }
    return [
      field(
        "Host",
        input({ value: form.host, onInput: (v) => (form.host = v) }),
      ),
      field(
        "Port",
        input({
          value: form.port ?? "",
          onInput: (v) => (form.port = v),
          placeholder: form.kind === "postgres" ? "5432" : "3306",
        }),
      ),
      field(
        "User",
        input({ value: form.user, onInput: (v) => (form.user = v) }),
      ),
      field(
        "Password",
        input({
          type: "password",
          value: form.password,
          onInput: (v) => (form.password = v),
        }),
      ),
      field(
        "Database (optional)",
        input({
          value: form.database,
          onInput: (v) => (form.database = v),
          placeholder: "leave blank to browse all",
        }),
      ),
      field(
        "TLS",
        select(
          [
            { value: "none", label: "None" },
            { value: "preferred", label: "Preferred" },
            { value: "required", label: "Required" },
            { value: "verify_ca", label: "Verify CA" },
            { value: "verify_full", label: "Verify full" },
          ],
          form.sslMode,
          (v) => (form.sslMode = v),
        ),
      ),
    ];
  }

  function rerenderDialog() {
    clearChildren(grid);
    grid.appendChild(field("Name", nameInput, true));
    grid.appendChild(field("Engine", kindSelect));
    for (const f of renderHostFields()) grid.appendChild(f);
    grid.appendChild(
      field(
        "Mode",
        select(
          [
            { value: "ro", label: "Read-only" },
            { value: "rw", label: "Read + Write" },
          ],
          form.allow_writes ? "rw" : "ro",
          (v) => (form.allow_writes = v === "rw"),
        ),
      ),
    );
    grid.appendChild(
      field(
        "Query timeout (ms)",
        numberInput({
          value: String(form.query_timeout_ms),
          min: 0,
          step: 100,
          onInput: (v) => (form.query_timeout_ms = Number(v) || 0),
        }),
      ),
    );
    grid.appendChild(
      field(
        "Row cap",
        numberInput({
          value: String(form.row_limit),
          min: 0,
          step: 100,
          onInput: (v) => (form.row_limit = Number(v) || 0),
        }),
      ),
    );
  }

  rerenderDialog();
  body.appendChild(grid);

  const error = el("p", { class: "tsql-form-error" });
  body.appendChild(error);

  const actions = el(
    "div",
    { class: "tsql-dialog-actions" },
    el("button", {
      class: "tsql-btn",
      text: "Cancel",
      attrs: { type: "button" },
      on: {
        click: () => close(),
      },
    }),
    el("button", {
      class: "tsql-btn is-primary",
      text: "Test",
      attrs: { type: "button" },
      on: {
        click: async () => {
          error.textContent = "";
          try {
            await connectFromForm(form, { test: true });
            error.style.color = "var(--primary)";
            error.textContent = "Connected successfully.";
            safeToast(`Connected to ${form.name || form.host || form.sqlitePath}`, "success");
          } catch (err) {
            error.style.color = "var(--destructive, #ef4444)";
            error.textContent = `Test failed: ${err?.message ?? err}`;
          }
        },
      },
    }),
    el("button", {
      class: "tsql-btn is-primary",
      text: isEdit ? "Save" : "Add",
      attrs: { type: "button" },
      on: {
        click: async () => {
          error.textContent = "";
          try {
            await saveAndConnect(form);
            close();
            safeToast(
              `${isEdit ? "Updated" : "Added"} connection ${form.name || form.id}`,
              "success",
            );
          } catch (err) {
            error.style.color = "var(--destructive, #ef4444)";
            error.textContent = err?.message ?? String(err);
          }
        },
      },
    }),
  );
  body.appendChild(actions);
}

async function saveAndConnect(form) {
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

function validateForm(form) {
  if (!form.name && !form.id) throw new Error("Name is required");
  if (form.kind === "sqlite" && !form.sqlitePath) throw new Error("SQLite file path is required");
  if (form.kind !== "sqlite" && !form.host) throw new Error("Host is required");
}

function formToPersistable(form) {
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
  try {
    await fetchJson("/disconnect", { method: "POST", body: { id } });
  } catch {
    /* silent: pool may not be open */
  }
  if (state.active === id) {
    state.active = null;
    setTabState("disconnected");
  }
  delete connStatus[id];
  delete state.sessions[id];
  syncSidebarSection();
  rerender();
}

function buildUrl(form) {
  if (form.kind === "sqlite") {
    const ro = form.sqliteReadOnly ? "?mode=ro" : "";
    const path = form.sqlitePath.replace(/\\/g, "/");
    if (path === ":memory:") return "sqlite::memory:";
    return `sqlite://${path}${ro}`;
  }
  const ssl = sslParam(form);
  const port = form.port ? `:${form.port}` : "";
  const user = encodeURIComponent(form.user || "");
  const pass = form.password ? `:${encodeURIComponent(form.password)}` : "";
  const cred = user ? `${user}${pass}@` : "";
  const db = form.database ? `/${encodeURIComponent(form.database)}` : "";
  const scheme = form.kind === "postgres" ? "postgres" : "mysql";
  return `${scheme}://${cred}${form.host}${port}${db}${ssl}`;
}

function sslParam(form) {
  if (!form.sslMode || form.sslMode === "none") return "";
  if (form.kind === "postgres") {
    const map = {
      preferred: "prefer",
      required: "require",
      verify_ca: "verify-ca",
      verify_full: "verify-full",
    };
    return `?sslmode=${map[form.sslMode] ?? "require"}`;
  }
  // MySQL: ssl-mode=PREFERRED / REQUIRED / VERIFY_CA / VERIFY_IDENTITY
  const map = {
    preferred: "PREFERRED",
    required: "REQUIRED",
    verify_ca: "VERIFY_CA",
    verify_full: "VERIFY_IDENTITY",
  };
  return `?ssl-mode=${map[form.sslMode] ?? "REQUIRED"}`;
}

async function connectFromForm(form, { test = false } = {}) {
  await ensureSidecar();
  const body = {
    id: test ? `__test_${form.id}` : form.id,
    kind: form.kind,
    url: buildUrl(form),
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
