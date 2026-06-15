// SQL Explorer — gridedit/typedEditor: the shared typed inline-edit widget.
// Bundled into extension.js by build.mjs.
import { inputValueToIso, isoToInputValue } from "../columns.js";
import { clearChildren, el, makeNumberWrap } from "../dom.js";

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
export function mountTypedEditor(td, { type, nullable, original, colInfo, commit, cancel }) {
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
