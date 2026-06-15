// SQL Explorer — render/completions: the autocomplete source for the query
// editor. Bundled into extension.js by build.mjs.
import {
  COMMON_FUNCTIONS,
  COMMON_KEYWORDS,
  COMMON_TYPES,
  getDialect,
} from "../dialects/index.js";
import { state } from "../runtime.js";

/**
 * Autocomplete source for the query editor. Returns three buckets:
 *  - schema cache entries (tables + columns) populated by the host
 *    sidebar tree (`treeLoadTables`) and `loadTableRows` as the user navigates
 *  - SQL syntax keywords / functions / data types so the editor stays
 *    useful before any table has been opened
 *  - engine-specific syntax for MySQL / PostgreSQL / SQLite, pulled
 *    from the active session's connection kind
 *
 * Boost ordering (higher = closer to top): tables 12, keywords 10,
 * functions 8, columns 5, types 3. Tables outrank keywords because the
 * common case after `FROM ` is a table name; columns sit below so they
 * surface mainly when the user has typed a column-ish prefix.
 *
 * Identical labels collapse (e.g. MySQL where db == schema, the same
 * table can appear as `db.db.table` and `db.table`). Dedup is by label
 * + type so a table and a column sharing a name both stay visible.
 */
export function buildSchemaCompletions(session, prefix) {
  const needle = (prefix || "").toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (key, item) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const matches = (label) => !needle || label.toLowerCase().startsWith(needle);

  // Schema cache: tables + columns
  const cache = session?.schemaCache;
  if (cache && cache.size > 0) {
    for (const entry of cache.values()) {
      const tableName = entry.table;
      if (tableName && matches(tableName)) {
        const qualifier =
          entry.database === entry.schema
            ? entry.database
            : `${entry.database}.${entry.schema}`;
        push(`t:${tableName}`, {
          label: tableName,
          detail: qualifier,
          type: entry.kind === "view" ? "interface" : "class",
          boost: 12,
        });
      }
      for (const col of entry.columns) {
        if (matches(col)) {
          push(`c:${col}:${tableName}`, {
            label: col,
            detail: tableName,
            type: "property",
            boost: 5,
          });
        }
      }
    }
  }

  // SQL syntax: keywords, functions, types. Always available so the
  // editor offers help before the schema cache has anything. Engine-specific
  // words come from the active connection's dialect descriptor.
  const connKind = state.connections.find((c) => c.id === session?.connId)?.kind;
  const dialect = getDialect(connKind);
  for (const kw of COMMON_KEYWORDS) {
    if (matches(kw)) push(`k:${kw}`, { label: kw, detail: "keyword", type: "keyword", boost: 10 });
  }
  for (const kw of dialect.keywords) {
    if (matches(kw)) push(`k:${kw}`, { label: kw, detail: `${connKind} keyword`, type: "keyword", boost: 10 });
  }
  for (const fn of COMMON_FUNCTIONS) {
    if (matches(fn)) push(`f:${fn}`, { label: fn, detail: "function", type: "function", boost: 8 });
  }
  for (const fn of dialect.functions) {
    if (matches(fn)) push(`f:${fn}`, { label: fn, detail: `${connKind} function`, type: "function", boost: 8 });
  }
  for (const ty of COMMON_TYPES) {
    if (matches(ty)) push(`y:${ty}`, { label: ty, detail: "type", type: "type", boost: 3 });
  }
  return out;
}
