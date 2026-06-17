// SQL Explorer — gridedit/cellEdit: inline single-cell UPDATE for both the
// table-browse grid and the editable query-result grid. All writes are gated by
// the sidecar's allow_writes classifier. Bundled into extension.js by build.mjs.
//
// The two public entry points differ ONLY in how they locate the cell's column
// metadata, primary-key values, and where the saved value is written back. The
// whole edit flow — typed widget, deepEqual no-op guard, confirm preview, POST,
// saved flash, revert on cancel/error — is identical and lives once in
// `editCell()`; the entry points are thin adapters that fill in those three
// differences.
import {
  classifyColumnType,
  deepEqual,
  ensurePkColumns,
  inputValueToIso,
  isBytesCell,
  isoToInputValue,
} from "../columns.js";
import { openConfirmDialog } from "../dialogs.js";
import { safeToast, setTooltipAttr } from "../dom.js";
import { cellTooltip, renderCellContent } from "../grid.js";
import { setActionSql } from "../render.js";
import { state } from "../runtime.js";
import { fetchJson } from "../sidecar.js";
import { buildUpdateSql, sqlLanguageForSession } from "../sql.js";
import { mountTypedEditor } from "./typedEditor.js";

/**
 * Shared inline-edit driver. Mounts the typed widget in `td` and, on commit,
 * runs the confirm → POST /table-update → write-back → flash flow.
 *
 * @param {HTMLTableCellElement} td
 * @param {object} spec
 * @param {*} spec.original         current cell value
 * @param {object|null} spec.colInfo  /columns metadata for this column
 * @param {string} spec.colName     column name being edited
 * @param {{database,schema,table}} spec.table  the target table
 * @param {string} spec.connId      connection id
 * @param {object} spec.actionSession  session whose action-SQL strip shows the UPDATE
 * @param {() => (object|null)} spec.resolvePkMap  build the WHERE pk map; null
 *        aborts the edit (the adapter has already surfaced why)
 * @param {(next:*) => void} spec.writeBack  persist `next` into the backing row
 */
function editCell(td, spec) {
  const { original, colInfo, colName, table, connId, actionSession, resolvePkMap, writeBack } = spec;
  if (isBytesCell(original)) {
    safeToast("Binary cells aren't editable inline yet.", "warning");
    return;
  }
  const type = classifyColumnType(colInfo);
  const nullable = colInfo ? colInfo.nullable !== false : true;

  const revert = () => {
    td.replaceChildren(renderCellContent(original));
    setTooltipAttr(td, cellTooltip(original));
  };

  const commit = async (next) => {
    // For date/time/datetime the picker yields a normalized input-format string
    // ("YYYY-MM-DD[THH:MM:SS]" / "HH:MM:SS") while `original` is the raw server
    // value, which may carry a TZ suffix, a space separator, or fractional
    // seconds. Compare against the normalized original so an untouched cell
    // doesn't fire a spurious, precision-dropping UPDATE on mere click-away.
    const baseline =
      type === "date" || type === "time" || type === "datetime"
        ? inputValueToIso(isoToInputValue(type, original))
        : original;
    if (deepEqual(next, baseline)) {
      revert();
      return;
    }
    const pkMap = resolvePkMap();
    if (!pkMap) {
      revert();
      return;
    }
    const sql = buildUpdateSql(connId, table, pkMap, { [colName]: next });
    const ok = await openConfirmDialog({
      title: "Apply update?",
      message: `Update 1 row in ${table.table}.`,
      sql,
      language: sqlLanguageForSession({ connId }),
      confirmLabel: "Update",
    });
    if (!ok) {
      revert();
      return;
    }
    try {
      await fetchJson("/table-update", {
        method: "POST",
        body: {
          conn: connId,
          database: table.database,
          schema: table.schema,
          table: table.table,
          pk: pkMap,
          values: { [colName]: next },
        },
      });
      writeBack(next);
      td.replaceChildren(renderCellContent(next));
      setTooltipAttr(td, cellTooltip(next));
      td.classList.add("tsql-cell-saved");
      setTimeout(() => td.classList.remove("tsql-cell-saved"), 800);
      setActionSql(actionSession, sql);
    } catch (err) {
      revert();
      safeToast(`Update failed: ${err?.message ?? err}`, "error");
    }
  };

  mountTypedEditor(td, { type, nullable, original, colInfo, commit, cancel: revert });
}

/**
 * Inline-edit a cell of an editable query result. Table identity, PK values,
 * and column type come from the resolved editCtx + the backing result row; the
 * new value is written back into that row so pagination / re-renders keep it.
 */
export function beginQueryCellEdit(editCtx, row, colIdx, td) {
  const colInfo = editCtx.colByIdx.get(colIdx);
  if (!colInfo) return;
  editCell(td, {
    original: row[colIdx],
    colInfo,
    colName: colInfo.name,
    table: { database: editCtx.database, schema: editCtx.schema, table: editCtx.table },
    connId: editCtx.connId,
    actionSession: state.sessions[editCtx.connId],
    // editCtx guarantees every PK is projected, so this never aborts.
    resolvePkMap: () => {
      const pkMap = {};
      for (const pk of editCtx.pks) pkMap[pk] = row[editCtx.pkResultIdx.get(pk)];
      return pkMap;
    },
    writeBack: (next) => {
      row[colIdx] = next;
    },
  });
}

/**
 * Inline-edit a cell of the table-browse grid. PK values come from the loaded
 * snapshot; the new value is written back into it. Bails if the table has no
 * primary key (can't build a safe WHERE).
 */
export async function beginCellEdit(session, rowIdx, colIdx, td) {
  const snap = session.tableSnapshot;
  if (!snap) return;
  const pks = await ensurePkColumns(session);
  if (pks.length === 0) {
    safeToast("Cannot edit: table has no primary key.", "warning");
    return;
  }
  const col = snap.columns[colIdx];
  editCell(td, {
    original: snap.rows[rowIdx][colIdx],
    colInfo: (session._pkCache?.columns ?? []).find((c) => c.name === col) ?? null,
    colName: col,
    table: session.activeTable,
    connId: session.connId,
    actionSession: session,
    // Map each PK to its column in the current grid; warn + abort if one isn't
    // present (e.g. a projection that dropped it) so we never UPDATE blindly.
    resolvePkMap: () => {
      const pkMap = {};
      for (const pk of pks) {
        const idx = snap.columns.indexOf(pk);
        if (idx < 0) {
          safeToast(`Primary key ${pk} not in current grid; refresh first.`, "warning");
          return null;
        }
        pkMap[pk] = snap.rows[rowIdx][idx];
      }
      return pkMap;
    },
    writeBack: (next) => {
      snap.rows[rowIdx][colIdx] = next;
    },
  });
}
