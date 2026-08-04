// SQL Explorer — columns module. Bundled into extension.js by build.mjs.
import { fetchJson } from "./sidecar.js";


/** Short type label for a grid header (e.g. "varchar(255)", "int unsigned").
 *  Prefers full_type, falls back to data_type, "" when metadata is missing. */
export function shortTypeLabel(meta) {
  return String(meta?.full_type || meta?.data_type || "").toLowerCase();
}

/** Rich hover tooltip for a column header: type · key · nullability · default. */
export function columnHeaderTooltip(col, meta) {
  if (!meta) return `${col} — click to sort`;
  const bits = [];
  const type = meta.full_type || meta.data_type;
  if (type) bits.push(String(type));
  if (meta.is_primary) bits.push("PRIMARY KEY");
  bits.push(meta.nullable === false ? "NOT NULL" : "nullable");
  if (meta.is_auto_increment) bits.push("auto-increment");
  if (meta.default_value != null && meta.default_value !== "")
    bits.push(`default ${meta.default_value}`);
  return `${col} · ${bits.join(" · ")}`;
}

/**
 * Map a `ColumnInfo` (from `/columns`) to one of the typed cell editor
 * widgets. Recognises:
 *   - boolean      → MySQL `tinyint(1)`, `bool`, `boolean`; PG `bool`
 *   - date         → `date`
 *   - time         → `time`, `timetz`
 *   - datetime     → MySQL `datetime` / `timestamp`; PG `timestamp(tz)`
 *   - integer      → `int*`, `smallint`, `tinyint`, `bigint`, `serial*`, `year`
 *   - number       → `float`, `double`, `real`, `decimal`, `numeric`, `money`
 *   - json         → `json`, `jsonb`
 *   - bytes        → `binary`, `varbinary`, `*blob*`, `bytea`
 *   - { kind: "enum", options } → MySQL `enum('a','b',...)`
 *   - text         → everything else (varchar, char, text, uuid, ...)
 *
 * Pass either the column info object or `null` when the type is unknown
 * (falls back to `"text"`).
 */
export function classifyColumnType(colInfo) {
  const dt = String(colInfo?.data_type ?? "").toLowerCase();
  const ft = String(colInfo?.full_type ?? "").toLowerCase();
  if (!dt && !ft) return "text";
  if (dt === "bool" || dt === "boolean") return "boolean";
  // MySQL convention: TINYINT(1) is the canonical bool storage.
  if (dt === "tinyint" && /\btinyint\(1\)/.test(ft)) return "boolean";
  // ENUM('a','b','c') → dropdown sourced from the type spec.
  if (dt === "enum") {
    const m = ft.match(/^enum\((.+)\)$/);
    if (m) {
      const opts = [];
      const re = /'((?:[^']|'')*)'/g;
      let mm;
      while ((mm = re.exec(m[1])) !== null) opts.push(mm[1].replace(/''/g, "'"));
      if (opts.length) return { kind: "enum", options: opts };
    }
  }
  if (dt === "date") return "date";
  if (dt === "time" || dt === "timetz" || dt.startsWith("time without")) return "time";
  if (
    dt === "datetime" ||
    dt === "timestamp" ||
    dt === "timestamptz" ||
    dt.startsWith("timestamp ")
  ) {
    return "datetime";
  }
  if (/^(smallint|mediumint|int|integer|bigint|tinyint|int2|int4|int8|serial|smallserial|bigserial|year)$/.test(dt)) {
    return "integer";
  }
  if (/^(float|double|real|float4|float8|decimal|numeric|money)$/.test(dt)) {
    return "number";
  }
  if (/json/.test(dt)) return "json";
  if (/binary|blob|bytea/.test(dt)) return "bytes";
  return "text";
}

/** True for a value the grid shows as a chip rather than text: a binary blob,
 *  or a type the helper could not render. Neither can be edited inline — there
 *  is no text form to hand the editor, and committing would write the marker
 *  object back as the cell's value. */
export function isBytesCell(value) {
  return (
    !!value &&
    typeof value === "object" &&
    (value.__type === "bytes" || value.__type === "unsupported")
  );
}

/** Convert a server-side ISO timestamp to the format the matching HTML5
 *  input expects. `kind` is one of `"date" | "time" | "datetime"`. */
export function isoToInputValue(kind, value) {
  if (value == null) return "";
  const s = String(value);
  if (kind === "date") return s.slice(0, 10);
  if (kind === "time") {
    // Accept "HH:MM:SS" or "HH:MM:SS.sss" or full ISO; trim to "HH:MM:SS".
    const m = s.match(/(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : s;
  }
  // datetime: drop any TZ suffix; datetime-local needs YYYY-MM-DDTHH:MM(:SS).
  const t = s.replace(/[zZ]$/, "").replace(/[+-]\d{2}:?\d{2}$/, "");
  // Convert "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS" for the input.
  return t.includes("T") ? t : t.replace(" ", "T");
}

/** Convert the value coming out of an HTML5 date/time/datetime input back
 *  to the canonical text the SQL backend accepts. The widget already yields
 *  that form (YYYY-MM-DD, HH:MM(:SS), YYYY-MM-DDTHH:MM(:SS)); only the empty
 *  field needs mapping to NULL. */
export function inputValueToIso(value) {
  return value === "" ? null : value;
}

/** True for the small set of values a boolean cell can carry across the
 *  number/bool/string boundary (tinyint(1), pg bool, sqlite int). */
function isBoolish(v) {
  return v === true || v === false || v === 0 || v === 1 || v === "0" || v === "1";
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // A tinyint(1) bool round-trips as numeric 1/0 on save but may have arrived
  // as JS true/false (or "1"/"0"). Compare the logical boolean value so an
  // unchanged bool cell doesn't trip the "value changed" check and fire a
  // spurious no-op UPDATE.
  if (isBoolish(a) && isBoolish(b)) {
    return (a === true || a === 1 || a === "1") === (b === true || b === 1 || b === "1");
  }
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Fetch the `/columns` metadata (name, data_type, full_type, nullable,
 *  is_primary, ...) for a `{ database, schema, table }` target on a
 *  connection. The raw sidecar response (`{ columns: [...] }`). */
export async function fetchTableColumns(connId, target) {
  return fetchJson(
    `/columns?conn=${encodeURIComponent(connId)}&database=${encodeURIComponent(target.database)}&schema=${encodeURIComponent(target.schema)}&table=${encodeURIComponent(target.table)}`,
  );
}

export async function ensurePkColumns(session) {
  const t = session.activeTable;
  // Key by the fully-qualified identifier (matching schemaCache / _qcols) so
  // two same-named tables in different databases/schemas don't return each
  // other's PK + column metadata, which would build a wrong WHERE on edit.
  const key = `${t.database}.${t.schema}.${t.table}`;
  if (session._pkCache?.key === key) return session._pkCache.pks;
  const resp = await fetchTableColumns(session.connId, t);
  const pks = resp.columns.filter((c) => c.is_primary).map((c) => c.name);
  session._pkCache = { key, pks, columns: resp.columns };
  return pks;
}
