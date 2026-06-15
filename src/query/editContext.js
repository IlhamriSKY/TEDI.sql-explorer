// SQL Explorer — query/editContext: decide whether a free-form query result can
// be edited in place, and if so build its edit context. Bundled by build.mjs.
//
// Free-form query results are normally read-only, but the common case of a
// plain `SELECT ... FROM one_table` maps 1:1 to base-table rows and can be
// edited in place using the same /table-update path as the table-browse grid.
// Cells then reuse mountTypedEditor via beginQueryCellEdit.
import { fetchTableColumns } from "../columns.js";
import { isReadOnly } from "../sql.js";
import { findCachedMatch, isSingleTableSelect, parseSqlReferences } from "./sqlRefs.js";

/**
 * Editable only when the statement is a plain single-table SELECT against a
 * base table (not a view) on a writable connection, the table has a primary
 * key, and every PK column is present in the result so each row can be uniquely
 * addressed. Returns null (read-only) for joins, aggregates, unions, views, or
 * projections with no real columns.
 */
export async function resolveQueryEditContext(session, sql, columns) {
  if (!session || !isSingleTableSelect(sql)) return null;
  const refs = parseSqlReferences(sql);
  if (refs.length !== 1) return null;
  const match = findCachedMatch(session, refs);
  if (!match || match.kind === "view") return null;
  // Read-only connections (no writes, or SQLite opened read-only) never get inline edit.
  if (isReadOnly(session.connId)) return null;

  // Column metadata, memoised per table on the session so repeated renders
  // (tab switches, re-runs of the same statement) don't re-hit /columns.
  const tkey = `${match.database}.${match.schema}.${match.table}`;
  session._qcols = session._qcols || new Map();
  let info = session._qcols.get(tkey);
  if (!info) {
    try {
      info = await fetchTableColumns(session.connId, match);
    } catch {
      return null;
    }
    session._qcols.set(tkey, info);
  }
  const cols = info?.columns ?? [];
  if (!cols.length) return null;

  // Match identifiers case-insensitively so an upper/lower-case alias in the
  // SELECT still resolves to its base column.
  const byName = new Map(cols.map((c) => [String(c.name).toLowerCase(), c]));
  const pks = cols.filter((c) => c.is_primary).map((c) => c.name);
  if (pks.length === 0) return null;

  // Every PK must be projected so we can build a unique WHERE per row.
  const pkResultIdx = new Map();
  for (const pk of pks) {
    const ri = columns.findIndex((name) => String(name).toLowerCase() === pk.toLowerCase());
    if (ri < 0) return null;
    pkResultIdx.set(pk, ri);
  }

  // Map each result column that corresponds to a real, editable base column.
  const colByIdx = new Map();
  const editableColIdx = new Set();
  columns.forEach((name, ci) => {
    const colInfo = byName.get(String(name).toLowerCase());
    if (colInfo) {
      colByIdx.set(ci, colInfo);
      editableColIdx.add(ci);
    }
  });
  if (editableColIdx.size === 0) return null;

  return {
    connId: session.connId,
    database: match.database,
    schema: match.schema,
    table: match.table,
    pks,
    pkResultIdx,
    colByIdx,
    editableColIdx,
  };
}
