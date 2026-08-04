// SQL Explorer — gridedit/structure: the read-only Structure view.
// Bundled into extension.js by build.mjs.
//
// A workbench's structure view is not just the column list: which indexes
// exist decides whether a query is fast, and which foreign keys exist decides
// what a row is related to. Both, plus the CREATE statement, come straight
// from the sidecar's catalog endpoints — no DDL is generated here.

import { ensurePkColumns } from "../columns.js";
import { openCenteredDialog, renderSqlPreview } from "../dialogs.js";
import { clearChildren, copyToClipboard, el, textBtn } from "../dom.js";
import { fetchJson } from "../sidecar.js";
import { sqlLanguageForSession } from "../sql.js";

/** Shared query string for the per-table catalog endpoints. */
function tableQuery(connId, t) {
  return (
    `conn=${encodeURIComponent(connId)}` +
    `&database=${encodeURIComponent(t.database)}` +
    `&schema=${encodeURIComponent(t.schema)}` +
    `&table=${encodeURIComponent(t.table)}`
  );
}

/** A plain metadata table: `headers` + one array of cells per row. */
function metaTable(headers, rows) {
  const wrap = el("div", { class: "tsql-grid-wrap tsql-structure-wrap" });
  const table = el("table", { class: "tsql-grid tsql-structure-grid" });
  const thead = el("thead");
  const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", { text: h }));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    for (const c of cells) tr.appendChild(el("td", { text: c == null ? "" : String(c) }));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function summary(count, singular, plural = `${singular}s`) {
  return el("div", {
    class: "tsql-structure-summary",
    text: `${count} ${count === 1 ? singular : plural}`,
  });
}

function emptyNote(text) {
  return el("p", { class: "tsql-empty", text });
}

// ----------------------------- Tab bodies ------------------------------------

async function renderColumns(body, session) {
  await ensurePkColumns(session);
  const columns = session._pkCache?.columns;
  if (!Array.isArray(columns) || columns.length === 0) {
    body.replaceChildren(emptyNote("No column metadata available."));
    return;
  }
  const rows = columns.map((c, i) => [
    c.ordinal ?? i + 1,
    c.name,
    c.full_type || c.data_type || "",
    c.nullable === false ? "NO" : "YES",
    c.is_primary ? "PRI" : "",
    c.default_value == null ? "" : c.default_value,
    c.is_auto_increment ? "auto_increment" : "",
  ]);
  body.replaceChildren(
    summary(columns.length, "column"),
    metaTable(["#", "Column", "Type", "Null", "Key", "Default", "Extra"], rows),
  );
}

async function renderIndexes(body, session) {
  const t = session.activeTable;
  const resp = await fetchJson(`/indexes?${tableQuery(session.connId, t)}`);
  const indexes = resp.indexes ?? [];
  if (indexes.length === 0) {
    body.replaceChildren(emptyNote("No indexes on this table."));
    return;
  }
  const rows = indexes.map((i) => [
    i.name,
    (i.columns ?? []).join(", "),
    i.primary ? "PRIMARY" : i.unique ? "UNIQUE" : "INDEX",
    i.method || "",
  ]);
  body.replaceChildren(
    summary(indexes.length, "index", "indexes"),
    metaTable(["Name", "Columns", "Kind", "Method"], rows),
  );
}

async function renderForeignKeys(body, session) {
  const t = session.activeTable;
  const resp = await fetchJson(`/foreign-keys?${tableQuery(session.connId, t)}`);
  const fks = resp.foreign_keys ?? [];
  if (fks.length === 0) {
    body.replaceChildren(emptyNote("No foreign keys on this table."));
    return;
  }
  const rows = fks.map((f) => [
    f.name,
    (f.columns ?? []).join(", "),
    [f.ref_schema, f.ref_table].filter(Boolean).join("."),
    (f.ref_columns ?? []).join(", "),
    f.on_update || "",
    f.on_delete || "",
  ]);
  body.replaceChildren(
    summary(fks.length, "foreign key"),
    metaTable(["Name", "Columns", "References", "Ref columns", "On update", "On delete"], rows),
  );
}

/**
 * The DDL tab's CodeMirror is tracked HERE rather than in the shared
 * `previewEditors` pool: that pool is emptied by every grid render, so a query
 * finishing behind the dialog would destroy this view and leave an empty box.
 * Tracking it locally also means it is disposed when the tab or dialog closes
 * instead of lingering until the next grid render.
 */
let ddlEditor = null;

function disposeDdlEditor() {
  try {
    ddlEditor?.dispose?.();
  } catch {
    // ignore
  }
  ddlEditor = null;
}

async function renderDdl(body, session) {
  const t = session.activeTable;
  const resp = await fetchJson(`/ddl?${tableQuery(session.connId, t)}`);
  const ddl = String(resp.ddl ?? "").trim();
  if (!ddl) {
    body.replaceChildren(emptyNote("No CREATE statement available for this object."));
    return;
  }
  body.replaceChildren(
    el(
      "div",
      { class: "tsql-structure-summary" },
      textBtn("Copy DDL", "Copy01Icon", {
        title: "Copy the CREATE statement",
        onClick: () => copyToClipboard(ddl, "DDL copied"),
      }),
    ),
    el(
      "div",
      { class: "tsql-ddl-wrap" },
      renderSqlPreview(ddl, sqlLanguageForSession(session), (h) => {
        ddlEditor = h;
      }),
    ),
  );
}

// ------------------------------- Dialog --------------------------------------

const TABS = [
  { id: "columns", label: "Columns", render: renderColumns },
  { id: "indexes", label: "Indexes", render: renderIndexes },
  { id: "fks", label: "Foreign keys", render: renderForeignKeys },
  { id: "ddl", label: "DDL", render: renderDdl },
];

/**
 * Read-only "Structure" view: columns, indexes, foreign keys and the CREATE
 * statement for the open table. Available on read-only connections too — none
 * of it writes.
 */
export async function openStructureDialog(session) {
  const target = session.activeTable;
  if (!target) return;
  // Reopening while an editor from a previous Structure dialog is still
  // tracked would strand that EditorView; `onClose` covers the X / Escape /
  // backdrop paths this module never sees.
  disposeDdlEditor();
  const { body } = openCenteredDialog({
    title: `Structure · ${target.table}`,
    width: 760,
    onClose: disposeDdlEditor,
  });

  const tabBar = el("div", { class: "tsql-result-tabs" });
  const content = el("div", { class: "tsql-structure-body" });
  body.appendChild(tabBar);
  body.appendChild(content);

  // Each tab loads on first show; a table with 40 indexes shouldn't cost four
  // catalog round-trips just to look at its columns.
  const show = async (tab, btn) => {
    for (const b of tabBar.querySelectorAll(".tsql-result-tab")) b.classList.remove("is-active");
    btn.classList.add("is-active");
    disposeDdlEditor();
    clearChildren(content);
    content.appendChild(emptyNote("Loading…"));
    try {
      await tab.render(content, session);
    } catch (err) {
      content.replaceChildren(
        el("p", { class: "tsql-error-text", text: `Failed to load: ${err?.message ?? err}` }),
      );
    }
  };

  for (const tab of TABS) {
    const btn = el("button", {
      class: "tsql-result-tab",
      text: tab.label,
      attrs: { type: "button" },
    });
    btn.addEventListener("click", () => void show(tab, btn));
    tabBar.appendChild(btn);
  }
  void show(TABS[0], tabBar.firstChild);
}
