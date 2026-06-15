// SQL Explorer — gridedit module. Bundled into extension.js by build.mjs.
// Cell editing + row mutation (update/delete/insert) + the Structure view.
// Split out of grid.js so that module stays focused on rendering; this one
// owns the write paths (all gated by the sidecar's allow_writes classifier).
import {
  classifyColumnType,
  deepEqual,
  ensurePkColumns,
  inputValueToIso,
  isBytesCell,
  isoToInputValue,
  shortTypeLabel,
} from "./columns.js";
import { openCenteredDialog, openConfirmDialog } from "./dialogs.js";
import { clearChildren, el, input, makeNumberWrap, safeToast, setTooltipAttr } from "./dom.js";
import { cellTooltip, loadTableRows, renderCellContent } from "./grid.js";
import { setActionSql } from "./render.js";
import { state } from "./runtime.js";
import { fetchJson } from "./sidecar.js";
import { buildDeleteSql, buildInsertSql, buildUpdateSql, sqlLanguageForSession } from "./sql.js";

/**
 * Inline-edit a single cell of an editable query result. Mirrors the
 * table-browse path (beginCellEdit) but resolves table identity, PK values,
 * and column type from the editCtx + the backing result row rather than a
 * session.tableSnapshot. On success the new value is written back into the
 * row array so pagination / re-renders keep the edit.
 */
export function beginQueryCellEdit(editCtx, row, colIdx, td) {
  const original = row[colIdx];
  if (isBytesCell(original)) {
    safeToast("Binary cells aren't editable inline yet.", "warning");
    return;
  }
  const colInfo = editCtx.colByIdx.get(colIdx);
  if (!colInfo) return;
  const colName = colInfo.name;
  const type = classifyColumnType(colInfo);
  const nullable = colInfo.nullable !== false;

  const revert = () => {
    td.replaceChildren(renderCellContent(original));
    setTooltipAttr(td, cellTooltip(original));
  };

  const commit = async (next) => {
    if (deepEqual(next, original)) {
      revert();
      return;
    }
    const pkMap = {};
    for (const pk of editCtx.pks) {
      pkMap[pk] = row[editCtx.pkResultIdx.get(pk)];
    }
    const t = { database: editCtx.database, schema: editCtx.schema, table: editCtx.table };
    const sql = buildUpdateSql(editCtx.connId, t, pkMap, { [colName]: next });
    const ok = await openConfirmDialog({
      title: "Apply update?",
      message: `Update 1 row in ${editCtx.table}.`,
      sql,
      language: sqlLanguageForSession({ connId: editCtx.connId }),
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
          conn: editCtx.connId,
          database: editCtx.database,
          schema: editCtx.schema,
          table: editCtx.table,
          pk: pkMap,
          values: { [colName]: next },
        },
      });
      row[colIdx] = next;
      td.replaceChildren(renderCellContent(next));
      setTooltipAttr(td, cellTooltip(next));
      td.classList.add("tsql-cell-saved");
      setTimeout(() => td.classList.remove("tsql-cell-saved"), 800);
      setActionSql(state.sessions[editCtx.connId], sql);
    } catch (err) {
      revert();
      safeToast(`Update failed: ${err?.message ?? err}`, "error");
    }
  };

  mountTypedEditor(td, { type, nullable, original, colInfo, commit, cancel: revert });
}

export async function beginCellEdit(session, rowIdx, colIdx, td) {
  const snap = session.tableSnapshot;
  if (!snap) return;
  const pks = await ensurePkColumns(session);
  if (pks.length === 0) {
    safeToast("Cannot edit: table has no primary key.", "warning");
    return;
  }
  const original = snap.rows[rowIdx][colIdx];
  // Bytes cells can't be edited inline. Bail with a hint so the user
  // doesn't end up with an empty text input that can never round-trip.
  if (isBytesCell(original)) {
    safeToast("Binary cells aren't editable inline yet.", "warning");
    return;
  }
  const col = snap.columns[colIdx];
  const colInfo = (session._pkCache?.columns ?? []).find((c) => c.name === col) ?? null;
  const type = classifyColumnType(colInfo);
  const nullable = colInfo ? colInfo.nullable !== false : true;

  const commitWith = async (next) => {
    if (deepEqual(next, original)) {
      td.replaceChildren(renderCellContent(original));
      setTooltipAttr(td, cellTooltip(original));
      return;
    }
    const pkMap = {};
    for (const pk of pks) {
      const idx = snap.columns.indexOf(pk);
      if (idx < 0) {
        safeToast(`Primary key ${pk} not in current grid; refresh first.`, "warning");
        td.replaceChildren(renderCellContent(original));
        setTooltipAttr(td, cellTooltip(original));
        return;
      }
      pkMap[pk] = snap.rows[rowIdx][idx];
    }
    const sql = buildUpdateSql(session.connId, session.activeTable, pkMap, { [col]: next });
    const ok = await openConfirmDialog({
      title: "Apply update?",
      message: `Update 1 row in ${session.activeTable.table}.`,
      sql,
      language: sqlLanguageForSession(session),
      confirmLabel: "Update",
    });
    if (!ok) {
      td.replaceChildren(renderCellContent(original));
      setTooltipAttr(td, cellTooltip(original));
      return;
    }
    try {
      await fetchJson("/table-update", {
        method: "POST",
        body: {
          conn: session.connId,
          database: session.activeTable.database,
          schema: session.activeTable.schema,
          table: session.activeTable.table,
          pk: pkMap,
          values: { [col]: next },
        },
      });
      snap.rows[rowIdx][colIdx] = next;
      td.replaceChildren(renderCellContent(next));
      setTooltipAttr(td, cellTooltip(next));
      td.classList.add("tsql-cell-saved");
      setTimeout(() => td.classList.remove("tsql-cell-saved"), 800);
      setActionSql(session, sql);
    } catch (err) {
      td.replaceChildren(renderCellContent(original));
      setTooltipAttr(td, cellTooltip(original));
      safeToast(`Update failed: ${err?.message ?? err}`, "error");
    }
  };

  const cancel = () => {
    td.replaceChildren(renderCellContent(original));
    setTooltipAttr(td, cellTooltip(original));
  };

  // Typed widget creation + commit/cancel wiring is shared with the
  // editable query-result grid via mountTypedEditor.
  mountTypedEditor(td, { type, nullable, original, colInfo, commit: commitWith, cancel });
}

/**
 * Build, mount, focus, and wire the typed inline-edit widget for one grid
 * cell. Shared by the table-browse grid (beginCellEdit) and the editable
 * query-result grid (beginQueryCellEdit) so both use identical widgets and
 * keyboard behaviour. Storage-agnostic: the caller supplies `commit(next)`
 * and `cancel()`, which close over the cell + backing row.
 *
 * Recognises boolean / enum / date / time / datetime / integer / number /
 * json / text. Commits on Enter (Shift+Enter keeps newlines in the JSON
 * textarea), on blur, and on change for the dropdown widgets; cancels on
 * Escape. Number widgets get themed up/down steppers in place of the
 * OS-native spin buttons.
 */
function mountTypedEditor(td, { type, nullable, original, colInfo, commit, cancel }) {
  let editor;
  let resolveValue;
  let committedOnChange = false;

  const enumType =
    type && typeof type === "object" && type.kind === "enum" ? type : null;

  if (type === "boolean") {
    editor = el("select", { class: "tsql-input tsql-cell-input tsql-cell-input--bool" });
    const opts = [];
    if (nullable) opts.push({ value: "__null__", label: "(NULL)" });
    opts.push({ value: "true", label: "true" }, { value: "false", label: "false" });
    for (const o of opts) {
      const node = el("option", { attrs: { value: o.value }, text: o.label });
      editor.appendChild(node);
    }
    // Original may be `true` / `false` / `null` / `0` / `1`.
    const initial =
      original === null || original === undefined
        ? nullable
          ? "__null__"
          : "false"
        : original === true || original === 1 || original === "1"
          ? "true"
          : original === false || original === 0 || original === "0"
            ? "false"
            : nullable
              ? "__null__"
              : "false";
    editor.value = initial;
    resolveValue = () => {
      const v = editor.value;
      if (v === "__null__") return null;
      // MySQL TINYINT(1) round-trips through i64; send 1/0 so the sqlx Number
      // path binds an integer instead of a bool the driver might reject on a
      // numeric column.
      const isTiny = String(colInfo?.data_type ?? "").toLowerCase() === "tinyint";
      if (v === "true") return isTiny ? 1 : true;
      return isTiny ? 0 : false;
    };
    // For dropdowns, commit on change so the user doesn't have to tab out.
    editor.addEventListener("change", () => {
      committedOnChange = true;
      commit(resolveValue());
    });
  } else if (enumType) {
    editor = el("select", { class: "tsql-input tsql-cell-input tsql-cell-input--enum" });
    if (nullable) {
      editor.appendChild(el("option", { attrs: { value: "__null__" }, text: "(NULL)" }));
    }
    for (const opt of enumType.options) {
      editor.appendChild(el("option", { attrs: { value: opt }, text: opt }));
    }
    editor.value = original == null ? (nullable ? "__null__" : enumType.options[0]) : String(original);
    resolveValue = () => {
      const v = editor.value;
      return v === "__null__" ? null : v;
    };
    editor.addEventListener("change", () => {
      committedOnChange = true;
      commit(resolveValue());
    });
  } else if (type === "date" || type === "time" || type === "datetime") {
    const htmlType =
      type === "date" ? "date" : type === "time" ? "time" : "datetime-local";
    editor = el("input", {
      class: `tsql-input tsql-cell-input tsql-cell-input--${type}`,
      attrs: { type: htmlType, step: type === "date" ? undefined : "1" },
    });
    editor.value = isoToInputValue(type, original);
    resolveValue = () => inputValueToIso(editor.value);
  } else if (type === "integer" || type === "number") {
    editor = el("input", {
      class: `tsql-input tsql-cell-input tsql-cell-input--${type}`,
      attrs: {
        type: "number",
        step: type === "integer" ? "1" : "any",
        inputmode: type === "integer" ? "numeric" : "decimal",
      },
    });
    editor.value = original == null ? "" : String(original);
    resolveValue = () => {
      if (editor.value === "") return null;
      const n = Number(editor.value);
      if (Number.isNaN(n)) return editor.value; // let server reject
      // Integer columns: keep precision by sending back as integer when it fits.
      if (type === "integer" && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
        return Math.trunc(n);
      }
      return n;
    };
  } else if (type === "json") {
    editor = el("textarea", {
      class: "tsql-input tsql-cell-input tsql-cell-input--json",
      attrs: { spellcheck: "false", rows: "3" },
    });
    editor.value =
      original == null ? "" : typeof original === "object" ? JSON.stringify(original, null, 2) : String(original);
    resolveValue = () => {
      if (editor.value === "") return null;
      // Try JSON; if invalid, surface the raw text so the server can
      // round-trip (sidecar binds JSON as text for non-JSON columns
      // already, so a syntactically invalid edit shows the SQL error).
      try {
        return JSON.parse(editor.value);
      } catch {
        return editor.value;
      }
    };
  } else {
    // text / fallback
    editor = el("input", { class: "tsql-input tsql-cell-input", attrs: { type: "text" } });
    editor.value =
      original == null ? "" : typeof original === "object" ? JSON.stringify(original) : String(original);
    resolveValue = () => {
      if (editor.value === "") return null;
      return editor.value;
    };
  }

  // Number inputs mount inside a stepper wrapper so the OS spin button is
  // replaced by themed up/down controls; every other widget mounts bare.
  const mountNode =
    editor.tagName === "INPUT" && editor.type === "number" ? makeNumberWrap(editor) : editor;

  clearChildren(td);
  td.appendChild(mountNode);
  if (typeof editor.focus === "function") editor.focus();
  if (typeof editor.select === "function" && editor.tagName !== "SELECT") {
    try {
      editor.select();
    } catch {
      // ignore (some input types don't support text selection)
    }
  }

  const blurCommit = () => {
    if (committedOnChange) return;
    committedOnChange = true;
    commit(resolveValue());
  };
  editor.addEventListener("blur", blurCommit);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // Allow newlines inside the JSON textarea on Shift+Enter; commit
      // on plain Enter for every other editor.
      if (editor.tagName === "TEXTAREA" && event.shiftKey) return;
      event.preventDefault();
      committedOnChange = true;
      commit(resolveValue());
    } else if (event.key === "Escape") {
      event.preventDefault();
      committedOnChange = true;
      cancel();
    }
  });
}

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
