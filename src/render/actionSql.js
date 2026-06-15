// SQL Explorer — render/actionSql: the middle "action-SQL" strip — a read-only,
// syntax-highlighted view of the SQL a GUI action (open table / edit / delete /
// insert) just ran, so a click is as transparent as a typed query. Bundled by
// build.mjs.
import { renderSqlPreview } from "../dialogs.js";
import { el } from "../dom.js";
import { panelRoot, state } from "../runtime.js";
import { sqlLanguageForSession } from "../sql.js";

/** Dispose just the middle action-SQL strip's editor. Kept off
 *  disposePreviewEditors so bottom-grid redraws don't kill it. Idempotent. */
export function disposeActionSqlEditor() {
  try {
    state.actionSqlEditor?.dispose?.();
  } catch {
    // ignore
  }
  state.actionSqlEditor = null;
}

/** The middle strip: a read-only, syntax-highlighted view of the SQL the last
 *  GUI action ran, so a click / edit / delete is as transparent as a typed
 *  query. Disposes the prior strip editor up front (this fn is the single
 *  build path for both full rebuilds and setActionSql's in-place replace). */
export function renderActionSqlStrip(session) {
  disposeActionSqlEditor();
  const strip = el("div", { class: "tsql-action-sql" });
  strip.appendChild(el("span", { class: "tsql-action-sql-label", text: "Query:" }));
  strip.appendChild(
    // `track` routes the handle to the singleton + suppresses the hover tooltip
    // (this is the always-visible middle strip, not a one-off preview).
    renderSqlPreview(session.actionSql, sqlLanguageForSession(session), (h) => {
      state.actionSqlEditor = h;
    }),
  );
  return strip;
}

/**
 * Update the middle action-SQL strip in place (no full rebuild, so the grid /
 * editor don't churn). `sql` falsy removes the strip. Used by GUI actions that
 * render in place (edit / delete / table load).
 */
export function setActionSql(session, sql) {
  session.actionSql = sql || null;
  if (!panelRoot) return;
  const main = panelRoot.querySelector(".tsql-main");
  if (!main) return;
  const existing = main.querySelector(":scope > .tsql-action-sql");
  if (!session.actionSql) {
    existing?.remove();
    disposeActionSqlEditor();
    return;
  }
  const fresh = renderActionSqlStrip(session);
  if (existing) {
    main.replaceChild(fresh, existing);
  } else {
    const results = main.querySelector(":scope > .tsql-results");
    if (results) main.insertBefore(fresh, results);
    else main.appendChild(fresh);
  }
}
