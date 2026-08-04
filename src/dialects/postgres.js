// SQL Explorer — PostgreSQL dialect descriptor. Bundled by build.mjs.
// See ./mysql.js for the field-by-field contract.

/** @type {import("./types.js").Dialect} */
export const postgres = {
  id: "postgres",
  label: "PostgreSQL",
  shortLabel: "PostgreSQL",
  languageId: "sql:postgres",
  fileBased: false,
  /** PostgreSQL binds ONE database per connection, so the connection's
   *  `database` is the maintenance database it attaches to, not a filter: the
   *  tree still lists every database on the server (pgAdmin / DBeaver both do
   *  this). MySQL has no such split, so there the field narrows the tree. */
  databaseIsConnectTarget: true,
  defaultPort: "5432",
  urlScheme: "postgres",
  quoteChar: '"',
  // Plain EXPLAIN, never ANALYZE: ANALYZE actually RUNS the statement, which
  // would make "show me the plan" execute a DELETE.
  explainPrefix: "EXPLAIN ",
  ssl: {
    param: "sslmode",
    fallback: "require",
    values: {
      preferred: "prefer",
      required: "require",
      verify_ca: "verify-ca",
      verify_full: "verify-full",
    },
  },
  keywords: [
    "SERIAL", "BIGSERIAL", "SMALLSERIAL", "JSONB", "UUID", "ILIKE", "ARRAY",
    "CONFLICT", "INTERVAL", "SIMILAR", "LATERAL", "MATERIALIZED", "FILTER",
    "WINDOW", "TABLESAMPLE", "GENERATED", "ALWAYS", "IDENTITY", "STORED",
  ],
  functions: [
    "TO_CHAR", "TO_DATE", "TO_TIMESTAMP", "AGE", "DATE_TRUNC", "DATE_PART",
    "STRING_AGG", "ARRAY_AGG", "JSONB_BUILD_OBJECT", "JSONB_AGG",
  ],
};
