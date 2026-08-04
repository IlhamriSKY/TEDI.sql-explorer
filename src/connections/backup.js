// SQL Explorer — connections/backup: export / import every saved connection as
// one passphrase-encrypted `.tedi-sql` file, so moving to another machine is
// one import instead of retyping every host and password.
//
// Mirrors the host's own `.tedi-ssh` backup (src/modules/ssh/backup.ts) on
// purpose, down to the sealed-blob shape: the passwords live in the OS keychain
// and CANNOT travel with the settings file on their own, which is exactly why
// this exists and why the file is always encrypted. A plaintext export would be
// a credential leak the moment it touched Downloads or a synced folder.
//
// Sealing runs in the host process (`backup_seal` / `backup_open`, gated by the
// matching `invoke:` permissions): `crypto.subtle` is unavailable to the webview
// because the app origin is plain http.
//
// Bundled into extension.js by build.mjs.
import { listDialects } from "../dialects/index.js";
import { ctx, state } from "../runtime.js";
import { deleteSecret, getSecret, persistConnections, setSecret } from "./store.js";

export const BACKUP_KIND = "tedi-sql-connections";
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = "tedi-sql";

/** True when this TEDI exposes the seal/open commands at all. */
export function backupSupported() {
  return typeof ctx?.invoke === "function";
}

/**
 * Serialize every saved connection plus its keychain password into file text.
 * Returns the count alongside it so the caller can say what it wrote without
 * parsing the JSON back out.
 */
export async function buildBackup(passphrase) {
  if (!passphrase) throw new Error("A passphrase is required.");
  const connections = state.connections ?? [];
  if (connections.length === 0) throw new Error("There are no saved connections to export.");

  const secrets = {};
  for (const c of connections) {
    // SQLite is a file path, never a credential.
    if (c.kind === "sqlite") continue;
    const password = await getSecret(c.id);
    if (password) secrets[c.id] = { password };
  }

  const sealed = await ctx.invoke("backup_seal", {
    plaintext: JSON.stringify(secrets),
    passphrase,
  });

  const file = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    // Strip any password that ever leaked into the persisted record: the
    // encrypted block is the ONLY place a credential may live in this file.
    connections: connections.map(({ password: _p, ...rest }) => rest),
    secrets: sealed,
  };
  return { text: JSON.stringify(file, null, 2), count: connections.length };
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const bool = (v) => v === true;

/** Whole number in `[min, max]`, else `fallback`. */
function num(v, min, max, fallback) {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

const VALID_SSL = new Set(["none", "preferred", "required", "verify_ca", "verify_full"]);

/**
 * Re-check one connection record from the file. An import is a TRUST BOUNDARY -
 * the file came off a USB stick or a chat, and whatever survives here is written
 * into the connections store and later DIALLED - so nothing is taken on faith.
 * An unknown `kind` would reach a dialect lookup that has no entry, a junk
 * `sslMode` would be handed to the sidecar verbatim, and a record with no id
 * would collide with the next one on save. Returns null to drop the entry.
 */
function sanitizeConnection(raw, validKinds) {
  if (!isRecord(raw)) return null;
  const id = str(raw.id).trim();
  const kind = str(raw.kind).trim();
  if (!id || !validKinds.has(kind)) return null;
  const isFile = kind === "sqlite";
  const sqlitePath = str(raw.sqlitePath).trim();
  const host = str(raw.host).trim();
  // A connection that can never be dialled is not worth importing: it would sit
  // in the tree failing, and the user cannot tell it apart from a real one.
  if (isFile ? !sqlitePath : !host) return null;
  const sslMode = str(raw.sslMode);
  return {
    id,
    kind,
    name: str(raw.name).trim() || host || sqlitePath,
    host: isFile ? "" : host,
    // Port is stored as a string (the form's own shape) and may legitimately be
    // blank, meaning "the dialect default".
    port: isFile ? "" : String(num(raw.port, 1, 65535, "") || ""),
    user: isFile ? "" : str(raw.user),
    database: isFile ? "" : str(raw.database),
    sqlitePath: isFile ? sqlitePath : "",
    sqliteReadOnly: bool(raw.sqliteReadOnly),
    allow_writes: bool(raw.allow_writes),
    sslMode: VALID_SSL.has(sslMode) ? sslMode : "none",
    // Resolved against this machine's SSH hosts by the caller.
    sshTunnel: str(raw.sshTunnel),
    query_timeout_ms: num(raw.query_timeout_ms, 0, 24 * 60 * 60 * 1000, 30000),
    row_limit: num(raw.row_limit, 0, 10_000_000, 10000),
  };
}

/** Validate the envelope and every record inside it. Throws on a file this is not. */
export function parseBackupFile(raw) {
  if (!isRecord(raw)) throw new Error("That file is not a connection backup.");
  if (raw.kind !== BACKUP_KIND) {
    throw new Error("That file is not a SQL Explorer connection backup.");
  }
  if (typeof raw.version !== "number" || raw.version > BACKUP_VERSION) {
    throw new Error("That backup was written by a newer SQL Explorer.");
  }
  if (!isRecord(raw.secrets)) throw new Error("The backup has no encrypted block.");
  const validKinds = new Set(listDialects().map((d) => d.id));
  const list = Array.isArray(raw.connections) ? raw.connections : [];
  const connections = [];
  let skipped = 0;
  for (const entry of list) {
    const clean = sanitizeConnection(entry, validKinds);
    if (clean) connections.push(clean);
    else skipped++;
  }
  if (connections.length === 0) throw new Error("The backup holds no usable connections.");
  return { connections, secrets: raw.secrets, skipped };
}

/** Only the password field survives; anything else in the blob is ignored. */
function sanitizeSecrets(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (isRecord(entry) && typeof entry.password === "string" && entry.password) {
      out[id] = entry.password;
    }
  }
  return out;
}

/**
 * Decrypt and merge a backup into the local store. Merging is by connection id,
 * which is stable across renames, so re-importing the same file updates rather
 * than duplicating. Nothing is deleted: a connection that exists here but not in
 * the file is left alone.
 */
export async function applyBackup(text, passphrase) {
  if (!passphrase) throw new Error("A passphrase is required.");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const { connections, secrets: sealed, skipped } = parseBackupFile(raw);

  // Decrypt BEFORE touching the store: a wrong passphrase must leave the
  // existing connections exactly as they were, not half-merged.
  const plain = await ctx.invoke("backup_open", { blob: sealed, passphrase });
  let secrets;
  try {
    secrets = sanitizeSecrets(JSON.parse(plain));
  } catch {
    throw new Error("The encrypted block did not contain readable credentials.");
  }

  // An SSH tunnel names a host saved in TEDI's OWN manager, which does not
  // travel in this file. Keeping an id this machine has never seen would make
  // every connect fail at tunnel-open time with nothing to fix in the dialog,
  // so an unresolvable one is dropped back to a direct connection.
  let knownSsh = new Set();
  try {
    if (typeof ctx?.ssh?.listConnections === "function") {
      knownSsh = new Set(((await ctx.ssh.listConnections()) ?? []).map((h) => h.id));
    }
  } catch (err) {
    ctx?.logger?.warn?.("ssh host list failed during import", err);
  }

  const existing = new Map((state.connections ?? []).map((c) => [c.id, c]));
  let added = 0;
  let replaced = 0;
  let withoutSecrets = 0;
  let tunnelsDropped = 0;

  for (const conn of connections) {
    if (conn.sshTunnel && !knownSsh.has(conn.sshTunnel)) {
      conn.sshTunnel = "";
      tunnelsDropped++;
    }
    const password = secrets[conn.id];
    if (conn.kind !== "sqlite" && !password) withoutSecrets++;
    if (existing.has(conn.id)) {
      state.connections = state.connections.map((c) => (c.id === conn.id ? conn : c));
      replaced++;
    } else {
      state.connections = [...state.connections, conn];
      added++;
    }
    if (password) await setSecret(conn.id, password);
    // Re-importing over a host whose password this file does NOT carry must not
    // leave the OLD one behind: the record was replaced, so a stale credential
    // would silently authenticate as something the file never described.
    else if (conn.kind !== "sqlite" && existing.has(conn.id)) await deleteSecret(conn.id);
  }

  await persistConnections();
  return { added, replaced, skipped, withoutSecrets, tunnelsDropped };
}
