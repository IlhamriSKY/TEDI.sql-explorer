// SQL Explorer — render/tabState: the pane tab title + lifecycle tone.
// Bundled into extension.js by build.mjs.
import { PANEL_ID, ctx, state } from "../runtime.js";

/** Label for the pane tab/header: "SQL Explorer · <db>[.<table>]" so it shows
 *  which database (and table) is open — like the title-bar "workspace · …". */
function currentPaneTitle() {
  const id = state.active;
  if (!id) return "SQL Explorer";
  const conn = state.connections.find((c) => c.id === id);
  const session = state.sessions[id];
  let detail = "";
  if (session?.activeTable) {
    const at = session.activeTable;
    detail = at.database ? `${at.database}.${at.table}` : at.table;
  } else {
    detail = session?.currentDatabase || conn?.database || conn?.name || "";
  }
  return detail ? `SQL Explorer · ${detail}` : "SQL Explorer";
}

/**
 * Tints the workspace tab title with a lifecycle tone matching the SSH
 * palette: yellow while connecting, green when connected, red on
 * disconnect/error. Safe no-op on older hosts that predate the API.
 *
 * @param {"idle"|"connecting"|"reconnecting"|"connected"|"disconnected"|"error"|null} state
 */
export function setTabState(state) {
  try {
    ctx?.tabs?.setExtensionTabState?.({
      panelId: PANEL_ID,
      reuseKey: "main",
      state,
      title: currentPaneTitle(),
    });
  } catch (err) {
    ctx?.logger?.warn?.("setExtensionTabState failed", err);
  }
}
