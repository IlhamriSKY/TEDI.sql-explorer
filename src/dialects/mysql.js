// SQL Explorer — MySQL / MariaDB dialect descriptor. Bundled by build.mjs.
//
// A dialect is plain data: the registry (./index.js) and pure helpers read
// these fields, so adding a new engine never means touching call sites — drop
// a sibling file like this one and register it in ./index.js.

/** @type {import("./types.js").Dialect} */
export const mysql = {
  id: "mysql",
  /** Long label for the connection dialog's engine <select>. */
  label: "MySQL / MariaDB",
  /** Short tag for the sidebar badge + connection subtitle. */
  shortLabel: "MySQL",
  /** ctx.ui.codeEditor language id (syntax highlight). */
  languageId: "sql:mysql",
  /** false → host/port/user/password/database form; true → file picker. */
  fileBased: false,
  /** Placeholder shown in the Port field. */
  defaultPort: "3306",
  /** sqlx connection-url scheme. */
  urlScheme: "mysql",
  /** Identifier quote char; doubled when it appears inside an identifier. */
  quoteChar: "`",
  /** Prefix that turns a statement into its execution plan. */
  explainPrefix: "EXPLAIN ",
  /** TLS: how the `sslMode` form value maps onto the connection url. */
  ssl: {
    param: "ssl-mode",
    fallback: "REQUIRED",
    values: {
      preferred: "PREFERRED",
      required: "REQUIRED",
      verify_ca: "VERIFY_CA",
      verify_full: "VERIFY_IDENTITY",
    },
  },
  /** Engine-specific autocomplete additions (on top of the common set). */
  keywords: [
    "AUTO_INCREMENT", "UNSIGNED", "ZEROFILL", "ENGINE", "CHARSET", "COLLATE",
    "MEDIUMINT", "LONGBLOB", "MEDIUMBLOB", "TINYBLOB", "ENUM", "DUAL", "USE",
    "LOCK", "UNLOCK", "DELIMITER", "STRAIGHT_JOIN", "STORAGE", "MEMORY",
    "INNODB", "MYISAM",
  ],
  functions: [
    "DATE_ADD", "DATE_SUB", "DATEDIFF", "TIMESTAMPDIFF", "IFNULL", "IF",
    "FIND_IN_SET", "GROUP_CONCAT", "JSON_EXTRACT", "JSON_OBJECT", "JSON_ARRAY",
  ],
};
