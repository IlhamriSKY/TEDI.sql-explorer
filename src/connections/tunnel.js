// SQL Explorer — connections/tunnel: reach a database only a bastion can see.
// Bundled into extension.js by build.mjs.
//
// A managed database usually sits in a private subnet: the port is open to a
// jump host and to nothing else, so a direct connect just times out. The fix
// everywhere else (pgAdmin, DBeaver, TablePlus) is an SSH tunnel, and this is
// ours.
//
// It does NOT re-ask for the SSH host, user and key the way pgAdmin does. The
// user already has those saved in TEDI's own SSH manager, so a connection just
// names one; the host opens the forward with credentials read from the OS
// keychain, and this extension only ever sees a loopback port number. That is
// also why it needs no filesystem access to read a `.pem`.

import { getDialect } from "../dialects/index.js";
import { ctx } from "../runtime.js";

/**
 * The database endpoint a tunnelled connection really points at. Kept apart
 * from the form's host/port because those are rewritten to loopback before the
 * URL is built, and closing the forward needs the original target back.
 */
function tunnelTarget(conn) {
  const dialect = getDialect(conn.kind);
  return {
    host: String(conn.host ?? "").trim(),
    port: Number(conn.port) || Number(dialect.defaultPort) || 0,
  };
}

/** True when this connection is configured to go through a jump host. */
function usesTunnel(conn) {
  return !!conn?.sshTunnel && !getDialect(conn.kind).fileBased;
}

/**
 * Open (or reuse) the forward for `form` and return the `{ host, port }` the
 * driver should connect to. Returns the form's own host/port unchanged when no
 * tunnel is configured, so callers can use this unconditionally.
 */
export async function resolveEndpoint(form) {
  if (!usesTunnel(form)) return { host: form.host, port: form.port };
  if (typeof ctx?.ssh?.openForward !== "function") {
    throw new Error("SSH tunnels need a newer TEDI (ctx.ssh.openForward).");
  }
  const target = tunnelTarget(form);
  if (!target.host || !target.port) {
    throw new Error("SSH tunnel needs the database host and port.");
  }
  const { localPort } = await ctx.ssh.openForward(form.sshTunnel, target.host, target.port);
  return { host: "127.0.0.1", port: String(localPort) };
}

/** Release a connection's forward. Never throws: teardown is cleanup, and a
 *  tunnel that is already gone is the outcome we wanted. */
export async function releaseTunnel(conn) {
  if (!usesTunnel(conn) || typeof ctx?.ssh?.closeForward !== "function") return;
  const target = tunnelTarget(conn);
  try {
    await ctx.ssh.closeForward(conn.sshTunnel, target.host, target.port);
  } catch (err) {
    ctx?.logger?.warn?.("ssh tunnel close failed", err);
  }
}

/**
 * Saved SSH connections for the dialog's picker.
 *
 * The host lists only connections whose server key has already been pinned,
 * because a first connect needs a human to verify the fingerprint. So a host
 * the user just added is simply ABSENT here rather than shown as unusable,
 * which is why the dialog's empty state has to name both possibilities.
 * Returns [] on hosts without `ctx.ssh`.
 */
export async function listSshHosts() {
  // `openForward` is the newer of the two APIs. A host that can list SSH
  // connections but cannot forward a port would otherwise let the dialog offer
  // a tunnel that only fails at connect time, so treat it as "none available".
  if (
    typeof ctx?.ssh?.listConnections !== "function" ||
    typeof ctx?.ssh?.openForward !== "function"
  ) {
    return [];
  }
  try {
    return (await ctx.ssh.listConnections()) ?? [];
  } catch (err) {
    ctx?.logger?.warn?.("ssh connection list failed", err);
    return [];
  }
}

/** True when this TEDI can forward a port at all. Lets the dialog tell "no
 *  hosts saved" apart from "this build can't tunnel". */
export function tunnelsSupported() {
  return typeof ctx?.ssh?.openForward === "function";
}
