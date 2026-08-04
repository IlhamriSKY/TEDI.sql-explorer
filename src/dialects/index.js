// SQL Explorer — dialect registry + pure helpers. Bundled by build.mjs.
//
// Single source of truth for every per-engine difference (quoting, connection
// url, TLS, autocomplete vocabulary, labels). UI/SQL modules import from here
// instead of branching on `kind` inline, so supporting a new database is a
// one-file change: add `./<engine>.js` and list it in DIALECTS below.

import { mysql } from "./mysql.js";
import { postgres } from "./postgres.js";
import { sqlite } from "./sqlite.js";
import { generic } from "./generic.js";
import { COMMON_FUNCTIONS, COMMON_KEYWORDS, COMMON_TYPES } from "./sqlWords.js";

export { COMMON_FUNCTIONS, COMMON_KEYWORDS, COMMON_TYPES };

/** Registered engines, in the order they appear in the engine <select>.
 *  Private: `listDialects()` is the accessor, so a caller can't reorder it. */
const DIALECTS = [mysql, postgres, sqlite];

const BY_ID = Object.fromEntries(DIALECTS.map((d) => [d.id, d]));

/** Resolve a connection.kind to its descriptor; `generic` for unknown kinds. */
export function getDialect(kind) {
  return BY_ID[kind] || generic;
}

/** All registered descriptors — drives the engine <select> and any per-engine
 *  UI. Returns the live ordered array (do not mutate). */
export function listDialects() {
  return DIALECTS;
}

/** Quote an identifier for `dialect`, doubling any embedded quote char per the
 *  SQL spec (display-only — the sidecar runs parameterized statements). */
export function quoteIdent(dialect, name) {
  const q = dialect.quoteChar;
  const s = String(name ?? "");
  return q + s.split(q).join(q + q) + q;
}

/** Map a `sslMode` form value onto the connection-url TLS query string. Empty
 *  for "none" or engines without TLS (SQLite). */
function sslParam(dialect, sslMode) {
  if (!sslMode || sslMode === "none" || !dialect.ssl) return "";
  const value = dialect.ssl.values[sslMode] ?? dialect.ssl.fallback;
  return `?${dialect.ssl.param}=${value}`;
}

/** Build the sqlx connection url from a connection-dialog `form`. File-based
 *  engines (SQLite) use `<scheme>://<path>` / `<scheme>::memory:`; server
 *  engines use `<scheme>://user:pass@host:port/db?<ssl>`. Credentials and the
 *  database segment are URL-encoded. */
export function buildConnectionUrl(dialect, form) {
  if (dialect.fileBased) {
    const path = (form.sqlitePath || "").replace(/\\/g, "/");
    if (path === ":memory:") return `${dialect.urlScheme}::memory:`;
    const ro = form.sqliteReadOnly ? "?mode=ro" : "";
    return `${dialect.urlScheme}://${path}${ro}`;
  }
  const ssl = sslParam(dialect, form.sslMode);
  const port = form.port ? `:${form.port}` : "";
  const user = encodeURIComponent(form.user || "");
  const pass = form.password ? `:${encodeURIComponent(form.password)}` : "";
  const cred = user ? `${user}${pass}@` : "";
  const db = form.database ? `/${encodeURIComponent(form.database)}` : "";
  return `${dialect.urlScheme}://${cred}${form.host}${port}${db}${ssl}`;
}
