// SQL Explorer — query/run: run + cancel the active query. Bundled by build.mjs.
import { ensureSession } from "../connections.js";
import { openConfirmDialog } from "../dialogs.js";
import { clearChildren, el, safeToast } from "../dom.js";
import { setActionSql } from "../render.js";
import { panelRoot, state } from "../runtime.js";
import { ensureSidecar, fetchJson } from "../sidecar.js";
import { containsDestructive } from "../sql.js";
import { renderQueryResult } from "./results.js";

export async function runActiveQuery() {
  if (!state.active) return;
  const session = ensureSession(state.active);
  if (!session.sql.trim()) return;
  if (containsDestructive(session.sql)) {
    const ok = await openConfirmDialog({
      title: "Run destructive statement?",
      message:
        "This query looks destructive (DROP / TRUNCATE / GRANT). Run it against the connected database?",
      confirmLabel: "Run",
      destructive: true,
    });
    if (!ok) return;
  }
  await ensureSidecar();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session.requestId = requestId;
  session.activeTable = null;
  session.result = null;
  // A typed query isn't a GUI action — clear the middle action-SQL strip
  // (its SQL is already in the editor right above).
  setActionSql(session, null);
  if (panelRoot) {
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) {
      clearChildren(root);
      root.appendChild(el("p", { class: "tsql-empty", text: "Running…" }));
    }
  }
  try {
    const resp = await fetchJson("/query", {
      method: "POST",
      body: {
        conn: session.connId,
        sql: session.sql,
        request_id: requestId,
        // Active database context tracked from the schema tree. Sidecar
        // runs USE <db> (MySQL) / SET search_path (Postgres) on a
        // pinned pool connection so unqualified table names resolve
        // even when the connection has no default_database pinned.
        database: session.currentDatabase ?? undefined,
      },
    });
    session.result = resp;
  } catch (err) {
    session.result = {
      statements: [
        { kind: "error", sql: session.sql, error: err?.message ?? String(err), elapsed_ms: 0 },
      ],
    };
  } finally {
    session.requestId = null;
    if (panelRoot) {
      const root = panelRoot.querySelector("[data-results-root]");
      if (root) renderQueryResult(root, session);
    }
  }
}

export async function cancelActiveQuery() {
  if (!state.active) return;
  const session = state.sessions[state.active];
  if (!session?.requestId) return;
  try {
    await fetchJson("/cancel", { method: "POST", body: { request_id: session.requestId } });
  } catch (err) {
    safeToast(`Cancel failed: ${err?.message ?? err}`, "error");
  }
}
