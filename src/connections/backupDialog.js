// SQL Explorer — connections/backupDialog: the passphrase modals that drive
// export / import of the connection list, plus the file in and out.
//
// File I/O goes through the browser (a Blob download, an <input type=file>
// read) rather than a native picker: that is already how this extension writes
// CSV / JSON / SQL exports, and it needs no extra permission. Bundled by
// build.mjs.
import { openCenteredDialog } from "../dialogs.js";
import { el, input, safeToast } from "../dom.js";
import { ctx, state } from "../runtime.js";
import { applyBackup, backupSupported, buildBackup, BACKUP_EXTENSION } from "./backup.js";

/** `tedi-sql-connections-2026-08-04.tedi-sql` — dated so successive exports
 *  don't silently overwrite each other in the Downloads folder. */
function backupFilename() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  return `tedi-sql-connections-${stamp}.${BACKUP_EXTENSION}`;
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = el("a", { attrs: { href: url, download: filename } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick; revoking synchronously can beat the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read one user-picked file as text, or null when the picker was dismissed. */
function pickTextFile(accept) {
  return new Promise((resolve) => {
    const picker = el("input", { attrs: { type: "file", accept } });
    picker.style.display = "none";
    document.body.appendChild(picker);
    // `cancel` is not universally delivered, so the picker is also removed by
    // the change handler; both paths are idempotent.
    const done = (value) => {
      picker.remove();
      resolve(value);
    };
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (!file) return done(null);
      file
        .text()
        .then((text) => done({ name: file.name, text }))
        .catch(() => done(null));
    });
    picker.addEventListener("cancel", () => done(null));
    picker.click();
  });
}

/** Shared chrome for both modals: a labelled field stack. */
function field(label, control, hint) {
  const wrap = el("label", { class: "tsql-field is-full" });
  wrap.appendChild(el("span", { class: "tsql-label", text: label }));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el("span", { class: "tsql-label-type", text: hint }));
  return wrap;
}

function unsupported() {
  safeToast("Connection backup needs a newer TEDI.", "warning");
}

/**
 * Export modal. Asks for a passphrase twice (a typo in a write-only secret is
 * unrecoverable: the file would be undecryptable and nothing would say so until
 * the day it is needed), then downloads the sealed file.
 */
export async function openExportConnectionsDialog() {
  if (!backupSupported()) return unsupported();
  if ((state.connections ?? []).length === 0) {
    safeToast("There are no saved connections to export.", "warning");
    return;
  }

  const { body, close } = openCenteredDialog({
    title: "Export connections",
    width: 460,
    compact: true,
  });

  let passphrase = "";
  let confirm = "";
  const grid = el("div", { class: "tsql-form-grid" });
  grid.appendChild(
    field(
      "Passphrase",
      input({ type: "password", onInput: (v) => (passphrase = v) }),
      "The file carries your database passwords, so it is always encrypted. Keep this passphrase: without it the backup cannot be opened.",
    ),
  );
  grid.appendChild(
    field("Confirm passphrase", input({ type: "password", onInput: (v) => (confirm = v) })),
  );
  body.appendChild(grid);

  const error = el("p", { class: "tsql-form-error" });
  body.appendChild(error);

  const save = el("button", {
    class: "tsql-btn is-primary",
    text: "Export",
    attrs: { type: "button" },
    on: {
      click: async () => {
        error.style.color = "var(--destructive, #ef4444)";
        if (!passphrase) {
          error.textContent = "A passphrase is required.";
          return;
        }
        if (passphrase !== confirm) {
          error.textContent = "The two passphrases do not match.";
          return;
        }
        try {
          const { text, count } = await buildBackup(passphrase);
          downloadText(backupFilename(), text);
          close();
          safeToast(`Exported ${count} connection${count === 1 ? "" : "s"}`, "success");
        } catch (err) {
          error.textContent = err?.message ?? String(err);
        }
      },
    },
  });
  body.appendChild(
    el(
      "div",
      { class: "tsql-dialog-actions" },
      el("button", {
        class: "tsql-btn is-outline",
        text: "Cancel",
        attrs: { type: "button" },
        on: { click: close },
      }),
      save,
    ),
  );
}

/**
 * Import. The file is picked FIRST so a wrong pick is reported before the user
 * types a passphrase, rather than after (the host's SSH backup orders it the
 * same way and for the same reason). `onDone` re-renders the tree.
 */
export async function openImportConnectionsDialog(onDone) {
  if (!backupSupported()) return unsupported();

  const picked = await pickTextFile(`.${BACKUP_EXTENSION},application/json`);
  if (!picked) return;

  const { body, close } = openCenteredDialog({
    title: "Import connections",
    width: 460,
    compact: true,
  });

  let passphrase = "";
  const grid = el("div", { class: "tsql-form-grid" });
  grid.appendChild(el("span", { class: "tsql-label-type", text: picked.name }));
  grid.appendChild(
    field(
      "Passphrase",
      input({ type: "password", onInput: (v) => (passphrase = v) }),
      "Connections merge by id: re-importing the same file updates them instead of duplicating, and nothing already here is deleted.",
    ),
  );
  body.appendChild(grid);

  const error = el("p", { class: "tsql-form-error" });
  body.appendChild(error);

  body.appendChild(
    el(
      "div",
      { class: "tsql-dialog-actions" },
      el("button", {
        class: "tsql-btn is-outline",
        text: "Cancel",
        attrs: { type: "button" },
        on: { click: close },
      }),
      el("button", {
        class: "tsql-btn is-primary",
        text: "Import",
        attrs: { type: "button" },
        on: {
          click: async () => {
            error.style.color = "var(--destructive, #ef4444)";
            if (!passphrase) {
              error.textContent = "A passphrase is required.";
              return;
            }
            try {
              const r = await applyBackup(picked.text, passphrase);
              close();
              onDone?.();
              const parts = [];
              if (r.added) parts.push(`${r.added} added`);
              if (r.replaced) parts.push(`${r.replaced} updated`);
              if (r.skipped) parts.push(`${r.skipped} skipped`);
              safeToast(`Imported connections: ${parts.join(", ") || "nothing to do"}`, "success");
              // Both of these leave a connection that LOOKS imported but cannot
              // connect, so they are said out loud rather than left to be found
              // at the next connect attempt.
              if (r.withoutSecrets) {
                safeToast(
                  `${r.withoutSecrets} connection${r.withoutSecrets === 1 ? "" : "s"} arrived without a saved password — set it in Edit connection.`,
                  "warning",
                );
              }
              if (r.tunnelsDropped) {
                safeToast(
                  `${r.tunnelsDropped} SSH tunnel${r.tunnelsDropped === 1 ? "" : "s"} pointed at a host not saved here and now connect directly.`,
                  "warning",
                );
              }
            } catch (err) {
              ctx?.logger?.warn?.("connection import failed", err);
              error.textContent = err?.message ?? String(err);
            }
          },
        },
      }),
    ),
  );
}
