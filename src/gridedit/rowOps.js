// SQL Explorer — gridedit/rowOps: row-level operations (delete, insert).
// Writes are gated by the sidecar's allow_writes classifier. The read-only
// Structure view lives in ./structure.js. Bundled into extension.js by
// build.mjs.
import { classifyColumnType, ensurePkColumns, inputValueToIso, shortTypeLabel } from "../columns.js";
import { openCenteredDialog, openConfirmDialog } from "../dialogs.js";
import { createDatePicker, el, input, safeToast, select } from "../dom.js";
import { invalidateRowCount, loadTableRows } from "../grid.js";
import { setActionSql } from "../render.js";
import { fetchJson } from "../sidecar.js";
import { buildDeleteSql, buildInsertSql, sqlLanguageForSession } from "../sql.js";

export async function deleteRowFromGrid(session, rowIdx) {
  const snap = session.tableSnapshot;
  if (!snap) return;
  const pks = await ensurePkColumns(session);
  if (pks.length === 0) {
    safeToast("Cannot delete: table has no primary key.", "warning");
    return;
  }
  const pkMap = {};
  for (const pk of pks) {
    const idx = snap.columns.indexOf(pk);
    if (idx < 0) {
      safeToast(`Primary key ${pk} not in grid; refresh first.`, "warning");
      return;
    }
    pkMap[pk] = snap.rows[rowIdx][idx];
  }
  const deleteSql = buildDeleteSql(session.connId, session.activeTable, pkMap);
  const ok = await openConfirmDialog({
    title: "Delete row?",
    message: "This deletes the row below and can't be undone.",
    sql: deleteSql,
    language: sqlLanguageForSession(session),
    confirmLabel: "Delete",
    destructive: true,
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  try {
    const resp = await fetchJson("/table-delete", {
      method: "POST",
      body: {
        conn: session.connId,
        database: session.activeTable.database,
        schema: session.activeTable.schema,
        table: session.activeTable.table,
        pk: pkMap,
      },
    });
    invalidateRowCount(session);
    await loadTableRows(session, snap.page);
    // Show the DELETE that ran (loadTableRows reset the strip to the SELECT).
    setActionSql(session, deleteSql);
    // Zero rows matched means the WHERE missed, not that the delete worked.
    if (resp?.affected === 0) {
      safeToast("No row matched — it may already be gone.", "warning");
      return;
    }
    safeToast("Row deleted", "success");
  } catch (err) {
    safeToast(`Delete failed: ${err?.message ?? err}`, "error");
  }
}

/**
 * Build the typed input for one Insert-dialog field, mirroring the inline
 * cell editor's widget family (classifyColumnType): boolean/enum dropdowns,
 * date/time pickers, number steppers, text otherwise. `resolve()` returns
 * `{ include, value }` — `include:false` means "leave the field out so the DB
 * applies its default / auto-increment"; `value:null` is an explicit NULL.
 */
function makeInsertField(col) {
  const type = classifyColumnType(col);
  const nullable = col.nullable !== false;
  const enumType = type && typeof type === "object" && type.kind === "enum" ? type : null;

  if (type === "boolean" || enumType) {
    // Custom themed dropdown so the insert dialog matches the connection
    // dialog's selects (and the grid cell editor) instead of a native <select>.
    const options = [{ value: "__tsqlx_default__", label: "(default)" }];
    if (nullable) options.push({ value: "__tsqlx_null__", label: "(NULL)" });
    for (const o of enumType ? enumType.options : ["true", "false"]) {
      options.push({ value: o, label: o });
    }
    let current = "__tsqlx_default__";
    const control = select(options, current, (v) => {
      current = v;
    });
    const resolve = () => {
      if (current === "__tsqlx_default__") return { include: false };
      if (current === "__tsqlx_null__") return { include: true, value: null };
      if (type === "boolean") {
        const isTiny = String(col.data_type ?? "").toLowerCase() === "tinyint";
        const truthy = current === "true";
        return { include: true, value: isTiny ? (truthy ? 1 : 0) : truthy };
      }
      return { include: true, value: current };
    };
    return { control, resolve };
  }

  if (type === "date" || type === "time" || type === "datetime") {
    // Custom themed picker (same square / 1px-border chrome as the rest of the
    // dialog) instead of the native date control.
    const picker = createDatePicker({ type, value: "" });
    return {
      control: picker.wrap,
      resolve: () => {
        const v = picker.getValue();
        return v === "" ? { include: false } : { include: true, value: inputValueToIso(v) };
      },
    };
  }

  if (type === "integer" || type === "number") {
    const inp = el("input", {
      class: "tsql-input",
      attrs: { type: "number", step: type === "integer" ? "1" : "any" },
    });
    return {
      control: inp,
      resolve: () => {
        if (inp.value === "") return { include: false };
        const n = Number(inp.value);
        if (Number.isNaN(n)) return { include: true, value: inp.value };
        if (type === "integer" && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
          return { include: true, value: Math.trunc(n) };
        }
        return { include: true, value: n };
      },
    };
  }

  // text / json / bytes (typed as text)
  const inp = input({});
  return {
    control: inp,
    resolve: () => (inp.value === "" ? { include: false } : { include: true, value: inp.value }),
  };
}

export async function openInsertDialog(session) {
  const pks = await ensurePkColumns(session);
  const columns = session._pkCache?.columns ?? [];
  const { body, close } = openCenteredDialog({
    title: `Insert into ${session.activeTable.table}`,
  });

  const fields = new Map();
  const grid = el("div", { class: "tsql-form-grid" });
  for (const col of columns) {
    const field = makeInsertField(col);
    fields.set(col.name, field);
    const typeHint = shortTypeLabel(col);
    const label = `${col.name}${col.is_primary ? " (PK)" : ""}${col.nullable === false ? " *" : ""}`;
    grid.appendChild(
      el(
        "label",
        // Flow in the form's 2-column grid (matches the connection dialog) so a
        // many-column insert reads as a compact, tidy form instead of one tall
        // single column.
        { class: "tsql-field" },
        el(
          "span",
          { class: "tsql-label" },
          document.createTextNode(label),
          typeHint ? el("span", { class: "tsql-label-type", text: ` ${typeHint}` }) : null,
        ),
        field.control,
      ),
    );
  }
  body.appendChild(grid);
  const error = el("p", { class: "tsql-form-error" });
  body.appendChild(error);
  body.appendChild(
    el(
      "div",
      { class: "tsql-dialog-actions" },
      el("button", {
        class: "tsql-btn",
        text: "Cancel",
        attrs: { type: "button" },
        on: { click: close },
      }),
      el("button", {
        class: "tsql-btn is-primary",
        text: "Insert",
        attrs: { type: "button" },
        on: {
          click: async () => {
            try {
              const values = {};
              for (const [name, field] of fields) {
                const r = field.resolve();
                if (r.include) values[name] = r.value;
              }
              await fetchJson("/table-insert", {
                method: "POST",
                body: {
                  conn: session.connId,
                  database: session.activeTable.database,
                  schema: session.activeTable.schema,
                  table: session.activeTable.table,
                  values,
                  pk: {},
                },
              });
              close();
              invalidateRowCount(session);
              await loadTableRows(session, session.tableSnapshot?.page ?? 0);
              // Show the INSERT that ran (loadTableRows reset the strip to SELECT).
              setActionSql(
                session,
                buildInsertSql(session.connId, session.activeTable, values),
              );
              safeToast(`Inserted row into ${session.activeTable.table}`, "success");
            } catch (err) {
              error.style.color = "var(--destructive, #ef4444)";
              error.textContent = err?.message ?? String(err);
            }
          },
        },
      }),
    ),
  );
  // Hint PK columns even when the user couldn't read them yet
  if (pks.length === 0) {
    safeToast("Table has no primary key; generated columns must be filled manually.", "info");
  }
}
