// SQL Explorer — SQLite dialect descriptor. Bundled by build.mjs.
// See ./mysql.js for the field-by-field contract.
//
// SQLite is file-based: the connection dialog shows a file-path + read-only
// control instead of host/port/user/password, and the url is `sqlite://<path>`
// (or `sqlite::memory:`). It has no TLS, so `ssl` is null.

/** @type {import("./types.js").Dialect} */
export const sqlite = {
  id: "sqlite",
  label: "SQLite",
  shortLabel: "SQLite",
  languageId: "sql:sqlite",
  fileBased: true,
  defaultPort: "",
  urlScheme: "sqlite",
  quoteChar: '"',
  explainPrefix: "EXPLAIN QUERY PLAN ",
  ssl: null,
  keywords: [
    "AUTOINCREMENT", "ROWID", "PRAGMA", "ATTACH", "DETACH", "VACUUM",
    "GLOB", "INDEXED", "ABORT", "FAIL", "IGNORE",
  ],
  functions: [
    "IFNULL", "IIF", "DATETIME", "STRFTIME", "JULIANDAY", "JSON", "JSON_EXTRACT",
  ],
};
