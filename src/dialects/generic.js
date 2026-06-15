// SQL Explorer — generic fallback dialect. Bundled by build.mjs.
//
// Returned by getDialect() for an unknown/unset engine kind so callers never
// have to null-check. Mirrors the historical defaults: ANSI double-quote
// identifiers and the plain "sql" highlight, with no engine-specific words.

/** @type {import("./types.js").Dialect} */
export const generic = {
  id: "sql",
  label: "SQL",
  shortLabel: "SQL",
  languageId: "sql",
  fileBased: false,
  defaultPort: "",
  urlScheme: "",
  quoteChar: '"',
  ssl: null,
  keywords: [],
  functions: [],
};
