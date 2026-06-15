// SQL Explorer — render/panel: the pane shell + the stacked editor/results
// layout (toolbar, CodeMirror query editor, drag splitter, action-SQL strip,
// results root). Bundled into extension.js by build.mjs.
import { ensureSession } from "../connections.js";
import { disposePreviewEditors } from "../dialogs.js";
import { appendIcon, clearChildren, closeAllSelectMenus, el, textBtn } from "../dom.js";
import { openExportDialog } from "../export.js";
import { renderTableGrid } from "../grid.js";
import { cancelActiveQuery, renderQueryResult, runActiveQuery } from "../query.js";
import { ctx, panelRoot, state } from "../runtime.js";
import { isReadOnly, sqlLanguageForSession } from "../sql.js";
import { disposeActionSqlEditor, renderActionSqlStrip } from "./actionSql.js";
import { buildSchemaCompletions } from "./completions.js";

export function renderPanel(container) {
  // The connection list + schema tree now live in TEDI's left "Databases"
  // sidebar, so the panel itself is just the stacked query-editor + results
  // body — no in-pane sidebar, no own header. That makes it read as a native
  // pane (the host pane frame supplies the title + drag + close). The
  // `.tsql-body` wrapper is kept so `rerenderMain()` can swap `.tsql-main`.
  const root = el("div", { class: "tsql-root" });
  const body = el("div", { class: "tsql-body" });
  body.appendChild(renderMainArea());
  root.appendChild(body);
  container.appendChild(root);
}

export function rerender() {
  if (!panelRoot) return;
  // Modals live on document.body (viewport-centered, immune to pane clipping),
  // so a panel-body rebuild leaves any open dialog untouched.
  clearChildren(panelRoot);
  renderPanel(panelRoot);
}

/**
 * Rebuild only the main area (the stacked query-editor + results), leaving the
 * panel shell in place. Used by table-open and grid refreshes so they don't
 * tear down the whole pane. Falls back to a full rerender if the body layout
 * isn't present yet.
 */
export function rerenderMain() {
  if (!panelRoot) return;
  // A dropdown (e.g. the grid column-filter) may be open over the area we're
  // about to replace; close it so its menu node + document listeners don't
  // orphan when its trigger is detached.
  closeAllSelectMenus();
  const body = panelRoot.querySelector(".tsql-body");
  const oldMain = body?.querySelector(":scope > .tsql-main");
  if (!body || !oldMain) {
    rerender();
    return;
  }
  body.replaceChild(renderMainArea(), oldMain);
}

function renderMainArea() {
  if (!state.active) {
    return el(
      "section",
      { class: "tsql-main tsql-main--empty" },
      el("p", { class: "tsql-empty", text: "Select a connection on the left to start." }),
    );
  }
  return renderEditorAndResults(ensureSession(state.active));
}

/**
 * The pane's main area, stacked top-to-bottom: the query editor (CodeMirror),
 * a drag splitter, the middle action-SQL strip (the SQL a GUI action ran), and
 * the results / table grid under `[data-results-root]`. Opening a table or
 * running a query rebuilds just this area via `rerenderMain`.
 */
export function renderEditorAndResults(session) {
  // The previous CodeMirror mount is detached once this area is rebuilt;
  // dispose it (and any read-only SQL previews) up front so EditorViews don't
  // leak across a connection switch / remount.
  if (state.editorHandle && typeof state.editorHandle.dispose === "function") {
    try {
      state.editorHandle.dispose();
    } catch {
      // ignore
    }
    state.editorHandle = null;
  }
  disposePreviewEditors();
  // If this rebuild has no action-SQL strip, renderActionSqlStrip won't run to
  // self-dispose the prior strip editor — drop it here so it never leaks.
  disposeActionSqlEditor();

  const wrap = el("div", { class: "tsql-main" });

  // --- Top: query editor + toolbar ---
  const toolbar = el(
    "div",
    { class: "tsql-toolbar" },
    textBtn("Run", "PlayIcon", {
      primary: true,
      title: "Run query (Ctrl+Enter)",
      onClick: () => runActiveQuery(),
    }),
    textBtn("Stop", "SquareIcon", {
      title: "Cancel current statement",
      onClick: () => cancelActiveQuery(),
    }),
    textBtn("Export", "Download01Icon", {
      title: "Export current result",
      onClick: () => openExportDialog(),
    }),
  );
  if (isReadOnly(session.connId)) {
    const pill = el("span", {
      class: "tsql-ro-pill",
      attrs: { title: "This connection is read-only — inserts, edits and deletes are disabled." },
    });
    appendIcon(pill, "SquareLock02Icon", { size: 11 });
    pill.appendChild(el("span", { text: "Read only" }));
    toolbar.appendChild(pill);
  }
  wrap.appendChild(toolbar);

  const editorWrap = el("div", { class: "tsql-editor" });
  wrap.appendChild(editorWrap);
  const language = sqlLanguageForSession(session);
  try {
    state.editorHandle = ctx.ui.codeEditor(editorWrap, {
      language,
      value: session.sql ?? "",
      onChange: (v) => {
        session.sql = v;
      },
      onCmdEnter: () => runActiveQuery(),
      completions: (prefix) => buildSchemaCompletions(session, prefix),
    });
  } catch (err) {
    ctx?.logger?.error?.("codeEditor mount failed", err);
    editorWrap.appendChild(
      el("p", { class: "tsql-empty", text: "Code editor unavailable. Update TEDI to >= 0.3.9." }),
    );
  }

  // --- Splitter (resize the editor height; the bottom takes the rest) ---
  const splitter = el("div", {
    class: "tsql-splitter",
    attrs: {
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-label": "Resize query editor",
      tabindex: "0",
    },
  });
  wrap.appendChild(splitter);
  if (session.editorHeightPx) {
    wrap.style.setProperty("--tsql-editor-h", `${session.editorHeightPx}px`);
  }
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const editorEl = wrap.querySelector(".tsql-editor");
    if (!editorEl) return;
    const splitterH = splitter.offsetHeight;
    const minEditor = 80;
    const minResults = 120;
    const onMove = (ev) => {
      const top = editorEl.getBoundingClientRect().top;
      const mainBottom = wrap.getBoundingClientRect().bottom;
      const stripH = wrap.querySelector(".tsql-action-sql")?.offsetHeight ?? 0;
      const maxEditor = mainBottom - top - splitterH - stripH - minResults;
      const clamped = Math.max(minEditor, Math.min(Math.max(minEditor, maxEditor), ev.clientY - top));
      wrap.style.setProperty("--tsql-editor-h", `${clamped}px`);
      session.editorHeightPx = clamped;
    };
    const onUp = () => {
      splitter.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { splitter.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    splitter.classList.add("is-dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    e.preventDefault();
  });
  splitter.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const cur =
      parseFloat(getComputedStyle(wrap).getPropertyValue("--tsql-editor-h")) ||
      wrap.querySelector(".tsql-editor")?.offsetHeight ||
      0;
    const step = e.key === "ArrowUp" ? -16 : 16;
    const next = Math.max(80, cur + step);
    wrap.style.setProperty("--tsql-editor-h", `${next}px`);
    session.editorHeightPx = next;
    e.preventDefault();
  });

  // --- Middle: the SQL a GUI action ran (open table / edit / delete /
  //     insert). Cleared for editor-run queries — their SQL is in the editor. ---
  if (session.actionSql) wrap.appendChild(renderActionSqlStrip(session));

  // --- Bottom: results — the browsed table grid OR a free-form query result. ---
  const results = el("div", { class: "tsql-results", attrs: { "data-results-root": "1" } });
  if (session.activeTable) {
    renderTableGrid(results, session);
  } else if (session.result) {
    renderQueryResult(results, session);
  } else {
    results.appendChild(
      el("p", { class: "tsql-empty", text: "Open a table from the sidebar, or run a query above." }),
    );
  }
  wrap.appendChild(results);
  return wrap;
}
