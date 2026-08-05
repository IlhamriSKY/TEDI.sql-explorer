// SQL Explorer — sidecar module. Bundled into extension.js by build.mjs.
import { ctx } from "./runtime.js";


// Tight enough that the READY line lands "instantly" from a user POV,
// loose enough that a slow first-time process spawn (Defender / Gatekeeper
// scanning the unsigned helper) doesn't trip the timeout.
const READY_TIMEOUT_MS = 12_000;
const READY_POLL_MS = 80;

// Sidecar binary directory layout; mirrors tedi.screenshot.
function platformDir(os) {
  const arch = os?.arch || "x86_64";
  // Only arches the release CI actually builds resolve to a dir; anything
  // else returns null so bootSidecar reports a clean "unsupported platform"
  // error instead of pointing at a binary the package never shipped. macOS
  // ships both arches; Windows and Linux ship x86_64 only.
  if (os?.platform === "windows") return arch === "aarch64" ? null : "windows-x86_64";
  if (os?.platform === "macos") return arch === "aarch64" ? "macos-aarch64" : "macos-x86_64";
  if (os?.platform === "linux") return arch === "aarch64" ? null : "linux-x86_64";
  return null;
}

function helperPath(installPath, os) {
  if (!installPath || !os) return null;
  const dir = platformDir(os);
  if (!dir) return null;
  const exe = os.platform === "windows" ? "tedi-sql-helper.exe" : "tedi-sql-helper";
  return `${installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}
export let sidecar = null; // { handle, port, token, baseUrl }
let bootInFlight = null;

/** Where the running helper's endpoint is published for the OTHER windows.
 *  `ctx.storage` is a Rust-side store, so a write here is visible to every
 *  webview immediately, which is what makes the hand-off below work. */
const ENDPOINT_KEY = "sidecar";

// ----------------------------- Sidecar boot ----------------------------------

export async function ensureSidecar() {
  if (sidecar?.baseUrl) return sidecar;
  if (bootInFlight) return bootInFlight;
  setBootInFlight(
    (async () => (await adoptRunningSidecar()) ?? (await bootSidecar()))().finally(() => {
      setBootInFlight(null);
    }),
  );
  return bootInFlight;
}

/**
 * Adopt the helper another window already booted, instead of spawning a second
 * one.
 *
 * Floating the workbench runs a SECOND copy of this extension in the float
 * window (panel renderers are per-webview). Left alone it would spawn its own
 * helper process: the two windows would then hold separate database sessions,
 * so a connection opened in the float would be invisible after docking back,
 * and the float's helper would outlive the window that owned it.
 *
 * The probe is what keeps this honest - a record left behind by a previous app
 * run points at nothing, and then we boot as usual.
 */
async function adoptRunningSidecar() {
  let saved = null;
  try {
    saved = await ctx.storage.get(ENDPOINT_KEY);
  } catch {
    return null;
  }
  if (!saved?.port || !saved?.token) return null;
  const baseUrl = `http://127.0.0.1:${saved.port}`;
  try {
    const res = await fetch(`${baseUrl}/healthz`, {
      headers: { Authorization: `Bearer ${saved.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
  } catch {
    return null; // nothing listening on that port any more
  }
  setSidecar({ handle: saved.handle ?? null, port: saved.port, token: saved.token, baseUrl });
  ctx?.logger?.info?.(`adopted the running sidecar on ${baseUrl}`);
  return sidecar;
}

/** Forget the published endpoint (deactivate). Best effort: a stale record is
 *  harmless, the probe rejects it. */
export async function clearPublishedEndpoint() {
  try {
    await ctx.storage.delete(ENDPOINT_KEY);
  } catch {
    // nothing to clean up
  }
}

async function bootSidecar() {
  const program = helperPath(ctx.installPath, ctx.os);
  if (!program) {
    throw new Error(`unsupported platform ${ctx.os?.platform}/${ctx.os?.arch}`);
  }
  let handle;
  try {
    handle = await ctx.invoke("shell_bg_spawn_direct", { program, args: [] });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (/os error 2|no such file|cannot find/i.test(msg)) {
      throw new Error(
        `Sidecar binary missing for ${ctx.os?.platform}-${ctx.os?.arch}. Reinstall the extension to repopulate sidecar/. (${msg})`,
      );
    }
    throw new Error(`spawn failed: ${msg}`);
  }

  // Drain stdout until READY lands. shell_bg_logs returns *new* bytes since
  // the last `sinceOffset`; the helper prints `READY <json>` then keeps
  // logging via stderr.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let offset = 0;
  let buf = "";
  while (true) {
    if (Date.now() > deadline) {
      await ctx.invoke("shell_bg_kill", { handle }).catch(() => {});
      throw new Error("sidecar handshake timed out");
    }
    const resp = await ctx.invoke("shell_bg_logs", { handle, sinceOffset: offset });
    if (resp?.bytes) buf += resp.bytes;
    offset = typeof resp?.next_offset === "number" ? resp.next_offset : offset;
    if (resp?.exited) {
      throw new Error(`sidecar exited before READY (exit ${resp.exit_code ?? "?"})`);
    }
    const line = extractReady(buf);
    if (line) {
      setSidecar({
        handle,
        port: line.port,
        token: line.token,
        baseUrl: `http://127.0.0.1:${line.port}`,
      });
      // Publish it so a float window adopts this helper instead of spawning its
      // own. Known limit: last writer wins, so two windows booting in the same
      // instant can still leave one orphan - the float only opens on a click
      // long after the main window is up.
      void ctx.storage
        .set(ENDPOINT_KEY, { handle, port: line.port, token: line.token })
        .catch(() => {});
      ctx?.logger?.info?.(`sidecar ready on ${sidecar.baseUrl}`);
      return sidecar;
    }
    await sleep(READY_POLL_MS);
  }
}

function extractReady(buf) {
  // Strict prefix match. Anything before the keyword is throwaway stderr.
  const idx = buf.indexOf("READY ");
  if (idx < 0) return null;
  const nl = buf.indexOf("\n", idx);
  if (nl < 0) return null;
  const jsonText = buf.slice(idx + "READY ".length, nl).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

/**
 * Tear down the cached (presumed-dead) sidecar and boot a fresh one. Kills the
 * stale handle first so a transient failure can't leave an orphaned helper
 * process running unreferenced, then re-runs the normal boot/handshake.
 */
async function respawnSidecar() {
  const dead = sidecar;
  setSidecar(null);
  // The helper can be SHARED with another window now, so confirm it is really
  // gone before killing it: one failed fetch (a cancelled request, a hiccup) is
  // not grounds for taking the other window's sessions down with it.
  const alive = await adoptRunningSidecar();
  if (alive) return alive;
  if (dead?.handle != null) {
    await ctx.invoke("shell_bg_kill", { handle: dead.handle }).catch(() => {});
  }
  return ensureSidecar();
}

export async function fetchJson(path, opts = {}, allowRespawn = true) {
  if (!sidecar?.baseUrl) await ensureSidecar();
  const url = `${sidecar.baseUrl}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sidecar.token}`,
  };
  const init = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal) init.signal = opts.signal;
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // A network-level rejection (not an HTTP error response) means the sidecar
    // process is gone / refusing connections. Re-boot it once and retry so a
    // crashed helper self-heals without re-enabling the extension. Don't
    // respawn when the caller aborted the request.
    if (allowRespawn && !opts.signal?.aborted) {
      await respawnSidecar();
      return fetchJson(path, opts, false);
    }
    throw err;
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* empty */
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? text ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function setSidecar(value) {
  sidecar = value;
}

// Module-local: bootInFlight never crosses a module boundary.
function setBootInFlight(value) {
  bootInFlight = value;
}
