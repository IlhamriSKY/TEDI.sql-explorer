// SQL Explorer — tree/menu: the right-click menu on a schema-tree node.
// Bundled into extension.js by build.mjs.
//
// The sidebar row itself only has room for a couple of hover buttons, but a
// database tree needs more than that: refresh one node instead of the whole
// tree, copy a qualified name, drop a SELECT skeleton into the editor, read the
// structure, and (on a writable connection) truncate or drop. Needs TEDI
// >= 0.4.9 for `SidebarSection.onItemContextMenu`; on older hosts the menu
// simply never opens and every action stays reachable elsewhere.

import { confirmAndDeleteConnection, ensureSession, openConnectionDialog } from "../connections.js";
import { openConfirmDialog } from "../dialogs.js";
import { copyToClipboard, openContextMenu, safeToast } from "../dom.js";
import { openStructureDialog } from "../gridedit.js";
import { rerenderMain } from "../render.js";
import { ctx, state } from "../runtime.js";
import { fetchJson } from "../sidecar.js";
import { isReadOnly, qualifiedTableName, sqlLanguageForSession } from "../sql.js";
import { nid, parseNid, treeChildren, treeExpanded } from "./data.js";

/** `openContextMenu` wants a mouse event; the host hands us a position. */
function eventAt(at) {
  return { preventDefault() {}, clientX: at.x, clientY: at.y };
}

/**
 * Forget one node's loaded children so it refetches. The section header's
 * Reload could only collapse the ENTIRE tree, which loses every expansion just
 * to see one new table.
 *
 * Re-expanding is what triggers the fetch, and `view` owns the spinner + the
 * load, so hand the toggle back to it rather than fetching here.
 */
export function refreshNode(id, view) {
  treeChildren.delete(id);
  if (!treeExpanded.has(id)) {
    view.render();
    return;
  }
  treeExpanded.delete(id);
  void view.toggle(id);
}

/**
 * Refresh whichever node holds this table's siblings. MySQL/SQLite hang tables
 * straight off the database node (the schema level is collapsed away), while
 * PostgreSQL hangs them off the schema node — so try the schema node and fall
 * back to the database one.
 */
function refreshTableParent(m, view) {
  const schemaId = nid("schema", m.connId, m.db, m.schema);
  const dbId = nid("db", m.connId, m.db);
  refreshNode(treeChildren.has(schemaId) ? schemaId : dbId, view);
}

/** Put `sql` in the query editor for the node's connection and show it. */
function loadIntoEditor(connId, sql, view) {
  state.active = connId;
  const session = ensureSession(connId);
  session.sql = sql;
  session.activeTable = null;
  session.result = null;
  view.openWorkbench();
  // The pane rebuild reads `session.sql`; the live handle covers the case
  // where the editor is already mounted and would otherwise keep its old text.
  state.editorHandle?.setValue?.(sql);
  rerenderMain();
}

/**
 * Run one statement against the NODE the user right-clicked. Truncate / Drop
 * have no dedicated endpoint — they are ordinary DDL through `/query`, so the
 * connection's allow_writes gates them exactly like typed SQL.
 *
 * The context comes from the node (`m.db` / `m.schema`), never from the
 * session: the session points at whatever table is open in the pane, which on
 * PostgreSQL selects which per-database pool runs this. Right-clicking a table
 * in a database you have not opened would otherwise send the DROP to a
 * different database than the one you clicked in.
 */
async function runDdl(m, sql) {
  const resp = await fetchJson("/query", {
    method: "POST",
    body: { conn: m.connId, sql, database: m.db, schema: m.schema },
  });
  const failed = (resp.statements ?? []).find((s) => s.kind === "error");
  if (failed) throw new Error(failed.error);
}

async function confirmAndRun(m, view, { verb, qualified, label, past, message }) {
  const sql = `${verb} ${qualified};`;
  const ok = await openConfirmDialog({
    title: `${label} ${m.table}?`,
    message,
    sql,
    language: sqlLanguageForSession({ connId: m.connId }),
    confirmLabel: label,
    destructive: true,
  });
  if (!ok) return;
  try {
    await runDdl(m, sql);
    safeToast(`${past} ${m.table}`, "success");
    // The open grid now points at a table that is empty or gone. Compare the
    // whole identity, not just the name: two databases can hold a `users`.
    const session = state.sessions[m.connId];
    const open = session?.activeTable;
    if (open && open.database === m.db && open.schema === m.schema && open.table === m.table) {
      session.activeTable = null;
      session.tableSnapshot = null;
      rerenderMain();
    }
    refreshTableParent(m, view);
  } catch (err) {
    safeToast(`${label} failed: ${err?.message ?? err}`, "error");
  }
}

function tableItems(m, view) {
  const qualified = qualifiedTableName(m.connId, { schema: m.schema, table: m.table });
  const items = [
    { label: "Open", icon: "TableIcon", onClick: () => void view.openTableNode(m) },
    {
      label: "Copy name",
      icon: "Copy01Icon",
      onClick: () => copyToClipboard(qualified, "Name copied"),
    },
    { separator: true },
    {
      label: "SELECT in editor",
      icon: "DocumentCodeIcon",
      onClick: () => loadIntoEditor(m.connId, `SELECT *\nFROM ${qualified}\nLIMIT 100;`, view),
    },
    {
      label: "Structure",
      icon: "ListTreeIcon",
      onClick: async () => {
        // Structure reads the OPEN table, so open it first.
        await view.openTableNode(m);
        const session = state.sessions[m.connId];
        if (session) void openStructureDialog(session);
      },
    },
  ];
  if (!isReadOnly(m.connId)) {
    items.push(
      { separator: true },
      {
        label: "Truncate table",
        icon: "EraserIcon",
        onClick: () =>
          void confirmAndRun(m, view, {
            verb: "TRUNCATE TABLE",
            qualified,
            label: "Truncate",
            past: "Truncated",
            message: "Every row is removed. This can't be undone.",
          }),
      },
      {
        label: "Drop table",
        icon: "lucide:Trash2",
        danger: true,
        onClick: () =>
          void confirmAndRun(m, view, {
            verb: "DROP TABLE",
            qualified,
            label: "Drop",
            past: "Dropped",
            message: "The table and all of its rows are removed. This can't be undone.",
          }),
      },
    );
  }
  return items;
}

function menuItemsFor(m, id, view) {
  if (m.kind === "conn") {
    const conn = state.connections.find((c) => c.id === m.connId);
    if (!conn) return null;
    return [
      { label: "Refresh", icon: "Refresh01Icon", onClick: () => refreshNode(id, view) },
      {
        // Same glyphs the connection ROW's hover actions use (tree/items.js),
        // so "rename this thing" is one pencil and "delete it" is one red trash
        // everywhere in TEDI - menu and row alike.
        label: "Edit connection",
        icon: "lucide:Pencil",
        onClick: () => void openConnectionDialog(conn),
      },
      { separator: true },
      {
        label: "Delete connection",
        icon: "lucide:Trash2",
        danger: true,
        onClick: () => void confirmAndDeleteConnection(conn),
      },
    ];
  }
  if (m.kind === "db" || m.kind === "schema") {
    // A `db` node has no schema of its own: MySQL treats the database AS the
    // schema, while on PostgreSQL it is the schema node that sets search_path.
    const scope = m.kind === "schema" ? m.schema : m.db;
    return [
      { label: "Refresh", icon: "Refresh01Icon", onClick: () => refreshNode(id, view) },
      {
        label: "Use for unqualified names",
        icon: "Database01Icon",
        onClick: () => {
          const session = ensureSession(m.connId);
          session.currentDatabase = m.db;
          session.currentSchema = scope;
          safeToast(`Unqualified names now resolve in ${scope}`, "info");
        },
      },
    ];
  }
  if (m.kind === "table") return tableItems(m, view);
  return null;
}

/**
 * Open the right-click menu for tree node `id`. `view` carries the three
 * callbacks tree/view owns (re-render the section, toggle a node, open a
 * table), so this module never reaches into the view's internals.
 */
export function openTreeContextMenu(id, at, view) {
  const m = parseNid(id);
  const items = menuItemsFor(m, id, view);
  if (!items) return;
  try {
    openContextMenu(eventAt(at), items);
  } catch (err) {
    ctx?.logger?.warn?.("tree context menu failed", err);
  }
}
