// SQL Explorer — gridedit/rowOps: row-level operations (delete, insert) and the
// read-only Structure view. Writes are gated by the sidecar's allow_writes
// classifier. Bundled into extension.js by build.mjs.
import { classifyColumnType, ensurePkColumns, inputValueToIso, shortTypeLabel } from "../columns.js";
import { openCenteredDialog, openConfirmDialog } from "../dialogs.js";
import { el, input, safeToast } from "../dom.js";
import { loadTableRows } from "../grid.js";
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
    await fetchJson("/table-delete", {
      method: "POST",
      body: {
        conn: session.connId,
        database: session.activeTable.database,
        schema: session.activeTable.schema,
        table: session.activeTable.table,
        pk: pkMap,
      },
    });
    await loadTableRows(session, snap.page);
    // Show the DELETE that ran (loadTableRows reset the strip to the SELECT).
    setActionSql(session, deleteSql);
    safeToast("Row deleted", "success");
  } catch (err) {
    safeToast(`Delete failed: ${err?.message ?? err}`, "error");
  }
}

/**
 * Read-only "Structure" view: the table's columns rendered as a metadata grid
 * (ordinal, name, type, nullability, key, default, extra) from the existing
 * /columns response — no DDL endpoint needed. Available on read-only
 * connections too.
 */
export async function openStructureDialog(session) {
  const target = session.activeTable;
  if (!target) return;
  const { body } = openCenteredDialog({
    title: `Structure · ${target.table}`,
    width: 660,
  });
  body.appendChild(el("p", { class: "tsql-empty", text: "Loading…" }));

  let columns;
  try {
    await ensurePkColumns(session);
    columns = session._pkCache?.columns;
  } catch (err) {
    body.replaceChildren(
      el("p", { class: "tsql-error-text", text: `Failed to load structure: ${err?.message ?? err}` }),
    );
    return;
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    body.replaceChildren(el("p", { class: "tsql-empty", text: "No column metadata available." }));
    return;
  }

  const wrap = el("div", { class: "tsql-grid-wrap tsql-structure-wrap" });
  const table = el("table", { class: "tsql-grid tsql-structure-grid" });
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["#", "Column", "Type", "Null", "Key", "Default", "Extra"]) {
    hr.appendChild(el("th", { text: h }));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  columns.forEach((c, i) => {
    const tr = el("tr");
    const def = c.default_value == null ? "" : String(c.default_value);
    const cells = [
      String(c.ordinal ?? i + 1),
      c.name,
      c.full_type || c.data_type || "",
      c.nullable === false ? "NO" : "YES",
      c.is_primary ? "PRI" : "",
      def,
      c.is_auto_increment ? "auto_increment" : "",
    ];
    cells.forEach((textVal) => tr.appendChild(el("td", { text: textVal })));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  const summary = el("div", {
    class: "tsql-structure-summary",
    text: `${columns.length} column${columns.length === 1 ? "" : "s"}`,
  });
  body.replaceChildren(summary, wrap);
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
    const sel = el("select", { class: "tsql-input" });
    sel.appendChild(el("option", { attrs: { value: "__default__" }, text: "(default)" }));
    if (nullable) sel.appendChild(el("option", { attrs: { value: "__null__" }, text: "(NULL)" }));
    for (const o of enumType ? enumType.options : ["true", "false"]) {
      sel.appendChild(el("option", { attrs: { value: o }, text: o }));
    }
    sel.value = "__default__";
    const resolve = () => {
      const v = sel.value;
      if (v === "__default__") return { include: false };
      if (v === "__null__") return { include: true, value: null };
      if (type === "boolean") {
        const isTiny = String(col.data_type ?? "").toLowerCase() === "tinyint";
        const truthy = v === "true";
        return { include: true, value: isTiny ? (truthy ? 1 : 0) : truthy };
      }
      return { include: true, value: v };
    };
    return { control: sel, resolve };
  }

  if (type === "date" || type === "time" || type === "datetime") {
    const htmlType = type === "date" ? "date" : type === "time" ? "time" : "datetime-local";
    const inp = el("input", {
      class: "tsql-input",
      attrs: { type: htmlType, step: type === "date" ? undefined : "1" },
    });
    return {
      control: inp,
      resolve: () =>
        inp.value === "" ? { include: false } : { include: true, value: inputValueToIso(inp.value) },
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
        { class: "tsql-field is-full" },
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
