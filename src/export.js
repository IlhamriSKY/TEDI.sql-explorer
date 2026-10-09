// SQL Explorer: export module. Bundled into extension.js by build.mjs.
import { openCenteredDialog } from "./dialogs.js";
import { el, safeToast, select } from "./dom.js";
import { state } from "./runtime.js";
import { fetchRaw } from "./sidecar.js";

// ----------------------------- Export dialog ---------------------------------

export async function openExportDialog() {
  if (!state.active) return;
  const session = state.sessions[state.active];
  if (!session?.result?.statements?.length && !session?.activeTable) {
    safeToast("Nothing to export.", "info");
    return;
  }
  // Shared centered modal (same head + chrome as the connection / insert /
  // structure dialogs). `compact` keeps a single-field config modal from
  // inheriting the tall connection-editor min-height.
  const { body, close } = openCenteredDialog({ title: "Export", width: 420, compact: true });
  let format = "csv";
  body.appendChild(
    el(
      "div",
      { class: "tsql-form-grid" },
      el(
        "label",
        { class: "tsql-field is-full" },
        el("span", { class: "tsql-label", text: "Format" }),
        select(
          [
            { value: "csv", label: "CSV (.csv)" },
            { value: "json", label: "JSON (.json)" },
            { value: "sql", label: "INSERT SQL (.sql)" },
          ],
          format,
          (v) => (format = v),
        ),
      ),
    ),
  );
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
        text: "Save",
        attrs: { type: "button" },
        on: {
          click: async () => {
            try {
              const body = {
                conn: session.connId,
                format,
              };
              if (session.activeTable) {
                body.database = session.activeTable.database;
                body.schema = session.activeTable.schema;
                body.table = session.activeTable.table;
              } else {
                const firstRowStmt = session.result.statements.find((s) => s.kind === "rows");
                if (!firstRowStmt) {
                  throw new Error("No row-producing statement to export.");
                }
                body.sql = firstRowStmt.sql;
                // The same context the query ran in, or unqualified names
                // resolve against whatever a pooled connection last used.
                body.database = session.currentDatabase ?? undefined;
                body.schema = session.currentSchema ?? undefined;
              }
              const resp = await fetchRaw("/export", { method: "POST", body });
              const blob = await resp.blob();
              const rows = Number(resp.headers.get("x-export-rows") ?? 0);
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${session.activeTable?.table ?? "result"}.${resp.headers.get("x-export-extension") ?? format}`;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                try {
                  a.remove();
                } catch {
                  /* ignore */
                }
                URL.revokeObjectURL(url);
              }, 1500);
              close();
              safeToast(
                `Exported ${rows.toLocaleString()} rows as ${a.download}`,
                "success",
              );
            } catch (err) {
              safeToast(`Export failed: ${err?.message ?? err}`, "error");
            }
          },
        },
      }),
    ),
  );
}
