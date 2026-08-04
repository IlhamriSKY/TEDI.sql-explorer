// SQL Explorer — tree/view: publish the sidebar section + handle clicks/toggles
// + open the workbench on a connection or table. Bundled by build.mjs.
import {
  confirmAndDeleteConnection,
  ensureSession,
  openConnectionDialog,
  openExportConnectionsDialog,
  openImportConnectionsDialog,
  selectConnection,
} from "../connections.js";
import { safeToast } from "../dom.js";
import { openTable } from "../grid.js";
import { PANEL_ID, SIDEBAR_SECTION_ID, ctx, state } from "../runtime.js";
import { setConnState } from "./connState.js";
import {
  ensureConnected,
  parseNid,
  treeChildren,
  treeExpanded,
  treeLoadDatabases,
  treeLoadDbChildren,
  treeLoadTables,
  treeLoadingNodes,
} from "./data.js";
import { buildTreeItems } from "./items.js";
import { openTreeContextMenu } from "./menu.js";

/**
 * Publish the connection/schema tree into the host's left "Databases" sidebar
 * (`ctx.sidebar.setSection`). Re-called on every mutation / expand / status
 * change so rows, active highlight, and tone stay live. No-op on hosts that
 * predate the `ctx.sidebar` API.
 */
export function syncSidebarSection() {
  if (typeof ctx?.sidebar?.setSection !== "function") return;
  try {
    ctx.sidebar.setSection({
      id: SIDEBAR_SECTION_ID,
      title: "Databases",
      icon: "lucide:Database",
      headerActions: [
        { id: "add", icon: "lucide:Plus", tooltip: "New connection" },
        // Download = bring a file IN, Upload = send one OUT. Same pairing (and
        // same glyphs) as the SSH manager and the API Client sidebar.
        { id: "import", icon: "lucide:Download", tooltip: "Import connections (.tedi-sql)" },
        { id: "export", icon: "lucide:Upload", tooltip: "Export connections (.tedi-sql)" },
        { id: "refresh", icon: "lucide:RefreshCw", tooltip: "Reload tree" },
      ],
      items: buildTreeItems(),
      emptyText: "No connections yet. Click + to add one.",
      searchable: true,
      searchPlaceholder: "Search connections, tables…",
      // Offer the Source-Control-style "move to right panel" toggle + a
      // status-bar icon to reopen it there.
      movableToRight: true,
      onHeaderAction: (a) => {
        if (a === "add") void openConnectionDialog();
        else if (a === "import") void openImportConnectionsDialog(reloadTree);
        else if (a === "export") void openExportConnectionsDialog();
        else if (a === "refresh") reloadTree();
      },
      onItemClick: (id) => onTreeClick(id),
      onItemToggle: (id) => void onTreeToggle(id),
      // Per-node right-click menu (refresh one node, copy name, SELECT
      // template, structure, truncate / drop). No-op on hosts that predate
      // `onItemContextMenu`; they just show the native menu.
      onItemContextMenu: (id, at) =>
        openTreeContextMenu(id, at, {
          render: syncSidebarSection,
          toggle: onTreeToggle,
          openTableNode: openTableFromTree,
          openWorkbench: openWorkbenchTab,
        }),
      onItemAction: (id, action) => {
        const conn = state.connections.find((c) => c.id === parseNid(id).connId);
        if (!conn) return;
        if (action === "edit") void openConnectionDialog(conn);
        else if (action === "delete") void confirmAndDeleteConnection(conn);
      },
    });
  } catch (err) {
    ctx?.logger?.warn?.("sidebar section sync failed", err);
  }
}

/** Forget all loaded children + collapse everything (so newly-created
 *  databases/tables show on the next expand). */
function reloadTree() {
  treeExpanded.clear();
  treeLoadingNodes.clear();
  treeChildren.clear();
  syncSidebarSection();
}

function onTreeClick(id) {
  const m = parseNid(id);
  if (m.kind === "conn") {
    openConnection(m.connId);
    if (!treeExpanded.has(id)) void onTreeToggle(id);
  } else if (m.kind === "db" || m.kind === "schema") {
    void onTreeToggle(id);
  } else if (m.kind === "table") {
    void openTableFromTree(m);
  }
}

async function onTreeToggle(id) {
  if (treeExpanded.has(id)) {
    treeExpanded.delete(id);
    syncSidebarSection();
    return;
  }
  treeExpanded.add(id);
  if (treeChildren.has(id)) {
    syncSidebarSection();
    return;
  }
  const m = parseNid(id);
  treeLoadingNodes.add(id);
  syncSidebarSection();
  try {
    let kids = [];
    if (m.kind === "conn") {
      await ensureConnected(m.connId);
      kids = await treeLoadDatabases(m.connId);
    } else if (m.kind === "db") {
      kids = await treeLoadDbChildren(m.connId, m.db);
    } else if (m.kind === "schema") {
      kids = await treeLoadTables(m.connId, m.db, m.schema);
    }
    treeChildren.set(id, kids);
  } catch (err) {
    treeExpanded.delete(id);
    // connectWithRetry already toasts + reddens on connect failure (err.handled).
    if (!err?.handled) safeToast(`Load failed: ${err?.message ?? err}`, "error");
  } finally {
    treeLoadingNodes.delete(id);
    syncSidebarSection();
  }
}

/**
 * Open (or focus) the SQL Explorer as a NATIVE pane leaf (same frame as the
 * editor/terminal/browser — drag/icon/title/close, splittable). Falls back to a
 * standalone tab on hosts that predate `ctx.tabs.openExtensionPane`.
 */
export function openWorkbenchTab() {
  try {
    const tabs = ctx?.tabs;
    const opts = {
      panelId: PANEL_ID,
      title: "SQL Explorer",
      icon: "lucide:Database",
      reuseKey: "main",
    };
    if (typeof tabs?.openExtensionPane === "function") tabs.openExtensionPane(opts);
    else if (typeof tabs?.openExtensionTab === "function") tabs.openExtensionTab(opts);
  } catch (err) {
    ctx?.logger?.error?.("open workbench failed", err);
  }
}

/** Activate a connection in the pane (and open/focus the pane). */
function openConnection(connId) {
  state.active = connId;
  openWorkbenchTab();
  selectConnection(connId).catch((err) => {
    if (err?.handled) return; // already surfaced by connectWithRetry
    safeToast(`Connect failed: ${err?.message ?? err}`, "error");
    setConnState(connId, "error");
  });
}

/** Click a table leaf in the host sidebar: focus the pane on that table. */
async function openTableFromTree(m) {
  state.active = m.connId;
  openWorkbenchTab();
  try {
    await ensureConnected(m.connId);
  } catch (err) {
    if (!err?.handled) {
      safeToast(`Connect failed: ${err?.message ?? err}`, "error");
      setConnState(m.connId, "error");
    }
    return;
  }
  setConnState(m.connId, "connected");
  const session = ensureSession(m.connId);
  await openTable(session, {
    database: m.db,
    schema: m.schema,
    table: m.table,
    kind: m.tableKind || "table",
  });
  syncSidebarSection();
}
