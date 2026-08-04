// SQL Explorer — query/run: run + cancel the active query. Bundled by build.mjs.
import { ensureSession } from "../connections.js";
import { getDialect } from "../dialects/index.js";
import { openConfirmDialog } from "../dialogs.js";
import { clearChildren, el, safeToast } from "../dom.js";
import { setActionSql } from "../render.js";
import { panelRoot, state } from "../runtime.js";
import { ensureSidecar, fetchJson } from "../sidecar.js";
import { destructiveReason, sqlLanguageForSession } from "../sql.js";
import { record } from "./history.js";
import { renderQueryResult } from "./results.js";

/**
 * The SQL a Run should send: the selection when the user highlighted one,
 * otherwise the whole editor.
 *
 * Running only what you highlighted is standard in every SQL console, and it
 * is the difference between iterating on one statement inside a long script
 * and re-running the whole script every time. Needs the host's
 * `codeEditor.getSelection` (TEDI >= 0.4.9); older hosts fall back to the
 * whole editor, which is the previous behaviour.
 */
function activeSql(session) {
  const selected = (state.editorHandle?.getSelection?.() ?? "").trim();
  return selected || session.sql;
}

/** True when `sql` holds more than one statement (a `;` with anything after
 *  it). Used to keep Explain from running the statements it can't explain. */
function hasMultipleStatements(sql) {
  return /;\s*\S/.test(String(sql ?? "").trim());
}

export async function runActiveQuery(opts = {}) {
  if (!state.active) return;
  const session = ensureSession(state.active);
  let sql = activeSql(session).trim();
  if (!sql) return;

  if (opts.explain) {
    if (hasMultipleStatements(sql)) {
      safeToast("Select a single statement to explain.", "warning");
      return;
    }
    const kind = state.connections.find((c) => c.id === session.connId)?.kind;
    // Strip the trailing `;` first so the prefix produces one valid statement.
    sql = `${getDialect(kind).explainPrefix}${sql.replace(/;\s*$/, "")}`;
  } else {
    // Show the statement in the modal, not just a warning about it: the point
    // of the confirmation is to read what is about to run.
    const reason = destructiveReason(sql);
    if (reason) {
      const ok = await openConfirmDialog({
        title: "Run this statement?",
        message: reason,
        sql,
        language: sqlLanguageForSession(session),
        confirmLabel: "Run",
        destructive: true,
      });
      if (!ok) return;
    }
  }

  await ensureSidecar();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session.requestId = requestId;
  session.activeTable = null;
  session.result = null;
  // A typed query isn't a GUI action — clear the middle action-SQL strip
  // (its SQL is already in the editor right above). An Explain is the
  // exception: what ran is NOT what is in the editor, so show it.
  setActionSql(session, opts.explain ? sql : null);
  if (panelRoot) {
    const root = panelRoot.querySelector("[data-results-root]");
    if (root) {
      clearChildren(root);
      root.appendChild(
        el("p", { class: "tsql-empty", text: opts.explain ? "Explaining…" : "Running…" }),
      );
    }
  }
  try {
    const resp = await fetchJson("/query", {
      method: "POST",
      body: {
        conn: session.connId,
        sql,
        request_id: requestId,
        // Active database + schema context tracked from the schema tree.
        // MySQL resolves unqualified names through `USE <database>`;
        // PostgreSQL through `search_path`, which takes the SCHEMA (the
        // database only selects which per-database pool answers).
        database: session.currentDatabase ?? undefined,
        schema: session.currentSchema ?? undefined,
      },
    });
    session.result = resp;
    // Record only what the server accepted, and only the user's own SQL —
    // an Explain is a wrapper this module built, not something to replay.
    if (!opts.explain) void record(session.connId, sql);
  } catch (err) {
    session.result = {
      statements: [{ kind: "error", sql, error: err?.message ?? String(err), elapsed_ms: 0 }],
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
    const resp = await fetchJson("/cancel", {
      method: "POST",
      body: { request_id: session.requestId },
    });
    // The helper drops its end of the socket either way; `server_canceled`
    // tells us it also told the database to stop, which is what actually
    // releases the locks a long UPDATE is holding.
    if (resp?.canceled && !resp?.server_canceled) {
      safeToast("Stopped waiting — the server may still be running the statement.", "warning");
    }
  } catch (err) {
    safeToast(`Cancel failed: ${err?.message ?? err}`, "error");
  }
}
