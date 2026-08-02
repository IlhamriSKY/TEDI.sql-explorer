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


import { loadSavedConnections, refreshSavedConnections } from "./connections.js";
import { closeOpenDialogs, disposePreviewEditors } from "./dialogs.js";
import { initTooltipLayer, safeToast, setTooltipLayer, tooltipLayer } from "./dom.js";
import { runActiveQuery } from "./query.js";
import { disposeActionSqlEditor, renderPanel, rerender, setTabState } from "./render.js";
import { CMD_RUN, CMD_TOGGLE, PANEL_ID, SIDEBAR_SECTION_ID, ctx, setCtx, setPanelRoot, state } from "./runtime.js";
import {
  clearPublishedEndpoint,
  ensureSidecar,
  fetchJson,
  setSidecar,
  sidecar,
} from "./sidecar.js";
import { injectStyles } from "./styles.js";
import { openWorkbenchTab, syncSidebarSection } from "./tree.js";


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
  setCtx(context);
  const missing = checkRequiredApis(ctx);
  if (missing.length) {
    const msg = `SQL Explorer needs a newer TEDI (missing: ${missing.join(", ")}).`;
    ctx?.logger?.warn?.(msg);
    safeToast(msg, "warning");
    return;
  }
  injectStyles();
  await loadSavedConnections();
  // Publish the connection list into the host's left sidebar as a
  // Workspaces-styled section. The section exists only while this extension
  // is active, so it appears/disappears with enable/disable.
  syncSidebarSection();

  ctx.registerCommandHandler(CMD_TOGGLE, () => openWorkbenchTab());

  // No header-bar button: connections + opening live entirely in the left
  // "Databases" sidebar now, so a top-bar SQL icon would be redundant. The
  // Mod+Alt+D command still opens/focuses the workbench.

  ctx.registerCommandHandler(CMD_RUN, () => {
    runActiveQuery().catch((err) => ctx?.logger?.error?.("run failed", err));
  });

  const disposeRenderer = ctx.registerPanelRenderer(PANEL_ID, (container, paneCtx) => {
    setPanelRoot(container);
    // "tab" (workspace tab) or "pane" (split-pane leaf). In a pane the host
    // frame already supplies a header (title + drag + close), so the workbench
    // sits flush inside the pane frame (.tsql-host--pane).
    const surfaceMode = paneCtx?.surface === "pane" ? "pane" : "tab";
    container.replaceChildren();
    container.classList.add("tsql-host");
    container.classList.toggle("tsql-host--pane", surfaceMode === "pane");
    // Delegated styled-tooltip controller for the whole panel subtree
    // (survives the frequent clearChildren-based rerenders since it binds
    // to the persistent container, not its children).
    tooltipLayer?.dispose();
    setTooltipLayer(initTooltipLayer(container));
    renderPanel(container);
    // Pick up connections the OTHER window saved. Floating the workbench runs a
    // second copy of this extension, so on dock-back this one's list can be
    // behind. Guarded against clobbering our own unsaved writes.
    void refreshSavedConnections().then((changed) => {
      if (!changed) return;
      syncSidebarSection();
      rerender();
    });
    // Boot the sidecar lazily on first panel mount. If it later dies, fetchJson
    // detects the dropped connection and re-boots it automatically.
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
      disposeActionSqlEditor();
      closeOpenDialogs();
      tooltipLayer?.dispose();
      setTooltipLayer(null);
      setPanelRoot(null);
    };
  });
  ctx.addDisposer(disposeRenderer);
}

export async function deactivate() {
  try {
    setTabState(null);
    try {
      ctx?.sidebar?.removeSection?.(SIDEBAR_SECTION_ID);
    } catch {
      // ignore — host clears the registry slice on deactivate anyway
    }
    if (state.editorHandle?.dispose) {
      try {
        state.editorHandle.dispose();
      } catch {
        // ignore
      }
      state.editorHandle = null;
    }
    disposePreviewEditors();
    disposeActionSqlEditor();
    closeOpenDialogs();
    tooltipLayer?.dispose();
    setTooltipLayer(null);
    if (sidecar?.baseUrl) {
      await fetchJson("/shutdown", { method: "POST", body: {} }).catch(() => {});
    }
    if (sidecar?.handle != null) {
      await ctx.invoke("shell_bg_kill", { handle: sidecar.handle }).catch(() => {});
    }
    // Drop the published endpoint too, so the next window probes a dead port
    // once instead of adopting a helper that is being shut down.
    await clearPublishedEndpoint();
  } finally {
    setSidecar(null);
    setPanelRoot(null);
    setCtx(null);
  }
}

function checkRequiredApis(c) {
  const missing = [];
  if (typeof c?.invoke !== "function") missing.push("ctx.invoke");
  if (typeof c?.os?.platform !== "string") missing.push("ctx.os.platform");
  if (typeof c?.installPath !== "string") missing.push("ctx.installPath");
  if (typeof c?.registerPanelRenderer !== "function") missing.push("ctx.registerPanelRenderer");
  if (typeof c?.tabs?.openExtensionTab !== "function") missing.push("ctx.tabs.openExtensionTab");
  if (typeof c?.ui?.codeEditor !== "function") missing.push("ctx.ui.codeEditor");
  if (typeof c?.secrets?.set !== "function") missing.push("ctx.secrets");
  if (typeof c?.settings?.set !== "function") missing.push("ctx.settings");
  return missing;
}
