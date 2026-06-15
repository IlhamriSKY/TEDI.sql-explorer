// SQL Explorer — tree module. Bundled into extension.js by build.mjs.
import { confirmAndDeleteConnection, connectWithRetry, ensureSession, openConnectionDialog, selectConnection } from "./connections.js";
import { appendIcon, el, safeToast } from "./dom.js";
import { openTable } from "./grid.js";
import { setTabState } from "./render.js";
import { PANEL_ID, SIDEBAR_SECTION_ID, connStatus, ctx, state } from "./runtime.js";
import { ensureSidecar, fetchJson } from "./sidecar.js";


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

// ----------------------------- Host-sidebar tree -----------------------------
// The connection list AND schema navigation live in TEDI's left "Databases"
// sidebar as a lazy tree (connection → database → [schema] → table), fed via
// `ctx.sidebar.setSection`. The pane itself is just the query editor + table —
// it has no internal tree, so it reads as a native pane (like the editor pane,
// whose tree is the host File Explorer).

const TREE_SEP = ""; // unit separator; never appears in real identifiers
/** Expanded node ids. */
const treeExpanded = new Set();
/** Node ids currently loading their children. */
const treeLoadingNodes = new Set();
/** Loaded children per node id: [{ kind:"db"|"schema"|"table", name, tableKind? }]. */
const treeChildren = new Map();

function nid(kind, connId, db, schema, table) {
  return [kind, connId, db ?? "", schema ?? "", table ?? ""].join(TREE_SEP);
}
function parseNid(id) {
  const [kind, connId, db, schema, table] = id.split(TREE_SEP);
  return { kind, connId, db, schema, table };
}

// --- tree data fetchers (data only; reuse the sidecar endpoints) -------------

/** Open a connection's sidecar pool if it isn't already, WITHOUT stealing the
 *  pane's active session. Needed before listing its databases/tables. */
async function ensureConnected(connId) {
  await ensureSidecar();
  const conn = state.connections.find((c) => c.id === connId);
  if (!conn) throw new Error("connection not found");
  const conns = await fetchJson("/connections").catch(() => null);
  const open = conns?.connections?.some((c) => c.id === connId);
  if (!open) await connectWithRetry(connId);
  ensureSession(connId);
}

async function treeLoadDatabases(connId) {
  const resp = await fetchJson(`/databases?conn=${encodeURIComponent(connId)}`);
  const pinned = (state.connections.find((c) => c.id === connId) || {}).database;
  const dbs = pinned ? resp.databases.filter((d) => d.name === pinned) : resp.databases;
  return dbs.map((d) => ({ kind: "db", name: d.name }));
}

/** A database's children: schemas, or — when the engine exposes a single schema
 *  named like the DB (MySQL/SQLite) — the tables directly (schema collapsed). */
async function treeLoadDbChildren(connId, db) {
  const resp = await fetchJson(
    `/schemas?conn=${encodeURIComponent(connId)}&database=${encodeURIComponent(db)}`,
  );
  if (resp.schemas.length === 1 && resp.schemas[0].name === db) {
    return treeLoadTables(connId, db, db);
  }
  return resp.schemas.map((s) => ({ kind: "schema", name: s.name }));
}

async function treeLoadTables(connId, db, schema) {
  const resp = await fetchJson(
    `/tables?conn=${encodeURIComponent(connId)}&database=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}`,
  );
  // Seed the autocomplete cache with table identities (columns fill in lazily
  // when the table grid opens).
  const session = state.sessions[connId];
  if (session?.schemaCache) {
    for (const t of resp.tables) {
      const key = `${db}.${schema}.${t.name}`;
      const prev = session.schemaCache.get(key);
      session.schemaCache.set(key, {
        database: db,
        schema,
        table: t.name,
        kind: t.kind,
        columns: prev?.columns ?? [],
      });
    }
  }
  return resp.tables.map((t) => ({ kind: "table", name: t.name, tableKind: t.kind, schema }));
}

// --- tree → host SidebarSection items ----------------------------------------

function buildTreeItems() {
  return state.connections.map((c) => {
    const id = nid("conn", c.id);
    const item = {
      id,
      label: c.name || c.id,
      sublabel: connSubtitle(c),
      // Catppuccin pack (same as the file tree): a "database folder" for the
      // connection, plain database / folder / table glyphs for its children.
      icon: "fileicon:folder-database",
      // Engine-type tag next to the connection name (MySQL / PostgreSQL /
      // SQLite). Uses the host <Badge> "secondary" look for app-wide parity.
      badge: { text: KIND_LABEL[c.kind] || String(c.kind || "SQL"), variant: "secondary" },
      active: state.active === c.id,
      tone: sidebarToneFor(c.id),
      expandable: true,
      expanded: treeExpanded.has(id),
      loading: treeLoadingNodes.has(id),
      actions: [
        { id: "edit", icon: "hugeicon:PencilEdit01Icon", tooltip: "Edit connection" },
        { id: "delete", icon: "hugeicon:Delete02Icon", tooltip: "Delete connection", danger: true },
      ],
    };
    if (item.expanded) item.children = treeChildItems(id, c.id);
    return item;
  });
}

function treeChildItems(parentId, connId) {
  const kids = treeChildren.get(parentId);
  if (!kids || kids.length === 0) return [];
  const parent = parseNid(parentId);
  return kids.map((k) => {
    if (k.kind === "db") {
      const id = nid("db", connId, k.name);
      const item = {
        id,
        label: k.name,
        icon: "fileicon:database",
        expandable: true,
        expanded: treeExpanded.has(id),
        loading: treeLoadingNodes.has(id),
      };
      if (item.expanded) item.children = treeChildItems(id, connId);
      return item;
    }
    if (k.kind === "schema") {
      const id = nid("schema", connId, parent.db, k.name);
      const item = {
        id,
        label: k.name,
        icon: "fileicon:folder",
        expandable: true,
        expanded: treeExpanded.has(id),
        loading: treeLoadingNodes.has(id),
      };
      if (item.expanded) item.children = treeChildItems(id, connId);
      return item;
    }
    // table leaf — db comes from the parent (db or schema node), schema from
    // the descriptor (equals the db name when the schema level was collapsed).
    const db = parent.db;
    const schema = k.schema ?? parent.schema ?? db;
    const id = nid("table", connId, db, schema, k.name);
    const at = state.active === connId ? state.sessions[connId]?.activeTable : null;
    const isActive = !!at && at.database === db && at.schema === schema && at.table === k.name;
    return {
      id,
      label: k.name,
      // No dedicated table/view glyph in the Catppuccin pack; `csv` is its
      // tabular-data icon and reads as a table/grid at the leaf level.
      icon: "fileicon:csv",
      active: isActive,
    };
  });
}

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
      icon: "hugeicon:Database01Icon",
      headerActions: [
        { id: "add", icon: "hugeicon:Add01Icon", tooltip: "New connection" },
        { id: "refresh", icon: "hugeicon:Refresh01Icon", tooltip: "Reload tree" },
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
        else if (a === "refresh") reloadTree();
      },
      onItemClick: (id) => onTreeClick(id),
      onItemToggle: (id) => void onTreeToggle(id),
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
      icon: "hugeicon:Database01Icon",
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

// ----------------------------- Left sidebar (unified tree) -------------------
// One tree: each saved connection is a root node that expands to its
// databases → schemas → tables. A single search box filters every level.


/** Display name shown for each backend kind in the rail subtitle and as
 *  the engine dropdown label. We intentionally do not ship brand marks
 *  here — the rail and the engine select stay text-only so the workbench
 *  reads as part of TEDI's chrome instead of a third-party panel. */
const KIND_LABEL = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

export function rowActionBtn(iconName, title, onClick, opts = {}) {
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





function connSubtitle(c) {
  const kind = KIND_LABEL[c.kind] || c.kind;
  if (c.kind === "sqlite")
    return `${kind} · ${c.sqlitePath || c.host || c.database || "file"}`;
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
