// SQL Explorer — tree/data: node-id encoding, the lazy-tree state sets, and the
// sidecar fetchers that populate them. Bundled into extension.js by build.mjs.
//
// The connection list AND schema navigation live in TEDI's left "Databases"
// sidebar as a lazy tree (connection → database → [schema] → table). This module
// owns the raw data; tree/items renders it and tree/view wires interaction.
import { connectWithRetry, ensureSession } from "../connections.js";
import { scopedDatabases } from "../connections/store.js";
import { state } from "../runtime.js";
import { ensureSidecar, fetchJson } from "../sidecar.js";

const TREE_SEP = "\x01"; // SOH control char; never appears in real identifiers
/** Expanded node ids. */
export const treeExpanded = new Set();
/** Node ids currently loading their children. */
export const treeLoadingNodes = new Set();
/** Loaded children per node id: [{ kind:"db"|"schema"|"table", name, tableKind? }]. */
export const treeChildren = new Map();

export function nid(kind, connId, db, schema, table) {
  return [kind, connId, db ?? "", schema ?? "", table ?? ""].join(TREE_SEP);
}
export function parseNid(id) {
  const [kind, connId, db, schema, table] = id.split(TREE_SEP);
  return { kind, connId, db, schema, table };
}

/** Open a connection's sidecar pool if it isn't already, WITHOUT stealing the
 *  pane's active session. Needed before listing its databases/tables. */
export async function ensureConnected(connId) {
  await ensureSidecar();
  const conn = state.connections.find((c) => c.id === connId);
  if (!conn) throw new Error("connection not found");
  const conns = await fetchJson("/connections").catch(() => null);
  const open = conns?.connections?.some((c) => c.id === connId);
  if (!open) await connectWithRetry(connId);
  ensureSession(connId);
}

export async function treeLoadDatabases(connId) {
  const resp = await fetchJson(`/databases?conn=${encodeURIComponent(connId)}`);
  const conn = state.connections.find((c) => c.id === connId) || {};
  // The connection's `database` field narrows the tree, and may name SEVERAL
  // (comma separated). Empty = show everything the server reports, which is
  // also what a connect-target engine like PostgreSQL always does: there the
  // field names the maintenance database, usually the empty `postgres` one, so
  // filtering to it hid every database the user actually keeps data in.
  const scope = scopedDatabases(conn);
  const dbs = scope.length ? resp.databases.filter((d) => scope.includes(d.name)) : resp.databases;
  return dbs.map((d) => ({ kind: "db", name: d.name }));
}

/** A database's children: schemas, or — when the engine exposes a single schema
 *  named like the DB (MySQL/SQLite) — the tables directly (schema collapsed). */
export async function treeLoadDbChildren(connId, db) {
  const resp = await fetchJson(
    `/schemas?conn=${encodeURIComponent(connId)}&database=${encodeURIComponent(db)}`,
  );
  if (resp.schemas.length === 1 && resp.schemas[0].name === db) {
    return treeLoadTables(connId, db, db);
  }
  return resp.schemas.map((s) => ({ kind: "schema", name: s.name }));
}

export async function treeLoadTables(connId, db, schema) {
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
