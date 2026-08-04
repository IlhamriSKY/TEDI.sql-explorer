// SQL Explorer — grid/cells: cell rendering, tooltip + the right-click copy
// menu, shared by both the query-result grid and the table-browse grid.
// Bundled into extension.js by build.mjs.
import { appendIcon, cellText, copyToClipboard, el, setTooltipAttr } from "../dom.js";
import { buildInsertSql } from "../sql.js";

export function renderCellTd(value) {
  const td = el("td");
  td.appendChild(renderCellContent(value));
  setTooltipAttr(td, cellTooltip(value));
  return td;
}

export function renderCellContent(value) {
  if (value === null || value === undefined) {
    return el("span", { class: "tsql-cell-null", text: "NULL" });
  }
  if (typeof value === "boolean") {
    return el("span", { class: "tsql-cell-bool", text: value ? "true" : "false" });
  }
  if (typeof value === "number") return document.createTextNode(String(value));
  if (typeof value === "string") return document.createTextNode(value);
  if (value && typeof value === "object" && value.__type === "bytes") {
    const wrap = el("span", { class: "tsql-cell-bytes" });
    appendIcon(wrap, "CodeIcon", { size: 12 });
    wrap.appendChild(document.createTextNode(` ${value.size ?? "?"} bytes`));
    return wrap;
  }
  // A type the helper could not render (a Postgres range, point, tsvector...).
  // Naming it beats both raw JSON and the NULL this used to show, which was
  // indistinguishable from the column actually being empty.
  if (value && typeof value === "object" && value.__type === "unsupported") {
    const wrap = el("span", { class: "tsql-cell-unsupported" });
    appendIcon(wrap, "CircleHelpIcon", { size: 12 });
    wrap.appendChild(document.createTextNode(` ${String(value.pg_type ?? "value").toLowerCase()}`));
    return wrap;
  }
  return document.createTextNode(JSON.stringify(value));
}

export function cellTooltip(value) {
  if (value && typeof value === "object" && value.__type === "bytes") {
    return `Binary value: ${value.size} bytes (double-click to inspect base64)`;
  }
  if (value && typeof value === "object" && value.__type === "unsupported") {
    return `A ${value.pg_type} value is stored here. The helper can't render this type yet — cast it in a query (e.g. SELECT col::text) to read it.`;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value == null ? "NULL" : String(value);
}

/**
 * Build the right-click copy menu for a grid cell: copy the cell, the whole
 * row as TSV, or the row as an INSERT statement. `target` (a `{database,
 * schema, table}` descriptor) enables the INSERT item; pass null to omit it
 * (e.g. a non-editable query result that doesn't map to one base table).
 */
export function gridCopyMenuItems({ columns, row, value, connId, target }) {
  const items = [
    {
      label: "Copy cell",
      icon: "Copy01Icon",
      onClick: () => copyToClipboard(cellText(value), "Cell copied"),
    },
    {
      label: "Copy row",
      icon: "Copy01Icon",
      onClick: () => copyToClipboard(row.map(cellText).join("\t"), "Row copied"),
    },
  ];
  if (target) {
    items.push({
      label: "Copy row as INSERT",
      icon: "Database01Icon",
      onClick: () => {
        const values = {};
        columns.forEach((c, i) => {
          values[c] = row[i];
        });
        copyToClipboard(buildInsertSql(connId, target, values), "INSERT copied");
      },
    });
  }
  return items;
}
