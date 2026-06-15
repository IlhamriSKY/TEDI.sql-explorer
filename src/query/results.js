// SQL Explorer — query/results: render a /query response (one or many
// statements) into the results pane. Bundled into extension.js by build.mjs.
import { disposePreviewEditors, renderSqlPreview } from "../dialogs.js";
import { clearChildren, el } from "../dom.js";
import { renderResultGrid } from "../grid.js";
import { sqlLanguageForSession } from "../sql.js";

export function renderQueryResult(container, session) {
  clearChildren(container);
  disposePreviewEditors();
  if (!session.result?.statements?.length) {
    container.appendChild(el("p", { class: "tsql-empty", text: "No statements ran." }));
    return;
  }
  const statements = session.result.statements;
  const language = sqlLanguageForSession(session);
  const content = el("div", { class: "tsql-result-body" });
  // Hide the tab strip for the common single-statement case so the meta
  // line in renderStatementDetail can carry the row count + duration on
  // its own without a redundant tab pill.
  if (statements.length > 1) {
    const tabs = el("div", { class: "tsql-result-tabs" });
    statements.forEach((stmt, idx) => {
      const tab = el("button", {
        class: `tsql-result-tab${idx === 0 ? " is-active" : ""}`,
        text: tabLabel(stmt),
        attrs: { type: "button" },
        on: {
          click: () => {
            tabs.querySelectorAll(".tsql-result-tab").forEach((t) => t.classList.remove("is-active"));
            tab.classList.add("is-active");
            renderStatementDetail(content, stmt, language, session);
          },
        },
      });
      tabs.appendChild(tab);
    });
    container.appendChild(tabs);
  }
  container.appendChild(content);
  renderStatementDetail(content, statements[0], language, session);
}

function tabLabel(stmt) {
  if (stmt.kind === "rows") return `${stmt.rows.length} rows · ${stmt.elapsed_ms} ms`;
  if (stmt.kind === "exec") return `${stmt.rows_affected} affected · ${stmt.elapsed_ms} ms`;
  return `error · ${stmt.elapsed_ms} ms`;
}

function renderStatementDetail(container, stmt, language, session) {
  clearChildren(container);
  // Re-rendering this slot (fresh result or a statement-tab switch) drops
  // the prior preview editor's DOM; destroy the EditorView too so it
  // doesn't linger.
  disposePreviewEditors();
  if (stmt.kind === "rows") {
    renderResultGrid(container, {
      sql: stmt.sql,
      columns: stmt.columns.map((c) => c.name),
      rows: stmt.rows,
      elapsedMs: stmt.elapsed_ms,
      truncated: stmt.truncated,
      language,
      session,
    });
    return;
  }
  if (stmt.kind === "exec") {
    const meta = el("div", { class: "tsql-result-meta" });
    meta.appendChild(
      el("span", { text: `${stmt.rows_affected} affected · ${stmt.elapsed_ms} ms` }),
    );
    container.appendChild(meta);
    container.appendChild(renderSqlPreview(stmt.sql, language));
    return;
  }
  if (stmt.kind === "error") {
    const meta = el("div", { class: "tsql-result-meta" });
    meta.appendChild(
      el("span", { class: "tsql-error-line", text: `Error · ${stmt.elapsed_ms} ms` }),
    );
    container.appendChild(meta);
    container.appendChild(el("pre", { class: "tsql-error-text", text: stmt.error }));
    container.appendChild(renderSqlPreview(stmt.sql, language));
  }
}
