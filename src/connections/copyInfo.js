// SQL Explorer: connections/copyInfo. Copy a connection's details as plain
// text, so another tool or an AI agent can connect to the same database.
// Bundled into extension.js by build.mjs.
//
// `connectionInfoText` is pure (no DOM, no ctx) so the self-check runs it under
// plain node; `copyConnectionInfo` adds the keychain read and the clipboard.

import { buildConnectionUrl, getDialect } from "../dialects/index.js";
import { copyToClipboard } from "../dom/feedback.js";
import { state } from "../runtime.js";
import { connectTargetDatabase, getSecret } from "./store.js";
import { listSshHosts } from "./tunnel.js";

/** Any free local port works; this one is unlikely to clash with a real server. */
const LOCAL_TUNNEL_PORT = 15432;

/** Wrap `s` for a POSIX shell: single quotes, with embedded ones escaped.
 *  @param {string} s */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The details of `conn` as labelled lines plus a ready URL and CLI command.
 *
 * `password`: the secret to include, `""` when none is saved, or `null` to
 * leave it out on purpose. `sshHost`: the saved SSH connection a tunnelled
 * database is reached through, so the text can say how to get there.
 *
 * @param {any} conn
 * @param {{ password?: string | null, database?: string | null, schema?: string | null, sshHost?: any }} [opts]
 */
export function connectionInfoText(conn, opts = {}) {
  const { password = null, database = null, schema = null, sshHost = null } = opts;
  const dialect = getDialect(conn.kind);
  const lines = [`Database connection "${conn.name || conn.id}" (from TEDI SQL Explorer)`];
  lines.push(`Engine: ${dialect.label}`);

  if (dialect.fileBased) {
    const path = conn.sqlitePath || conn.host || conn.database || "";
    lines.push(`File: ${path}`);
    if (conn.sqliteReadOnly || !conn.allow_writes) lines.push("Access: read-only in TEDI");
    lines.push(`CLI: sqlite3 ${shellQuote(path)}`);
    return lines.join("\n");
  }

  const port = conn.port || dialect.defaultPort;
  const db = database || null;
  lines.push(`Host: ${conn.host}`, `Port: ${port}`, `User: ${conn.user || "(none)"}`);
  if (password === null) lines.push("Password: (not included)");
  else lines.push(`Password: ${password || "(none saved)"}`);
  if (db) lines.push(`Database: ${db}`);
  if (schema && schema !== db) lines.push(`Schema: ${schema}`);
  if (conn.sslMode && conn.sslMode !== "none") lines.push(`SSL: ${conn.sslMode}`);
  if (!conn.allow_writes) lines.push("Access: read-only in TEDI (the server account may still allow writes)");

  const form = { ...conn, port, database: db ?? "", password: password ?? "" };
  lines.push(`URL: ${buildConnectionUrl(dialect, form)}`);
  lines.push(`CLI: ${cliCommand(conn.kind, form, password)}`);

  if (conn.sshTunnel) {
    const via = sshHost
      ? `${sshHost.user ? `${sshHost.user}@` : ""}${sshHost.host}${sshHost.port && sshHost.port !== 22 ? ` -p ${sshHost.port}` : ""}`
      : "(the SSH host saved in TEDI)";
    lines.push(
      `SSH: only reachable through ${via}. Open a tunnel first:`,
      `     ssh -N -L ${LOCAL_TUNNEL_PORT}:${conn.host}:${port} ${via}`,
      `     then connect to 127.0.0.1:${LOCAL_TUNNEL_PORT} instead of the host and port above.`,
    );
  }
  return lines.join("\n");
}

/** @param {string} kind @param {any} form @param {string | null} password */
function cliCommand(kind, form, password) {
  const db = form.database ? ` ${shellQuote(form.database)}` : "";
  if (kind === "postgres") {
    const env = password ? `PGPASSWORD=${shellQuote(password)} ` : "";
    const user = form.user ? ` -U ${shellQuote(form.user)}` : "";
    return `${env}psql -h ${form.host} -p ${form.port}${user}${db ? ` -d${db}` : ""}`;
  }
  const user = form.user ? ` -u ${shellQuote(form.user)}` : "";
  // `-p` alone prompts; the value must follow it with no space.
  const pass = password ? ` -p${shellQuote(password)}` : password === null ? " -p" : "";
  return `mysql -h ${form.host} -P ${form.port}${user}${pass}${db ? ` -D${db}` : ""}`;
}

/**
 * Copy `conn`'s details to the clipboard. The database defaults to the one the
 * workbench is pointed at for this connection, then to the saved one.
 *
 * @param {any} conn
 * @param {{ withPassword?: boolean, database?: string | null, schema?: string | null }} [opts]
 */
export async function copyConnectionInfo(conn, opts = {}) {
  const { withPassword = true } = opts;
  const session = state.sessions[conn.id];
  const database = opts.database ?? session?.currentDatabase ?? connectTargetDatabase(conn);
  const schema = opts.schema ?? (opts.database ? null : session?.currentSchema) ?? null;
  const password =
    withPassword && conn.kind !== "sqlite" ? ((await getSecret(conn.id)) ?? "") : null;
  const sshHost = conn.sshTunnel
    ? (await listSshHosts()).find((h) => h.id === conn.sshTunnel) ?? null
    : null;
  const text = connectionInfoText(conn, { password, database, schema, sshHost });
  await copyToClipboard(
    text,
    password ? "Connection info copied (includes the password)" : "Connection info copied",
  );
}

/** The two copy entries every connection-level menu offers.
 *  @param {any} conn @param {{ database?: string, schema?: string }} [scope] */
export function copyConnectionMenuItems(conn, scope = {}) {
  return [
    {
      label: "Copy connection info",
      icon: "Copy01Icon",
      onClick: () => void copyConnectionInfo(conn, { ...scope, withPassword: true }),
    },
    {
      label: "Copy connection info without password",
      icon: "Copy01Icon",
      onClick: () => void copyConnectionInfo(conn, { ...scope, withPassword: false }),
    },
  ];
}
