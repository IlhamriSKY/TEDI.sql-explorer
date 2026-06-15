// SQL Explorer — tree/connState: per-connection lifecycle status + its mapping
// to a sidebar row tone. Bundled into extension.js by build.mjs.
import { setTabState } from "../render.js";
import { connStatus, state } from "../runtime.js";
import { syncSidebarSection } from "./view.js";

/**
 * Record a connection's lifecycle status and reflect it in both the workbench
 * tab tone (when that connection is the active one) and the host-sidebar row.
 * Pass `null` to clear.
 * @param {string} id
 * @param {"connecting"|"reconnecting"|"connected"|"disconnected"|"error"|"idle"|null} st
 */
export function setConnState(id, st) {
  if (st == null || st === "idle") delete connStatus[id];
  else connStatus[id] = st;
  if (id === state.active) setTabState(st);
  syncSidebarSection();
}

/** Map a per-connection status to a host SidebarSection item tone. */
export function sidebarToneFor(id) {
  const s = connStatus[id];
  if (s === "connecting" || s === "reconnecting") return "connecting";
  if (s === "connected") return "connected";
  if (s === "error") return "error";
  return "default";
}
