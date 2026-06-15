// SQL Explorer — dialect type contract (JSDoc only; no runtime code).
// Documents the shape every descriptor in this folder must satisfy so the
// registry + helpers can stay fully data-driven. Bundled by build.mjs (emits
// nothing).

/**
 * @typedef {Object} DialectSsl
 * @property {string} param            URL query param name (e.g. "sslmode").
 * @property {string} fallback         Value used when a mode isn't mapped.
 * @property {Record<string,string>} values  formMode → url value.
 */

/**
 * A database engine, described as plain data. Adding an engine = add one file
 * exporting an object of this shape and register it in ./index.js.
 *
 * @typedef {Object} Dialect
 * @property {string} id            Stable engine key (matches connection.kind).
 * @property {string} label         Long name for the engine <select>.
 * @property {string} shortLabel    Short name for the sidebar badge/subtitle.
 * @property {string} languageId    ctx.ui.codeEditor language id.
 * @property {boolean} fileBased    File path form (SQLite) vs host/port form.
 * @property {string} defaultPort   Port field placeholder ("" when file-based).
 * @property {string} urlScheme     sqlx connection-url scheme.
 * @property {string} quoteChar     Identifier quote char (doubled when nested).
 * @property {DialectSsl|null} ssl  TLS url mapping, or null when unsupported.
 * @property {string[]} keywords    Engine-specific autocomplete keywords.
 * @property {string[]} functions   Engine-specific autocomplete functions.
 */

export {};
