// SQL Explorer — tree/items: build host SidebarSection items from the tree
// state + the per-row action button + connection subtitle. Bundled by build.mjs.
import { getDialect } from "../dialects/index.js";
import { appendIcon, el } from "../dom.js";
import { state } from "../runtime.js";
import { sidebarToneFor } from "./connState.js";
import { nid, parseNid, treeChildren, treeExpanded, treeLoadingNodes } from "./data.js";

export function buildTreeItems() {
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
      badge: { text: getDialect(c.kind).shortLabel, variant: "secondary" },
      active: state.active === c.id,
      tone: sidebarToneFor(c.id),
      expandable: true,
      expanded: treeExpanded.has(id),
      loading: treeLoadingNodes.has(id),
      actions: [
        { id: "edit", icon: "lucide:Pencil", tooltip: "Edit connection" },
        { id: "delete", icon: "lucide:Trash2", tooltip: "Delete connection", danger: true },
      ],
    };
    if (item.expanded) item.children = treeChildItems(id, c.id);
    return item;
  });
}

export function treeChildItems(parentId, connId) {
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
  const dialect = getDialect(c.kind);
  const kind = dialect.shortLabel;
  if (dialect.fileBased)
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
