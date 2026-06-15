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
function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
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
export function containsDestructive(sql) {
  return DESTRUCTIVE_REGEX.test(sql);
}
