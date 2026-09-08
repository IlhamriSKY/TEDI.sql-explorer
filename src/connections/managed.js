// SQL Explorer — connections/managed: the databases the Dev Environment
// extension runs, offered here without anyone typing a host and port.
//
// The handoff is a FILE, not a call, because the host gives two extensions no
// way to talk: `ctx.settings`, `ctx.events` and `ctx.secrets` all namespace
// their key under the id of whoever is CALLING, so `tedi.devenv` cannot write
// into this extension's settings and cannot emit onto a channel this one
// listens on. What both sides can name without being configured is a path under
// `~/.tedi`, so that is where `tedi.devenv` publishes what it is running.
//
// The direction matters: the file states a FACT ("these managed databases
// exist, reach them here"), and this side decides what to do with it. Nothing
// in it is executed and nothing is trusted - it goes through the same
// `sanitizeConnection` an imported backup does, because a file on disk that
// another program writes is the same trust boundary whether it arrived on a USB
// stick or from an extension the user installed.
//
// There is no password in it and none is expected: those servers are
// initialised insecure and bound to loopback, which is what a local development
// database is.
//
// Bundled into extension.js by build.mjs.
import { listDialects } from "../dialects/index.js";
import { ctx, state } from "../runtime.js";
import { sanitizeConnection } from "./backup.js";
import { persistConnections } from "./store.js";

/** Connection ids the Dev Environment owns. It writes them, so it names them. */
const MANAGED_PREFIX = "devenv:";
const HANDOFF_KIND = "tedi-dev-environment";
const HANDOFF_VERSION = 1;

/** The published path, or `""` when the host cannot say where home is.
 *  @param {import("../../tedi").ExtensionContext | null} c @returns {string} */
function handoffFile(c) {
  const home = String(c?.paths?.home ?? "").replace(/[\/]+$/, "");
  if (!home) return "";
  const sep = c?.os?.platform === "windows" ? "\\" : "/";
  return [home, ".tedi", "dev-environment.json"].join(sep);
}

/**
 * The connections the file offers, or `[]` for every reason it might not:
 * the extension is not installed, nothing is installed in it, the host is too
 * old to have `paths.home`, or the file is unreadable. All of those mean the
 * same thing here - there is nothing managed to show - so none of them is an
 * error the user needs to see.
 *
 * @returns {Promise<object[]>}
 */
export async function readOfferedConnections() {
  const path = handoffFile(ctx);
  if (!path || typeof ctx?.invoke !== "function") return [];
  let raw;
  try {
    const res = await ctx.invoke("fs_read_file", { path });
    if (res?.kind !== "text") return [];
    raw = JSON.parse(res.content);
  } catch {
    return [];
  }
  if (raw?.kind !== HANDOFF_KIND) return [];
  if (typeof raw.version !== "number" || raw.version > HANDOFF_VERSION) return [];
  const validKinds = new Set(listDialects().map((d) => d.id));
  const out = [];
  for (const entry of Array.isArray(raw.connections) ? raw.connections : []) {
    const clean = sanitizeConnection(entry, validKinds);
    // An id outside the prefix would let the file rewrite a connection the user
    // typed themselves, which is not what publishing a managed database is for.
    if (clean && clean.id.startsWith(MANAGED_PREFIX)) out.push(clean);
  }
  return out;
}

/**
 * Bring the managed rows in line with the file.
 *
 * Only the ADDRESS is taken from it. Everything else on an existing row is the
 * user's - whether writes are allowed, what the row limit is, what they renamed
 * it to - and losing that on every launch because a port moved would make the
 * row worse than one typed by hand. A row the file no longer offers is dropped,
 * because the database behind it is gone and a saved connection that can never
 * connect is indistinguishable from one that is merely stopped.
 *
 * @returns {Promise<boolean>} true when the list changed.
 */
export async function syncManagedConnections() {
  const offered = await readOfferedConnections();
  const byId = new Map(offered.map((c) => [c.id, c]));
  const seen = new Set();

  const next = [];
  for (const conn of state.connections ?? []) {
    if (!String(conn.id).startsWith(MANAGED_PREFIX)) {
      next.push(conn);
      continue;
    }
    const offer = byId.get(conn.id);
    if (!offer) continue;
    seen.add(conn.id);
    next.push({ ...conn, kind: offer.kind, host: offer.host, port: offer.port, user: offer.user });
  }
  for (const offer of offered) if (!seen.has(offer.id)) next.push(offer);

  if (JSON.stringify(next) === JSON.stringify(state.connections)) return false;
  state.connections = next;
  await persistConnections();
  return true;
}
