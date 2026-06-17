// SQL Explorer — dialogs module. Bundled into extension.js by build.mjs.
import { appendIcon, closeAllSelectMenus, el } from "./dom.js";
import { ctx, state } from "./runtime.js";


/** Destroy and forget any read-only SQL preview editors. Idempotent, so it
 *  is safe to call at the top of every result renderer. */
export function disposePreviewEditors() {
  for (const handle of state.previewEditors) {
    try {
      handle?.dispose?.();
    } catch {
      // ignore
    }
  }
  state.previewEditors = [];
}

export function closeOpenDialogs() {
  for (const node of document.querySelectorAll("body > .tsql-overlay")) node.remove();
  closeAllSelectMenus();
}

/**
 * Centered modal dialog (dimmed backdrop), matching the Settings look. Returns
 * `{ body, close }`; the caller fills `body` with its content. Closes on the X
 * button, a backdrop click, or Escape. Only one form modal at a time.
 */
export function openCenteredDialog({ title, width = 520, compact = false }) {
  // Mount on document.body (not panelRoot) so the modal centers on the whole
  // window and is never clipped by a short split-pane — matches host modals.
  const host = document.body;
  for (const prev of host.querySelectorAll(":scope > .tsql-overlay[data-form-modal]")) {
    prev.remove();
  }
  let settled = false;
  const overlay = el("div", { class: "tsql-overlay", attrs: { "data-form-modal": "1" } });
  // `compact` sizes the card to its content (small config modals like Export)
  // instead of the tall 460px min-height the connection editor wants, while
  // keeping the identical head + body + actions chrome.
  const dialog = el("div", {
    class: `tsql-dialog tsql-dialog-form${compact ? " tsql-dialog-form--compact" : ""}`,
  });
  dialog.style.width = `${width}px`;
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const head = el("div", { class: "tsql-dialog-head" });
  head.appendChild(el("h3", { class: "tsql-dialog-title", text: title }));
  const closeBtn = el("button", {
    class: "tsql-dialog-x",
    attrs: { type: "button", "aria-label": "Close", title: "Close" },
  });
  appendIcon(closeBtn, "Cancel01Icon", { size: 14 });
  head.appendChild(closeBtn);

  const body = el("div", { class: "tsql-dialog-body" });
  dialog.appendChild(head);
  dialog.appendChild(body);
  overlay.appendChild(dialog);

  const close = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", onKey, true);
    // Force-close any tracked body-mounted popup (e.g. an open date picker) so
    // dismissing the modal by Escape / X / backdrop can't orphan it.
    closeAllSelectMenus();
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", () => close());
  document.addEventListener("keydown", onKey, true);
  host.appendChild(overlay);
  return { body, close };
}

/**
 * Give a hand-built `.tsql-dialog` (the confirm / insert / export modals, which
 * don't run through openCenteredDialog) the same top-right X close button the
 * host AlertDialog and the connection-editor modal render, so every modal in
 * the extension carries the same close affordance. The button is corner-pinned
 * (position: absolute via .tsql-dialog-x-corner) so it overlays the card
 * without disturbing the existing title/body layout. `onClose` runs on click;
 * pair it with the caller's own Esc / backdrop handling.
 */
export function appendDialogClose(dialog, onClose) {
  dialog.classList.add("tsql-dialog-has-x");
  const btn = el("button", {
    class: "tsql-dialog-x tsql-dialog-x-corner",
    attrs: { type: "button", "aria-label": "Close", title: "Close" },
    on: { click: onClose },
  });
  appendIcon(btn, "Cancel01Icon", { size: 14 });
  dialog.appendChild(btn);
  return btn;
}

/**
 * Promise-based confirmation modal that reuses `tsql-overlay` / `tsql-dialog`
 * so visuals stay consistent with the connection editor. Resolves to `true`
 * when the user confirms, `false` on cancel / overlay-click / Escape.
 * The confirm button defaults to the primary style; pass `destructive: true`
 * to flip it to the host's red destructive chrome (matches the
 * `AlertDialogAction variant="destructive"` pattern used in
 * SourceControlPanel.tsx).
 */
export function openConfirmDialog({
  title,
  message,
  sql,
  language,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    // Read-only CodeMirror handle for the SQL preview; disposed on close so the
    // transient dialog doesn't leak an editor.
    let previewHandle = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      if (previewHandle?.dispose) {
        try {
          previewHandle.dispose();
        } catch {
          // ignore
        }
      }
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };

    const overlay = el("div", { class: "tsql-overlay" });
    const dialog = el("div", { class: "tsql-dialog tsql-dialog-confirm" });
    dialog.addEventListener("click", (event) => event.stopPropagation());
    overlay.addEventListener("click", () => finish(false));
    // Top-right X close, matching the host AlertDialog (Esc/Enter/backdrop
    // already handled above). X dismisses = cancel, like the reference.
    appendDialogClose(dialog, () => finish(false));

    dialog.appendChild(el("h3", { class: "tsql-dialog-title", text: title }));
    if (message) {
      dialog.appendChild(el("p", { class: "tsql-dialog-message", text: message }));
    }
    if (sql) {
      // Preview the exact statement that will run, syntax-highlighted like the
      // rest of the extension. `track` keeps the handle local so the editor is
      // disposed when the dialog closes.
      dialog.appendChild(
        el(
          "div",
          { class: "tsql-dialog-sql" },
          renderSqlPreview(sql, language, (h) => {
            previewHandle = h;
          }),
        ),
      );
    }

    const actions = el("div", { class: "tsql-dialog-actions" });
    const cancelBtn = el("button", {
      class: "tsql-btn",
      attrs: { type: "button" },
      text: cancelLabel,
      on: { click: () => finish(false) },
    });
    const confirmBtn = el("button", {
      class: `tsql-btn ${destructive ? "is-destructive" : "is-primary"}`,
      attrs: { type: "button" },
      text: confirmLabel,
      on: { click: () => finish(true) },
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => confirmBtn.focus());
  });
}

// SQL preview shown above the grid so the user can see exactly what
// statement produced the displayed rows. Rendered as a read-only,
// syntax-highlighted CodeMirror so it reads as real code (mono font,
// keyword/string/number colors) instead of a cramped grey strip. Falls
// back to a plain text line on hosts without ctx.ui.codeEditor.
export function renderSqlPreview(sql, language, track) {
  const text = String(sql ?? "");
  // The middle strip (track present) is always visible, so no hover tooltip;
  // the one-off grid previews keep the title for the truncated case.
  const titleAttr = track ? {} : { title: text };
  if (ctx?.ui?.codeEditor) {
    const wrap = el("div", { class: "tsql-sql-editor", attrs: titleAttr });
    try {
      const handle = ctx.ui.codeEditor(wrap, {
        language: language ?? "sql",
        value: text,
        readOnly: true,
      });
      // `track` routes the handle to a dedicated sink (the action-SQL strip's
      // singleton); otherwise it joins the shared previewEditors pool.
      if (track) track(handle);
      else state.previewEditors.push(handle);
      return wrap;
    } catch (err) {
      ctx?.logger?.warn?.("sql preview editor mount failed", err);
    }
  }
  return el("div", { class: "tsql-sql-preview", attrs: titleAttr, text });
}
