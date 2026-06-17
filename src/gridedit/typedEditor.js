// SQL Explorer — gridedit/typedEditor: the shared typed inline-edit widget.
// Bundled into extension.js by build.mjs.
import { inputValueToIso, isoToInputValue } from "../columns.js";
import { clearChildren, createDatePicker, el, makeNumberWrap, select, trackFloatingMenu } from "../dom.js";

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

  if (type === "boolean" || enumType) {
    // Custom themed dropdown (the same .tsql-select-menu chrome as every other
    // dropdown in the app) instead of a native <select>, whose option list is
    // OS-drawn and doesn't match the workbench in dark/light. It owns its own
    // lifecycle: pick → commit, dismiss (outside-click / Escape / close) →
    // revert; so it bypasses the shared blur/keydown wiring below.
    const options = [];
    if (nullable) options.push({ value: "__tsqlx_null__", label: "(NULL)" });
    if (type === "boolean") {
      options.push({ value: "true", label: "true" }, { value: "false", label: "false" });
    } else {
      for (const opt of enumType.options) options.push({ value: opt, label: opt });
    }
    // Original may be `true` / `false` / `null` / `0` / `1` (bool) or a string (enum).
    const initial =
      type === "boolean"
        ? original === null || original === undefined
          ? nullable
            ? "__tsqlx_null__"
            : "false"
          : original === true || original === 1 || original === "1"
            ? "true"
            : original === false || original === 0 || original === "0"
              ? "false"
              : nullable
                ? "__tsqlx_null__"
                : "false"
        : original == null
          ? nullable
            ? "__tsqlx_null__"
            : enumType.options[0]
          : String(original);
    const resolveSel = (v) => {
      if (v === "__tsqlx_null__") return null;
      if (type === "boolean") {
        // MySQL TINYINT(1) round-trips through i64; send 1/0 so the sqlx Number
        // path binds an integer instead of a bool the driver might reject.
        const isTiny = String(colInfo?.data_type ?? "").toLowerCase() === "tinyint";
        if (v === "true") return isTiny ? 1 : true;
        return isTiny ? 0 : false;
      }
      return v;
    };
    let done = false;
    const trigger = select(
      options,
      initial,
      (v) => {
        if (done) return;
        done = true;
        commit(resolveSel(v));
      },
      {
        className: "tsql-cell-select",
        onDismiss: () => {
          if (done) return;
          done = true;
          cancel();
        },
      },
    );
    clearChildren(td);
    td.appendChild(trigger);
    // Auto-open so the cell behaves like a single click-to-pick editor (the
    // double-click that started the edit already settled).
    requestAnimationFrame(() => {
      try {
        trigger.click();
      } catch {
        // ignore
      }
    });
    return;
  } else if (type === "date" || type === "time" || type === "datetime") {
    // Custom themed picker — replaces the native control whose popup can't be
    // restyled. It owns its own commit/cancel lifecycle (Apply / day-click /
    // Enter / click-away → commit, Escape → cancel), so it bypasses the shared
    // blur/keydown wiring below.
    let docArmed = false;
    let untrackDoc = null;
    const onDocDown = (e) => {
      if (picker.contains(e.target)) return;
      teardownDoc();
      commit(inputValueToIso(picker.getValue()));
    };
    // Removes the click-away listener. Also registered with the floating-menu
    // registry so a mid-edit grid re-render (closeAllSelectMenus) drops it
    // instead of leaving a stale listener that would fire on a later click.
    const teardownDoc = () => {
      if (untrackDoc) {
        try { untrackDoc(); } catch { /* ignore */ }
        untrackDoc = null;
      }
      if (!docArmed) return;
      document.removeEventListener("mousedown", onDocDown, true);
      docArmed = false;
    };
    const picker = createDatePicker({
      type,
      value: isoToInputValue(type, original),
      onCommit: (v) => {
        teardownDoc();
        commit(inputValueToIso(v));
      },
      onCancel: () => {
        teardownDoc();
        cancel();
      },
    });
    // Tab / programmatic focus leaving the widget commits too — the date branch
    // returns before the shared blur wiring, so without this a keyboard-only
    // exit would never commit and would leave the click-away listener armed.
    // Deferred so focus moving INTO the body-mounted popup (a day button or an
    // HH/MM/SS field) is not treated as leaving.
    picker.wrap.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!docArmed) return;
        if (picker.contains(document.activeElement)) return;
        teardownDoc();
        commit(inputValueToIso(picker.getValue()));
      }, 0);
    });
    clearChildren(td);
    td.appendChild(picker.wrap);
    picker.focus();
    picker.openPopup();
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDocDown, true);
      docArmed = true;
      untrackDoc = trackFloatingMenu(teardownDoc);
    });
    return;
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
