// SQL Explorer — query/history: remember what was run, and let the user pull it
// back into the editor. Bundled into extension.js by build.mjs.
//
// Every workbench keeps a query history; without one, a statement you spent ten
// minutes getting right is gone the moment you type over it. Entries are kept
// per connection in `ctx.settings` (not the keychain — SQL is not a secret, but
// see the note on `record`), newest first, capped so the setting stays small.

import { openCenteredDialog } from "../dialogs.js";
import { copyToClipboard, el, safeToast, textBtn } from "../dom.js";
import { ctx } from "../runtime.js";

const SETTINGS_KEY = "queryHistory";
/** Per connection. 200 entries is a few weeks of real use and still a small
 *  settings blob. */
const MAX_ENTRIES = 200;
/** Skip pathological pastes rather than bloat the settings file with them. */
const MAX_SQL_LENGTH = 20_000;

/** In-memory mirror so the History dialog opens without an await, and so a
 *  failed settings read can't wipe what this session ran. */
let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const saved = await ctx?.settings?.get?.(SETTINGS_KEY);
    cache = saved && typeof saved === "object" ? saved : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist() {
  try {
    await ctx?.settings?.set?.(SETTINGS_KEY, cache ?? {});
  } catch (err) {
    ctx?.logger?.warn?.("save query history failed", err);
  }
}

/**
 * Record a statement that was actually sent to the server.
 *
 * Deduped against the newest entry so hammering Run on one query doesn't fill
 * the list with copies. `at` is stamped client-side purely for display.
 *
 * A query can carry credentials (`CREATE USER … IDENTIFIED BY 'x'`), so
 * anything that looks like a password-bearing statement is skipped rather
 * than written to a settings file in plain text.
 */
export async function record(connId, sql) {
  const trimmed = String(sql ?? "").trim();
  if (!connId || !trimmed || trimmed.length > MAX_SQL_LENGTH) return;
  if (/\b(IDENTIFIED\s+BY|PASSWORD\s*\(|ENCRYPTED\s+PASSWORD)\b/i.test(trimmed)) return;
  const all = await load();
  const list = Array.isArray(all[connId]) ? all[connId] : [];
  if (list[0]?.sql === trimmed) return;
  list.unshift({ sql: trimmed, at: Date.now() });
  all[connId] = list.slice(0, MAX_ENTRIES);
  await persist();
}

/** Newest-first entries for a connection. */
export async function list(connId) {
  const all = await load();
  return Array.isArray(all[connId]) ? all[connId] : [];
}

export async function clear(connId) {
  const all = await load();
  delete all[connId];
  await persist();
}

/** Drop a connection's history when the connection itself is deleted, so the
 *  setting doesn't accumulate entries nobody can reach any more. */
export async function forgetConnection(connId) {
  await clear(connId);
}

function relativeTime(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The History modal: newest first, click an entry to load it into the query
 * editor. `onPick` is what actually writes the editor (the panel owns the
 * CodeMirror handle), so this module stays free of render concerns.
 */
export async function openHistoryDialog(session, onPick) {
  const entries = await list(session.connId);
  const { body, close } = openCenteredDialog({ title: "Query history", width: 640 });

  if (entries.length === 0) {
    body.appendChild(el("p", { class: "tsql-empty", text: "Nothing run on this connection yet." }));
    return;
  }

  const listEl = el("div", { class: "tsql-history-list" });
  for (const entry of entries) {
    const row = el("div", { class: "tsql-history-row" });
    row.appendChild(el("div", { class: "tsql-history-sql", text: entry.sql }));
    const meta = el("div", { class: "tsql-history-meta" });
    meta.appendChild(el("span", { text: relativeTime(entry.at) }));
    meta.appendChild(
      textBtn("Copy", "Copy01Icon", {
        title: "Copy this statement",
        onClick: () => copyToClipboard(entry.sql, "Query copied"),
      }),
    );
    meta.appendChild(
      textBtn("Load", "ArrowUpToLineIcon", {
        title: "Put this statement in the editor",
        onClick: () => {
          onPick(entry.sql);
          close();
        },
      }),
    );
    row.appendChild(meta);
    listEl.appendChild(row);
  }
  body.appendChild(listEl);
  body.appendChild(
    el(
      "div",
      { class: "tsql-dialog-actions" },
      el("button", {
        class: "tsql-btn",
        text: "Clear history",
        attrs: { type: "button" },
        on: {
          click: async () => {
            await clear(session.connId);
            close();
            safeToast("Query history cleared", "success");
          },
        },
      }),
      el("button", {
        class: "tsql-btn is-primary",
        text: "Close",
        attrs: { type: "button" },
        on: { click: close },
      }),
    ),
  );
}
