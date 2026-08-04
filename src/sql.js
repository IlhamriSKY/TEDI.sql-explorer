// SQL Explorer — sql module. Bundled into extension.js by build.mjs.
import { getDialect, quoteIdent } from "./dialects/index.js";
import { pageSizeFor, state } from "./runtime.js";


/** Map a connection's engine kind to the codeEditor language id used for
 *  SQL syntax highlighting. Falls back to generic "sql". */
export function sqlLanguageForSession(session) {
  return getDialect(sqlConnKind(session.connId)).languageId;
}

// --- Readable SQL builders for the action strip + edit/delete confirms.
// Display-only representations (the sidecar runs parameterized statements);
// quoting is engine-aware so they read like real SQL.

function sqlConnKind(connId) {
  return state.connections.find((c) => c.id === connId)?.kind;
}
/** A connection is read-only when writes weren't allowed at connect time
 *  (Mode = Read-only), or it's a SQLite file opened read-only. Inserts /
 *  edits / deletes are hidden + blocked for these. */
export function isReadOnly(connId) {
  const c = state.connections.find((x) => x.id === connId);
  if (!c) return false;
  if (!c.allow_writes) return true;
  if (c.kind === "sqlite" && c.sqliteReadOnly) return true;
  return false;
}
function qid(connId, name) {
  return quoteIdent(getDialect(sqlConnKind(connId)), name);
}
function qualName(connId, t) {
  const parts = [];
  if (t.schema) parts.push(qid(connId, t.schema));
  parts.push(qid(connId, t.table));
  return parts.join(".");
}
/** `"schema"."table"` quoted for the connection's engine. Exported for the
 *  schema-tree context menu, which builds statements outside a session. */
export function qualifiedTableName(connId, t) {
  return qualName(connId, t);
}
function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    // The grid's internal chips (a blob, a type the helper can't render) carry
    // no literal the server would accept; emitting their JSON would paste
    // `'{"__type":"bytes",...}'` into a copied INSERT.
    if (v.__type === "bytes" || v.__type === "unsupported") return "NULL";
    return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function whereFromPk(connId, pkMap) {
  return Object.entries(pkMap)
    .map(([c, v]) => `${qid(connId, c)} = ${sqlLit(v)}`)
    .join(" AND ");
}
export function buildSelectSql(session, t) {
  const connId = session.connId;
  let sql = `SELECT * FROM ${qualName(connId, t)}`;
  const term = (session.gridSearch || "").trim();
  if (term) {
    const col = session.gridSearchCol;
    const like = sqlLit(`%${term}%`);
    sql += col ? ` WHERE ${qid(connId, col)} LIKE ${like}` : ` WHERE <any column> LIKE ${like}`;
  }
  if (session.orderBy) {
    sql += ` ORDER BY ${qid(connId, session.orderBy)} ${session.orderDir === "desc" ? "DESC" : "ASC"}`;
  }
  const page = session.tableSnapshot?.page ?? 0;
  const size = pageSizeFor(session);
  sql += ` LIMIT ${size}`;
  if (page > 0) sql += ` OFFSET ${page * size}`;
  return sql + ";";
}
export function buildUpdateSql(connId, t, pkMap, values) {
  const sets = Object.entries(values)
    .map(([c, v]) => `${qid(connId, c)} = ${sqlLit(v)}`)
    .join(", ");
  return `UPDATE ${qualName(connId, t)} SET ${sets} WHERE ${whereFromPk(connId, pkMap)};`;
}
export function buildDeleteSql(connId, t, pkMap) {
  return `DELETE FROM ${qualName(connId, t)} WHERE ${whereFromPk(connId, pkMap)};`;
}
export function buildInsertSql(connId, t, values) {
  const cols = Object.keys(values);
  const colSql = cols.map((c) => qid(connId, c)).join(", ");
  const valSql = cols.map((c) => sqlLit(values[c])).join(", ");
  return `INSERT INTO ${qualName(connId, t)} (${colSql}) VALUES (${valSql});`;
}

const DESTRUCTIVE_REGEX = /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE?|DROP\s+ROLE|GRANT\s+ALL)\b/i;

/** Blank out comments and string literals so a keyword scan only sees real
 *  SQL — `WHERE` inside a quoted value must not look like a WHERE clause, and
 *  `-- DROP TABLE` in a comment must not look like a DROP. */
function bareSql(sql) {
  return String(sql ?? "")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
}

/**
 * Why running `sql` deserves a confirmation first, or null when it doesn't.
 *
 * Two kinds of statement earn one. The obvious kind removes a whole object
 * (DROP / TRUNCATE / GRANT ALL). The second is the one that actually catches
 * people out, and the reason phpMyAdmin asks: an `UPDATE` or `DELETE` with no
 * `WHERE` reads like an edit and silently rewrites every row in the table.
 *
 * Ordinary reads and targeted writes run straight away — a confirmation on
 * every Run would be noise, and noise is what gets clicked through.
 */
export function destructiveReason(sql) {
  const clean = bareSql(sql);
  if (DESTRUCTIVE_REGEX.test(clean)) {
    return "This drops or empties a database object. That can't be undone.";
  }
  for (const stmt of clean.split(";")) {
    const s = stmt.trim();
    if (!/^(delete\s+from|update)\b/i.test(s)) continue;
    if (/\bwhere\b/i.test(s)) continue;
    return /^delete/i.test(s)
      ? "This DELETE has no WHERE clause, so it removes every row in the table."
      : "This UPDATE has no WHERE clause, so it rewrites every row in the table.";
  }
  return null;
}
