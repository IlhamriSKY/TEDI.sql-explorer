// SQL Explorer — query/sqlRefs: parse the table(s) a statement touches and
// decide whether a SELECT maps 1:1 to one editable base table. Pure string +
// schema-cache logic, no host calls. Bundled into extension.js by build.mjs.

/**
 * Extracts table identifiers from the free-form SQL the user is typing.
 * Strips comments and string literals first so a `'-- foo'` or `'INTO bar'`
 * inside a string doesn't fire a false match. Recognises the usual table
 * positions: FROM, JOIN (all variants), UPDATE, INSERT INTO, DELETE FROM,
 * TRUNCATE, CREATE/ALTER/DROP TABLE. Identifiers may be quoted (` " [ ])
 * and may carry up to two qualifiers (`db.schema.table`).
 *
 * Returns `[{ raw, parts: [..lower] }]` — the caller resolves each ref
 * against `session.schemaCache`.
 */
export function parseSqlReferences(sql) {
  if (!sql) return [];
  let clean = String(sql);
  // Strip comments before strings; a `--` inside a string literal isn't
  // actually a comment, but stripping strings first would chew up that
  // literal anyway, so order is mostly cosmetic for the regex output.
  clean = clean.replace(/--[^\r\n]*/g, " ");
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Strip string literals so a `WHERE name = 'FROM users'` doesn't trip.
  clean = clean.replace(/'(?:''|[^'])*'/g, "''");
  // Double-quoted strings are ambiguous (Postgres treats them as identifiers,
  // MySQL as strings). We keep them so qualified `"db"."table"` survives.
  // Match keyword(s) + qualified identifier. Identifier tokens accept the
  // four common quoting styles. {0,2} caps qualifier depth at three (db.
  // schema.table).
  const ident = `(?:\`[^\`]+\`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)`;
  const re = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|(?:CREATE|ALTER|DROP)\\s+TABLE)\\b\\s+(${ident}(?:\\s*\\.\\s*${ident}){0,2})`,
    "gi",
  );
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(clean)) !== null) {
    const raw = m[1].trim();
    const parts = raw
      .split(/\s*\.\s*/)
      .map((p) => p.replace(/^[`"[]|[`"\]]$/g, ""))
      .map((p) => p.toLowerCase());
    const key = parts.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, parts });
  }
  return out;
}

/** Resolves a list of parsed references against the session's schema
 *  cache. Returns the best matching cache entry, or `null` if nothing
 *  matches. Preference order:
 *    1. Fully-qualified `db.schema.table` matches the input qualifiers
 *    2. Two-part input matches by `db` OR `schema`
 *    3. Bare table name — first cached entry wins, but with a bias toward
 *       the session's currently-expanded database so a user typing
 *       `users` against an already-expanded `app` DB resolves to `app`'s
 *       users table, not some other DB's. */
export function findCachedMatch(session, refs) {
  const cache = session?.schemaCache;
  if (!cache || cache.size === 0) return null;
  const current = (session.currentDatabase || "").toLowerCase();
  for (const ref of refs) {
    const tableName = ref.parts[ref.parts.length - 1];
    if (!tableName) continue;
    const candidates = [];
    for (const entry of cache.values()) {
      if ((entry.table || "").toLowerCase() === tableName) candidates.push(entry);
    }
    if (candidates.length === 0) continue;
    if (ref.parts.length >= 3) {
      const [db, sch] = ref.parts;
      const exact = candidates.find(
        (e) => (e.database || "").toLowerCase() === db && (e.schema || "").toLowerCase() === sch,
      );
      if (exact) return exact;
    }
    if (ref.parts.length === 2) {
      const qual = ref.parts[0];
      const exact = candidates.find(
        (e) => (e.database || "").toLowerCase() === qual || (e.schema || "").toLowerCase() === qual,
      );
      if (exact) return exact;
    }
    if (current) {
      const inCurrent = candidates.find((e) => (e.database || "").toLowerCase() === current);
      if (inCurrent) return inCurrent;
    }
    return candidates[0];
  }
  return null;
}

/** True for a single-table `SELECT` whose rows map 1:1 to base-table rows.
 *  Comments + string literals are stripped first so keywords inside them
 *  don't trip the guards. Rejects joins (keyword + comma), set operations,
 *  GROUP BY / HAVING, and DISTINCT, which all break the row-to-row mapping
 *  inline editing relies on. */
export function isSingleTableSelect(sql) {
  const clean = String(sql || "")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
  if (!/^\s*select\b/i.test(clean)) return false;
  if (/\bjoin\b/i.test(clean)) return false;
  if (/\bgroup\s+by\b/i.test(clean)) return false;
  if (/\bhaving\b/i.test(clean)) return false;
  if (/\bdistinct\b/i.test(clean)) return false;
  if (/\b(union|intersect|except)\b/i.test(clean)) return false;
  // Comma (cross) join inside the FROM clause → more than one table.
  const from = /\bfrom\b([\s\S]*?)(\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|\bwindow\b|$)/i.exec(clean);
  if (from && from[1].includes(",")) return false;
  return true;
}
