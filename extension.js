// SQL Explorer. HeidiSQL-style database viewer for MySQL / PostgreSQL /
// SQLite, backed by the `tedi-sql-helper` native sidecar.
//
// Lifecycle
// ---------
//   activate(ctx):
//     1. Detect the OS/arch and resolve the sidecar binary path.
//     2. Spawn it via `shell_bg_spawn_direct`; poll its stdout until the
//        `READY {port,token}` line lands.
//     3. Register the right-panel renderer + command/keybinding handlers.
//     4. Load saved connections from settings; passwords stay in the
//        keychain until the user opens a connection.
//
//   deactivate():
//     1. Best-effort POST /shutdown (lets sqlx drain its pools).
//     2. `shell_bg_kill` as the hard fallback.
//
// All chrome lives inside one container the host gives us. No global DOM
// pollution; on `deactivate` the panel renderer returns its cleanup
// callback and the host clears the slot.

const EXT_ID = "tedi.sql-explorer";
const PANEL_ID = "sql-explorer";
const CMD_TOGGLE = "tedi.sql-explorer.toggle";
const CMD_RUN = "tedi.sql-explorer.runQuery";

// Tight enough that the READY line lands "instantly" from a user POV,
// loose enough that a slow first-time process spawn (Defender / Gatekeeper
// scanning the unsigned helper) doesn't trip the timeout.
const READY_TIMEOUT_MS = 12_000;
const READY_POLL_MS = 80;

// Sidecar binary directory layout; mirrors tedi.screenshot.
function platformDir(os) {
  const arch = os?.arch || "x86_64";
  if (os?.platform === "windows") return arch === "aarch64" ? "windows-aarch64" : "windows-x86_64";
  if (os?.platform === "macos") return arch === "aarch64" ? "macos-aarch64" : "macos-x86_64";
  if (os?.platform === "linux") return arch === "aarch64" ? "linux-aarch64" : "linux-x86_64";
  return null;
}

function helperPath(installPath, os) {
  if (!installPath || !os) return null;
  const dir = platformDir(os);
  if (!dir) return null;
  const exe = os.platform === "windows" ? "tedi-sql-helper.exe" : "tedi-sql-helper";
  return `${installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}

// ----------------------------- Module state ----------------------------------

/** @type {import("./extension.d.ts").ExtensionContext | null} */
let ctx = null;
let sidecar = null; // { handle, port, token, baseUrl }
let bootInFlight = null;
let panelRoot = null;
let panelDispose = null;
const state = {
  connections: [], // [{ id, name, kind, host, port, database, user, allow_writes, sslMode, sqliteReadOnly, url? }]
  active: null, // active connection id
  /** @type {Record<string, SessionState>} */
  sessions: {},
  /** Current CodeMirror editor mount, kept singleton across re-renders so
   *  we can dispose the previous EditorView before mounting a new one. */
  editorHandle: null,
};

/**
 * @typedef SessionState
 * @property {string} connId
 * @property {string} sql
 * @property {any | null} result
 * @property {{ database: string, schema: string, table: string, kind: string } | null} activeTable
 * @property {any | null} tableSnapshot server response from /table-rows
 * @property {string | null} requestId in-flight query id
 */

// ----------------------------- Entry points ----------------------------------

export async function activate(context) {
  ctx = context;
  const missing = checkRequiredApis(ctx);
  if (missing.length) {
    const msg = `SQL Explorer needs a newer TEDI (missing: ${missing.join(", ")}).`;
    ctx?.logger?.warn?.(msg);
    safeToast(msg, "warning");
    return;
  }
  injectStyles();
  await loadSavedConnections();

  // Open or focus the workspace tab. Tabs reuse on identical reuseKey
  // so the user doesn't end up with N copies of the workbench. We also
  // collapse the left sidebar (file explorer + SCM) so the workbench
  // gets the full workspace width on open; the user can re-expand it
  // from the header toggle whenever they want it back.
  function openWorkbenchTab() {
    try {
      ctx.app?.setSidebarVisible?.(false);
    } catch (err) {
      ctx?.logger?.warn?.("sidebar collapse failed", err);
    }
    try {
      ctx.tabs.openExtensionTab({
        panelId: PANEL_ID,
        title: "SQL Explorer",
        icon: "hugeicon:Database01Icon",
        reuseKey: "main",
      });
    } catch (err) {
      ctx?.logger?.error?.("open tab failed", err);
    }
  }

  ctx.registerCommandHandler(CMD_TOGGLE, () => openWorkbenchTab());

  // Header button (right of SSH icon). One click opens the tab.
  // Uses the host's HugeIcon set via the `hugeicon:` icon prefix so the
  // button paints with `currentColor` and reads as part of the same icon
  // family as TEDI core's SSH / Extensions / Settings buttons.
  try {
    ctx.headerBar.setItem({
      id: "open",
      icon: "hugeicon:Database01Icon",
      tooltip: "SQL Explorer",
      onClick: () => openWorkbenchTab(),
    });
  } catch (err) {
    ctx?.logger?.warn?.("headerBar.setItem failed", err);
  }

  ctx.registerCommandHandler(CMD_RUN, () => {
    runActiveQuery().catch((err) => ctx?.logger?.error?.("run failed", err));
  });

  const disposeRenderer = ctx.registerPanelRenderer(PANEL_ID, (container) => {
    panelRoot = container;
    container.replaceChildren();
    container.classList.add("tsql-host");
    renderPanel(container);
    // Boot the sidecar lazily on first panel mount. If it dies the user can
    // restart it from the menu without re-opening the extension.
    ensureSidecar().catch((err) => {
      ctx?.logger?.error?.("sidecar boot failed", err);
      safeToast(`SQL helper failed to start: ${err?.message ?? err}`, "error");
    });
    return () => {
      panelRoot = null;
    };
  });
  ctx.addDisposer(disposeRenderer);
}

export async function deactivate() {
  try {
    if (state.editorHandle?.dispose) {
      try {
        state.editorHandle.dispose();
      } catch {
        // ignore
      }
      state.editorHandle = null;
    }
    if (sidecar?.baseUrl) {
      await fetchJson("/shutdown", { method: "POST", body: {} }).catch(() => {});
    }
    if (sidecar?.handle != null) {
      await ctx.invoke("shell_bg_kill", { handle: sidecar.handle }).catch(() => {});
    }
  } finally {
    sidecar = null;
    panelRoot = null;
    panelDispose = null;
    ctx = null;
  }
}

function checkRequiredApis(c) {
  const missing = [];
  if (typeof c?.invoke !== "function") missing.push("ctx.invoke");
  if (typeof c?.os?.platform !== "string") missing.push("ctx.os.platform");
  if (typeof c?.installPath !== "string") missing.push("ctx.installPath");
  if (typeof c?.registerPanelRenderer !== "function") missing.push("ctx.registerPanelRenderer");
  if (typeof c?.tabs?.openExtensionTab !== "function") missing.push("ctx.tabs.openExtensionTab");
  if (typeof c?.headerBar?.setItem !== "function") missing.push("ctx.headerBar");
  if (typeof c?.ui?.codeEditor !== "function") missing.push("ctx.ui.codeEditor");
  if (typeof c?.secrets?.set !== "function") missing.push("ctx.secrets");
  if (typeof c?.settings?.set !== "function") missing.push("ctx.settings");
  return missing;
}

// ----------------------------- Sidecar boot ----------------------------------

async function ensureSidecar() {
  if (sidecar?.baseUrl) return sidecar;
  if (bootInFlight) return bootInFlight;
  bootInFlight = bootSidecar().finally(() => {
    bootInFlight = null;
  });
  return bootInFlight;
}

async function bootSidecar() {
  const program = helperPath(ctx.installPath, ctx.os);
  if (!program) {
    throw new Error(`unsupported platform ${ctx.os?.platform}/${ctx.os?.arch}`);
  }
  let handle;
  try {
    handle = await ctx.invoke("shell_bg_spawn_direct", { program, args: [] });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (/os error 2|no such file|cannot find/i.test(msg)) {
      throw new Error(
        `Sidecar binary missing for ${ctx.os?.platform}-${ctx.os?.arch}. Reinstall the extension to repopulate sidecar/. (${msg})`,
      );
    }
    throw new Error(`spawn failed: ${msg}`);
  }

  // Drain stdout until READY lands. shell_bg_logs returns *new* bytes since
  // the last `sinceOffset`; the helper prints `READY <json>` then keeps
  // logging via stderr.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let offset = 0;
  let buf = "";
  while (true) {
    if (Date.now() > deadline) {
      await ctx.invoke("shell_bg_kill", { handle }).catch(() => {});
      throw new Error("sidecar handshake timed out");
    }
    const resp = await ctx.invoke("shell_bg_logs", { handle, sinceOffset: offset });
    if (resp?.bytes) buf += resp.bytes;
    offset = typeof resp?.next_offset === "number" ? resp.next_offset : offset;
    if (resp?.exited) {
      throw new Error(`sidecar exited before READY (exit ${resp.exit_code ?? "?"})`);
    }
    const line = extractReady(buf);
    if (line) {
      sidecar = {
        handle,
        port: line.port,
        token: line.token,
        baseUrl: `http://127.0.0.1:${line.port}`,
      };
      ctx?.logger?.info?.(`sidecar ready on ${sidecar.baseUrl}`);
      return sidecar;
    }
    await sleep(READY_POLL_MS);
  }
}

function extractReady(buf) {
  // Strict prefix match. Anything before the keyword is throwaway stderr.
  const idx = buf.indexOf("READY ");
  if (idx < 0) return null;
  const nl = buf.indexOf("\n", idx);
  if (nl < 0) return null;
  const jsonText = buf.slice(idx + "READY ".length, nl).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function fetchJson(path, opts = {}) {
  if (!sidecar?.baseUrl) await ensureSidecar();
  const url = `${sidecar.baseUrl}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sidecar.token}`,
  };
  const init = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(url, init);
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* empty */
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? text ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------- Settings + secrets ----------------------------

async function loadSavedConnections() {
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

// ----------------------------- DOM helpers -----------------------------------

function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.html != null) node.innerHTML = opts.html; // only for trusted static strings
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v != null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (opts.style) Object.assign(node.style, opts.style);
  if (opts.on) {
    for (const [k, v] of Object.entries(opts.on)) {
      node.addEventListener(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      for (const inner of c) {
        if (inner == null || inner === false) continue;
        node.appendChild(inner instanceof Node ? inner : document.createTextNode(String(inner)));
      }
      continue;
    }
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Append a HugeIcon to `parent` via ctx.ui.icon. Tolerates older TEDI
 * hosts that pre-date the icon API by rendering a tiny placeholder so
 * the layout stays stable instead of jumping when buttons lose chrome.
 */
function appendIcon(parent, iconName, opts = {}) {
  if (!parent) return;
  const size = opts.size ?? 14;
  try {
    if (ctx?.ui?.icon) {
      parent.appendChild(ctx.ui.icon(iconName, { size, strokeWidth: 1.75, ...opts }));
      return;
    }
  } catch (err) {
    ctx?.logger?.warn?.("icon mount failed", iconName, err);
  }
  const placeholder = document.createElement("span");
  placeholder.style.display = "inline-block";
  placeholder.style.width = `${size}px`;
  placeholder.style.height = `${size}px`;
  parent.appendChild(placeholder);
}

/** Returns a span with the requested icon. Just calls `appendIcon`
 *  into a fresh span; kept as its own helper so call sites read
 *  declaratively (`row.appendChild(makeIcon("Database01Icon"))`). */
function makeIcon(iconName, opts = {}) {
  const wrap = document.createElement("span");
  appendIcon(wrap, iconName, opts);
  return wrap;
}

function safeToast(message, variant) {
  try {
    ctx?.ui?.toast(message, { variant });
  } catch {
    ctx?.logger?.info?.(message);
  }
}

// ----------------------------- Top-level render ------------------------------

function renderPanel(container) {
  const root = el("div", { class: "tsql-root" });
  root.appendChild(renderHeader());
  const body = el("div", { class: "tsql-body" });
  body.appendChild(renderConnRail());
  body.appendChild(renderWorkspace());
  root.appendChild(body);
  container.appendChild(root);
}

function rerender() {
  if (!panelRoot) return;
  clearChildren(panelRoot);
  renderPanel(panelRoot);
}

function renderHeader() {
  // Close button is dropped: the host tab strip already has an X.
  return el(
    "header",
    { class: "tsql-header" },
    el("span", { class: "tsql-title", text: "SQL Explorer" }),
    el(
      "div",
      { class: "tsql-header-actions" },
      iconButton("Add01Icon", "New connection", () => openConnectionDialog()),
      iconButton("Refresh01Icon", "Restart sidecar", restartSidecarFlow),
    ),
  );
}

function iconButton(iconName, title, onClick) {
  const btn = el("button", {
    class: "tsql-icon-btn",
    attrs: { title, "aria-label": title, type: "button" },
    on: { click: onClick },
  });
  appendIcon(btn, iconName, { size: 14 });
  return btn;
}

// ----------------------------- Connection rail -------------------------------

function renderConnRail() {
  const list = el("aside", { class: "tsql-conn-rail" });
  if (state.connections.length === 0) {
    list.appendChild(
      el("p", {
        class: "tsql-empty",
        text: "No connections yet. Click + to add one.",
      }),
    );
    return list;
  }
  for (const c of state.connections) {
    list.appendChild(renderConnRow(c));
  }
  return list;
}

/**
 * Stylised brand mark per backend kind. Each `<svg>` is a hand-drawn
 * abstraction (not a copy of the official trademark) sized to fit the
 * conn-row badge box. Trademarks belong to their respective owners; we
 * use a generic silhouette here so the row reads as "MySQL-like" /
 * "Postgres-like" / "SQLite-like" at a glance without shipping the
 * official assets.
 */
const KIND_SVG = {
  mysql:
    '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M2.2 13.5c2.3-2.1 5-3 7.8-2.7 2.1.2 3.5 1.4 5.2 2.3 1.4.7 2.9 1 4.3.4-.6 1.9-2 3.4-4 4-1.9.5-3.6-.2-5.3-.7-2.2-.7-4.5-1.1-6.8-.5C3 16.8 2.2 15.1 2.2 13.5z"/>' +
    '<circle cx="17.5" cy="9" r="1.2"/>' +
    '<path d="M14.6 7.4c.5-1.2 1.5-2 2.7-2.2-.2 1.2-.9 2.2-2.1 2.7" opacity="0.7"/>' +
    "</svg>",
  postgres:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M4 14c0-5 4-9 9-9s7 3 7 7c0 4-2 7-5 7-1 0-2-1-2-2 0-1 1-1.6 2-1.6"/>' +
    '<path d="M9 8c0 1 .5 2 1.2 2.6"/>' +
    '<path d="M7 18c-1-2-1-4 0-6"/>' +
    '<circle cx="14.5" cy="9.5" r=".7" fill="currentColor" stroke="none"/>' +
    "</svg>",
  sqlite:
    '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M6 3h9l4 4v14H6V3z" opacity="0.85"/>' +
    '<path d="M15 3v4h4" fill="none" stroke="var(--background)" stroke-width="1.5"/>' +
    '<ellipse cx="13" cy="14" rx="4.5" ry="1.6" fill="none" stroke="var(--background)" stroke-width="1.2"/>' +
    '<path d="M8.5 14v2.5c0 .9 2 1.7 4.5 1.7s4.5-.8 4.5-1.7V14" fill="none" stroke="var(--background)" stroke-width="1.2"/>' +
    "</svg>",
};

function kindBadge(kind) {
  const wrap = el("span", { class: `tsql-conn-kind tsql-kind-${kind}`, attrs: { "aria-label": kind } });
  // Static, author-controlled SVG strings — safe to assign via innerHTML.
  wrap.innerHTML = KIND_SVG[kind] || "";
  return wrap;
}

function rowActionBtn(iconName, title, onClick) {
  const btn = el("button", {
    class: "tsql-row-action",
    attrs: { title, "aria-label": title, type: "button" },
    on: { click: onClick },
  });
  appendIcon(btn, iconName, { size: 13 });
  return btn;
}

function renderConnRow(c) {
  const isActive = state.active === c.id;
  return el(
    "div",
    {
      class: `tsql-conn-row${isActive ? " is-active" : ""}`,
      on: {
        click: () => selectConnection(c.id),
      },
    },
    kindBadge(c.kind),
    el(
      "div",
      { class: "tsql-conn-meta" },
      el("span", { class: "tsql-conn-name", text: c.name || c.id }),
      el("span", { class: "tsql-conn-host", text: connSubtitle(c) }),
    ),
    rowActionBtn("PencilEdit01Icon", "Edit connection", (event) => {
      event.stopPropagation();
      void openConnectionDialog(c);
    }),
    rowActionBtn("Delete02Icon", "Delete connection", (event) => {
      event.stopPropagation();
      deleteConnection(c.id);
    }),
  );
}

function connSubtitle(c) {
  if (c.kind === "sqlite") return c.host || c.database || "file";
  return `${c.user ?? ""}@${c.host ?? ""}${c.port ? ":" + c.port : ""}/${c.database ?? ""}`;
}

// ----------------------------- Connection dialog -----------------------------

async function openConnectionDialog(existing) {
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

  // Modal overlay anchored inside the panel; keeps the dialog scoped.
  const overlay = el("div", { class: "tsql-overlay" });
  const dialog = el("div", { class: "tsql-dialog" });
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
    sqlitePath: existing?.kind === "sqlite" ? (existing?.host ?? existing?.database ?? "") : "",
    query_timeout_ms: existing?.query_timeout_ms ?? 30000,
    row_limit: existing?.row_limit ?? 10000,
  };

  dialog.appendChild(el("h3", { class: "tsql-dialog-title", text: isEdit ? "Edit connection" : "New connection" }));

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
          dataField: "password",
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
        input({
          value: String(form.query_timeout_ms),
          onInput: (v) => (form.query_timeout_ms = Number(v) || 0),
        }),
      ),
    );
    grid.appendChild(
      field(
        "Row cap",
        input({
          value: String(form.row_limit),
          onInput: (v) => (form.row_limit = Number(v) || 0),
        }),
      ),
    );
  }

  rerenderDialog();
  dialog.appendChild(grid);

  const error = el("p", { class: "tsql-form-error" });
  dialog.appendChild(error);

  const actions = el(
    "div",
    { class: "tsql-dialog-actions" },
    el("button", {
      class: "tsql-btn",
      text: "Cancel",
      attrs: { type: "button" },
      on: {
        click: () => overlay.remove(),
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
            overlay.remove();
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
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  panelRoot.appendChild(overlay);
}

function cryptoId() {
  if (globalThis.crypto?.randomUUID) return `c-${globalThis.crypto.randomUUID()}`;
  return `c-${Math.random().toString(36).slice(2, 10)}`;
}

function input({ type = "text", value = "", onInput, placeholder, dataField } = {}) {
  const node = el("input", {
    class: "tsql-input",
    attrs: { type, placeholder, "data-field": dataField },
  });
  node.value = value ?? "";
  if (onInput) node.addEventListener("input", () => onInput(node.value));
  return node;
}

function select(options, current, onChange) {
  const node = el("select", { class: "tsql-input" });
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === current) o.selected = true;
    node.appendChild(o);
  }
  if (onChange) node.addEventListener("change", () => onChange(node.value));
  return node;
}

function checkbox(checked, onChange) {
  const node = el("input", { class: "tsql-checkbox", attrs: { type: "checkbox" } });
  node.checked = !!checked;
  if (onChange) node.addEventListener("change", () => onChange(node.checked));
  return node;
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
  rerender();
}

function validateForm(form) {
  if (!form.name && !form.id) throw new Error("Name is required");
  if (form.kind === "sqlite" && !form.sqlitePath) throw new Error("SQLite file path is required");
  if (form.kind !== "sqlite" && !form.host) throw new Error("Host is required");
}

function formToPersistable(form) {
  const { password: _p, ...rest } = form;
  return rest;
}

async function deleteConnection(id) {
  state.connections = state.connections.filter((c) => c.id !== id);
  await persistConnections();
  try {
    await fetchJson("/disconnect", { method: "POST", body: { id } });
  } catch {
    /* silent: pool may not be open */
  }
  if (state.active === id) state.active = null;
  delete state.sessions[id];
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

async function selectConnection(id) {
  state.active = id;
  // Lazy connect on selection so the sidecar pool isn't held open for
  // every saved connection on startup.
  await ensureSidecar();
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;
  const conns = await fetchJson("/connections").catch(() => null);
  const alreadyOpen = conns?.connections?.some((c) => c.id === id);
  if (!alreadyOpen) {
    const password = conn.kind === "sqlite" ? "" : (await getSecret(id)) ?? "";
    try {
      await connectFromForm({ ...conn, password, sqlitePath: conn.host || conn.database || "" });
    } catch (err) {
      safeToast(`Connect failed: ${err?.message ?? err}`, "error");
      return;
    }
  }
  ensureSession(id);
  rerender();
}

function ensureSession(id) {
  if (!state.sessions[id]) {
    state.sessions[id] = {
      connId: id,
      sql: "SELECT 1;",
      result: null,
      activeTable: null,
      tableSnapshot: null,
      requestId: null,
    };
  }
  return state.sessions[id];
}

// ----------------------------- Workspace -------------------------------------

function renderWorkspace() {
  const work = el("section", { class: "tsql-workspace" });
  if (!state.active) {
    work.appendChild(
      el("p", {
        class: "tsql-empty",
        text: "Select a connection on the left to start.",
      }),
    );
    return work;
  }
  const session = ensureSession(state.active);
  work.appendChild(renderTreePane(session));
  work.appendChild(renderEditorAndResults(session));
  return work;
}

// ----------------------------- Tree pane -------------------------------------

function renderTreePane(session) {
  const wrap = el("div", { class: "tsql-tree" });
  wrap.appendChild(
    el(
      "header",
      { class: "tsql-subheader" },
      el("span", { text: "Schema" }),
      iconButton("Refresh01Icon", "Refresh", () => refreshDatabases(session, wrap)),
    ),
  );
  const list = el("ul", { class: "tsql-tree-list" });
  wrap.appendChild(list);
  loadDatabases(session, list).catch((err) =>
    safeToast(`Failed to load databases: ${err?.message ?? err}`, "error"),
  );
  return wrap;
}

async function refreshDatabases(session, wrap) {
  const list = wrap.querySelector(".tsql-tree-list");
  if (!list) return;
  clearChildren(list);
  await loadDatabases(session, list);
}

async function loadDatabases(session, list) {
  clearChildren(list);
  const resp = await fetchJson(`/databases?conn=${encodeURIComponent(session.connId)}`);
  for (const db of resp.databases) {
    list.appendChild(renderDbNode(session, db.name));
  }
}

function renderDbNode(session, dbName) {
  const li = el("li", { class: "tsql-tree-node tsql-node-db" });
  const caretBox = el("span", { class: "tsql-caret" });
  appendIcon(caretBox, "ArrowRight01Icon", { size: 11 });
  const iconBox = el("span", { class: "tsql-tree-icon" });
  appendIcon(iconBox, "Database01Icon", { size: 14 });
  const head = el(
    "button",
    {
      class: "tsql-tree-row",
      attrs: { type: "button" },
    },
    caretBox,
    iconBox,
    el("span", { class: "tsql-tree-label", text: dbName }),
  );
  li.appendChild(head);
  const childList = el("ul", { class: "tsql-tree-children" });
  childList.style.display = "none";
  li.appendChild(childList);
  let loaded = false;
  head.addEventListener("click", async () => {
    const open = childList.style.display !== "none";
    childList.style.display = open ? "none" : "";
    caretBox.classList.toggle("is-open", !open);
    if (!loaded && !open) {
      loaded = true;
      try {
        await loadSchemas(session, dbName, childList);
      } catch (err) {
        loaded = false;
        childList.appendChild(el("li", { class: "tsql-tree-error", text: err?.message ?? String(err) }));
      }
    }
  });
  return li;
}

async function loadSchemas(session, dbName, parent) {
  const resp = await fetchJson(
    `/schemas?conn=${encodeURIComponent(session.connId)}&database=${encodeURIComponent(dbName)}`,
  );
  // Collapse single-schema (MySQL/SQLite) into the parent.
  if (resp.schemas.length === 1 && resp.schemas[0].name === dbName) {
    await loadTables(session, dbName, dbName, parent);
    return;
  }
  for (const s of resp.schemas) {
    parent.appendChild(renderSchemaNode(session, dbName, s.name));
  }
}

function renderSchemaNode(session, dbName, schemaName) {
  const li = el("li", { class: "tsql-tree-node tsql-node-schema" });
  const caretBox = el("span", { class: "tsql-caret" });
  appendIcon(caretBox, "ArrowRight01Icon", { size: 11 });
  const iconBox = el("span", { class: "tsql-tree-icon" });
  appendIcon(iconBox, "Folder01Icon", { size: 14 });
  const head = el(
    "button",
    { class: "tsql-tree-row", attrs: { type: "button" } },
    caretBox,
    iconBox,
    el("span", { class: "tsql-tree-label", text: schemaName }),
  );
  li.appendChild(head);
  const childList = el("ul", { class: "tsql-tree-children" });
  childList.style.display = "none";
  li.appendChild(childList);
  let loaded = false;
  head.addEventListener("click", async () => {
    const open = childList.style.display !== "none";
    childList.style.display = open ? "none" : "";
    caretBox.classList.toggle("is-open", !open);
    if (!loaded && !open) {
      loaded = true;
      try {
        await loadTables(session, dbName, schemaName, childList);
      } catch (err) {
        loaded = false;
        childList.appendChild(el("li", { class: "tsql-tree-error", text: err?.message ?? String(err) }));
      }
    }
  });
  return li;
}

async function loadTables(session, database, schema, parent) {
  const resp = await fetchJson(
    `/tables?conn=${encodeURIComponent(session.connId)}&database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}`,
  );
  if (resp.tables.length === 0) {
    parent.appendChild(el("li", { class: "tsql-tree-empty", text: "(no tables)" }));
    return;
  }
  for (const t of resp.tables) {
    parent.appendChild(renderTableNode(session, database, schema, t));
  }
}

function renderTableNode(session, database, schema, info) {
  const li = el("li", { class: `tsql-tree-node tsql-node-${info.kind}` });
  const iconBox = el("span", { class: "tsql-tree-icon" });
  appendIcon(iconBox, info.kind === "view" ? "ViewIcon" : "Table01Icon", { size: 14 });
  const head = el(
    "button",
    {
      class: "tsql-tree-row",
      attrs: { type: "button" },
      on: {
        click: () => openTable(session, { database, schema, table: info.name, kind: info.kind }),
        dblclick: () => openTable(session, { database, schema, table: info.name, kind: info.kind }, true),
      },
    },
    el("span", { class: "tsql-caret tsql-caret-empty" }),
    iconBox,
    el("span", { class: "tsql-tree-label", text: info.name }),
    info.rows != null
      ? el("span", { class: "tsql-tree-meta", text: `${info.rows}` })
      : null,
  );
  li.appendChild(head);
  return li;
}

// ----------------------------- Editor + results ------------------------------

/** Button with a HugeIcon on the left and a text label. The icon is the
 *  same chrome class TEDI core's header buttons use (size 13, stroke 1.75). */
function textBtn(text, iconName, opts = {}) {
  const cls = `tsql-btn${opts.primary ? " is-primary" : ""}${opts.disabled ? " is-disabled" : ""}`;
  const btn = el("button", {
    class: cls,
    attrs: {
      type: "button",
      title: opts.title,
      "aria-label": opts.title ?? text,
      disabled: opts.disabled ? "true" : undefined,
    },
    on: opts.onClick ? { click: opts.onClick } : undefined,
  });
  if (iconName) appendIcon(btn, iconName, { size: 13 });
  // Wrap the label in a span so CSS `gap` treats it as a flex child.
  // A bare text node is anonymous inline content and falls outside the
  // gap algorithm, which is why icon+label looked glued together.
  const label = document.createElement("span");
  label.textContent = text;
  btn.appendChild(label);
  return btn;
}

function renderEditorAndResults(session) {
  const wrap = el("div", { class: "tsql-main" });
  const toolbar = el(
    "div",
    { class: "tsql-toolbar" },
    textBtn("Run", "PlayIcon", {
      primary: true,
      title: "Run query (Ctrl+Enter)",
      onClick: () => runActiveQuery(),
    }),
    textBtn("Stop", "SquareIcon", {
      title: "Cancel current statement",
      onClick: () => cancelActiveQuery(),
    }),
    textBtn("Export", "Download01Icon", {
      title: "Export current result",
      onClick: () => openExportDialog(),
    }),
  );
  wrap.appendChild(toolbar);

  // Dispose any previous CodeMirror mount before spawning a new one;
  // rerender() blows the panel DOM away, but the React-less CodeMirror
  // view stays alive in the host iconRoots / handle registry until we
  // tell it to die. Without this, every connection switch (or window
  // close + reopen of the tab) would leak an EditorView.
  if (state.editorHandle && typeof state.editorHandle.dispose === "function") {
    try {
      state.editorHandle.dispose();
    } catch {
      // ignore
    }
    state.editorHandle = null;
  }

  const editorWrap = el("div", { class: "tsql-editor" });
  wrap.appendChild(editorWrap);

  const connKind = state.connections.find((c) => c.id === session.connId)?.kind;
  const language =
    connKind === "mysql"
      ? "sql:mysql"
      : connKind === "postgres"
        ? "sql:postgres"
        : connKind === "sqlite"
          ? "sql:sqlite"
          : "sql";

  try {
    state.editorHandle = ctx.ui.codeEditor(editorWrap, {
      language,
      value: session.sql ?? "",
      onChange: (v) => {
        session.sql = v;
      },
      onCmdEnter: () => runActiveQuery(),
    });
  } catch (err) {
    ctx?.logger?.error?.("codeEditor mount failed", err);
    // Fail loud rather than silently disabling editing; tell the user
    // they're on an older TEDI without the editor API.
    editorWrap.appendChild(
      el("p", {
        class: "tsql-empty",
        text: "Code editor unavailable. Update TEDI to >= 0.2.26.",
      }),
    );
  }

  const results = el("div", { class: "tsql-results", attrs: { "data-results-root": "1" } });
  if (session.activeTable) {
    renderTableGrid(results, session);
  } else if (session.result) {
    renderQueryResult(results, session);
  } else {
    results.appendChild(el("p", { class: "tsql-empty", text: "Results appear here." }));
  }
  wrap.appendChild(results);

  return wrap;
}

function renderQueryResult(container, session) {
  clearChildren(container);
  if (!session.result?.statements?.length) {
    container.appendChild(el("p", { class: "tsql-empty", text: "No statements ran." }));
    return;
  }
  const tabs = el("div", { class: "tsql-result-tabs" });
  const content = el("div", { class: "tsql-result-body" });
  session.result.statements.forEach((stmt, idx) => {
    const tab = el("button", {
      class: `tsql-result-tab${idx === 0 ? " is-active" : ""}`,
      text: tabLabel(stmt, idx),
      attrs: { type: "button" },
      on: {
        click: () => {
          tabs.querySelectorAll(".tsql-result-tab").forEach((t) => t.classList.remove("is-active"));
          tab.classList.add("is-active");
          renderStatementDetail(content, stmt);
        },
      },
    });
    tabs.appendChild(tab);
  });
  container.appendChild(tabs);
  container.appendChild(content);
  renderStatementDetail(content, session.result.statements[0]);
}

function tabLabel(stmt, idx) {
  const prefix = `#${idx + 1}`;
  if (stmt.kind === "rows") return `${prefix} ${stmt.rows.length} rows`;
  if (stmt.kind === "exec") return `${prefix} ${stmt.rows_affected} affected`;
  return `${prefix} error`;
}

function renderStatementDetail(container, stmt) {
  clearChildren(container);
  const meta = el("div", { class: "tsql-result-meta" });
  if (stmt.kind === "rows") {
    meta.appendChild(el("span", { text: `${stmt.rows.length} rows · ${stmt.elapsed_ms} ms${stmt.truncated ? " · truncated" : ""}` }));
    container.appendChild(meta);
    container.appendChild(renderGrid(stmt.columns.map((c) => c.name), stmt.rows));
    return;
  }
  if (stmt.kind === "exec") {
    meta.appendChild(el("span", { text: `${stmt.rows_affected} row(s) affected · ${stmt.elapsed_ms} ms` }));
    container.appendChild(meta);
    return;
  }
  if (stmt.kind === "error") {
    meta.appendChild(
      el("span", {
        class: "tsql-error-line",
        text: `Error · ${stmt.elapsed_ms} ms`,
      }),
    );
    container.appendChild(meta);
    container.appendChild(el("pre", { class: "tsql-error-text", text: stmt.error }));
    container.appendChild(el("pre", { class: "tsql-sql-source", text: stmt.sql }));
  }
}

// ----------------------------- Grid (read-only) ------------------------------

function renderGrid(columns, rows) {
  const wrap = el("div", { class: "tsql-grid-wrap" });
  const table = el("table", { class: "tsql-grid" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of columns) headRow.appendChild(el("th", { text: col }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const cell of row) tr.appendChild(renderCellTd(cell));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderCellTd(value) {
  const td = el("td");
  td.appendChild(renderCellContent(value));
  td.title = cellTooltip(value);
  return td;
}

function renderCellContent(value) {
  if (value === null || value === undefined) {
    return el("span", { class: "tsql-cell-null", text: "NULL" });
  }
  if (typeof value === "boolean") {
    return el("span", { class: "tsql-cell-bool", text: value ? "true" : "false" });
  }
  if (typeof value === "number") return document.createTextNode(String(value));
  if (typeof value === "string") return document.createTextNode(value);
  if (value && typeof value === "object" && value.__type === "bytes") {
    const wrap = el("span", { class: "tsql-cell-bytes" });
    appendIcon(wrap, "CodeIcon", { size: 12 });
    wrap.appendChild(document.createTextNode(` ${value.size ?? "?"} bytes`));
    return wrap;
  }
  return document.createTextNode(JSON.stringify(value));
}

function cellTooltip(value) {
  if (value && typeof value === "object" && value.__type === "bytes") {
    return `Binary value: ${value.size} bytes (double-click to inspect base64)`;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value == null ? "NULL" : String(value);
}

// ----------------------------- Editable table grid ---------------------------

async function openTable(session, target, scrollIntoView = false) {
  session.activeTable = target;
  session.tableSnapshot = null;
  await loadTableRows(session, 0);
  if (panelRoot && scrollIntoView) {
    panelRoot.querySelector("[data-results-root]")?.scrollIntoView({ block: "start" });
  }
}

async function loadTableRows(session, page) {
  if (!session.activeTable) return;
  const body = {
    conn: session.connId,
    database: session.activeTable.database,
    schema: session.activeTable.schema,
    table: session.activeTable.table,
    page,
    page_size: 100,
  };
  try {
    const resp = await fetchJson("/table-rows", { method: "POST", body });
    session.tableSnapshot = resp.result;
    if (!panelRoot) return;
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) renderTableGrid(root, session);
  } catch (err) {
    safeToast(`Failed to load table: ${err?.message ?? err}`, "error");
  }
}

function renderTableGrid(container, session) {
  clearChildren(container);
  const snap = session.tableSnapshot;
  const target = session.activeTable;
  if (!snap) {
    container.appendChild(el("p", { class: "tsql-empty", text: "Loading…" }));
    return;
  }
  container.appendChild(
    el(
      "header",
      { class: "tsql-subheader" },
      el(
        "span",
        { class: "tsql-table-title" },
        target.database === target.schema ? target.table : `${target.schema}.${target.table}`,
        snap.total != null ? ` · ${snap.total} rows` : "",
      ),
      el(
        "div",
        { class: "tsql-toolbar" },
        textBtn("Row", "Add01Icon", {
          title: "Insert row",
          onClick: () => openInsertDialog(session),
        }),
        textBtn("Reload", "Refresh01Icon", {
          title: "Reload current page",
          onClick: () => loadTableRows(session, snap.page),
        }),
        textBtn("Close", "Cancel01Icon", {
          title: "Close table view",
          onClick: () => {
            session.activeTable = null;
            session.tableSnapshot = null;
            rerender();
          },
        }),
      ),
    ),
  );

  // Build the editable grid. PK detection happens lazily on first edit
  // via /columns; we cache it on the snapshot.
  const wrap = el("div", { class: "tsql-grid-wrap is-editable" });
  const table = el("table", { class: "tsql-grid" });
  const thead = el("thead");
  const headRow = el("tr");
  headRow.appendChild(el("th", { class: "tsql-grid-actions-col", text: "" }));
  for (const col of snap.columns) headRow.appendChild(el("th", { text: col }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  snap.rows.forEach((row, ri) => {
    const tr = el("tr");
    tr.appendChild(rowActionsCell(session, ri));
    row.forEach((cell, ci) => {
      const td = el("td", {
        on: {
          dblclick: () => beginCellEdit(session, ri, ci, td),
        },
      });
      td.appendChild(renderCellContent(cell));
      td.title = cellTooltip(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  container.appendChild(renderPager(session, snap));
}

function rowActionsCell(session, rowIdx) {
  return el(
    "td",
    { class: "tsql-grid-actions-col" },
    rowActionBtn("Delete02Icon", "Delete row", () => deleteRowFromGrid(session, rowIdx)),
  );
}

function renderPager(session, snap) {
  const pager = el("footer", { class: "tsql-pager" });
  const hasPrev = snap.page > 0;
  const total = snap.total ?? null;
  const lastPage = total != null ? Math.max(0, Math.ceil(total / snap.page_size) - 1) : null;
  const hasNext = lastPage == null ? snap.rows.length === Number(snap.page_size) : snap.page < lastPage;
  pager.appendChild(
    textBtn("Prev", "ArrowLeft01Icon", {
      title: "Previous page",
      disabled: !hasPrev,
      onClick: () => hasPrev && loadTableRows(session, snap.page - 1),
    }),
  );
  pager.appendChild(
    el("span", { class: "tsql-pager-label", text: `Page ${snap.page + 1}${lastPage != null ? ` / ${lastPage + 1}` : ""}` }),
  );
  const nextBtn = textBtn("Next", null, {
    title: "Next page",
    disabled: !hasNext,
    onClick: () => hasNext && loadTableRows(session, snap.page + 1),
  });
  // Append the arrow icon AFTER the label so it sits on the right.
  appendIcon(nextBtn, "ArrowRight01Icon", { size: 13 });
  pager.appendChild(nextBtn);
  return pager;
}

async function beginCellEdit(session, rowIdx, colIdx, td) {
  const snap = session.tableSnapshot;
  if (!snap) return;
  const pks = await ensurePkColumns(session);
  if (pks.length === 0) {
    safeToast("Cannot edit: table has no primary key.", "warning");
    return;
  }
  const original = snap.rows[rowIdx][colIdx];
  const input = el("input", { class: "tsql-input tsql-cell-input" });
  input.value = original == null ? "" : typeof original === "object" ? JSON.stringify(original) : String(original);
  clearChildren(td);
  td.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    if (input.dataset.done) return;
    input.dataset.done = "1";
    const next = parseEditedValue(input.value, original);
    if (deepEqual(next, original)) {
      td.replaceChildren(renderCellContent(original));
      return;
    }
    const col = snap.columns[colIdx];
    const pkMap = {};
    for (const pk of pks) {
      const idx = snap.columns.indexOf(pk);
      if (idx < 0) {
        safeToast(`Primary key ${pk} not in current grid; refresh first.`, "warning");
        td.replaceChildren(renderCellContent(original));
        return;
      }
      pkMap[pk] = snap.rows[rowIdx][idx];
    }
    try {
      await fetchJson("/table-update", {
        method: "POST",
        body: {
          conn: session.connId,
          database: session.activeTable.database,
          schema: session.activeTable.schema,
          table: session.activeTable.table,
          pk: pkMap,
          values: { [col]: next },
        },
      });
      snap.rows[rowIdx][colIdx] = next;
      td.replaceChildren(renderCellContent(next));
      td.classList.add("tsql-cell-saved");
      setTimeout(() => td.classList.remove("tsql-cell-saved"), 800);
    } catch (err) {
      td.replaceChildren(renderCellContent(original));
      safeToast(`Update failed: ${err?.message ?? err}`, "error");
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      input.dataset.done = "1";
      td.replaceChildren(renderCellContent(original));
    }
  });
}

function parseEditedValue(text, prev) {
  if (text === "") return null;
  if (typeof prev === "number") {
    const n = Number(text);
    if (!Number.isNaN(n)) return n;
  }
  if (typeof prev === "boolean") {
    if (/^(true|t|1|yes)$/i.test(text)) return true;
    if (/^(false|f|0|no)$/i.test(text)) return false;
  }
  return text;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

async function ensurePkColumns(session) {
  if (session._pkCache?.table === session.activeTable.table) return session._pkCache.pks;
  const resp = await fetchJson(
    `/columns?conn=${encodeURIComponent(session.connId)}&database=${encodeURIComponent(session.activeTable.database)}&schema=${encodeURIComponent(session.activeTable.schema)}&table=${encodeURIComponent(session.activeTable.table)}`,
  );
  const pks = resp.columns.filter((c) => c.is_primary).map((c) => c.name);
  session._pkCache = { table: session.activeTable.table, pks, columns: resp.columns };
  return pks;
}

async function deleteRowFromGrid(session, rowIdx) {
  const snap = session.tableSnapshot;
  if (!snap) return;
  const pks = await ensurePkColumns(session);
  if (pks.length === 0) {
    safeToast("Cannot delete: table has no primary key.", "warning");
    return;
  }
  const pkMap = {};
  for (const pk of pks) {
    const idx = snap.columns.indexOf(pk);
    if (idx < 0) {
      safeToast(`Primary key ${pk} not in grid; refresh first.`, "warning");
      return;
    }
    pkMap[pk] = snap.rows[rowIdx][idx];
  }
  if (!confirm(`Delete row where ${pks.map((k) => `${k}=${pkMap[k]}`).join(", ")} ?`)) return;
  try {
    await fetchJson("/table-delete", {
      method: "POST",
      body: {
        conn: session.connId,
        database: session.activeTable.database,
        schema: session.activeTable.schema,
        table: session.activeTable.table,
        pk: pkMap,
      },
    });
    await loadTableRows(session, snap.page);
    safeToast("Row deleted", "success");
  } catch (err) {
    safeToast(`Delete failed: ${err?.message ?? err}`, "error");
  }
}

async function openInsertDialog(session) {
  const pks = await ensurePkColumns(session);
  const columns = session._pkCache?.columns ?? [];
  const overlay = el("div", { class: "tsql-overlay" });
  const dialog = el("div", { class: "tsql-dialog" });
  dialog.appendChild(el("h3", { class: "tsql-dialog-title", text: `Insert into ${session.activeTable.table}` }));
  const form = {};
  const grid = el("div", { class: "tsql-form-grid" });
  for (const col of columns) {
    const i = input({ onInput: (v) => (form[col.name] = v) });
    const label = `${col.name}${col.is_primary ? " (PK)" : ""}${!col.nullable ? " *" : ""}`;
    grid.appendChild(
      el(
        "label",
        { class: "tsql-field is-full" },
        el("span", { class: "tsql-label", text: label }),
        i,
      ),
    );
  }
  dialog.appendChild(grid);
  const error = el("p", { class: "tsql-form-error" });
  dialog.appendChild(error);
  dialog.appendChild(
    el(
      "div",
      { class: "tsql-dialog-actions" },
      el("button", {
        class: "tsql-btn",
        text: "Cancel",
        attrs: { type: "button" },
        on: { click: () => overlay.remove() },
      }),
      el("button", {
        class: "tsql-btn is-primary",
        text: "Insert",
        attrs: { type: "button" },
        on: {
          click: async () => {
            try {
              const values = {};
              for (const [k, v] of Object.entries(form)) {
                if (v !== "") values[k] = parseEditedValue(v, "");
              }
              await fetchJson("/table-insert", {
                method: "POST",
                body: {
                  conn: session.connId,
                  database: session.activeTable.database,
                  schema: session.activeTable.schema,
                  table: session.activeTable.table,
                  values,
                  pk: {},
                },
              });
              overlay.remove();
              await loadTableRows(session, session.tableSnapshot?.page ?? 0);
              safeToast(`Inserted row into ${session.activeTable.table}`, "success");
            } catch (err) {
              error.style.color = "var(--destructive, #ef4444)";
              error.textContent = err?.message ?? String(err);
            }
          },
        },
      }),
    ),
  );
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  panelRoot.appendChild(overlay);
  // Hint PK columns even when the user couldn't read them yet
  if (pks.length === 0) {
    safeToast("Table has no primary key; generated columns must be filled manually.", "info");
  }
}

// ----------------------------- Query run / cancel ----------------------------

async function runActiveQuery() {
  if (!state.active) return;
  const session = ensureSession(state.active);
  if (!session.sql.trim()) return;
  if (containsDestructive(session.sql) && !confirmDestructive(session.sql)) return;
  await ensureSidecar();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session.requestId = requestId;
  session.activeTable = null;
  session.result = null;
  if (panelRoot) {
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) {
      clearChildren(root);
      root.appendChild(el("p", { class: "tsql-empty", text: "Running…" }));
    }
  }
  try {
    const resp = await fetchJson("/query", {
      method: "POST",
      body: {
        conn: session.connId,
        sql: session.sql,
        request_id: requestId,
      },
    });
    session.result = resp;
  } catch (err) {
    session.result = {
      statements: [
        { kind: "error", sql: session.sql, error: err?.message ?? String(err), elapsed_ms: 0 },
      ],
    };
  } finally {
    session.requestId = null;
    if (panelRoot) {
      const root = panelRoot.querySelector("[data-results-root]");
      if (root) renderQueryResult(root, session);
    }
  }
}

async function cancelActiveQuery() {
  if (!state.active) return;
  const session = state.sessions[state.active];
  if (!session?.requestId) return;
  try {
    await fetchJson("/cancel", { method: "POST", body: { request_id: session.requestId } });
  } catch (err) {
    safeToast(`Cancel failed: ${err?.message ?? err}`, "error");
  }
}

const DESTRUCTIVE_REGEX = /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE?|DROP\s+ROLE|GRANT\s+ALL)\b/i;
function containsDestructive(sql) {
  return DESTRUCTIVE_REGEX.test(sql);
}
function confirmDestructive(sql) {
  return confirm(
    "This query looks destructive (DROP / TRUNCATE / GRANT).\nType OK in the next prompt to proceed.",
  ) && prompt("Type OK to confirm:") === "OK";
}

// ----------------------------- Export dialog ---------------------------------

async function openExportDialog() {
  if (!state.active) return;
  const session = state.sessions[state.active];
  if (!session?.result?.statements?.length && !session?.activeTable) {
    safeToast("Nothing to export.", "info");
    return;
  }
  const overlay = el("div", { class: "tsql-overlay" });
  const dialog = el("div", { class: "tsql-dialog" });
  dialog.appendChild(el("h3", { class: "tsql-dialog-title", text: "Export" }));
  let format = "csv";
  dialog.appendChild(
    el(
      "div",
      { class: "tsql-form-grid" },
      el(
        "label",
        { class: "tsql-field is-full" },
        el("span", { class: "tsql-label", text: "Format" }),
        select(
          [
            { value: "csv", label: "CSV (.csv)" },
            { value: "json", label: "JSON (.json)" },
            { value: "sql", label: "INSERT SQL (.sql)" },
          ],
          format,
          (v) => (format = v),
        ),
      ),
    ),
  );
  dialog.appendChild(
    el(
      "div",
      { class: "tsql-dialog-actions" },
      el("button", {
        class: "tsql-btn",
        text: "Cancel",
        attrs: { type: "button" },
        on: { click: () => overlay.remove() },
      }),
      el("button", {
        class: "tsql-btn is-primary",
        text: "Save",
        attrs: { type: "button" },
        on: {
          click: async () => {
            try {
              const body = {
                conn: session.connId,
                format,
              };
              if (session.activeTable) {
                body.database = session.activeTable.database;
                body.schema = session.activeTable.schema;
                body.table = session.activeTable.table;
              } else {
                const firstRowStmt = session.result.statements.find((s) => s.kind === "rows");
                if (!firstRowStmt) {
                  throw new Error("No row-producing statement to export.");
                }
                body.sql = firstRowStmt.sql;
              }
              const resp = await fetchJson("/export", { method: "POST", body });
              const blob = new Blob([resp.export.content], { type: resp.export.mime });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${session.activeTable?.table ?? "result"}.${resp.export.extension}`;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                try {
                  a.remove();
                } catch {
                  /* ignore */
                }
                URL.revokeObjectURL(url);
              }, 1500);
              overlay.remove();
              safeToast(
                `Exported ${resp.export.rows ?? 0} rows as ${a.download}`,
                "success",
              );
            } catch (err) {
              safeToast(`Export failed: ${err?.message ?? err}`, "error");
            }
          },
        },
      }),
    ),
  );
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  panelRoot.appendChild(overlay);
}

// ----------------------------- Misc actions ----------------------------------

async function restartSidecarFlow() {
  if (!confirm("Restart the SQL sidecar? Active connections will be closed.")) return;
  try {
    if (sidecar?.handle != null) await ctx.invoke("shell_bg_kill", { handle: sidecar.handle });
  } catch {
    /* ignore */
  }
  sidecar = null;
  state.sessions = {};
  state.active = null;
  rerender();
  ensureSidecar()
    .then(() => safeToast("Sidecar restarted", "success"))
    .catch((err) => safeToast(`Restart failed: ${err?.message ?? err}`, "error"));
}

// ----------------------------- Styles ----------------------------------------
//
// Single <style> block; class names all start with `tsql-` so they don't
// collide with TEDI host styles. Colours pull from TEDI's design tokens via
// CSS variables, so the panel inherits dark/light themes automatically.

const STYLE_ID = "tsql-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES_CSS;
  document.head.appendChild(style);
}

const STYLES_CSS = `
.tsql-host { height: 100%; display: flex; flex-direction: column; color: var(--foreground); background: var(--background); font-size: 12px; position: relative; }
.tsql-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tsql-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--card, var(--background)); user-select: none; }
.tsql-title { font-weight: 600; font-size: 12px; letter-spacing: 0.02em; }
.tsql-header-actions { display: flex; gap: 4px; }
.tsql-icon-btn { width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted-foreground); cursor: pointer; line-height: 1; display: inline-flex; align-items: center; justify-content: center; transition: background 0.12s ease, color 0.12s ease; }
.tsql-icon-btn:hover { background: var(--accent, rgba(127,127,127,0.12)); border-color: var(--border); color: var(--foreground); }

/* Responsive 2-pane shell: connection rail + workspace. The rail shrinks
   on narrow windows; below 720 px the connection list collapses into a
   horizontal strip above the workspace. */
.tsql-body { display: grid; grid-template-columns: minmax(180px, 220px) minmax(0, 1fr); flex: 1 1 auto; min-height: 0; min-width: 0; }
.tsql-conn-rail { border-right: 1px solid var(--border); overflow-y: auto; padding: 4px 0; min-width: 0; }
.tsql-conn-row { display: grid; grid-template-columns: 26px 1fr 22px 22px; gap: 6px; align-items: center; padding: 5px 8px; cursor: pointer; border-left: 2px solid transparent; border-radius: 0 4px 4px 0; }
.tsql-conn-row:hover { background: var(--accent, rgba(127,127,127,0.06)); }
.tsql-conn-row.is-active { background: var(--accent, rgba(127,127,127,0.12)); border-left-color: var(--primary, #3b82f6); }

/* Brand badge: 24-square box, holds the inline SVG mark. Background tint
   uses the official-ish brand colours so the row reads as MySQL / Postgres /
   SQLite at a glance without depending on the text. */
.tsql-conn-kind { width: 24px; height: 24px; border-radius: 6px; color: #fff; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
.tsql-conn-kind svg { width: 18px; height: 18px; }
.tsql-kind-mysql { background: #00758f; }
.tsql-kind-postgres { background: #336791; }
.tsql-kind-sqlite { background: #0f5b8a; }

.tsql-conn-meta { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.tsql-conn-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tsql-conn-host { font-size: 10px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tsql-row-action { width: 22px; height: 22px; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }
.tsql-row-action:hover { background: var(--accent, rgba(127,127,127,0.12)); color: var(--foreground); }

/* Workspace: schema tree (auto-shrinking) + editor / results column. */
.tsql-workspace { display: grid; grid-template-columns: minmax(200px, 260px) minmax(0, 1fr); min-width: 0; min-height: 0; }
.tsql-tree { border-right: 1px solid var(--border); overflow-y: auto; min-height: 0; min-width: 0; }
.tsql-subheader { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; font-weight: 500; color: var(--muted-foreground); border-bottom: 1px solid var(--border); background: var(--card, var(--background)); gap: 8px; }
.tsql-tree-list { list-style: none; margin: 0; padding: 4px 0; }
.tsql-tree-children { list-style: none; margin: 0; padding: 0 0 0 14px; }
.tsql-tree-node { padding: 0; }
.tsql-tree-row { width: 100%; display: grid; grid-template-columns: 14px 16px minmax(0, 1fr) auto; align-items: center; gap: 5px; padding: 4px 8px; background: transparent; border: 0; color: inherit; text-align: left; cursor: pointer; font-size: 12px; border-radius: 4px; }
.tsql-tree-row:hover { background: var(--accent, rgba(127,127,127,0.08)); }
.tsql-caret { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); transition: transform 0.12s ease; }
.tsql-caret.is-open { transform: rotate(90deg); }
.tsql-caret-empty { visibility: hidden; }
.tsql-tree-icon { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); }
.tsql-tree-row:hover .tsql-tree-icon, .tsql-tree-row:hover .tsql-caret { color: var(--foreground); }
.tsql-tree-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tsql-tree-meta { font-size: 10px; color: var(--muted-foreground); padding-left: 8px; }
.tsql-tree-error { padding: 4px 12px; color: var(--destructive, #ef4444); font-size: 11px; }
.tsql-tree-empty { padding: 4px 16px; color: var(--muted-foreground); font-size: 11px; }

.tsql-main { display: grid; grid-template-rows: auto minmax(80px, 1fr) minmax(120px, 1.4fr); min-height: 0; min-width: 0; }
.tsql-toolbar { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--card, var(--background)); flex-wrap: wrap; }
.tsql-btn { padding: 5px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--background); color: var(--foreground); cursor: pointer; font-size: 11px; font-family: inherit; display: inline-flex; align-items: center; gap: 5px; line-height: 1; transition: background 0.12s ease, border-color 0.12s ease; }
.tsql-btn:hover:not([disabled]) { background: var(--accent, rgba(127,127,127,0.08)); border-color: var(--ring, var(--border)); }
.tsql-btn.is-disabled, .tsql-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.tsql-btn.is-primary { background: var(--primary, #3b82f6); color: var(--primary-foreground, #fff); border-color: transparent; }
.tsql-btn.is-primary:hover:not([disabled]) { filter: brightness(1.1); }

/* Code-editor container: hosts a CodeMirror EditorView mounted by
   ctx.ui.codeEditor. The .cm-editor inside fills the container. */
.tsql-editor { width: 100%; height: 100%; min-height: 0; overflow: hidden; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; }
.tsql-editor .cm-editor { height: 100%; flex: 1 1 auto; min-height: 0; }
.tsql-editor .cm-editor.cm-focused { outline: none; }
.tsql-results { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.tsql-result-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 8px; border-bottom: 1px solid var(--border); background: var(--card, var(--background)); }
.tsql-result-tab { padding: 4px 9px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 11px; transition: color 0.12s ease, background 0.12s ease; }
.tsql-result-tab:hover { color: var(--foreground); }
.tsql-result-tab.is-active { color: var(--foreground); border-color: var(--primary, #3b82f6); background: var(--accent, rgba(127,127,127,0.08)); }
.tsql-result-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0; display: flex; flex-direction: column; }
.tsql-result-meta { padding: 6px 12px; color: var(--muted-foreground); font-size: 11px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Result / table grid — sticky header with subtle shadow, zebra rows,
   no horizontal overflow surprise. */
.tsql-grid-wrap { overflow: auto; flex: 1 1 auto; min-height: 0; }
.tsql-grid-wrap.is-editable { border-top: 1px solid var(--border); }
.tsql-grid { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 11px; }
.tsql-grid thead th { position: sticky; top: 0; background: var(--card, var(--background)); border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left; font-weight: 600; color: var(--muted-foreground); white-space: nowrap; z-index: 1; box-shadow: 0 1px 0 0 var(--border); user-select: none; }
.tsql-grid tbody td { padding: 5px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.tsql-grid tbody tr:nth-child(even) td { background: var(--accent, rgba(127,127,127,0.025)); }
.tsql-grid tbody tr:hover td { background: var(--accent, rgba(127,127,127,0.08)); }
.tsql-cell-null { color: var(--muted-foreground); font-style: italic; opacity: 0.7; }
.tsql-cell-bool { color: var(--primary, #3b82f6); font-weight: 600; }
.tsql-cell-bytes { color: var(--muted-foreground); font-family: var(--font-mono, monospace); display: inline-flex; align-items: center; gap: 3px; }
.tsql-grid-actions-col { width: 30px; }
.tsql-cell-input { width: 100%; padding: 2px 6px; font-size: 11px; border: 1px solid var(--primary, #3b82f6); border-radius: 3px; background: var(--background); color: var(--foreground); font-family: inherit; outline: none; }
.tsql-cell-saved { background: rgba(34, 197, 94, 0.22) !important; transition: background 0.6s ease; }

.tsql-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 7px 10px; border-top: 1px solid var(--border); background: var(--card, var(--background)); flex-shrink: 0; }
.tsql-pager-label { font-size: 11px; color: var(--muted-foreground); min-width: 80px; text-align: center; }
.tsql-empty { padding: 18px 14px; color: var(--muted-foreground); font-size: 12px; text-align: center; }

/* Modal dialog. */
.tsql-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 2000; backdrop-filter: blur(2px); }
.tsql-dialog { background: var(--card, var(--background)); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; min-width: 340px; max-width: 92%; max-height: 92%; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.4); }
.tsql-dialog-title { margin: 0 0 14px; font-size: 13px; font-weight: 600; }
.tsql-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px 14px; }
.tsql-field { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--muted-foreground); min-width: 0; }
.tsql-field.is-full { grid-column: 1 / -1; }
.tsql-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }

/* Inputs + native dropdown. Native arrow + pointer cursor on selects. */
.tsql-input { padding: 6px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--background); color: var(--foreground); font-size: 12px; font-family: inherit; transition: border-color 0.12s ease, box-shadow 0.12s ease; }
.tsql-input:focus { outline: none; border-color: var(--primary, #3b82f6); box-shadow: 0 0 0 1px var(--primary, #3b82f6); }
.tsql-input::placeholder { color: var(--muted-foreground); opacity: 0.6; }
select.tsql-input { cursor: pointer; padding-right: 28px; appearance: none; -webkit-appearance: none; -moz-appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2399a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>"); background-repeat: no-repeat; background-position: right 8px center; background-size: 12px 12px; }
select.tsql-input:hover { border-color: var(--ring, var(--border)); }

.tsql-checkbox { width: 14px; height: 14px; cursor: pointer; }
.tsql-form-error { margin: 10px 0 0; min-height: 14px; font-size: 11px; color: var(--destructive, #ef4444); }
.tsql-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.tsql-table-title { font-weight: 600; color: var(--foreground); }
.tsql-error-line { color: var(--destructive, #ef4444); font-weight: 600; }
.tsql-error-text { padding: 10px 12px; background: rgba(239, 68, 68, 0.08); color: var(--destructive, #ef4444); font-family: var(--font-mono, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.tsql-sql-source { padding: 10px 12px; background: var(--accent, rgba(127,127,127,0.06)); color: var(--muted-foreground); font-family: var(--font-mono, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; }

/* Narrow-window adaptations. The connection rail collapses into a single
   compressed row above the workspace; the schema tree also gets tighter. */
@media (max-width: 720px) {
  .tsql-body { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .tsql-conn-rail { border-right: 0; border-bottom: 1px solid var(--border); max-height: 120px; }
  .tsql-workspace { grid-template-columns: minmax(160px, 200px) minmax(0, 1fr); }
}
@media (max-width: 540px) {
  .tsql-workspace { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .tsql-tree { border-right: 0; border-bottom: 1px solid var(--border); max-height: 160px; }
  .tsql-toolbar { padding: 5px 8px; }
  .tsql-btn { padding: 4px 8px; }
}
`;
