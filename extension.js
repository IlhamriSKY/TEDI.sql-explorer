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
  // Only arches the release CI actually builds resolve to a dir; anything
  // else returns null so bootSidecar reports a clean "unsupported platform"
  // error instead of pointing at a binary the package never shipped. macOS
  // ships both arches; Windows and Linux ship x86_64 only.
  if (os?.platform === "windows") return arch === "aarch64" ? null : "windows-x86_64";
  if (os?.platform === "macos") return arch === "aarch64" ? "macos-aarch64" : "macos-x86_64";
  if (os?.platform === "linux") return arch === "aarch64" ? null : "linux-x86_64";
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
// Unified left-sidebar layout state. Persisted to settings so width /
// collapsed survive a tab reopen; `expandedConns` + `sidebarSearch` only
// need to survive the frequent in-panel rerenders.
let sidebarWidthPx = 240;
let sidebarCollapsed = false;
let sidebarSearch = "";
const expandedConns = new Set();
// "tab" (workspace tab) or "pane" (split-pane leaf). Set by the host when it
// mounts the renderer. In a pane the host frame already supplies a header
// (title + drag + close), so we drop our own and fold its actions into the
// sidebar, and the workbench sits flush inside the pane frame.
let surfaceMode = "tab";
const state = {
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
};

/** Destroy and forget any read-only SQL preview editors. Idempotent, so it
 *  is safe to call at the top of every result renderer. */
function disposePreviewEditors() {
  for (const handle of state.previewEditors) {
    try {
      handle?.dispose?.();
    } catch {
      // ignore
    }
  }
  state.previewEditors = [];
}

/** Map a connection's engine kind to the codeEditor language id used for
 *  SQL syntax highlighting. Falls back to generic "sql". */
function sqlLanguageForSession(session) {
  const kind = state.connections.find((c) => c.id === session.connId)?.kind;
  return kind === "mysql"
    ? "sql:mysql"
    : kind === "postgres"
      ? "sql:postgres"
      : kind === "sqlite"
        ? "sql:sqlite"
        : "sql";
}

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
  // collapse both sidebars (left file explorer + right AI/aux column)
  // so the workbench gets the full workspace width on open; the user
  // can re-expand either side from the header toggle whenever they
  // want it back. The right-sidebar API is only on hosts >= 0.3.5;
  // older hosts safely fall through the optional-chain.
  function openWorkbenchTab() {
    try {
      ctx.app?.setSidebarVisible?.(false);
    } catch (err) {
      ctx?.logger?.warn?.("sidebar collapse failed", err);
    }
    try {
      ctx.app?.setRightSidebarVisible?.(false);
    } catch (err) {
      ctx?.logger?.warn?.("right sidebar collapse failed", err);
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

  const disposeRenderer = ctx.registerPanelRenderer(PANEL_ID, (container, paneCtx) => {
    panelRoot = container;
    surfaceMode = paneCtx?.surface === "pane" ? "pane" : "tab";
    container.replaceChildren();
    container.classList.add("tsql-host");
    container.classList.toggle("tsql-host--pane", surfaceMode === "pane");
    // Delegated styled-tooltip controller for the whole panel subtree
    // (survives the frequent clearChildren-based rerenders since it binds
    // to the persistent container, not its children).
    tooltipLayer?.dispose();
    tooltipLayer = initTooltipLayer(container);
    renderPanel(container);
    // Boot the sidecar lazily on first panel mount. If it dies the user can
    // restart it from the menu without re-opening the extension.
    ensureSidecar().catch((err) => {
      ctx?.logger?.error?.("sidecar boot failed", err);
      safeToast(`SQL helper failed to start: ${err?.message ?? err}`, "error");
    });
    return () => {
      // Closing the tab tears the renderer down without deactivating the
      // extension; dispose the live CodeMirror views here too (mirrors
      // deactivate()) so they don't linger in the host handle registry.
      if (state.editorHandle?.dispose) {
        try {
          state.editorHandle.dispose();
        } catch {
          // ignore
        }
        state.editorHandle = null;
      }
      disposePreviewEditors();
      tooltipLayer?.dispose();
      tooltipLayer = null;
      panelRoot = null;
    };
  });
  ctx.addDisposer(disposeRenderer);
}

export async function deactivate() {
  try {
    setTabState(null);
    if (state.editorHandle?.dispose) {
      try {
        state.editorHandle.dispose();
      } catch {
        // ignore
      }
      state.editorHandle = null;
    }
    disposePreviewEditors();
    tooltipLayer?.dispose();
    tooltipLayer = null;
    if (sidecar?.baseUrl) {
      await fetchJson("/shutdown", { method: "POST", body: {} }).catch(() => {});
    }
    if (sidecar?.handle != null) {
      await ctx.invoke("shell_bg_kill", { handle: sidecar.handle }).catch(() => {});
    }
  } finally {
    sidecar = null;
    panelRoot = null;
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

/**
 * Tints the workspace tab title with a lifecycle tone matching the SSH
 * palette: yellow while connecting, green when connected, red on
 * disconnect/error. Safe no-op on older hosts that predate the API.
 *
 * @param {"idle"|"connecting"|"reconnecting"|"connected"|"disconnected"|"error"|null} state
 */
function setTabState(state) {
  try {
    ctx?.tabs?.setExtensionTabState?.({
      panelId: PANEL_ID,
      reuseKey: "main",
      state,
    });
  } catch (err) {
    ctx?.logger?.warn?.("setExtensionTabState failed", err);
  }
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
    const sb = await ctx.settings.get("sidebar");
    if (sb && typeof sb === "object") {
      if (typeof sb.width === "number" && sb.width > 0) sidebarWidthPx = sb.width;
      if (typeof sb.collapsed === "boolean") sidebarCollapsed = sb.collapsed;
    }
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
      if (v == null || v === false) continue;
      // Route every `title` through the custom tooltip layer (data-tooltip)
      // instead of the OS-native browser bubble, so all SQL Explorer
      // tooltips paint with the host's rounded popover chrome. `aria-label`
      // (set alongside `title` on icon buttons) still carries the a11y name.
      const attrName = k === "title" ? "data-tooltip" : k;
      node.setAttribute(attrName, v === true ? "" : String(v));
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

function safeToast(message, variant) {
  try {
    ctx?.ui?.toast(message, { variant });
  } catch {
    ctx?.logger?.info?.(message);
  }
}

/** Set (or clear) the custom-tooltip text on a node. Mirrors a `title`
 *  attribute but routes through the styled tooltip layer instead of the
 *  OS-native bubble. Empty / null clears it. Used for the many cell tds
 *  whose tooltip is assigned imperatively after creation. */
function setTooltipAttr(node, text) {
  if (!node) return;
  if (text == null || text === "") node.removeAttribute("data-tooltip");
  else node.setAttribute("data-tooltip", String(text));
}

// ----------------------------- Tooltip layer ---------------------------------
// A single delegated tooltip controller. Native `title` attributes render
// the OS bubble, which clashes with TEDI's chrome; every `title` in this
// extension is rewritten to `data-tooltip` (see el() + setTooltipAttr) and
// surfaced here as a styled popover that mirrors the host's Radix
// TooltipContent (rounded popover, 1px ring, soft shadow, 11px text, 200 ms
// hover delay, fade/zoom in). One reused bubble node, positioned with the
// same prefer-top / flip-to-bottom / clamp-to-viewport logic.
const TOOLTIP_DELAY_MS = 200;
const TOOLTIP_OFFSET = 6; // matches host tooltip sideOffset
const TOOLTIP_PAD = 8; // matches host tooltip collisionPadding
let tooltipLayer = null;

function initTooltipLayer(root) {
  if (!root) return null;
  let bubble = null;
  let showTimer = null;
  let current = null;

  const ensureBubble = () => {
    if (!bubble || !bubble.isConnected) {
      bubble = document.createElement("div");
      bubble.className = "tsql-tooltip";
      bubble.setAttribute("role", "tooltip");
      document.body.appendChild(bubble);
    }
    return bubble;
  };

  const place = (target) => {
    const tip = ensureBubble();
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer above the target; flip below if it would clip the top edge.
    let top = r.top - th - TOOLTIP_OFFSET;
    let side = "top";
    if (top < TOOLTIP_PAD) {
      top = r.bottom + TOOLTIP_OFFSET;
      side = "bottom";
    }
    if (side === "bottom" && top + th > vh - TOOLTIP_PAD && r.top - th - TOOLTIP_OFFSET >= TOOLTIP_PAD) {
      top = r.top - th - TOOLTIP_OFFSET;
      side = "top";
    }
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(TOOLTIP_PAD, Math.min(left, vw - tw - TOOLTIP_PAD));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.side = side;
  };

  const show = (target) => {
    const text = target.getAttribute("data-tooltip");
    if (!text) return;
    const tip = ensureBubble();
    tip.textContent = text;
    tip.style.visibility = "hidden";
    tip.classList.add("is-open");
    // Measure first (visibility:hidden keeps it laid out), then position.
    place(target);
    tip.style.visibility = "";
  };

  const hide = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    current = null;
    if (bubble) bubble.classList.remove("is-open");
  };

  const onOver = (event) => {
    const target = event.target?.closest?.("[data-tooltip]");
    if (!target || target === current || !root.contains(target)) return;
    current = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      if (current === target && target.isConnected) show(target);
    }, TOOLTIP_DELAY_MS);
  };
  const onOut = (event) => {
    if (!current) return;
    const target = event.target?.closest?.("[data-tooltip]");
    if (target !== current) return;
    // Ignore moves that stay inside the same tooltip owner.
    if (event.relatedTarget && target.contains(event.relatedTarget)) return;
    hide();
  };
  const onFocusIn = (event) => {
    const target = event.target?.closest?.("[data-tooltip]");
    if (!target || !root.contains(target)) return;
    current = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      if (current === target && target.isConnected) show(target);
    }, TOOLTIP_DELAY_MS);
  };

  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerout", onOut);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", hide);
  // A click / scroll / wheel can detach the hovered node or move it out from
  // under the bubble; drop the tooltip immediately so it never floats orphaned.
  root.addEventListener("pointerdown", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("wheel", hide, { capture: true, passive: true });

  return {
    dispose() {
      hide();
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerout", onOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide, { capture: true });
      bubble?.remove();
      bubble = null;
    },
  };
}

// ----------------------------- Top-level render ------------------------------

function renderPanel(container) {
  const pane = surfaceMode === "pane";
  const root = el("div", { class: "tsql-root" });
  // In a pane the host frame already supplies the header (title + drag +
  // close); only the workspace-tab surface renders our own header.
  if (!pane) root.appendChild(renderHeader());
  // Body is a flex row: [sidebar] [drag splitter] [editor + results]. The
  // sidebar holds the unified connection/schema/table tree and can be resized
  // by dragging the splitter. The collapse toggle lives in our header, so it
  // only applies on the tab surface; in a pane the sidebar is always shown
  // (size it via the splitter).
  const body = el("div", { class: "tsql-body" });
  if (pane || !sidebarCollapsed) {
    body.style.setProperty("--tsql-sidebar-w", `${sidebarWidthPx}px`);
    body.appendChild(renderSidebar());
    body.appendChild(makeSidebarSplitter(body));
  }
  body.appendChild(renderMainArea());
  root.appendChild(body);
  container.appendChild(root);
}

function rerender() {
  if (!panelRoot) return;
  // Detach any open modal / overlay before tearing down the panel body so
  // an in-flight connection edit or confirm dialog survives a rerender
  // (e.g. user clicks another connection in the rail while the editor is
  // open). Re-attached after the rebuild so they stay on top.
  const preserved = panelRoot.querySelectorAll(
    ":scope > .tsql-conn-modal, :scope > .tsql-overlay",
  );
  const detached = Array.from(preserved);
  for (const node of detached) panelRoot.removeChild(node);
  clearChildren(panelRoot);
  renderPanel(panelRoot);
  for (const node of detached) panelRoot.appendChild(node);
}

function renderHeader() {
  // Close button is dropped: the host tab strip already has an X.
  return el(
    "header",
    { class: "tsql-header" },
    el(
      "div",
      { class: "tsql-header-left" },
      iconButton(
        sidebarCollapsed ? "ArrowRight01Icon" : "ArrowLeft01Icon",
        sidebarCollapsed ? "Show connections" : "Hide connections",
        toggleSidebar,
      ),
      el("span", { class: "tsql-title", text: "SQL Explorer" }),
    ),
    el(
      "div",
      { class: "tsql-header-actions" },
      iconButton("Add01Icon", "New connection", () => openConnectionDialog()),
      iconButton("Refresh01Icon", "Restart sidecar", restartSidecarFlow),
    ),
  );
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  void persistSidebarPrefs();
  rerender();
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

/**
 * SQL syntax dictionaries fed into the autocomplete source. Split into
 * keywords / functions / types / engine-specific so each can be tagged
 * with the right CodeMirror completion `type` (controls the leading
 * icon glyph) and boost (controls vertical order in the popup).
 *
 * Labels are uppercase by convention; CodeMirror's prefix matcher is
 * case-insensitive against the user-typed word, so a user typing "se"
 * still resolves to "SELECT". The inserted text is the uppercase form
 * which is the usual house style in SQL editors.
 */
const SQL_KEYWORDS_COMMON = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "FULL", "CROSS",
  "ON", "USING", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "BETWEEN",
  "LIKE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "DISTINCT",
  "UNION", "ALL", "EXCEPT", "INTERSECT", "EXISTS", "CREATE", "TABLE",
  "INDEX", "VIEW", "SCHEMA", "DATABASE", "DROP", "ALTER", "ADD", "COLUMN",
  "RENAME", "TO", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE",
  "DEFAULT", "CONSTRAINT", "CHECK", "IF", "ELSE", "ELSIF", "CASE", "WHEN",
  "THEN", "END", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "SAVEPOINT",
  "WITH", "RECURSIVE", "RETURNING", "NATURAL", "TRUE", "FALSE", "ASC",
  "DESC", "CASCADE", "RESTRICT", "GRANT", "REVOKE", "EXPLAIN", "ANALYZE",
  "SHOW", "DESCRIBE", "TRUNCATE", "REPLACE", "MERGE",
];
const SQL_FUNCTIONS_COMMON = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST",
  "CONVERT", "NOW", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME",
  "DATE", "DATETIME", "TIME", "EXTRACT", "CONCAT", "SUBSTRING", "SUBSTR",
  "LENGTH", "CHAR_LENGTH", "TRIM", "LTRIM", "RTRIM", "UPPER", "LOWER",
  "REPLACE", "ROUND", "FLOOR", "CEIL", "CEILING", "ABS", "MOD", "POWER",
  "SQRT", "RANDOM", "RAND", "GREATEST", "LEAST", "ROW_NUMBER", "RANK",
  "DENSE_RANK", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "OVER",
  "PARTITION",
];
const SQL_TYPES_COMMON = [
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE",
  "DECIMAL", "NUMERIC", "REAL", "VARCHAR", "CHAR", "TEXT", "LONGTEXT",
  "MEDIUMTEXT", "BLOB", "BINARY", "VARBINARY", "DATE", "DATETIME",
  "TIMESTAMP", "TIME", "YEAR", "BOOLEAN", "BOOL", "JSON",
];
const SQL_KEYWORDS_BY_ENGINE = {
  mysql: [
    "AUTO_INCREMENT", "UNSIGNED", "ZEROFILL", "ENGINE", "CHARSET", "COLLATE",
    "MEDIUMINT", "LONGBLOB", "MEDIUMBLOB", "TINYBLOB", "ENUM", "DUAL", "USE",
    "LOCK", "UNLOCK", "DELIMITER", "STRAIGHT_JOIN", "STORAGE", "MEMORY",
    "INNODB", "MYISAM",
  ],
  postgres: [
    "SERIAL", "BIGSERIAL", "SMALLSERIAL", "JSONB", "UUID", "ILIKE", "ARRAY",
    "CONFLICT", "INTERVAL", "SIMILAR", "LATERAL", "MATERIALIZED", "FILTER",
    "WINDOW", "TABLESAMPLE", "GENERATED", "ALWAYS", "IDENTITY", "STORED",
  ],
  sqlite: [
    "AUTOINCREMENT", "ROWID", "PRAGMA", "ATTACH", "DETACH", "VACUUM",
    "GLOB", "INDEXED", "ABORT", "FAIL", "IGNORE",
  ],
};
const SQL_FUNCTIONS_BY_ENGINE = {
  mysql: ["DATE_ADD", "DATE_SUB", "DATEDIFF", "TIMESTAMPDIFF", "IFNULL", "IF", "FIND_IN_SET", "GROUP_CONCAT", "JSON_EXTRACT", "JSON_OBJECT", "JSON_ARRAY"],
  postgres: ["TO_CHAR", "TO_DATE", "TO_TIMESTAMP", "AGE", "DATE_TRUNC", "DATE_PART", "STRING_AGG", "ARRAY_AGG", "JSONB_BUILD_OBJECT", "JSONB_AGG"],
  sqlite: ["IFNULL", "IIF", "DATETIME", "STRFTIME", "JULIANDAY", "JSON", "JSON_EXTRACT"],
};

/**
 * Autocomplete source for the query editor. Returns three buckets:
 *  - schema cache entries (tables + columns) populated by `loadTables`
 *    and `loadTableRows` as the user navigates the tree
 *  - SQL syntax keywords / functions / data types so the editor stays
 *    useful before any table has been opened
 *  - engine-specific syntax for MySQL / PostgreSQL / SQLite, pulled
 *    from the active session's connection kind
 *
 * Boost ordering (higher = closer to top): tables 12, keywords 10,
 * functions 8, columns 5, types 3. Tables outrank keywords because the
 * common case after `FROM ` is a table name; columns sit below so they
 * surface mainly when the user has typed a column-ish prefix.
 *
 * Identical labels collapse (e.g. MySQL where db == schema, the same
 * table can appear as `db.db.table` and `db.table`). Dedup is by label
 * + type so a table and a column sharing a name both stay visible.
 */
function buildSchemaCompletions(session, prefix) {
  const needle = (prefix || "").toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (key, item) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const matches = (label) => !needle || label.toLowerCase().startsWith(needle);

  // Schema cache: tables + columns
  const cache = session?.schemaCache;
  if (cache && cache.size > 0) {
    for (const entry of cache.values()) {
      const tableName = entry.table;
      if (tableName && matches(tableName)) {
        const qualifier =
          entry.database === entry.schema
            ? entry.database
            : `${entry.database}.${entry.schema}`;
        push(`t:${tableName}`, {
          label: tableName,
          detail: qualifier,
          type: entry.kind === "view" ? "interface" : "class",
          boost: 12,
        });
      }
      for (const col of entry.columns) {
        if (matches(col)) {
          push(`c:${col}:${tableName}`, {
            label: col,
            detail: tableName,
            type: "property",
            boost: 5,
          });
        }
      }
    }
  }

  // SQL syntax: keywords, functions, types. Always available so the
  // editor offers help before the schema cache has anything.
  const connKind = state.connections.find((c) => c.id === session?.connId)?.kind;
  const engineKeywords = SQL_KEYWORDS_BY_ENGINE[connKind] ?? [];
  const engineFunctions = SQL_FUNCTIONS_BY_ENGINE[connKind] ?? [];
  for (const kw of SQL_KEYWORDS_COMMON) {
    if (matches(kw)) push(`k:${kw}`, { label: kw, detail: "keyword", type: "keyword", boost: 10 });
  }
  for (const kw of engineKeywords) {
    if (matches(kw)) push(`k:${kw}`, { label: kw, detail: `${connKind} keyword`, type: "keyword", boost: 10 });
  }
  for (const fn of SQL_FUNCTIONS_COMMON) {
    if (matches(fn)) push(`f:${fn}`, { label: fn, detail: "function", type: "function", boost: 8 });
  }
  for (const fn of engineFunctions) {
    if (matches(fn)) push(`f:${fn}`, { label: fn, detail: `${connKind} function`, type: "function", boost: 8 });
  }
  for (const ty of SQL_TYPES_COMMON) {
    if (matches(ty)) push(`y:${ty}`, { label: ty, detail: "type", type: "type", boost: 3 });
  }
  return out;
}

// Builds a search input with a HugeIcon clear (X) button overlaid on the
// right. Browser's native `type=search` clear button paints in the user's
// system colour and doesn't match the host icon family, so we use a
// `type=text` input + an absolutely-positioned button that shares the
// HugeIcon palette with iconButton / textBtn / row actions. The clear
// button hides while the input is empty (no useless X glyph) and shows
// the moment the user types one character.
function makeSearchInput({
  placeholder,
  ariaLabel,
  inputClass = "",
  wrapClass = "",
  initialValue = "",
  onInput,
}) {
  const wrap = el("div", { class: `tsql-search-wrap ${wrapClass}`.trim() });
  const input = el("input", {
    class: inputClass,
    attrs: {
      type: "text",
      placeholder,
      "aria-label": ariaLabel,
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  input.value = initialValue;
  const clearBtn = el("button", {
    class: "tsql-search-clear",
    attrs: {
      type: "button",
      "aria-label": "Clear search",
      title: "Clear",
      tabindex: "-1",
    },
  });
  appendIcon(clearBtn, "Cancel01Icon", { size: 12 });
  const sync = () => {
    clearBtn.classList.toggle("is-visible", Boolean(input.value));
  };
  sync();
  input.addEventListener("input", () => {
    sync();
    onInput?.(input.value);
  });
  clearBtn.addEventListener("click", () => {
    if (!input.value) return;
    input.value = "";
    sync();
    onInput?.("");
    input.focus();
  });
  wrap.appendChild(input);
  wrap.appendChild(clearBtn);
  return { wrap, input };
}

// ----------------------------- Left sidebar (unified tree) -------------------
// One tree: each saved connection is a root node that expands to its
// databases → schemas → tables. A single search box filters every level.

function renderSidebar() {
  const aside = el("aside", { class: "tsql-sidebar" });
  const head = el("div", { class: "tsql-tree-head" });
  const { wrap: searchWrap } = makeSearchInput({
    placeholder: "Search connections, tables…",
    ariaLabel: "Search connections, databases and tables",
    inputClass: "tsql-tree-search",
    wrapClass: "tsql-search-wrap--tree",
    initialValue: sidebarSearch,
    onInput: (val) => {
      sidebarSearch = val;
      applyTreeFilter(aside, val);
    },
  });
  if (surfaceMode === "pane") {
    // No workbench header in a pane, so the new-connection + restart-sidecar
    // actions ride in the sidebar head next to the search box.
    const row = el(
      "div",
      { class: "tsql-sidebar-head-row" },
      searchWrap,
      iconButton("Add01Icon", "New connection", () => openConnectionDialog()),
      iconButton("Refresh01Icon", "Restart sidecar", restartSidecarFlow),
    );
    head.appendChild(row);
  } else {
    head.appendChild(searchWrap);
  }
  aside.appendChild(head);

  const list = el("ul", { class: "tsql-tree-list" });
  // Connections sit at depth 0; their databases render one level in, schemas
  // two, tables three (see renderConnNode / renderDbNode / renderSchemaNode).
  list.style.setProperty("--tsql-depth", "0");
  if (state.connections.length === 0) {
    list.appendChild(
      el("li", { class: "tsql-empty", text: "No connections yet. Click + to add one." }),
    );
  } else {
    for (const c of state.connections) list.appendChild(renderConnNode(c));
  }
  aside.appendChild(list);
  // Re-apply a pending filter once the (sync) connection rows exist; async
  // database/table loads re-apply again as they resolve (reapplyTreeFilter).
  if (sidebarSearch) requestAnimationFrame(() => applyTreeFilter(aside, sidebarSearch));
  return aside;
}

/** Display name shown for each backend kind in the rail subtitle and as
 *  the engine dropdown label. We intentionally do not ship brand marks
 *  here — the rail and the engine select stay text-only so the workbench
 *  reads as part of TEDI's chrome instead of a third-party panel. */
const KIND_LABEL = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

function rowActionBtn(iconName, title, onClick, opts = {}) {
  // `danger` paints the trash / delete affordance in --destructive with
  // a red-tinted hover bg, matching the host's
  // `text-muted-foreground hover:bg-destructive/10 hover:text-destructive`
  // pattern used across Settings / WorkspacesPanel / ExplorerGrep so
  // delete actions read the same everywhere in TEDI.
  const cls = `tsql-row-action${opts.danger ? " is-danger" : ""}`;
  const btn = el("button", {
    class: cls,
    attrs: { title, "aria-label": title, type: "button" },
    on: { click: onClick },
  });
  appendIcon(btn, iconName, { size: 13 });
  return btn;
}

/** A connection as a tree root. Its row carries the caret + database icon +
 *  name + hover actions (reload / edit / delete); the child list holds the
 *  database tree once the connection is expanded. The row is a <div
 *  role=button> (not a <button>) so the action <button>s can nest legally. */
function renderConnNode(c) {
  const isActive = state.active === c.id;
  const isOpen = expandedConns.has(c.id);
  const session = state.sessions[c.id];
  // Rebuild the active session's tree registry as we re-render its subtree,
  // so stale element refs from the previous pass can't survive (matches the
  // old renderTreePane behaviour).
  if (isActive && session) clearTreeRegistry(session);

  const li = el("li", {
    class: "tsql-tree-node tsql-node-conn",
    attrs: { "data-conn-id": c.id },
  });
  const caretBox = el("span", { class: `tsql-caret${isOpen ? " is-open" : ""}` });
  appendIcon(caretBox, "ArrowRight01Icon", { size: 11 });
  const iconBox = el("span", { class: "tsql-tree-icon" });
  appendIcon(iconBox, "Database01Icon", { size: 14 });
  const actions = el(
    "span",
    { class: "tsql-tree-actions" },
    rowActionBtn("Refresh01Icon", "Reload databases", (event) => {
      event.stopPropagation();
      refreshConnTree(c);
    }),
    rowActionBtn("PencilEdit01Icon", "Edit connection", (event) => {
      event.stopPropagation();
      void openConnectionDialog(c);
    }),
    rowActionBtn(
      "Delete02Icon",
      "Delete connection",
      (event) => {
        event.stopPropagation();
        void confirmAndDeleteConnection(c);
      },
      { danger: true },
    ),
  );
  const head = el(
    "div",
    {
      class: `tsql-tree-row tsql-conn-head${isActive ? " is-active" : ""}`,
      attrs: { role: "button", tabindex: "0", title: connSubtitle(c), "aria-label": c.name || c.id },
      on: {
        click: () => onConnNodeClick(c),
        keydown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onConnNodeClick(c);
          }
        },
      },
    },
    caretBox,
    iconBox,
    el("span", { class: "tsql-tree-label", text: c.name || c.id }),
    actions,
  );
  li.appendChild(head);

  const childList = el("ul", { class: "tsql-tree-children" });
  childList.style.setProperty("--tsql-depth", "1");
  childList.style.display = isOpen ? "" : "none";
  li.appendChild(childList);

  if (isOpen && session) {
    loadDatabases(session, childList)
      .then(() => scheduleTreeSync(session))
      .catch((err) =>
        childList.appendChild(
          el("li", { class: "tsql-tree-error", text: err?.message ?? String(err) }),
        ),
      );
  }
  return li;
}

/** Click a connection root: select + connect it (expanding its tree), or
 *  toggle the already-active connection open/closed. Only the active
 *  connection is ever expanded, so every table click maps to the one
 *  session backing the editor. */
function onConnNodeClick(c) {
  if (state.active === c.id) {
    if (expandedConns.has(c.id)) expandedConns.delete(c.id);
    else expandedConns.add(c.id);
    rerender();
    return;
  }
  expandedConns.clear();
  expandedConns.add(c.id);
  selectConnection(c.id).catch((err) => {
    safeToast(`Connect failed: ${err?.message ?? err}`, "error");
    setTabState("error");
  });
}

/** Reload the database subtree for a connection in place (without rebuilding
 *  the editor). Falls back to selecting it if it isn't the active/open one. */
function refreshConnTree(c) {
  const session = state.sessions[c.id];
  if (state.active !== c.id || !session) {
    onConnNodeClick(c);
    return;
  }
  expandedConns.add(c.id);
  const li = panelRoot?.querySelector(`.tsql-node-conn[data-conn-id="${cssEscape(c.id)}"]`);
  const childList = li?.querySelector(":scope > .tsql-tree-children");
  if (!childList) {
    rerender();
    return;
  }
  childList.style.display = "";
  li.querySelector(":scope > .tsql-tree-row .tsql-caret")?.classList.add("is-open");
  clearTreeRegistry(session);
  loadDatabases(session, childList)
    .then(() => scheduleTreeSync(session))
    .catch((err) => safeToast(`Reload failed: ${err?.message ?? err}`, "error"));
}

/** Minimal CSS.escape shim for attribute selectors (connection ids are
 *  `c-<uuid>` so this only needs to survive the rare odd character). */
function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\\]]/g, "\\$&");
}

function connSubtitle(c) {
  const kind = KIND_LABEL[c.kind] || c.kind;
  if (c.kind === "sqlite") return `${kind} · ${c.host || c.database || "file"}`;
  // Build the host/database tail from non-empty parts only. A connection
  // with no user and no pinned database used to render dangling separators
  // (e.g. "@127.0.0.1:3306/"); skipping empty segments keeps the subtitle
  // clean as "MySQL · 127.0.0.1:3306" or "MySQL · root@127.0.0.1:3306/app".
  const user = c.user ? `${c.user}@` : "";
  const port = c.port ? `:${c.port}` : "";
  const db = c.database ? `/${c.database}` : "";
  const tail = `${user}${c.host ?? ""}${port}${db}`;
  return tail ? `${kind} · ${tail}` : kind;
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

  // Floating tool window docked to the right of the workbench. No
  // dark overlay (the SQL Explorer is still usable behind it); the
  // header is a drag handle so the user can reposition it, and the
  // X button closes it. Esc also closes when the dialog has focus.
  const { body, close } = openDockedDialog({
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
    sqlitePath: existing?.kind === "sqlite" ? (existing?.host ?? existing?.database ?? "") : "",
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

/**
 * Draggable, dockable side panel. Returns `{ root, body, header, close }`.
 * Initial position docks to the right edge of `panelRoot`; the user can
 * grab the title bar to move it (pointer events with capture so the drag
 * survives transient pointer-out), and the X button or Escape closes it.
 * Unlike the centred modal it leaves the workbench usable underneath, so
 * the rail and tree stay clickable while the form is open.
 */
function openDockedDialog({ title, width = 460 }) {
  const host = panelRoot || document.body;
  // Only one docked dialog at a time. Without this, clicking Edit on a
  // second connection while the first dialog is open piles two dialogs
  // on top of each other, since the docked variant intentionally does
  // not block clicks behind it.
  for (const prev of host.querySelectorAll(":scope > .tsql-conn-modal")) {
    prev.remove();
  }
  const root = el("div", { class: "tsql-conn-modal" });
  root.style.width = `${width}px`;

  // Header doubles as a drag handle. Pointer capture on the header keeps
  // drag alive when the cursor briefly leaves the element (e.g. moving
  // fast over scrollbars). `cursor: grab/grabbing` is hinted in CSS.
  const header = el("div", { class: "tsql-conn-modal-header" });
  const titleEl = el("span", { class: "tsql-conn-modal-title", text: title });
  const closeBtn = el("button", {
    class: "tsql-conn-modal-close",
    attrs: { type: "button", "aria-label": "Close", title: "Close" },
  });
  appendIcon(closeBtn, "Cancel01Icon", { size: 13, strokeWidth: 2 });
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const body = el("div", { class: "tsql-conn-modal-body" });

  root.appendChild(header);
  root.appendChild(body);

  // Dock to the right edge by default (16px gutter). Switches to a
  // `left`/`top` coordinate system once the user starts dragging so the
  // dialog can be freely moved within the panel bounds.
  root.style.position = "absolute";
  root.style.right = "16px";
  root.style.top = "16px";
  root.style.zIndex = "1500";

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (closeBtn.contains(event.target)) return;
    const hostRect = host.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    root.style.left = `${rect.left - hostRect.left}px`;
    root.style.top = `${rect.top - hostRect.top}px`;
    root.style.right = "";
    startLeft = rect.left - hostRect.left;
    startTop = rect.top - hostRect.top;
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;
    try {
      header.setPointerCapture(event.pointerId);
    } catch {
      // pointer capture may fail on touch + unusual inputs; drag still
      // works via the global move/up listeners.
    }
    event.preventDefault();
  });
  header.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const hostRect = host.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const maxLeft = Math.max(0, hostRect.width - rect.width);
    const maxTop = Math.max(0, hostRect.height - rect.height);
    const nextLeft = Math.min(maxLeft, Math.max(0, startLeft + dx));
    const nextTop = Math.min(maxTop, Math.max(0, startTop + dy));
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try {
      header.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  };
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  };
  closeBtn.addEventListener("click", close);

  host.appendChild(root);
  return { root, body, header, close };
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

/** A `type="number"` input wrapped with themed up/down steppers (see
 *  makeNumberWrap). Returns the wrapper element; the `onInput` listener fires
 *  for both typing and stepper clicks. Used for the connection editor's
 *  numeric fields so they match the cell editor's number chrome. */
function numberInput({ value = "", onInput, min, step, placeholder, dataField } = {}) {
  const node = input({ type: "number", value, onInput, placeholder, dataField });
  if (min != null) node.setAttribute("min", String(min));
  if (step != null) node.setAttribute("step", String(step));
  return makeNumberWrap(node);
}

/**
 * Text-only dropdown that mirrors TEDI's Settings DropdownMenu (shadcn /
 * radix-luma): outline trigger with an ArrowDown01Icon caret, rounded
 * popup rendered into `document.body`, Tick02Icon next to the selected
 * item, click-outside + Escape to close. No per-option icons by design
 * so the workbench stays compact and reads as part of TEDI's chrome.
 *
 * Returns the trigger element. The signature matches the old native-
 * `<select>` helper so we can drop it in without changing callers.
 */
function select(options, current, onChange) {
  let value = current;
  let menu = null;
  let isOpen = false;

  const trigger = el("button", {
    class: "tsql-select",
    attrs: {
      type: "button",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
    },
  });

  const labelSpan = el("span", { class: "tsql-select-label" });
  trigger.appendChild(labelSpan);

  const caretBox = el("span", { class: "tsql-select-caret" });
  appendIcon(caretBox, "ArrowDown01Icon", { size: 12, strokeWidth: 2 });
  trigger.appendChild(caretBox);

  const updateLabel = () => {
    const current = options.find((o) => o.value === value);
    labelSpan.textContent = current?.label ?? "";
  };
  updateLabel();

  const onDocMouseDown = (event) => {
    if (!menu) return;
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    closeMenu();
  };
  const onDocKeyDown = (event) => {
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeMenu();
    }
  };

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    isOpen = false;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
  }

  function openMenu() {
    if (isOpen) return;
    const rect = trigger.getBoundingClientRect();
    menu = el("ul", {
      class: "tsql-select-menu",
      attrs: { role: "listbox" },
    });
    menu.style.position = "fixed";
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.minWidth = `${Math.max(rect.width, 200)}px`;
    menu.style.zIndex = "10000";

    for (const opt of options) {
      const item = el("li", {
        class: `tsql-select-item${opt.value === value ? " is-selected" : ""}`,
        attrs: { role: "option", "data-value": opt.value },
      });
      item.appendChild(el("span", { class: "tsql-select-item-label", text: opt.label }));
      if (opt.value === value) {
        const check = el("span", { class: "tsql-select-item-check" });
        appendIcon(check, "Tick02Icon", { size: 13, strokeWidth: 2 });
        item.appendChild(check);
      }
      item.addEventListener("click", () => {
        value = opt.value;
        if (onChange) {
          try {
            onChange(opt.value);
          } catch (err) {
            ctx?.logger?.error?.("dropdown onChange threw", err);
          }
        }
        updateLabel();
        closeMenu();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    trigger.setAttribute("aria-expanded", "true");
    isOpen = true;
    // Defer listener attach so the click that opened us doesn't immediately close.
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDocMouseDown, true);
      document.addEventListener("keydown", onDocKeyDown, true);
    });
  }

  trigger.addEventListener("click", () => {
    if (isOpen) closeMenu();
    else openMenu();
  });
  return trigger;
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
  // Auto-expand the just-saved connection in the tree (accordion: only the
  // active connection stays open).
  expandedConns.clear();
  expandedConns.add(form.id);
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

async function confirmAndDeleteConnection(conn) {
  const label = conn.name || conn.id;
  const ok = await openConfirmDialog({
    title: "Delete connection?",
    message: `"${label}" will be removed and its stored credentials wiped from the keychain.`,
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  await deleteConnection(conn.id);
}

async function deleteConnection(id) {
  state.connections = state.connections.filter((c) => c.id !== id);
  await persistConnections();
  try {
    await fetchJson("/disconnect", { method: "POST", body: { id } });
  } catch {
    /* silent: pool may not be open */
  }
  if (state.active === id) {
    state.active = null;
    setTabState("disconnected");
  }
  expandedConns.delete(id);
  delete state.sessions[id];
  rerender();
}

/**
 * Promise-based confirmation modal that reuses `tsql-overlay` / `tsql-dialog`
 * so visuals stay consistent with the connection editor. Resolves to `true`
 * when the user confirms, `false` on cancel / overlay-click / Escape.
 * The confirm button defaults to the primary style; pass `destructive: true`
 * to flip it to the host's red destructive chrome (matches the
 * `AlertDialogAction variant="destructive"` pattern used in
 * SourceControlPanel.tsx).
 */
function openConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };

    const overlay = el("div", { class: "tsql-overlay" });
    const dialog = el("div", { class: "tsql-dialog tsql-dialog-confirm" });
    dialog.addEventListener("click", (event) => event.stopPropagation());
    overlay.addEventListener("click", () => finish(false));

    dialog.appendChild(el("h3", { class: "tsql-dialog-title", text: title }));
    if (message) {
      dialog.appendChild(el("p", { class: "tsql-dialog-message", text: message }));
    }

    const actions = el("div", { class: "tsql-dialog-actions" });
    const cancelBtn = el("button", {
      class: "tsql-btn",
      attrs: { type: "button" },
      text: cancelLabel,
      on: { click: () => finish(false) },
    });
    const confirmBtn = el("button", {
      class: `tsql-btn ${destructive ? "is-destructive" : "is-primary"}`,
      attrs: { type: "button" },
      text: confirmLabel,
      on: { click: () => finish(true) },
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    const host = panelRoot || document.body;
    host.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => confirmBtn.focus());
  });
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
  if (!conn) {
    setTabState("disconnected");
    return;
  }
  const conns = await fetchJson("/connections").catch(() => null);
  const alreadyOpen = conns?.connections?.some((c) => c.id === id);
  if (!alreadyOpen) {
    setTabState("connecting");
    const password = conn.kind === "sqlite" ? "" : (await getSecret(id)) ?? "";
    try {
      await connectFromForm({ ...conn, password, sqlitePath: conn.host || conn.database || "" });
    } catch (err) {
      safeToast(`Connect failed: ${err?.message ?? err}`, "error");
      setTabState("error");
      return;
    }
  }
  ensureSession(id);
  setTabState("connected");
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
      // Cache for the autocomplete source in the query editor. Keyed by
      // `database.schema.table` so MySQL (db == schema) and PostgreSQL
      // (db > schema) both collapse to a stable identifier. `columns` is
      // populated lazily when the user opens the table grid; tables alone
      // are populated when their parent DB / schema is expanded in the
      // tree. The completion provider walks every entry on every keystroke.
      schemaCache: new Map(),
    };
  }
  // schemaCache was added after some sessions might already exist; backfill
  // so older entries don't crash the completion source on first keystroke.
  if (!state.sessions[id].schemaCache) state.sessions[id].schemaCache = new Map();
  // Tree navigation registries. Wiped on every rerender (renderConnNode
  // calls clearTreeRegistry for the active connection); rebuilt as the
  // renderer walks DB / schema / table rows. Lets the SQL-driven tree sync
  // open a DB or scroll a table into view without re-querying the DOM.
  if (!state.sessions[id].dbHandles) state.sessions[id].dbHandles = new Map();
  if (!state.sessions[id].schemaHandles) state.sessions[id].schemaHandles = new Map();
  if (!state.sessions[id].tableHandles) state.sessions[id].tableHandles = new Map();
  return state.sessions[id];
}

function clearTreeRegistry(session) {
  session.dbHandles?.clear();
  session.schemaHandles?.clear();
  session.tableHandles?.clear();
}

function tableHandleKey(database, schema, table) {
  return `${database} ${schema} ${table}`.toLowerCase();
}

// ----------------------------- SQL → tree sync -------------------------------

/**
 * Extracts table identifiers from the free-form SQL the user is typing.
 * Strips comments and string literals first so a `'-- foo'` or `'INTO bar'`
 * inside a string doesn't fire a false match. Recognises the usual table
 * positions: FROM, JOIN (all variants), UPDATE, INSERT INTO, DELETE FROM,
 * TRUNCATE, CREATE/ALTER/DROP TABLE. Identifiers may be quoted (` " [ ])
 * and may carry up to two qualifiers (`db.schema.table`).
 *
 * Returns `[{ raw, parts: [..lower] }]` — the caller resolves each ref
 * against `session.schemaCache`.
 */
function parseSqlReferences(sql) {
  if (!sql) return [];
  let clean = String(sql);
  // Strip comments before strings; a `--` inside a string literal isn't
  // actually a comment, but stripping strings first would chew up that
  // literal anyway, so order is mostly cosmetic for the regex output.
  clean = clean.replace(/--[^\r\n]*/g, " ");
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Strip string literals so a `WHERE name = 'FROM users'` doesn't trip.
  clean = clean.replace(/'(?:''|[^'])*'/g, "''");
  // Double-quoted strings are ambiguous (Postgres treats them as identifiers,
  // MySQL as strings). We keep them so qualified `"db"."table"` survives.
  // Match keyword(s) + qualified identifier. Identifier tokens accept the
  // four common quoting styles. {0,2} caps qualifier depth at three (db.
  // schema.table).
  const ident = `(?:\`[^\`]+\`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)`;
  const re = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|(?:CREATE|ALTER|DROP)\\s+TABLE)\\b\\s+(${ident}(?:\\s*\\.\\s*${ident}){0,2})`,
    "gi",
  );
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(clean)) !== null) {
    const raw = m[1].trim();
    const parts = raw
      .split(/\s*\.\s*/)
      .map((p) => p.replace(/^[`"[]|[`"\]]$/g, ""))
      .map((p) => p.toLowerCase());
    const key = parts.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, parts });
  }
  return out;
}

/** Resolves a list of parsed references against the session's schema
 *  cache. Returns the best matching cache entry, or `null` if nothing
 *  matches. Preference order:
 *    1. Fully-qualified `db.schema.table` matches the input qualifiers
 *    2. Two-part input matches by `db` OR `schema`
 *    3. Bare table name — first cached entry wins, but with a bias toward
 *       the session's currently-expanded database so a user typing
 *       `users` against an already-expanded `app` DB resolves to `app`'s
 *       users table, not some other DB's. */
function findCachedMatch(session, refs) {
  const cache = session?.schemaCache;
  if (!cache || cache.size === 0) return null;
  const current = (session.currentDatabase || "").toLowerCase();
  for (const ref of refs) {
    const tableName = ref.parts[ref.parts.length - 1];
    if (!tableName) continue;
    const candidates = [];
    for (const entry of cache.values()) {
      if ((entry.table || "").toLowerCase() === tableName) candidates.push(entry);
    }
    if (candidates.length === 0) continue;
    if (ref.parts.length >= 3) {
      const [db, sch] = ref.parts;
      const exact = candidates.find(
        (e) => (e.database || "").toLowerCase() === db && (e.schema || "").toLowerCase() === sch,
      );
      if (exact) return exact;
    }
    if (ref.parts.length === 2) {
      const qual = ref.parts[0];
      const exact = candidates.find(
        (e) => (e.database || "").toLowerCase() === qual || (e.schema || "").toLowerCase() === qual,
      );
      if (exact) return exact;
    }
    if (current) {
      const inCurrent = candidates.find((e) => (e.database || "").toLowerCase() === current);
      if (inCurrent) return inCurrent;
    }
    return candidates[0];
  }
  return null;
}

let treeSyncTimer = null;
function scheduleTreeSync(session) {
  if (treeSyncTimer) clearTimeout(treeSyncTimer);
  treeSyncTimer = setTimeout(() => {
    treeSyncTimer = null;
    syncTreeToSql(session).catch((err) => ctx?.logger?.warn?.("tree sync failed", err));
  }, 280);
}

async function syncTreeToSql(session) {
  if (!session || !panelRoot) return;
  // The user may have switched connections during the debounce; the
  // session's DOM handles are detached at that point. Bail rather than
  // mutate an offscreen tree.
  if (state.active !== session.connId) return;
  const refs = parseSqlReferences(session.sql);
  if (refs.length === 0) return;
  const match = findCachedMatch(session, refs);
  if (!match) return;
  // Pop the matching DB open (collapses siblings via the accordion logic
  // inside dbHandles.open). Then walk the loaded child tree to find the
  // table row. Schemas inside the DB are lazy too, so we await the schema
  // expand before we look for the table row.
  const db = session.dbHandles?.get(match.database);
  if (db) {
    await db.open();
  }
  const key = tableHandleKey(match.database, match.schema, match.table);
  let rowHandle = session.tableHandles?.get(key);
  if (!rowHandle) {
    // Tables aren't loaded yet for this schema; the DB's open() above
    // populated single-schema DBs but a multi-schema DB still needs the
    // matching schema row expanded. Look for the schema handle and click.
    const schemaKey = `${match.database.toLowerCase()} ${match.schema.toLowerCase()}`;
    const sch = session.schemaHandles?.get(schemaKey);
    if (sch) {
      await sch.open();
      rowHandle = session.tableHandles?.get(key);
    }
  }
  if (rowHandle?.row) highlightTableRow(rowHandle.row);
}

function highlightTableRow(row) {
  if (!row) return;
  // The query cue (`.is-target`) marks the table the running / typed
  // statement is about, so query mode gets the same kind of indication as
  // browsing a table. Only one table is ever in focus: clear the prior
  // query cue AND the browse highlight, then mark this row. If the row is
  // already the target, don't re-add (that would re-trigger the pulse and
  // re-scroll on every keystroke).
  const already = row.classList.contains("is-target");
  panelRoot
    ?.querySelectorAll(".tsql-tree-row.is-target")
    .forEach((r) => {
      if (r !== row) r.classList.remove("is-target");
    });
  panelRoot
    ?.querySelectorAll(
      ".tsql-node-table > .tsql-tree-row.is-active, .tsql-node-view > .tsql-tree-row.is-active",
    )
    .forEach((r) => r.classList.remove("is-active"));
  if (already) return;
  row.classList.add("is-target");
  try {
    row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  } catch {
    row.scrollIntoView();
  }
}

// ----------------------------- Workspace -------------------------------------

// ----------------------------- Main area -------------------------------------

function renderMainArea() {
  if (!state.active) {
    return el(
      "section",
      { class: "tsql-main tsql-main--empty" },
      el("p", { class: "tsql-empty", text: "Select a connection on the left to start." }),
    );
  }
  return renderEditorAndResults(ensureSession(state.active));
}

// Horizontal (col-resize) splitter between the sidebar and the main area.
// Mirrors the editor/results splitter; drag updates --tsql-sidebar-w on the
// body and persists the width so it survives a tab reopen.
function makeSidebarSplitter(body) {
  const splitter = el("div", {
    class: "tsql-hsplitter",
    attrs: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize sidebar",
      tabindex: "0",
    },
  });
  const MIN_W = 140;
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const bodyRect = body.getBoundingClientRect();
    const maxW = Math.max(MIN_W, bodyRect.width - 220);
    const onMove = (ev) => {
      const w = Math.max(MIN_W, Math.min(maxW, ev.clientX - bodyRect.left));
      sidebarWidthPx = Math.round(w);
      body.style.setProperty("--tsql-sidebar-w", `${sidebarWidthPx}px`);
    };
    const onUp = () => {
      splitter.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { splitter.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      void persistSidebarPrefs();
    };
    splitter.classList.add("is-dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    e.preventDefault();
  });
  splitter.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    sidebarWidthPx = Math.max(MIN_W, sidebarWidthPx + (e.key === "ArrowLeft" ? -16 : 16));
    body.style.setProperty("--tsql-sidebar-w", `${sidebarWidthPx}px`);
    void persistSidebarPrefs();
    e.preventDefault();
  });
  return splitter;
}

/** Filter the whole tree: a node stays visible if its own label matches the
 *  query or any descendant does. Empty query shows everything. Spans the
 *  connection / database / schema / table levels. */
function applyTreeFilter(aside, query) {
  const q = (query || "").trim().toLowerCase();
  const list = aside?.querySelector(".tsql-tree-list");
  if (!list) return;
  const visit = (node) => {
    const labelEl = node.querySelector(":scope > .tsql-tree-row .tsql-tree-label");
    const selfMatch = !q || (labelEl ? labelEl.textContent.toLowerCase().includes(q) : false);
    let descMatch = false;
    const children = node.querySelector(":scope > .tsql-tree-children");
    if (children) {
      for (const child of children.querySelectorAll(":scope > .tsql-tree-node")) {
        if (visit(child)) descMatch = true;
      }
    }
    const visible = selfMatch || descMatch;
    node.style.display = visible ? "" : "none";
    return visible;
  };
  for (const conn of list.querySelectorAll(":scope > .tsql-node-conn")) visit(conn);
}

/** Re-run the active tree filter after async database/table loads mount new
 *  rows, so the search keeps hiding non-matches as the tree fills in. */
function reapplyTreeFilter() {
  if (!sidebarSearch || !panelRoot) return;
  const aside = panelRoot.querySelector(".tsql-sidebar");
  if (aside) applyTreeFilter(aside, sidebarSearch);
}

async function persistSidebarPrefs() {
  if (!ctx?.settings?.set) return;
  try {
    await ctx.settings.set("sidebar", { width: sidebarWidthPx, collapsed: sidebarCollapsed });
  } catch (err) {
    ctx?.logger?.warn?.("save sidebar prefs failed", err);
  }
}

async function loadDatabases(session, list) {
  clearChildren(list);
  const resp = await fetchJson(`/databases?conn=${encodeURIComponent(session.connId)}`);
  // When the connection pins a `database`, the schema tree shows only that
  // one — matches the user's "this is the database I care about" intent
  // from the connection form. Without a pin, list every database the
  // server exposes.
  const pinned = (state.connections.find((c) => c.id === session.connId) || {}).database;
  const databases = pinned
    ? resp.databases.filter((db) => db.name === pinned)
    : resp.databases;
  for (const db of databases) {
    list.appendChild(renderDbNode(session, db.name));
  }
  // New database rows just mounted; re-apply the sidebar search if active.
  reapplyTreeFilter();
}

function renderDbNode(session, dbName) {
  const li = el("li", { class: "tsql-tree-node tsql-node-db" });
  const caretBox = el("span", { class: "tsql-caret" });
  appendIcon(caretBox, "ArrowRight01Icon", { size: 11 });
  const iconBox = el("span", { class: "tsql-tree-icon" });
  appendIcon(iconBox, "Database01Icon", { size: 14 });
  const isActive = session.currentDatabase === dbName;
  const head = el(
    "button",
    {
      class: `tsql-tree-row${isActive ? " is-active" : ""}`,
      attrs: { type: "button" },
    },
    caretBox,
    iconBox,
    el("span", { class: "tsql-tree-label", text: dbName }),
  );
  li.appendChild(head);
  const childList = el("ul", { class: "tsql-tree-children" });
  // Database sits at depth 1 (under its connection); schemas / tables under
  // it render one level deeper.
  childList.style.setProperty("--tsql-depth", "2");
  childList.style.display = "none";
  li.appendChild(childList);
  let loaded = false;
  let loadingPromise = null;
  // Single source of truth for "expand this DB". Both the click handler
  // and the SQL-sync caller route through this so the accordion
  // collapse-siblings logic + active-state highlight always run together.
  async function openDb() {
    const wasOpen = childList.style.display !== "none";
    if (!wasOpen) {
      const parent = li.parentElement;
      if (parent) {
        for (const sib of parent.querySelectorAll(":scope > .tsql-node-db")) {
          if (sib === li) continue;
          const sCaret = sib.querySelector(":scope > .tsql-tree-row > .tsql-caret");
          const sList = sib.querySelector(":scope > .tsql-tree-children");
          if (sList && sList.style.display !== "none") sList.style.display = "none";
          if (sCaret) sCaret.classList.remove("is-open");
        }
      }
      session.currentDatabase = dbName;
      panelRoot
        ?.querySelectorAll(".tsql-node-db .tsql-tree-row.is-active")
        .forEach((r) => r.classList.remove("is-active"));
      head.classList.add("is-active");
      childList.style.display = "";
      caretBox.classList.add("is-open");
    }
    if (!loaded) {
      if (!loadingPromise) {
        loadingPromise = (async () => {
          try {
            await loadSchemas(session, dbName, childList);
            loaded = true;
          } catch (err) {
            loaded = false;
            childList.appendChild(
              el("li", { class: "tsql-tree-error", text: err?.message ?? String(err) }),
            );
          } finally {
            loadingPromise = null;
          }
        })();
      }
      await loadingPromise;
    }
  }
  function closeDb() {
    childList.style.display = "none";
    caretBox.classList.remove("is-open");
  }
  head.addEventListener("click", async () => {
    const wasOpen = childList.style.display !== "none";
    if (wasOpen) closeDb();
    else await openDb();
  });
  session.dbHandles?.set(dbName, { open: openDb, close: closeDb, row: head });
  return li;
}

async function loadSchemas(session, dbName, parent) {
  const resp = await fetchJson(
    `/schemas?conn=${encodeURIComponent(session.connId)}&database=${encodeURIComponent(dbName)}`,
  );
  // Collapse single-schema (MySQL/SQLite) into the parent. Tables hang
  // directly off the DB; register a flat schema handle anyway so the
  // SQL sync can resolve `db.table` against it without branching on
  // engine kind.
  if (resp.schemas.length === 1 && resp.schemas[0].name === dbName) {
    const key = `${dbName.toLowerCase()} ${dbName.toLowerCase()}`;
    session.schemaHandles?.set(key, {
      open: async () => {},
      close: () => {},
      row: null,
    });
    await loadTables(session, dbName, dbName, parent);
    return;
  }
  for (const s of resp.schemas) {
    parent.appendChild(renderSchemaNode(session, dbName, s.name));
  }
  reapplyTreeFilter();
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
  // Tables under a multi-schema database render three indent levels in
  // (connection → database → schema → table).
  childList.style.setProperty("--tsql-depth", "3");
  childList.style.display = "none";
  li.appendChild(childList);
  let loaded = false;
  let loadingPromise = null;
  async function openSchema() {
    if (childList.style.display === "none") {
      childList.style.display = "";
      caretBox.classList.add("is-open");
    }
    if (!loaded) {
      if (!loadingPromise) {
        loadingPromise = (async () => {
          try {
            await loadTables(session, dbName, schemaName, childList);
            loaded = true;
          } catch (err) {
            loaded = false;
            childList.appendChild(
              el("li", { class: "tsql-tree-error", text: err?.message ?? String(err) }),
            );
          } finally {
            loadingPromise = null;
          }
        })();
      }
      await loadingPromise;
    }
  }
  function closeSchema() {
    childList.style.display = "none";
    caretBox.classList.remove("is-open");
  }
  head.addEventListener("click", async () => {
    const wasOpen = childList.style.display !== "none";
    if (wasOpen) closeSchema();
    else await openSchema();
  });
  const schemaKey = `${dbName.toLowerCase()} ${schemaName.toLowerCase()}`;
  session.schemaHandles?.set(schemaKey, { open: openSchema, close: closeSchema, row: head });
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
    // Seed the autocomplete cache with the table identity. Columns get
    // filled in when the user actually opens the table grid (lazy).
    const key = `${database}.${schema}.${t.name}`;
    const prev = session.schemaCache.get(key);
    session.schemaCache.set(key, {
      database,
      schema,
      table: t.name,
      kind: t.kind,
      columns: prev?.columns ?? [],
    });
    parent.appendChild(renderTableNode(session, database, schema, t));
  }
  // Cache just gained a batch of table names; replay the SQL-driven
  // sync in case the user typed the table before its DB was expanded.
  scheduleTreeSync(session);
  // Table rows just mounted; re-apply the sidebar search if active.
  reapplyTreeFilter();
}

function renderTableNode(session, database, schema, info) {
  const li = el("li", { class: `tsql-tree-node tsql-node-${info.kind}` });
  const iconBox = el("span", { class: "tsql-tree-icon" });
  appendIcon(iconBox, info.kind === "view" ? "ViewIcon" : "Table01Icon", { size: 14 });
  const t = session.activeTable;
  const isActive =
    !!t && t.database === database && t.schema === schema && t.table === info.name;
  const head = el(
    "button",
    {
      class: `tsql-tree-row${isActive ? " is-active" : ""}`,
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
  // Register so the SQL-driven sync can scroll this row into view and
  // pulse the highlight when the user references the table by name.
  const key = tableHandleKey(database, schema, info.name);
  session.tableHandles?.set(key, { row: head, database, schema, table: info.name });
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
  disposePreviewEditors();

  const editorWrap = el("div", { class: "tsql-editor" });
  wrap.appendChild(editorWrap);

  const language = sqlLanguageForSession(session);

  try {
    state.editorHandle = ctx.ui.codeEditor(editorWrap, {
      language,
      value: session.sql ?? "",
      onChange: (v) => {
        session.sql = v;
        // Debounced parse of the new SQL; if the user typed a table
        // name we already cached, expand its DB in the accordion and
        // scroll the table row into view. No-op when the parser
        // finds nothing recognisable.
        scheduleTreeSync(session);
      },
      onCmdEnter: () => runActiveQuery(),
      // Walks the schema cache (populated as the user expands the tree /
      // opens table grids) and returns matching tables + columns. Older
      // TEDI hosts (<0.3.3) ignore this field, so the extension still
      // loads but the popup never appears - by design.
      completions: (prefix) => buildSchemaCompletions(session, prefix),
    });
  } catch (err) {
    ctx?.logger?.error?.("codeEditor mount failed", err);
    // Fail loud rather than silently disabling editing; tell the user
    // they're on an older TEDI without the editor API.
    editorWrap.appendChild(
      el("p", {
        class: "tsql-empty",
        text: "Code editor unavailable. Update TEDI to >= 0.3.9.",
      }),
    );
  }

  // Vertical splitter between editor and results. Drag updates the CSS
  // variable that drives the editor's flex-basis; the results pane takes
  // the rest via `flex: 1 1 auto`. Height is persisted on the session so
  // re-renders (connection switch, panel remount) restore it.
  const splitter = el("div", {
    class: "tsql-splitter",
    attrs: {
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-label": "Resize query editor",
      tabindex: "0",
    },
  });
  wrap.appendChild(splitter);
  if (session.editorHeightPx) {
    wrap.style.setProperty("--tsql-editor-h", `${session.editorHeightPx}px`);
  }
  // Single pointer-event drag handler covers mouse + touch + pen so the
  // splitter works on any input. clamps editor between minEditor and the
  // available height minus minResults so neither pane vanishes.
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const mainRect = wrap.getBoundingClientRect();
    const toolbarH = wrap.querySelector(".tsql-toolbar")?.offsetHeight ?? 0;
    const splitterH = splitter.offsetHeight;
    const minEditor = 80;
    const minResults = 120;
    const onMove = (ev) => {
      const desired = ev.clientY - mainRect.top - toolbarH;
      const maxEditor = mainRect.height - toolbarH - splitterH - minResults;
      const clamped = Math.max(minEditor, Math.min(maxEditor, desired));
      wrap.style.setProperty("--tsql-editor-h", `${clamped}px`);
      session.editorHeightPx = clamped;
    };
    const onUp = () => {
      splitter.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { splitter.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    splitter.classList.add("is-dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    e.preventDefault();
  });
  // Keyboard nudge: Up/Down shrinks/grows the editor by 16 px so users
  // who can't reach the 6 px hit area (e.g. trackpad) can still resize.
  splitter.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const cur = parseFloat(getComputedStyle(wrap).getPropertyValue("--tsql-editor-h")) || wrap.querySelector(".tsql-editor")?.offsetHeight || 0;
    const step = e.key === "ArrowUp" ? -16 : 16;
    const next = Math.max(80, cur + step);
    wrap.style.setProperty("--tsql-editor-h", `${next}px`);
    session.editorHeightPx = next;
    e.preventDefault();
  });

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
  disposePreviewEditors();
  if (!session.result?.statements?.length) {
    container.appendChild(el("p", { class: "tsql-empty", text: "No statements ran." }));
    return;
  }
  const statements = session.result.statements;
  const language = sqlLanguageForSession(session);
  const content = el("div", { class: "tsql-result-body" });
  // Hide the tab strip for the common single-statement case so the meta
  // line in renderStatementDetail can carry the row count + duration on
  // its own without a redundant tab pill.
  if (statements.length > 1) {
    const tabs = el("div", { class: "tsql-result-tabs" });
    statements.forEach((stmt, idx) => {
      const tab = el("button", {
        class: `tsql-result-tab${idx === 0 ? " is-active" : ""}`,
        text: tabLabel(stmt),
        attrs: { type: "button" },
        on: {
          click: () => {
            tabs.querySelectorAll(".tsql-result-tab").forEach((t) => t.classList.remove("is-active"));
            tab.classList.add("is-active");
            renderStatementDetail(content, stmt, language, session);
          },
        },
      });
      tabs.appendChild(tab);
    });
    container.appendChild(tabs);
  }
  container.appendChild(content);
  renderStatementDetail(content, statements[0], language, session);
}

function tabLabel(stmt) {
  if (stmt.kind === "rows") return `${stmt.rows.length} rows · ${stmt.elapsed_ms} ms`;
  if (stmt.kind === "exec") return `${stmt.rows_affected} affected · ${stmt.elapsed_ms} ms`;
  return `error · ${stmt.elapsed_ms} ms`;
}

function renderStatementDetail(container, stmt, language, session) {
  clearChildren(container);
  // Re-rendering this slot (fresh result or a statement-tab switch) drops
  // the prior preview editor's DOM; destroy the EditorView too so it
  // doesn't linger.
  disposePreviewEditors();
  if (stmt.kind === "rows") {
    renderResultGrid(container, {
      sql: stmt.sql,
      columns: stmt.columns.map((c) => c.name),
      rows: stmt.rows,
      elapsedMs: stmt.elapsed_ms,
      truncated: stmt.truncated,
      language,
      session,
    });
    return;
  }
  if (stmt.kind === "exec") {
    const meta = el("div", { class: "tsql-result-meta" });
    meta.appendChild(
      el("span", { text: `${stmt.rows_affected} affected · ${stmt.elapsed_ms} ms` }),
    );
    container.appendChild(meta);
    container.appendChild(renderSqlPreview(stmt.sql, language));
    return;
  }
  if (stmt.kind === "error") {
    const meta = el("div", { class: "tsql-result-meta" });
    meta.appendChild(
      el("span", { class: "tsql-error-line", text: `Error · ${stmt.elapsed_ms} ms` }),
    );
    container.appendChild(meta);
    container.appendChild(el("pre", { class: "tsql-error-text", text: stmt.error }));
    container.appendChild(renderSqlPreview(stmt.sql, language));
  }
}

// SQL preview shown above the grid so the user can see exactly what
// statement produced the displayed rows. Rendered as a read-only,
// syntax-highlighted CodeMirror so it reads as real code (mono font,
// keyword/string/number colors) instead of a cramped grey strip. Falls
// back to a plain text line on hosts without ctx.ui.codeEditor.
function renderSqlPreview(sql, language) {
  const text = String(sql ?? "");
  if (ctx?.ui?.codeEditor) {
    const wrap = el("div", { class: "tsql-sql-editor", attrs: { title: text } });
    try {
      const handle = ctx.ui.codeEditor(wrap, {
        language: language ?? "sql",
        value: text,
        readOnly: true,
      });
      state.previewEditors.push(handle);
      return wrap;
    } catch (err) {
      ctx?.logger?.warn?.("sql preview editor mount failed", err);
    }
  }
  return el("div", { class: "tsql-sql-preview", attrs: { title: text }, text });
}

// ----------------------------- Query result grid -----------------------------
// Read-only grid for free-form SELECT results with HeidiSQL-style chrome:
// row-count + duration meta on the left, client-side search input + page
// navigation on the right, divider, then a sticky-header virtualised
// table. Rows are paginated in JS (sidecar already capped to row_limit)
// so the DOM stays small no matter how big the result is.
const GRID_PAGE_SIZE = 100;

function renderResultGrid(container, opts) {
  const { sql, columns, rows, elapsedMs, truncated, language, session } = opts;
  const grid = {
    query: "",
    page: 0,
    filtered: rows,
  };
  let searchTimer = null;
  // Resolved asynchronously below: non-null once this result is recognised
  // as a single-table SELECT whose rows can be edited in place. redraw()
  // reads it each pass, so a late resolve simply re-wires the live cells.
  let editCtx = null;

  // Meta bar: row count + duration on the left, search on the right.
  // Pagination is no longer crammed into this bar; it lives in a bottom
  // footer so the layout mirrors the table-browse view. Sticky so the
  // controls stay reachable while the result scrolls.
  const metaBar = el("div", { class: "tsql-result-meta tsql-grid-meta tsql-meta--sticky" });
  const leftMeta = el("span", { class: "tsql-grid-meta-left" });
  metaBar.appendChild(leftMeta);

  // Shared search input + HugeIcon clear (X) button: the same component
  // the table-browse view uses, so the reset affordance matches everywhere.
  const { wrap: searchWrap } = makeSearchInput({
    placeholder: "Search rows…",
    ariaLabel: "Search rows on this page",
    inputClass: "tsql-input tsql-grid-search",
    wrapClass: "tsql-search-wrap--grid",
    initialValue: "",
    onInput: (val) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        applyFilter(val.trim());
      }, 160);
    },
  });
  metaBar.appendChild(el("span", { class: "tsql-grid-meta-right" }, searchWrap));
  container.appendChild(metaBar);

  // Executed statement, rendered as a read-only syntax-highlighted editor
  // so the user always sees exactly what produced the rows below.
  container.appendChild(renderSqlPreview(sql, language));

  const gridSlot = el("div", { class: "tsql-grid-slot" });
  container.appendChild(gridSlot);

  // Bottom pager footer: same chrome (.tsql-pager + Prev / label / Next)
  // as renderPager so paginated query results read identically to the
  // table-browse view.
  const pager = el("footer", { class: "tsql-pager" });
  container.appendChild(pager);

  function applyFilter(q) {
    grid.query = q;
    grid.page = 0;
    if (!q) {
      grid.filtered = rows;
    } else {
      const needle = q.toLowerCase();
      grid.filtered = rows.filter((row) => rowMatches(row, needle));
    }
    redraw();
  }

  function redraw() {
    const total = grid.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / GRID_PAGE_SIZE));
    if (grid.page >= totalPages) grid.page = totalPages - 1;
    const start = grid.page * GRID_PAGE_SIZE;
    const slice = grid.filtered.slice(start, start + GRID_PAGE_SIZE);

    leftMeta.replaceChildren();
    const baseInfo = grid.query
      ? `${total.toLocaleString()} of ${rows.length.toLocaleString()} rows match`
      : `${rows.length.toLocaleString()} rows`;
    leftMeta.appendChild(document.createTextNode(`${baseInfo} · ${elapsedMs} ms`));
    if (truncated && !grid.query) {
      leftMeta.appendChild(el("span", { class: "tsql-tag tsql-tag--warn", text: "truncated" }));
    }
    if (editCtx) {
      const tag = el("span", {
        class: "tsql-tag tsql-tag--edit",
        attrs: { title: `Double-click a cell to edit. Changes write to ${editCtx.table}.` },
      });
      appendIcon(tag, "PencilEdit01Icon", { size: 11 });
      tag.appendChild(document.createTextNode("editable"));
      leftMeta.appendChild(tag);
    }

    gridSlot.replaceChildren(buildGridTable(columns, slice, editCtx));

    const hasPrev = grid.page > 0;
    const hasNext = grid.page < totalPages - 1;
    pager.replaceChildren();
    pager.appendChild(
      textBtn("Prev", "ArrowLeft01Icon", {
        title: "Previous page",
        disabled: !hasPrev,
        onClick: () => {
          if (!hasPrev) return;
          grid.page -= 1;
          redraw();
        },
      }),
    );
    pager.appendChild(
      el("span", {
        class: "tsql-pager-label",
        text: `Page ${grid.page + 1} / ${totalPages}`,
      }),
    );
    const nextBtn = textBtn("Next", null, {
      title: "Next page",
      disabled: !hasNext,
      onClick: () => {
        if (!hasNext) return;
        grid.page += 1;
        redraw();
      },
    });
    appendIcon(nextBtn, "ArrowRight01Icon", { size: 13 });
    pager.appendChild(nextBtn);
  }

  redraw();

  // Resolve editability off the main render path. If the statement turns out
  // to be a plain single-table SELECT on a writable connection, wire the
  // cells for inline edit and surface the "editable" pill. Cheap no-op for
  // joins / aggregates / read-only connections (resolves to null).
  if (session) {
    resolveQueryEditContext(session, sql, columns)
      .then((resolved) => {
        if (!resolved || !container.isConnected) return;
        editCtx = resolved;
        redraw();
      })
      .catch((err) => ctx?.logger?.warn?.("query edit resolve failed", err));
  }
}

function rowMatches(row, needle) {
  for (const cell of row) {
    if (cell == null) continue;
    let s;
    if (typeof cell === "string") s = cell;
    else if (typeof cell === "number" || typeof cell === "boolean") s = String(cell);
    else if (typeof cell === "object" && cell.__type === "bytes") continue;
    else s = JSON.stringify(cell);
    if (s.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function buildGridTable(columns, rows, editCtx) {
  const wrap = el("div", { class: `tsql-grid-wrap${editCtx ? " is-editable" : ""}` });
  const table = el("table", { class: "tsql-grid" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of columns) headRow.appendChild(el("th", { text: col }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, ci) => {
      const td = renderCellTd(cell);
      // When the result maps to an editable table, columns that correspond
      // to real table columns get the spreadsheet affordance + double-click
      // edit. The backing `row` array is passed (not an index) so edits and
      // PK lookups stay correct across the grid's client-side pagination.
      if (editCtx && editCtx.editableColIdx.has(ci)) {
        td.classList.add("tsql-cell-editable");
        td.addEventListener("dblclick", () => beginQueryCellEdit(editCtx, row, ci, td));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderCellTd(value) {
  const td = el("td");
  td.appendChild(renderCellContent(value));
  setTooltipAttr(td, cellTooltip(value));
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

// ------------------------- Editable query results ----------------------------
// Free-form query results are normally read-only, but the common case of a
// plain `SELECT ... FROM one_table` maps 1:1 to base-table rows and can be
// edited in place using the same /table-update path as the table-browse grid.
// resolveQueryEditContext figures out whether that mapping is safe; cells then
// reuse mountTypedEditor via beginQueryCellEdit.

/**
 * Decide whether a free-form query result can be edited in place, and if so
 * build its edit context. Editable only when the statement is a plain
 * single-table SELECT against a base table (not a view) on a writable
 * connection, the table has a primary key, and every PK column is present in
 * the result so each row can be uniquely addressed. Returns null (read-only)
 * for joins, aggregates, unions, views, or projections with no real columns.
 */
async function resolveQueryEditContext(session, sql, columns) {
  if (!session || !isSingleTableSelect(sql)) return null;
  const refs = parseSqlReferences(sql);
  if (refs.length !== 1) return null;
  const match = findCachedMatch(session, refs);
  if (!match || match.kind === "view") return null;
  const conn = state.connections.find((c) => c.id === session.connId);
  if (conn && conn.allow_writes === false) return null;

  // Column metadata, memoised per table on the session so repeated renders
  // (tab switches, re-runs of the same statement) don't re-hit /columns.
  const tkey = `${match.database}.${match.schema}.${match.table}`;
  session._qcols = session._qcols || new Map();
  let info = session._qcols.get(tkey);
  if (!info) {
    try {
      info = await fetchTableColumns(session.connId, match);
    } catch {
      return null;
    }
    session._qcols.set(tkey, info);
  }
  const cols = info?.columns ?? [];
  if (!cols.length) return null;

  // Match identifiers case-insensitively so an upper/lower-case alias in the
  // SELECT still resolves to its base column.
  const byName = new Map(cols.map((c) => [String(c.name).toLowerCase(), c]));
  const pks = cols.filter((c) => c.is_primary).map((c) => c.name);
  if (pks.length === 0) return null;

  // Every PK must be projected so we can build a unique WHERE per row.
  const pkResultIdx = new Map();
  for (const pk of pks) {
    const ri = columns.findIndex((name) => String(name).toLowerCase() === pk.toLowerCase());
    if (ri < 0) return null;
    pkResultIdx.set(pk, ri);
  }

  // Map each result column that corresponds to a real, editable base column.
  const colByIdx = new Map();
  const editableColIdx = new Set();
  columns.forEach((name, ci) => {
    const colInfo = byName.get(String(name).toLowerCase());
    if (colInfo) {
      colByIdx.set(ci, colInfo);
      editableColIdx.add(ci);
    }
  });
  if (editableColIdx.size === 0) return null;

  return {
    connId: session.connId,
    database: match.database,
    schema: match.schema,
    table: match.table,
    pks,
    pkResultIdx,
    colByIdx,
    editableColIdx,
  };
}

/** True for a single-table `SELECT` whose rows map 1:1 to base-table rows.
 *  Comments + string literals are stripped first so keywords inside them
 *  don't trip the guards. Rejects joins (keyword + comma), set operations,
 *  GROUP BY / HAVING, and DISTINCT, which all break the row-to-row mapping
 *  inline editing relies on. */
function isSingleTableSelect(sql) {
  const clean = String(sql || "")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  if (!/^\s*select\b/i.test(clean)) return false;
  if (/\bjoin\b/i.test(clean)) return false;
  if (/\bgroup\s+by\b/i.test(clean)) return false;
  if (/\bhaving\b/i.test(clean)) return false;
  if (/\bdistinct\b/i.test(clean)) return false;
  if (/\b(union|intersect|except)\b/i.test(clean)) return false;
  // Comma (cross) join inside the FROM clause → more than one table.
  const from = /\bfrom\b([\s\S]*?)(\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|\bwindow\b|$)/i.exec(clean);
  if (from && from[1].includes(",")) return false;
  return true;
}

/**
 * Inline-edit a single cell of an editable query result. Mirrors the
 * table-browse path (beginCellEdit) but resolves table identity, PK values,
 * and column type from the editCtx + the backing result row rather than a
 * session.tableSnapshot. On success the new value is written back into the
 * row array so pagination / re-renders keep the edit.
 */
function beginQueryCellEdit(editCtx, row, colIdx, td) {
  const original = row[colIdx];
  if (isBytesCell(original)) {
    safeToast("Binary cells aren't editable inline yet.", "warning");
    return;
  }
  const colInfo = editCtx.colByIdx.get(colIdx);
  if (!colInfo) return;
  const colName = colInfo.name;
  const type = classifyColumnType(colInfo);
  const nullable = colInfo.nullable !== false;

  const revert = () => {
    td.replaceChildren(renderCellContent(original));
    setTooltipAttr(td, cellTooltip(original));
  };

  const commit = async (next) => {
    if (deepEqual(next, original)) {
      revert();
      return;
    }
    const pkMap = {};
    for (const pk of editCtx.pks) {
      pkMap[pk] = row[editCtx.pkResultIdx.get(pk)];
    }
    try {
      await fetchJson("/table-update", {
        method: "POST",
        body: {
          conn: editCtx.connId,
          database: editCtx.database,
          schema: editCtx.schema,
          table: editCtx.table,
          pk: pkMap,
          values: { [colName]: next },
        },
      });
      row[colIdx] = next;
      td.replaceChildren(renderCellContent(next));
      setTooltipAttr(td, cellTooltip(next));
      td.classList.add("tsql-cell-saved");
      setTimeout(() => td.classList.remove("tsql-cell-saved"), 800);
    } catch (err) {
      revert();
      safeToast(`Update failed: ${err?.message ?? err}`, "error");
    }
  };

  mountTypedEditor(td, { type, nullable, original, colInfo, commit, cancel: revert });
}

// ----------------------------- Editable table grid ---------------------------

/** Reflect the open table in the schema tree. Opening a table re-renders
 *  only the results pane, so we toggle `is-active` on the existing tree
 *  rows directly: clear any prior table/view highlight (and the query cue
 *  so browse and query never both light up a row), then mark the row for
 *  `session.activeTable`. Re-renders pick the state up via the `isActive`
 *  check in renderTableNode. */
function markActiveTableInTree(session) {
  if (!panelRoot) return;
  panelRoot
    .querySelectorAll(
      ".tsql-node-table > .tsql-tree-row.is-active, .tsql-node-view > .tsql-tree-row.is-active, .tsql-tree-row.is-target",
    )
    .forEach((r) => r.classList.remove("is-active", "is-target"));
  const t = session.activeTable;
  if (!t) return;
  session.tableHandles
    ?.get(tableHandleKey(t.database, t.schema, t.table))
    ?.row?.classList.add("is-active");
}

async function openTable(session, target, scrollIntoView = false) {
  session.activeTable = target;
  markActiveTableInTree(session);
  // Opening a table also sets the active database context, so a
  // subsequent free-form `SELECT * FROM …` in the query editor
  // resolves against the same DB the user just clicked into.
  session.currentDatabase = target.database;
  session.tableSnapshot = null;
  // Per-table grid state. Cleared on switch so the new table opens
  // unsorted with empty filter, rather than inheriting state from the
  // previous one (which would pass an order_by column that doesn't exist).
  session.orderBy = null;
  session.orderDir = "asc";
  session.gridSearch = "";
  session.gridSearchCol = "";
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
  if (session.orderBy) {
    body.order_by = session.orderBy;
    body.order_dir = session.orderDir === "desc" ? "desc" : "asc";
  }
  // Server-side search. The sidecar ORs the LIKE predicate across
  // either the single `search_column` (if set) or the full
  // `search_columns` list. We send the column list from the snapshot
  // so the helper doesn't need an extra introspection round-trip.
  const term = (session.gridSearch || "").trim();
  if (term) {
    body.search = term;
    if (session.gridSearchCol) {
      body.search_column = session.gridSearchCol;
    } else {
      const cols = session.tableSnapshot?.columns;
      if (Array.isArray(cols) && cols.length) body.search_columns = cols;
    }
  }
  try {
    // Client-side timing: /table-rows doesn't return elapsed_ms today,
    // so we measure round-trip locally. Captures network + decode, which
    // is the user-visible "how long did the table take to load" anyway.
    const startedAt = performance.now();
    const resp = await fetchJson("/table-rows", { method: "POST", body });
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    session.tableSnapshot = resp.result;
    if (session.tableSnapshot) session.tableSnapshot.elapsed_ms = elapsedMs;
    // Update the autocomplete cache with the columns we just learned.
    // Subsequent keystrokes in the query editor immediately see them.
    if (resp.result?.columns?.length) {
      const t = session.activeTable;
      const key = `${t.database}.${t.schema}.${t.table}`;
      const prev = session.schemaCache.get(key);
      session.schemaCache.set(key, {
        database: t.database,
        schema: t.schema,
        table: t.table,
        kind: prev?.kind ?? "table",
        columns: resp.result.columns.slice(),
      });
    }
    if (!panelRoot) return;
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) renderTableGrid(root, session);
  } catch (err) {
    safeToast(`Failed to load table: ${err?.message ?? err}`, "error");
  }
}

function renderTableGrid(container, session) {
  clearChildren(container);
  disposePreviewEditors();
  const snap = session.tableSnapshot;
  const target = session.activeTable;
  if (!snap) {
    container.appendChild(el("p", { class: "tsql-empty", text: "Loading…" }));
    return;
  }
  // Search + column filter run server-side: every change re-issues
  // `/table-rows` with the new predicate so the LIKE applies across
  // every row in the table, not just the loaded page. The keystroke
  // path is debounced (240 ms) so a fast typist doesn't fire one
  // request per character; the column dropdown reloads immediately
  // since users typically change it rarely. `total` returned by the
  // sidecar reflects the filter, which keeps the pager and "N rows"
  // header consistent.
  const { wrap: searchWrap } = makeSearchInput({
    placeholder: "Search rows…",
    ariaLabel: "Search rows",
    inputClass: "tsql-input tsql-grid-search",
    wrapClass: "tsql-search-wrap--grid",
    initialValue: session.gridSearch ?? "",
    onInput: (val) => {
      session.gridSearch = val;
      scheduleGridSearch(session);
    },
  });

  const colOptions = [
    { value: "", label: "All columns" },
    ...snap.columns.map((c) => ({ value: c, label: c })),
  ];
  const colSelect = select(colOptions, session.gridSearchCol ?? "", (val) => {
    session.gridSearchCol = val;
    loadTableRows(session, 0);
  });
  colSelect.classList.add("tsql-grid-colfilter");

  // HeidiSQL-style meta bar: title + row count + load duration on the
  // left, every filter / action on the right. Sticky to the top of the
  // results body so the controls follow the user when the table scrolls.
  const tableLabel =
    target.database === target.schema ? target.table : `${target.schema}.${target.table}`;
  const rowsLabel = snap.total != null
    ? `${snap.total.toLocaleString()} rows`
    : `${snap.rows.length.toLocaleString()} rows`;
  const elapsedLabel =
    typeof snap.elapsed_ms === "number" ? ` · ${snap.elapsed_ms} ms` : "";
  container.appendChild(
    el(
      "div",
      { class: "tsql-result-meta tsql-grid-meta tsql-meta--sticky" },
      el(
        "span",
        { class: "tsql-grid-meta-left" },
        el("span", { class: "tsql-table-title", text: tableLabel }),
        document.createTextNode(` · ${rowsLabel}${elapsedLabel}`),
      ),
      el(
        "span",
        { class: "tsql-grid-meta-right" },
        searchWrap,
        colSelect,
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
  for (const col of snap.columns) {
    const isSorted = session.orderBy === col;
    const dir = session.orderDir === "desc" ? "desc" : "asc";
    const th = el("th", {
      class: `tsql-grid-th${isSorted ? ` is-sort-${dir}` : ""}`,
      attrs: { title: `Sort by ${col}` },
    });
    th.appendChild(document.createTextNode(col));
    // Three-state cycle: unset -> asc -> desc -> unset. Triggers a
    // server reload so order_by applies across all pages, not just the
    // current snapshot.
    th.addEventListener("click", () => {
      if (session.orderBy === col) {
        if (session.orderDir === "asc") session.orderDir = "desc";
        else {
          session.orderBy = null;
          session.orderDir = "asc";
        }
      } else {
        session.orderBy = col;
        session.orderDir = "asc";
      }
      loadTableRows(session, 0);
    });
    const arrow = el("span", {
      class: "tsql-sort-arrow",
      text: isSorted ? (dir === "asc" ? "▲" : "▼") : "",
    });
    th.appendChild(arrow);
    headRow.appendChild(th);
  }
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
      setTooltipAttr(td, cellTooltip(cell));
      td.classList.add("tsql-cell-editable");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  container.appendChild(renderPager(session, snap));
}

// Debounce holder for the keystroke-driven grid search. Module-level
// because the search input is recreated on every render; the user's
// last keystroke wins per session.
const gridSearchTimers = new Map();
function scheduleGridSearch(session) {
  const prev = gridSearchTimers.get(session.connId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    gridSearchTimers.delete(session.connId);
    // Server-side search resets to page 0; the filtered total may be
    // smaller than the current page index pointed into.
    loadTableRows(session, 0).catch((err) =>
      ctx?.logger?.warn?.("grid search failed", err),
    );
  }, 240);
  gridSearchTimers.set(session.connId, t);
}

function rowActionsCell(session, rowIdx) {
  return el(
    "td",
    { class: "tsql-grid-actions-col" },
    rowActionBtn("Delete02Icon", "Delete row", () => deleteRowFromGrid(session, rowIdx), {
      danger: true,
    }),
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

/**
 * Map a `ColumnInfo` (from `/columns`) to one of the typed cell editor
 * widgets. Recognises:
 *   - boolean      → MySQL `tinyint(1)`, `bool`, `boolean`; PG `bool`
 *   - date         → `date`
 *   - time         → `time`, `timetz`
 *   - datetime     → MySQL `datetime` / `timestamp`; PG `timestamp(tz)`
 *   - integer      → `int*`, `smallint`, `tinyint`, `bigint`, `serial*`, `year`
 *   - number       → `float`, `double`, `real`, `decimal`, `numeric`, `money`
 *   - json         → `json`, `jsonb`
 *   - bytes        → `binary`, `varbinary`, `*blob*`, `bytea`
 *   - { kind: "enum", options } → MySQL `enum('a','b',...)`
 *   - text         → everything else (varchar, char, text, uuid, ...)
 *
 * Pass either the column info object or `null` when the type is unknown
 * (falls back to `"text"`).
 */
function classifyColumnType(colInfo) {
  const dt = String(colInfo?.data_type ?? "").toLowerCase();
  const ft = String(colInfo?.full_type ?? "").toLowerCase();
  if (!dt && !ft) return "text";
  if (dt === "bool" || dt === "boolean") return "boolean";
  // MySQL convention: TINYINT(1) is the canonical bool storage.
  if (dt === "tinyint" && /\btinyint\(1\)/.test(ft)) return "boolean";
  // ENUM('a','b','c') → dropdown sourced from the type spec.
  if (dt === "enum") {
    const m = ft.match(/^enum\((.+)\)$/);
    if (m) {
      const opts = [];
      const re = /'((?:[^']|'')*)'/g;
      let mm;
      while ((mm = re.exec(m[1])) !== null) opts.push(mm[1].replace(/''/g, "'"));
      if (opts.length) return { kind: "enum", options: opts };
    }
  }
  if (dt === "date") return "date";
  if (dt === "time" || dt === "timetz" || dt.startsWith("time without")) return "time";
  if (
    dt === "datetime" ||
    dt === "timestamp" ||
    dt === "timestamptz" ||
    dt.startsWith("timestamp ")
  ) {
    return "datetime";
  }
  if (/^(smallint|mediumint|int|integer|bigint|tinyint|int2|int4|int8|serial|smallserial|bigserial|year)$/.test(dt)) {
    return "integer";
  }
  if (/^(float|double|real|float4|float8|decimal|numeric|money)$/.test(dt)) {
    return "number";
  }
  if (/json/.test(dt)) return "json";
  if (/binary|blob|bytea/.test(dt)) return "bytes";
  return "text";
}

/** True iff the snapshot row value is a "binary chip" marker. */
function isBytesCell(value) {
  return value && typeof value === "object" && value.__type === "bytes";
}

/** Convert a server-side ISO timestamp to the format the matching HTML5
 *  input expects. `kind` is one of `"date" | "time" | "datetime"`. */
function isoToInputValue(kind, value) {
  if (value == null) return "";
  const s = String(value);
  if (kind === "date") return s.slice(0, 10);
  if (kind === "time") {
    // Accept "HH:MM:SS" or "HH:MM:SS.sss" or full ISO; trim to "HH:MM:SS".
    const m = s.match(/(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : s;
  }
  // datetime: drop any TZ suffix; datetime-local needs YYYY-MM-DDTHH:MM(:SS).
  const t = s.replace(/[zZ]$/, "").replace(/[+-]\d{2}:?\d{2}$/, "");
  // Convert "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS" for the input.
  return t.includes("T") ? t : t.replace(" ", "T");
}

/** Convert the value coming out of an HTML5 date/time/datetime input back
 *  to the canonical text the SQL backend accepts. The widget already yields
 *  that form (YYYY-MM-DD, HH:MM(:SS), YYYY-MM-DDTHH:MM(:SS)); only the empty
 *  field needs mapping to NULL. */
function inputValueToIso(value) {
  return value === "" ? null : value;
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
  // Bytes cells can't be edited inline. Bail with a hint so the user
  // doesn't end up with an empty text input that can never round-trip.
  if (isBytesCell(original)) {
    safeToast("Binary cells aren't editable inline yet.", "warning");
    return;
  }
  const col = snap.columns[colIdx];
  const colInfo = (session._pkCache?.columns ?? []).find((c) => c.name === col) ?? null;
  const type = classifyColumnType(colInfo);
  const nullable = colInfo ? colInfo.nullable !== false : true;

  const commitWith = async (next) => {
    if (deepEqual(next, original)) {
      td.replaceChildren(renderCellContent(original));
      setTooltipAttr(td, cellTooltip(original));
      return;
    }
    const pkMap = {};
    for (const pk of pks) {
      const idx = snap.columns.indexOf(pk);
      if (idx < 0) {
        safeToast(`Primary key ${pk} not in current grid; refresh first.`, "warning");
        td.replaceChildren(renderCellContent(original));
        setTooltipAttr(td, cellTooltip(original));
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
      setTooltipAttr(td, cellTooltip(next));
      td.classList.add("tsql-cell-saved");
      setTimeout(() => td.classList.remove("tsql-cell-saved"), 800);
    } catch (err) {
      td.replaceChildren(renderCellContent(original));
      setTooltipAttr(td, cellTooltip(original));
      safeToast(`Update failed: ${err?.message ?? err}`, "error");
    }
  };

  const cancel = () => {
    td.replaceChildren(renderCellContent(original));
    setTooltipAttr(td, cellTooltip(original));
  };

  // Typed widget creation + commit/cancel wiring is shared with the
  // editable query-result grid via mountTypedEditor.
  mountTypedEditor(td, { type, nullable, original, colInfo, commit: commitWith, cancel });
}

/**
 * Build, mount, focus, and wire the typed inline-edit widget for one grid
 * cell. Shared by the table-browse grid (beginCellEdit) and the editable
 * query-result grid (beginQueryCellEdit) so both use identical widgets and
 * keyboard behaviour. Storage-agnostic: the caller supplies `commit(next)`
 * and `cancel()`, which close over the cell + backing row.
 *
 * Recognises boolean / enum / date / time / datetime / integer / number /
 * json / text. Commits on Enter (Shift+Enter keeps newlines in the JSON
 * textarea), on blur, and on change for the dropdown widgets; cancels on
 * Escape. Number widgets get themed up/down steppers in place of the
 * OS-native spin buttons.
 */
function mountTypedEditor(td, { type, nullable, original, colInfo, commit, cancel }) {
  let editor;
  let resolveValue;
  let committedOnChange = false;

  const enumType =
    type && typeof type === "object" && type.kind === "enum" ? type : null;

  if (type === "boolean") {
    editor = el("select", { class: "tsql-input tsql-cell-input tsql-cell-input--bool" });
    const opts = [];
    if (nullable) opts.push({ value: "__null__", label: "(NULL)" });
    opts.push({ value: "true", label: "true" }, { value: "false", label: "false" });
    for (const o of opts) {
      const node = el("option", { attrs: { value: o.value }, text: o.label });
      editor.appendChild(node);
    }
    // Original may be `true` / `false` / `null` / `0` / `1`.
    const initial =
      original === null || original === undefined
        ? nullable
          ? "__null__"
          : "false"
        : original === true || original === 1 || original === "1"
          ? "true"
          : original === false || original === 0 || original === "0"
            ? "false"
            : nullable
              ? "__null__"
              : "false";
    editor.value = initial;
    resolveValue = () => {
      const v = editor.value;
      if (v === "__null__") return null;
      if (v === "true") {
        // MySQL TINYINT(1) round-trips through i64; send 1/0 so the
        // sqlx Number path binds an integer instead of a bool that the
        // driver might reject on a numeric column.
        const isTiny = String(colInfo?.data_type ?? "").toLowerCase() === "tinyint";
        return isTiny ? 1 : true;
      }
      const isTiny = String(colInfo?.data_type ?? "").toLowerCase() === "tinyint";
      return isTiny ? 0 : false;
    };
    // For dropdowns, commit on change so the user doesn't have to tab out.
    editor.addEventListener("change", () => {
      committedOnChange = true;
      commit(resolveValue());
    });
  } else if (enumType) {
    editor = el("select", { class: "tsql-input tsql-cell-input tsql-cell-input--enum" });
    if (nullable) {
      editor.appendChild(el("option", { attrs: { value: "__null__" }, text: "(NULL)" }));
    }
    for (const opt of enumType.options) {
      editor.appendChild(el("option", { attrs: { value: opt }, text: opt }));
    }
    editor.value = original == null ? (nullable ? "__null__" : enumType.options[0]) : String(original);
    resolveValue = () => {
      const v = editor.value;
      return v === "__null__" ? null : v;
    };
    editor.addEventListener("change", () => {
      committedOnChange = true;
      commit(resolveValue());
    });
  } else if (type === "date" || type === "time" || type === "datetime") {
    const htmlType =
      type === "date" ? "date" : type === "time" ? "time" : "datetime-local";
    editor = el("input", {
      class: `tsql-input tsql-cell-input tsql-cell-input--${type}`,
      attrs: { type: htmlType, step: type === "date" ? undefined : "1" },
    });
    editor.value = isoToInputValue(type, original);
    resolveValue = () => inputValueToIso(editor.value);
  } else if (type === "integer" || type === "number") {
    editor = el("input", {
      class: `tsql-input tsql-cell-input tsql-cell-input--${type}`,
      attrs: {
        type: "number",
        step: type === "integer" ? "1" : "any",
        inputmode: type === "integer" ? "numeric" : "decimal",
      },
    });
    editor.value = original == null ? "" : String(original);
    resolveValue = () => {
      if (editor.value === "") return null;
      const n = Number(editor.value);
      if (Number.isNaN(n)) return editor.value; // let server reject
      // Integer columns: keep precision by sending back as integer when it fits.
      if (type === "integer" && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
        return Math.trunc(n);
      }
      return n;
    };
  } else if (type === "json") {
    editor = el("textarea", {
      class: "tsql-input tsql-cell-input tsql-cell-input--json",
      attrs: { spellcheck: "false", rows: "3" },
    });
    editor.value =
      original == null ? "" : typeof original === "object" ? JSON.stringify(original, null, 2) : String(original);
    resolveValue = () => {
      if (editor.value === "") return null;
      // Try JSON; if invalid, surface the raw text so the server can
      // round-trip (sidecar binds JSON as text for non-JSON columns
      // already, so a syntactically invalid edit shows the SQL error).
      try {
        return JSON.parse(editor.value);
      } catch {
        return editor.value;
      }
    };
  } else {
    // text / fallback
    editor = el("input", { class: "tsql-input tsql-cell-input", attrs: { type: "text" } });
    editor.value =
      original == null ? "" : typeof original === "object" ? JSON.stringify(original) : String(original);
    resolveValue = () => {
      if (editor.value === "") return null;
      return editor.value;
    };
  }

  // Number inputs mount inside a stepper wrapper so the OS spin button is
  // replaced by themed up/down controls; every other widget mounts bare.
  const mountNode =
    editor.tagName === "INPUT" && editor.type === "number" ? makeNumberWrap(editor) : editor;

  clearChildren(td);
  td.appendChild(mountNode);
  if (typeof editor.focus === "function") editor.focus();
  if (typeof editor.select === "function" && editor.tagName !== "SELECT") {
    try {
      editor.select();
    } catch {
      // ignore (some input types don't support text selection)
    }
  }

  const blurCommit = () => {
    if (committedOnChange) return;
    committedOnChange = true;
    commit(resolveValue());
  };
  editor.addEventListener("blur", blurCommit);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // Allow newlines inside the JSON textarea on Shift+Enter; commit
      // on plain Enter for every other editor.
      if (editor.tagName === "TEXTAREA" && event.shiftKey) return;
      event.preventDefault();
      committedOnChange = true;
      commit(resolveValue());
    } else if (event.key === "Escape") {
      event.preventDefault();
      committedOnChange = true;
      cancel();
    }
  });
}

/**
 * Wrap a `<input type="number">` in a container with themed up/down stepper
 * buttons. The native WebView2 spin button renders light-on-dark and clashes
 * with the workbench chrome, so it's hidden in CSS and replaced here. Buttons
 * preventDefault on mousedown to keep focus on the input (so an inline cell
 * editor's blur-commit doesn't fire mid-step), step the value via the native
 * stepUp/stepDown, then dispatch `input` so any onInput listener stays in sync.
 */
function makeNumberWrap(editor) {
  const wrap = el("div", { class: "tsql-num" });
  wrap.appendChild(editor);
  const steps = el("div", { class: "tsql-num-steps" });
  const makeStep = (dir, iconName, label) => {
    const btn = el("button", {
      class: "tsql-num-step",
      attrs: { type: "button", tabindex: "-1", "aria-label": label },
    });
    appendIcon(btn, iconName, { size: 9, strokeWidth: 2.5 });
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      try {
        if (dir > 0) editor.stepUp();
        else editor.stepDown();
      } catch {
        // stepUp/stepDown throws when the field is empty / non-numeric;
        // seed a sensible first step instead.
        editor.value = dir > 0 ? "1" : "-1";
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
    });
    return btn;
  };
  steps.appendChild(makeStep(1, "ArrowUp01Icon", "Increment"));
  steps.appendChild(makeStep(-1, "ArrowDown01Icon", "Decrement"));
  wrap.appendChild(steps);
  return wrap;
}

/** Loose text → JS-value coercion for the legacy Insert dialog. The inline
 *  cell editor uses dedicated typed widgets and does NOT go through this
 *  path. Kept text-only because the Insert dialog still renders a flat
 *  `<input type="text">` per column. */
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

/** Fetch the `/columns` metadata (name, data_type, full_type, nullable,
 *  is_primary, ...) for a `{ database, schema, table }` target on a
 *  connection. The raw sidecar response (`{ columns: [...] }`). */
async function fetchTableColumns(connId, target) {
  return fetchJson(
    `/columns?conn=${encodeURIComponent(connId)}&database=${encodeURIComponent(target.database)}&schema=${encodeURIComponent(target.schema)}&table=${encodeURIComponent(target.table)}`,
  );
}

async function ensurePkColumns(session) {
  const t = session.activeTable;
  // Key by the fully-qualified identifier (matching schemaCache / _qcols) so
  // two same-named tables in different databases/schemas don't return each
  // other's PK + column metadata, which would build a wrong WHERE on edit.
  const key = `${t.database}.${t.schema}.${t.table}`;
  if (session._pkCache?.key === key) return session._pkCache.pks;
  const resp = await fetchTableColumns(session.connId, t);
  const pks = resp.columns.filter((c) => c.is_primary).map((c) => c.name);
  session._pkCache = { key, pks, columns: resp.columns };
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
  const pkSummary = pks.map((k) => `${k} = ${pkMap[k]}`).join(", ");
  const ok = await openConfirmDialog({
    title: "Delete row?",
    message: `This will delete the row where ${pkSummary}. This action can't be undone.`,
    confirmLabel: "Delete",
    destructive: true,
    cancelLabel: "Cancel",
  });
  if (!ok) return;
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
  if (containsDestructive(session.sql)) {
    const ok = await openConfirmDialog({
      title: "Run destructive statement?",
      message:
        "This query looks destructive (DROP / TRUNCATE / GRANT). Run it against the connected database?",
      confirmLabel: "Run",
      destructive: true,
    });
    if (!ok) return;
  }
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
        // Active database context tracked from the schema tree. Sidecar
        // runs USE <db> (MySQL) / SET search_path (Postgres) on a
        // pinned pool connection so unqualified table names resolve
        // even when the connection has no default_database pinned.
        database: session.currentDatabase ?? undefined,
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
      // Reflect the executed query in the tree the same way browsing does:
      // drop the now-stale browse highlight (activeTable is null here) and
      // mark the table the statement references via the SQL sync. Gives
      // query mode a clear "this is the table" cue instead of nothing.
      markActiveTableInTree(session);
      syncTreeToSql(session).catch((err) => ctx?.logger?.warn?.("tree sync failed", err));
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
  const ok = await openConfirmDialog({
    title: "Restart SQL sidecar?",
    message: "Active connections will be closed.",
    confirmLabel: "Restart",
  });
  if (!ok) return;
  try {
    if (sidecar?.handle != null) await ctx.invoke("shell_bg_kill", { handle: sidecar.handle });
  } catch {
    /* ignore */
  }
  sidecar = null;
  state.sessions = {};
  state.active = null;
  setTabState("disconnected");
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
.tsql-icon-btn { width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: var(--radius, 0); background: transparent; color: var(--muted-foreground); cursor: pointer; line-height: 1; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease; }
.tsql-icon-btn:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
.tsql-icon-btn:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }

/* Body is a flex row: resizable sidebar | drag splitter | editor+results.
   The sidebar holds the unified connection → database → schema → table tree
   and can be resized (splitter) or hidden (header toggle) so the workbench
   stays usable inside a narrow split pane. */
.tsql-body { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
.tsql-header-left { display: flex; align-items: center; gap: 2px; min-width: 0; }
.tsql-sidebar { flex: 0 0 var(--tsql-sidebar-w, 240px); width: var(--tsql-sidebar-w, 240px); display: flex; flex-direction: column; border-right: 1px solid var(--border); min-width: 0; min-height: 0; overflow: hidden; }
/* Horizontal (col-resize) splitter; mirrors .tsql-splitter chrome on the
   vertical axis (thin hairline + centred grip, primary tint on hover/drag). */
.tsql-hsplitter { position: relative; flex: 0 0 6px; cursor: col-resize; background: transparent; user-select: none; touch-action: none; outline: none; display: flex; align-items: center; justify-content: center; }
.tsql-hsplitter::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-50%); background: color-mix(in srgb, var(--border) 50%, transparent); transition: background 0.12s ease; }
.tsql-hsplitter::after { content: ""; position: relative; z-index: 1; width: 4px; height: 24px; background: var(--tedi-resize-handle, var(--border)); transition: background 0.12s ease; }
.tsql-hsplitter:hover::before, .tsql-hsplitter.is-dragging::before, .tsql-hsplitter:focus-visible::before { background: color-mix(in srgb, var(--primary, #3b82f6) 50%, transparent); }
.tsql-hsplitter:hover::after, .tsql-hsplitter.is-dragging::after, .tsql-hsplitter:focus-visible::after { background: var(--primary, #3b82f6); }
/* Connection root row: bolder label + a primary-tinted icon when active, and
   hover-revealed reload / edit / delete actions in the trailing grid cell. */
.tsql-conn-head .tsql-tree-label { font-weight: 600; }
.tsql-conn-head.is-active .tsql-tree-icon { color: var(--primary, #3b82f6); }
.tsql-tree-actions { display: inline-flex; align-items: center; gap: 1px; opacity: 0; transition: opacity 0.12s ease; }
.tsql-tree-row:hover .tsql-tree-actions, .tsql-tree-row:focus-within .tsql-tree-actions, .tsql-tree-row:focus-visible .tsql-tree-actions { opacity: 1; }
.tsql-row-action { width: 20px; height: 20px; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; border-radius: var(--radius, 0); display: inline-flex; align-items: center; justify-content: center; outline: none; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-row-action:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
/* Destructive variant for delete / trash row actions. Rest sits at the
   same muted neutral as the regular action so the row doesn't scream
   "danger" until the user actually targets it; on hover the bg lifts
   to a 10% --destructive tint and the icon shifts to --destructive,
   matching the host's pattern (text-muted-foreground
   hover:bg-destructive/10 hover:text-destructive) used in Settings,
   WorkspacesPanel, ExplorerGrep, SSH menu, etc. */
.tsql-row-action.is-danger:hover { background: color-mix(in srgb, var(--destructive, #ef4444) 12%, transparent); color: var(--destructive, #ef4444); }
.tsql-row-action.is-danger:focus-visible { color: var(--destructive, #ef4444); outline: 1px solid var(--destructive, #ef4444); outline-offset: -1px; }

/* Sticky head holds the sidebar search input. Pinning the wrapper (not the
   children individually) keeps the input's horizontal margin gutters opaque
   so rows scrolling under it don't show through. */
.tsql-tree-head { flex: 0 0 auto; background: var(--card, var(--background)); padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.tsql-tree-head .tsql-subheader { border-bottom: 0; }
.tsql-subheader { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; font-weight: 500; color: var(--muted-foreground); background: var(--card, var(--background)); gap: 8px; }
.tsql-tree-search { display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 4px 26px 4px 10px; border: 1px solid transparent; border-radius: var(--radius, 0); background: color-mix(in srgb, var(--input) 50%, transparent); color: var(--foreground); font-size: 11px; font-family: inherit; height: 28px; line-height: 1; outline: none; transition: border-color 0.12s ease, background-color 0.12s ease; }
.tsql-tree-search:hover { background: color-mix(in srgb, var(--input) 60%, transparent); }
.tsql-tree-search:focus, .tsql-tree-search:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); background: color-mix(in srgb, var(--input) 60%, transparent); box-shadow: none; }
.tsql-tree-search::placeholder { color: var(--muted-foreground); opacity: 0.7; }
/* Search input wrapper + HugeIcon clear (X) button. Replaces the native
   type=search browser X so it paints with the same currentColor + hover
   bg as the rest of the workbench icon row. The wrap is always
   position:relative so the absolutely-positioned X stays anchored
   to the input's right edge regardless of variant. */
.tsql-search-wrap { position: relative; display: block; box-sizing: border-box; }
.tsql-search-wrap--tree { width: calc(100% - 16px); margin: 6px 8px 0; }
/* Pane surface: no workbench header, so the sidebar head is a row holding the
   search box (grows) + the new-connection / restart actions on the right. */
.tsql-sidebar-head-row { display: flex; align-items: center; gap: 4px; padding: 6px 8px 0; }
.tsql-sidebar-head-row > .tsql-search-wrap--tree { width: auto; flex: 1 1 auto; margin: 0; }
.tsql-sidebar-head-row > .tsql-icon-btn { flex: 0 0 auto; width: 26px; height: 26px; }
.tsql-search-wrap--grid { display: inline-flex; align-items: center; width: 160px; vertical-align: middle; }
.tsql-search-wrap--grid > .tsql-input.tsql-grid-search { width: 100%; padding-right: 26px; }
.tsql-search-clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; padding: 0; margin: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; display: none; align-items: center; justify-content: center; border-radius: var(--radius, 0); box-sizing: border-box; flex: 0 0 auto; z-index: 1; outline: none; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-search-clear.is-visible { display: inline-flex; }
.tsql-search-clear:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
.tsql-search-clear > svg, .tsql-search-clear > * { display: block; flex: 0 0 auto; pointer-events: none; }
.tsql-tree-list { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; list-style: none; margin: 0; padding: 0 0 4px; min-height: 0; }
/* Nesting no longer indents via the list's left padding; instead each row
   carries a depth-based left padding (see .tsql-tree-row) so the row's
   full-width background (hover / active) reaches the pane's left edge
   while the label stays visually indented. */
.tsql-tree-children { list-style: none; margin: 0; padding: 0; }
.tsql-tree-node { padding: 0; }
.tsql-tree-row { width: 100%; display: grid; grid-template-columns: 14px 16px minmax(0, 1fr) auto; align-items: center; gap: 5px; padding: 4px 8px 4px calc(8px + var(--tsql-depth, 0) * 14px); background: transparent; border: 0; color: inherit; text-align: left; cursor: pointer; font-size: 12px; border-radius: var(--radius, 0); outline: none; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-tree-row:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.08))); }
.tsql-tree-row:focus-visible { background: var(--accent, rgba(127,127,127,0.12)); }
/* Open table / view: the one clear selection. A soft primary tint + a
   flush 2 px primary left bar (inset box-shadow so it merges with the
   tint instead of reading as a detached line) + bold label. Calm, not a
   saturated block. Scoped to table/view rows so it never stacks with the
   database highlight into one confusing two-row blob. */
.tsql-node-table > .tsql-tree-row.is-active,
.tsql-node-view > .tsql-tree-row.is-active {
  background: color-mix(in srgb, var(--primary, #3b82f6) 14%, transparent);
  color: var(--foreground);
  box-shadow: inset 2px 0 0 0 var(--primary, #3b82f6);
  border-radius: 0;
}
.tsql-node-table > .tsql-tree-row.is-active .tsql-tree-label,
.tsql-node-view > .tsql-tree-row.is-active .tsql-tree-label { font-weight: 600; }
.tsql-node-table > .tsql-tree-row.is-active .tsql-tree-icon,
.tsql-node-view > .tsql-tree-row.is-active .tsql-tree-icon,
.tsql-node-table > .tsql-tree-row.is-active .tsql-tree-meta,
.tsql-node-view > .tsql-tree-row.is-active .tsql-tree-meta { color: var(--foreground); }
/* Active (expanded / current) database stays quiet so it doesn't compete
   with the open table: no fill or bar, just a bold label and a
   primary-tinted caret + icon as a subtle "current context" cue. */
.tsql-node-db > .tsql-tree-row.is-active { color: var(--foreground); }
.tsql-node-db > .tsql-tree-row.is-active .tsql-tree-label { font-weight: 600; }
.tsql-node-db > .tsql-tree-row.is-active .tsql-caret,
.tsql-node-db > .tsql-tree-row.is-active .tsql-tree-icon { color: var(--primary, #3b82f6); }
/* Query cue: the table the running / typed statement references. Gives
   query mode the same clear "this is the table" indication as browsing a
   table (matching the open-table highlight: soft tint + flush left bar +
   bold) so the two modes feel consistent. A one-shot pulse on first match
   draws the eye and settles into the resting tint without flashing out. */
.tsql-tree-row.is-target { background: color-mix(in srgb, var(--primary, #3b82f6) 14%, transparent); color: var(--foreground); box-shadow: inset 2px 0 0 0 var(--primary, #3b82f6); border-radius: 0; animation: tsql-target-pulse 1.1s ease-out 1; }
.tsql-tree-row.is-target .tsql-tree-label { font-weight: 600; }
.tsql-tree-row.is-target .tsql-tree-icon, .tsql-tree-row.is-target .tsql-tree-meta { color: var(--foreground); }
@keyframes tsql-target-pulse {
  0%   { background: color-mix(in srgb, var(--primary, #3b82f6) 30%, transparent); }
  100% { background: color-mix(in srgb, var(--primary, #3b82f6) 14%, transparent); }
}
.tsql-caret { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); transition: transform 0.12s ease; }
.tsql-caret.is-open { transform: rotate(90deg); }
.tsql-caret-empty { visibility: hidden; }
.tsql-tree-icon { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); }
.tsql-tree-row:hover .tsql-tree-icon, .tsql-tree-row:hover .tsql-caret { color: var(--foreground); }
.tsql-tree-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tsql-tree-meta { font-size: 10px; color: var(--muted-foreground); padding-left: 8px; }
.tsql-tree-error { padding: 4px 12px 4px calc(12px + var(--tsql-depth, 0) * 14px); color: var(--destructive, #ef4444); font-size: 11px; }
.tsql-tree-empty { padding: 4px 16px 4px calc(16px + var(--tsql-depth, 0) * 14px); color: var(--muted-foreground); font-size: 11px; }

.tsql-main { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.tsql-main--empty { align-items: center; justify-content: center; }
.tsql-toolbar { display: flex; gap: 5px; padding: 4px 8px; background: var(--card, var(--background)); flex-wrap: wrap; align-items: center; flex: 0 0 auto; border-bottom: 1px solid var(--border); }
/* Buttons match the host's <Button variant="ghost"> chrome: 1 px
   transparent border at rest so the hover bg paints as a clean box
   without an outline ring, only --ring shows on focus-visible.
   .is-primary swaps to --primary/--primary-foreground for the Run
   action. Stays bg-transparent so the toolbar's card tint shows
   through; hover lifts to --muted. */
.tsql-btn { box-sizing: border-box; padding: 0 10px; height: 28px; border: 1px solid transparent; border-radius: var(--radius, 0); background: transparent; color: var(--foreground); cursor: pointer; font-size: 11px; font-family: inherit; font-weight: 500; display: inline-flex; align-items: center; gap: 5px; line-height: 1; outline: none; transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
.tsql-btn:hover:not([disabled]) { background: var(--muted, var(--accent, rgba(127,127,127,0.08))); color: var(--foreground); }
.tsql-btn:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }
.tsql-btn.is-disabled, .tsql-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.tsql-btn.is-primary { background: var(--primary, #3b82f6); color: var(--primary-foreground, #fff); border-color: transparent; }
.tsql-btn.is-primary:hover:not([disabled]) { background: color-mix(in srgb, var(--primary, #3b82f6) 80%, transparent); }
.tsql-btn.is-primary:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }
/* Destructive confirm button. Mirrors the host's
   AlertDialogAction variant=destructive chrome: filled red bg
   with white text at rest, slightly lifted on hover, --ring on focus. */
.tsql-btn.is-destructive { background: var(--destructive, #ef4444); color: var(--destructive-foreground, #fff); border-color: transparent; }
.tsql-btn.is-destructive:hover:not([disabled]) { background: color-mix(in srgb, var(--destructive, #ef4444) 85%, transparent); }
.tsql-btn.is-destructive:focus-visible { border-color: var(--ring, var(--destructive, #ef4444)); }

/* Code-editor container: hosts a CodeMirror EditorView mounted by
   ctx.ui.codeEditor. The .cm-editor inside fills the container. */
.tsql-editor { width: 100%; min-height: 64px; overflow: hidden; display: flex; flex-direction: column; flex: 0 0 var(--tsql-editor-h, 38%); }
.tsql-editor .cm-editor { height: 100%; flex: 1 1 auto; min-height: 0; }
.tsql-editor .cm-editor.cm-focused { outline: none; }
/* Vertical splitter between the query editor and the results pane.
   Drag handler in renderEditorAndResults updates --tsql-editor-h on
   the parent .tsql-main, which flex-basis: var(...) flows into.
   Mirrors the host PaneTreeView's resize chrome (bg-border/50,
   hover bg-primary/50 on the line; thicker centred grip in
   --tedi-resize-handle) so the SQL Explorer splitter looks and feels
   identical to the terminal/editor pane separators. Grip is the
   "thicker section" the user sees in the middle of pane splits:
   24x4 sharp rectangle (radius-lg=0 in TEDI). NB: comment lives in
   a JS template literal, so backticks are forbidden here. */
.tsql-splitter { position: relative; flex: 0 0 10px; cursor: ns-resize; background: transparent; user-select: none; touch-action: none; outline: none; display: flex; align-items: center; justify-content: center; }
.tsql-splitter::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-50%); background: color-mix(in srgb, var(--border) 50%, transparent); transition: background 0.12s ease; }
.tsql-splitter::after { content: ""; position: relative; z-index: 1; width: 24px; height: 4px; background: var(--tedi-resize-handle, var(--border)); transition: background 0.12s ease; }
.tsql-splitter:hover::before, .tsql-splitter.is-dragging::before, .tsql-splitter:focus-visible::before { background: color-mix(in srgb, var(--primary, #3b82f6) 50%, transparent); }
.tsql-splitter:hover::after, .tsql-splitter.is-dragging::after, .tsql-splitter:focus-visible::after { background: var(--primary, #3b82f6); }
.tsql-results { display: flex; flex-direction: column; min-height: 96px; overflow: hidden; flex: 1 1 auto; }
.tsql-result-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 8px; background: var(--card, var(--background)); flex: 0 0 auto; }
.tsql-result-tab { padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 11px; transition: color 0.12s ease, background 0.12s ease; }
.tsql-result-tab:hover { color: var(--foreground); }
.tsql-result-tab.is-active { color: var(--foreground); border-color: var(--primary, #3b82f6); background: var(--accent, rgba(127,127,127,0.08)); }
.tsql-result-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0; display: flex; flex-direction: column; }
.tsql-result-meta { padding: 4px 10px; color: var(--muted-foreground); font-size: 11px; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
/* Heidi-style result-grid toolbar: row-count + duration on the left,
   client-side search input + page navigation on the right. Wraps under
   the search on narrow widths so the controls never overlap.
   .tsql-meta--sticky pins the bar to the top of the scrolling result
   body so the user keeps the controls in view while scrolling. The
   1 px bottom divider matches the project's standard hairline. */
.tsql-grid-meta { justify-content: space-between; flex-wrap: wrap; gap: 5px 8px; padding: 4px 10px; row-gap: 4px; }
.tsql-grid-meta-left { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
.tsql-grid-meta-right { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.tsql-meta--sticky {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--card, var(--background));
  border-bottom: 1px solid var(--border);
}
/* Small status pill rendered alongside the row count (e.g. "truncated"
   when the sidecar capped the result). Borrow the host's --warning
   palette so it reads as a soft amber tag, not an error. */
.tsql-tag { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 500; line-height: 1.4; }
.tsql-tag--warn { background: color-mix(in srgb, var(--tedi-icon-working, #f59e0b) 18%, transparent); color: var(--tedi-icon-working, #f59e0b); }
/* SQL preview strip above the grid so the user always sees the
   statement that produced the displayed rows. Single line with
   ellipsis; the full SQL is in the title attribute. Used as the
   fallback when ctx.ui.codeEditor is unavailable. */
.tsql-sql-preview { padding: 2px 12px 6px 12px; color: var(--muted-foreground); font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
/* Read-only, syntax-highlighted preview of the executed statement. Sizes
   to its content (auto-height CodeMirror) and caps tall multi-statement
   SQL with an internal scroll; the 1 px bottom hairline separates it from
   the result grid below. */
.tsql-sql-editor { flex: 0 0 auto; max-height: 108px; overflow: auto; border-bottom: 1px solid var(--border); background: var(--background); }
.tsql-sql-editor .cm-editor { height: auto; }
.tsql-sql-editor .cm-content { padding: 6px 0; }
/* Divider between the meta/search toolbar and the sticky table header
   so the two sections read as distinct bands instead of bleeding into
   each other. Border-top is dropped here because .tsql-meta--sticky
   already paints the 1 px hairline on its bottom edge, keeping the
   divider consistent across both result and table grids. */
.tsql-grid-slot { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.tsql-grid-slot > .tsql-grid-wrap { flex: 1 1 auto; }

/* Result / table grid: sticky header with a single 1px bottom hairline,
   zebra rows, no horizontal overflow surprise. */
.tsql-grid-wrap { overflow: auto; flex: 1 1 auto; min-height: 0; }
.tsql-grid-wrap.is-editable { border-top: 0; }
.tsql-grid { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 11px; }
.tsql-grid thead th { position: sticky; top: 0; background: var(--card, var(--background)); border-bottom: 1px solid var(--border); padding: 4px 9px; text-align: left; font-weight: 600; color: var(--muted-foreground); white-space: nowrap; z-index: 1; user-select: none; }
/* Sortable header: click cycles unset -> asc -> desc -> unset. The
   arrow span sits at the end of the cell; empty text reserves nothing
   so unsorted headers stay flush. */
.tsql-grid thead th.tsql-grid-th { cursor: pointer; transition: color 0.12s ease, background 0.12s ease; }
.tsql-grid thead th.tsql-grid-th:hover { color: var(--foreground); background: color-mix(in srgb, var(--foreground) 6%, var(--card, var(--background))); }
.tsql-grid thead th.tsql-grid-th.is-sort-asc, .tsql-grid thead th.tsql-grid-th.is-sort-desc { color: var(--foreground); }
.tsql-sort-arrow { display: inline-block; margin-left: 6px; font-size: 9px; line-height: 1; color: var(--muted-foreground); }
.tsql-grid-th.is-sort-asc .tsql-sort-arrow, .tsql-grid-th.is-sort-desc .tsql-sort-arrow { color: var(--foreground); }
/* Toolbar search + column-filter controls. Sit ahead of the action
   buttons; widths are compact so the toolbar stays single-row on
   typical widths and wraps gracefully when narrow. The 28 px height
   matches the rest of the form chrome so search + filter + Row/Reload/
   Close buttons all sit on the same baseline. */
.tsql-input.tsql-grid-search { width: 100%; padding: 4px 26px 4px 10px; font-size: 11px; height: 28px; line-height: 1; box-sizing: border-box; }
.tsql-select.tsql-grid-colfilter { height: 28px; min-height: 28px; padding: 0 10px; font-size: 11px; max-width: 160px; min-width: 96px; }
.tsql-select.tsql-grid-colfilter .tsql-select-label { font-weight: normal; }
.tsql-grid tbody td { padding: 3px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
/* Zebra stripes use foreground tint at low alpha so dark/light themes
   both get a clean shade pair without leaning into any accent hue. */
.tsql-grid tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--foreground) 4%, transparent); }
.tsql-grid tbody tr:hover td { background: color-mix(in srgb, var(--foreground) 9%, transparent); }
.tsql-cell-null { color: var(--muted-foreground); font-style: italic; opacity: 0.7; }
/* Monochromatic table palette — no brand-blue accents inside the grid.
   Bool values use plain foreground weight; the cell-edit input uses the
   strongest neutral border so it still pops without introducing color. */
.tsql-cell-bool { color: var(--foreground); font-weight: 600; }
.tsql-cell-bytes { color: var(--muted-foreground); font-family: var(--font-mono, monospace); display: inline-flex; align-items: center; gap: 3px; }
.tsql-grid-actions-col { width: 30px; }
.tsql-cell-input { width: 100%; padding: 2px 6px; font-size: 11px; border: 1px solid var(--foreground); border-radius: 3px; background: var(--background); color: var(--foreground); font-family: inherit; outline: none; box-sizing: border-box; }
/* Typed cell editors: same chrome as the text input above, but with a
   couple of variant-specific tweaks. They all sit flush in the table cell
   so the row height stays consistent with the read-only grid. */
.tsql-cell-input.tsql-cell-input--bool,
.tsql-cell-input.tsql-cell-input--enum {
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--foreground) 50%), linear-gradient(135deg, var(--foreground) 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 7px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 22px;
  cursor: pointer;
}
.tsql-cell-input.tsql-cell-input--date,
.tsql-cell-input.tsql-cell-input--time,
.tsql-cell-input.tsql-cell-input--datetime { font-variant-numeric: tabular-nums; }
.tsql-cell-input.tsql-cell-input--number { text-align: right; font-variant-numeric: tabular-nums; }
.tsql-cell-input.tsql-cell-input--json { width: 100%; min-height: 60px; max-height: 180px; padding: 4px 8px; resize: vertical; font-family: var(--font-mono, ui-monospace, monospace); white-space: pre; }
/* Calendar / clock indicator inherits the host's foreground colour so it
   doesn't render as a bright OS-default white square on dark themes. */
.tsql-cell-input::-webkit-calendar-picker-indicator { filter: invert(0.55); cursor: pointer; }
.tsql-cell-saved { background: color-mix(in srgb, var(--tedi-diff-added, #22c55e) 22%, transparent) !important; transition: background 0.6s ease; }

.tsql-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 5px 10px; border-top: 1px solid var(--border); background: var(--card, var(--background)); flex-shrink: 0; }
.tsql-pager-label { font-size: 11px; color: var(--muted-foreground); min-width: 80px; text-align: center; }
.tsql-empty { padding: 18px 14px; color: var(--muted-foreground); font-size: 12px; text-align: center; }

/* Modal dialog - matches the host's AlertDialog/Dialog chrome: bg-popover,
   1 px border, host --radius corners, deep shadow. */
.tsql-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 2000; backdrop-filter: blur(2px); }
.tsql-dialog { background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); padding: 18px 20px; min-width: 340px; max-width: 92%; max-height: 92%; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.4); }
.tsql-dialog-title { margin: 0 0 14px; font-size: 13px; font-weight: 600; }

/* Connection editor - docked side panel anchored to the right of the
   workbench. No overlay backdrop (rail/tree stay interactive); the
   title bar is a drag handle. Mirrors the standalone Settings window:
   brand --primary accent outline + faded card-tinted header + host
   --radius corners. The border uses 'outline' + negative offset (not
   'border') so it survives WebView2 edge clipping on Windows resize,
   matching the trick '#settings-root' uses in globals.css. */
.tsql-conn-modal { position: absolute; display: flex; flex-direction: column; max-width: calc(100% - 32px); max-height: calc(100% - 32px); background: var(--background); color: var(--popover-foreground, var(--foreground)); border-radius: var(--radius, 0); outline: 1px solid var(--primary); outline-offset: -1px; box-shadow: 0 18px 40px rgba(0,0,0,0.32); overflow: hidden; }
.tsql-conn-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 44px; padding: 0 8px 0 14px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); background: color-mix(in srgb, var(--card, var(--background)) 60%, transparent); cursor: grab; user-select: none; touch-action: none; }
.tsql-conn-modal-header:active { cursor: grabbing; }
.tsql-conn-modal-title { font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--foreground); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsql-conn-modal-close { width: 24px; height: 24px; padding: 0; border: 1px solid transparent; background: transparent; color: var(--muted-foreground); border-radius: var(--radius, 0); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; outline: none; transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease; flex-shrink: 0; }
.tsql-conn-modal-close:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
.tsql-conn-modal-close:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }
.tsql-conn-modal-body { padding: 14px 16px 16px; overflow-y: auto; min-height: 0; }
.tsql-conn-modal-body .tsql-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
/* Inputs inside the connection modal scale up to 32 px so the form feels
   closer to the host's 36 px default without breaking the workbench's
   compact toolbar. */
.tsql-conn-modal-body .tsql-input, .tsql-conn-modal-body .tsql-select { height: 32px; min-height: 32px; padding: 4px 12px; font-size: 12px; }
.tsql-conn-modal-body .tsql-btn { height: 32px; padding: 0 14px; font-size: 12px; }
/* Compact confirm modal: title + single message line + actions. Mirrors
   the host's AlertDialog (default + outline buttons, no destructive red),
   so a "Delete connection?" prompt reads the same as the SSH manager. */
.tsql-dialog-confirm { min-width: 320px; max-width: 420px; padding: 18px 20px 16px; }
.tsql-dialog-confirm .tsql-dialog-title { margin-bottom: 8px; }
.tsql-dialog-message { margin: 0 0 16px; font-size: 12px; color: var(--muted-foreground); line-height: 1.45; }
.tsql-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px 14px; }
.tsql-field { display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: var(--muted-foreground); min-width: 0; }
.tsql-field.is-full { grid-column: 1 / -1; }
.tsql-label { font-size: 11px; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--foreground); }

/* Form chrome - mirrors the host's <Input> component (bg-input/50,
   transparent border at rest, --ring on focus, host --radius for
   corners). Compact 28 px height keeps the data-dense workbench
   readable; the connection editor scales them up to 32 px so the modal
   feels closer to the host's 36 px default. */
.tsql-input { box-sizing: border-box; padding: 4px 10px; height: 28px; border: 1px solid transparent; border-radius: var(--radius, 0); background: color-mix(in srgb, var(--input) 50%, transparent); color: var(--foreground); font-size: 12px; font-family: inherit; transition: border-color 0.12s ease, background-color 0.12s ease; outline: none; }
.tsql-input:hover { background: color-mix(in srgb, var(--input) 60%, transparent); }
.tsql-input:focus, .tsql-input:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); background: color-mix(in srgb, var(--input) 60%, transparent); box-shadow: none; }
.tsql-input::placeholder { color: var(--muted-foreground); opacity: 0.7; }
.tsql-input[aria-invalid="true"] { border-color: var(--destructive, #ef4444); }
.tsql-input[disabled] { opacity: 0.5; cursor: not-allowed; }
/* Custom dropdown trigger uses the same chrome as inputs so a row of
   [input] [select] reads as one component family. Popup menu is rendered
   into body with the host's --popover bg + 1 px ring + square corners. */
.tsql-select { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px; height: 28px; min-height: 28px; border: 1px solid transparent; border-radius: var(--radius, 0); background: color-mix(in srgb, var(--input) 50%, transparent); color: var(--foreground); font-size: 12px; font-family: inherit; cursor: pointer; transition: background-color 0.12s ease, border-color 0.12s ease; min-width: 0; outline: none; }
.tsql-select:hover { background: color-mix(in srgb, var(--input) 60%, transparent); }
.tsql-select:focus, .tsql-select:focus-visible, .tsql-select[aria-expanded="true"] { border-color: var(--ring, var(--primary, #3b82f6)); background: color-mix(in srgb, var(--input) 60%, transparent); box-shadow: none; }
.tsql-select-label { flex: 1 1 auto; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.tsql-select-caret { display: inline-flex; flex-shrink: 0; opacity: 0.7; color: currentColor; transition: transform 0.15s ease; }
.tsql-select[aria-expanded="true"] .tsql-select-caret { transform: rotate(180deg); }

.tsql-select-menu { list-style: none; margin: 0; padding: 6px; background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); box-shadow: 0 14px 32px rgba(0,0,0,0.22); max-height: 320px; overflow-y: auto; font-size: 12px; min-width: 180px; }
.tsql-select-item { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: var(--radius, 0); cursor: pointer; font-weight: 500; color: var(--foreground); user-select: none; transition: background 0.1s ease; }
.tsql-select-item:hover, .tsql-select-item:focus-visible { background: var(--accent, rgba(127,127,127,0.1)); color: var(--accent-foreground, var(--foreground)); outline: none; }
.tsql-select-item-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsql-select-item-check { margin-left: auto; flex-shrink: 0; color: var(--primary, #3b82f6); }
.tsql-select-item.is-selected { color: var(--foreground); font-weight: 600; }

.tsql-checkbox { width: 14px; height: 14px; cursor: pointer; }
.tsql-form-error { margin: 10px 0 0; min-height: 14px; font-size: 11px; color: var(--destructive, #ef4444); }
.tsql-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.tsql-table-title { font-weight: 600; color: var(--foreground); }
.tsql-error-line { color: var(--destructive, #ef4444); font-weight: 600; }
.tsql-error-text { padding: 10px 12px; background: color-mix(in srgb, var(--destructive, #ef4444) 8%, transparent); color: var(--destructive, #ef4444); font-family: var(--font-mono, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; }

/* Custom tooltip bubble. Mirrors the host's Radix TooltipContent: --popover
   surface, a 1 px foreground-tinted ring, soft shadow, 11 px text, and the
   same square corners as the rest of TEDI (host sets --radius-2xl: 0). Fades
   + zooms in like the host tooltip. position:fixed + JS-set left/top so it
   escapes the result grid's overflow:auto clipping. */
.tsql-tooltip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 4000;
  pointer-events: none;
  box-sizing: border-box;
  max-width: 20rem;
  padding: 6px 12px;
  border-radius: var(--radius, 0);
  background: var(--popover, var(--card, var(--background)));
  color: var(--popover-foreground, var(--foreground));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent), 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 11px;
  font-family: inherit;
  line-height: 1.375;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0;
  transform: scale(0.96);
  transform-origin: 50% 100%;
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.tsql-tooltip[data-side="bottom"] { transform-origin: 50% 0%; }
.tsql-tooltip.is-open { opacity: 1; transform: scale(1); }

/* Editable grid cell affordance: the spreadsheet "cell" cursor signals the
   double-click-to-edit behaviour without adding visual noise. */
.tsql-cell-editable { cursor: cell; }

/* "Editable" pill in the query-result meta bar, shown once a free-form
   result is recognised as a single-table SELECT that can be edited in place.
   Soft primary tint so it reads as an affordance, not a warning. */
.tsql-tag--edit {
  gap: 4px;
  background: color-mix(in srgb, var(--primary, #3b82f6) 14%, transparent);
  color: var(--primary, #3b82f6);
  cursor: default;
}
.tsql-tag--edit > svg, .tsql-tag--edit > * { display: block; }

/* Number inputs: the OS-native spin buttons render as a light-on-dark block
   in WebView2 (the host sets no color-scheme), clashing with the themed
   chrome. Hide them and supply our own stacked up/down steppers that paint
   with --muted-foreground + the standard hover lift, matching the icon-button
   chrome used across the workbench. */
.tsql-input[type="number"]::-webkit-outer-spin-button,
.tsql-input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; appearance: none; margin: 0; }
.tsql-input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
.tsql-num { position: relative; display: inline-flex; align-items: stretch; width: 100%; box-sizing: border-box; }
.tsql-num > .tsql-input { flex: 1 1 auto; width: 100%; padding-right: 22px; }
.tsql-num-steps { position: absolute; top: 1px; right: 1px; bottom: 1px; width: 18px; display: flex; flex-direction: column; border-radius: var(--radius, 0); overflow: hidden; pointer-events: none; }
.tsql-num-step { flex: 1 1 50%; min-height: 0; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; outline: none; pointer-events: auto; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-num-step:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.16))); color: var(--foreground); }
.tsql-num-step:active { background: var(--accent, rgba(127,127,127,0.24)); }
.tsql-num-step > svg, .tsql-num-step > * { display: block; pointer-events: none; }

/* Narrow-window adaptations. The connection rail collapses into a single
   compressed row above the workspace; the schema tree also gets tighter. */
/* Narrow-width tweaks. The sidebar is now resizable + collapsible, so the
   layout no longer needs grid-collapse breakpoints — only the result-grid
   toolbar controls shrink to keep the toolbar single-row. */
@media (max-width: 960px) {
  .tsql-input.tsql-grid-search { width: 140px; }
  .tsql-search-wrap--grid { width: 140px; }
  .tsql-select.tsql-grid-colfilter { max-width: 140px; min-width: 84px; }
}
@media (max-width: 540px) {
  .tsql-toolbar { padding: 5px 8px; gap: 4px; }
  .tsql-btn { padding: 4px 8px; }
  .tsql-search-wrap--grid { width: 120px; }
  .tsql-input.tsql-grid-search { width: 120px; }
  .tsql-select.tsql-grid-colfilter { max-width: 120px; min-width: 80px; }
}
@media (max-width: 420px) {
  .tsql-search-wrap--grid { width: 100%; }
  .tsql-input.tsql-grid-search { width: 100%; }
  .tsql-select.tsql-grid-colfilter { max-width: none; width: 100%; }
}
`;
