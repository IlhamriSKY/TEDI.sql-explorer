// Live probe for tedi-sql-helper against REAL databases. CI has no database,
// so this is run by hand after touching the sidecar:
//
//   cargo build
//   PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//   MYSQL_URL=mysql://user:pass@127.0.0.1:3306/somedb \
//   node live-probe.mjs
//
// Either URL may be omitted to skip that engine. Everything it creates lives
// in a `tedi_probe` schema / database and is dropped at the end. Each check
// guards a behaviour that once returned plausible WRONG data instead of an
// error, which is why it needs a real server to see.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const exe = process.env.HELPER ?? `target/debug/tedi-sql-helper${process.platform === "win32" ? ".exe" : ""}`;
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

const child = spawn(exe, [], { stdio: ["ignore", "pipe", "ignore"] });
const ready = await new Promise((resolve, reject) => {
  createInterface({ input: child.stdout }).on("line", (l) => {
    if (l.startsWith("READY ")) resolve(JSON.parse(l.slice(6)));
  });
  child.on("exit", (c) => reject(new Error(`helper exited ${c}`)));
});
const base = `http://127.0.0.1:${ready.port}`;

async function call(path, body, raw = false) {
  if (path.includes("?")) path = path.replace(/=([^&]*)/g, (_, v) => `=${encodeURIComponent(v)}`);
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json;
}
const q = (conn, sql, extra = {}) => call("/query", { conn, sql, ...extra });
const first = (r) => r.statements[0];
const scalar = (r) => first(r).rows?.[0]?.[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probePostgres(url) {
  console.log("PostgreSQL");
  const c = "pg";
  await call("/connect", { id: c, kind: "postgres", url, allow_writes: true, row_limit: 10000 });
  const S = { session: true, schema: "tedi_probe" };
  await q(c, "DROP SCHEMA IF EXISTS tedi_probe CASCADE; CREATE SCHEMA tedi_probe");
  await q(c, "CREATE TABLE tedi_probe.t (id int PRIMARY KEY, note text, data bytea)");

  // Splitting: a dollar-quoted body is ONE statement.
  const fn = await q(c, "CREATE FUNCTION tedi_probe.f() RETURNS int AS $$ BEGIN RETURN 41 + 1; END; $$ LANGUAGE plpgsql; SELECT tedi_probe.f()");
  check("dollar-quoted function body is not split", fn.statements.length === 2 && fn.statements[1].rows?.[0]?.[0] === 42, JSON.stringify(fn.statements.map((s) => s.error ?? s.kind)));

  // A transaction spans editor runs, and stays invisible to other sessions.
  let r = await q(c, "BEGIN; INSERT INTO t VALUES (1, 'a', '\\x0102')", S);
  check("BEGIN in one run leaves the editor session in a transaction", r.in_transaction === true);
  r = await q(c, "SELECT count(*) FROM tedi_probe.t");
  check("an uncommitted insert is invisible to a one-off query", Number(scalar(r)) === 0);
  r = await call("/table-rows", { conn: c, database: "", schema: "tedi_probe", table: "t" });
  check("...and to the table browser (no open transaction leaked into the pool)", r.result.total === 0);
  r = await q(c, "COMMIT", S);
  check("COMMIT in a later run closes it", r.in_transaction === false);
  r = await q(c, "SELECT count(*) FROM tedi_probe.t");
  check("the committed row is visible elsewhere", Number(scalar(r)) === 1);

  // A one-off batch that leaves BEGIN open must not poison the pool.
  r = await q(c, "BEGIN; INSERT INTO tedi_probe.t VALUES (2, 'b', NULL)");
  check("a one-off batch left in a transaction is reported", /rolled back/.test(r.notice ?? ""));
  r = await q(c, "SELECT count(*) FROM tedi_probe.t");
  check("...and rolled back, not returned to the pool open", Number(scalar(r)) === 1);

  // Grid payloads carry no blob bytes; exports do.
  r = await q(c, "SELECT data FROM t", S);
  const cell = first(r).rows[0][0];
  check("display rows omit blob bytes", cell?.__type === "bytes" && cell.size === 2 && !("b64" in cell));
  let res = await call("/export", { conn: c, sql: "SELECT * FROM t", schema: "tedi_probe", format: "sql" }, true);
  const body = await res.text();
  check("raw-SQL export resolves names through the sent schema", res.ok && res.headers.get("x-export-rows") === "1", body.slice(0, 200));
  check("SQL export keeps the blob bytes", body.includes("decode('AQI=', 'base64')"), body);

  // Error position.
  r = await q(c, "SELECT nope FROM tedi_probe.t");
  check("errors carry line and column", /\(line 1, column 8\)/.test(first(r).error ?? ""), first(r).error);

  // Byte budget.
  r = await q(c, "SELECT repeat('x', 1000000) FROM generate_series(1, 100)");
  check("the byte budget stops a huge result", first(r).truncated && first(r).truncated_by_size && first(r).rows.length < 100, `${first(r).rows?.length} rows`);

  // Cancel and timeout on the editor session.
  const run = q(c, "SELECT pg_sleep(10)", { ...S, request_id: "pg-cancel" });
  await sleep(400);
  const cancel = await call("/cancel", { request_id: "pg-cancel" });
  const t0 = Date.now();
  r = await run;
  check("Stop cancels on the server", cancel.server_canceled && Date.now() - t0 < 3000 && first(r).kind === "error");
  r = await q(c, "SELECT pg_sleep(5); SELECT 7", { ...S, timeout_ms: 300 });
  check("a timed-out statement does not wedge the next one", /timed out/.test(r.statements[0].error ?? "") && r.statements[1].rows?.[0]?.[0] === 7);

  // A dead session connection is replaced, and a read is retried.
  const pid = scalar(await q(c, "SELECT pg_backend_pid()", S));
  await q(c, `SELECT pg_terminate_backend(${pid})`);
  await sleep(200);
  r = await q(c, "SELECT 1", S);
  check("a read after the session's connection died is retried on a fresh one", scalar(r) === 1, JSON.stringify(r.statements));

  // A session belongs to one database.
  await q(c, "BEGIN", { session: true, database: "postgres" });
  let err = "";
  try {
    await q(c, "SELECT 1", { session: true, database: "template1" });
  } catch (e) {
    err = e.message;
  }
  check("switching database with a transaction open is refused", /transaction is open/.test(err), err);
  await q(c, "ROLLBACK", { session: true, database: "postgres" });

  // Read-only gate with PostgreSQL's own quoting.
  await call("/connect", { id: "pg-ro", kind: "postgres", url, allow_writes: false });
  r = await q("pg-ro", "WITH a AS (SELECT 'x\\'), d AS (DELETE FROM tedi_probe.t RETURNING 1) SELECT 'y'");
  check("a backslash literal cannot hide a write from the read-only gate", /read-only/.test(first(r).error ?? ""), JSON.stringify(first(r)));

  // Estimated count for a big unfiltered table.
  await q(c, "CREATE TABLE tedi_probe.big AS SELECT g FROM generate_series(1, 1100000) g; ANALYZE tedi_probe.big");
  let t = Date.now();
  r = await call("/table-rows", { conn: c, database: "", schema: "tedi_probe", table: "big", page_size: 50 });
  const estMs = Date.now() - t;
  t = Date.now();
  await q(c, "SELECT count(*) FROM tedi_probe.big");
  const countMs = Date.now() - t;
  check(`a >1M-row table reports an estimate (page ${estMs} ms vs COUNT ${countMs} ms)`, r.result.total_estimated === true && r.result.total > 1_000_000);
  r = await call("/table-rows", { conn: c, database: "", schema: "tedi_probe", table: "big", search: "77", search_columns: ["g"] });
  check("a filtered count stays exact", !r.result.total_estimated && typeof r.result.total === "number");

  // Existing flows that must keep working: row edit, metadata, the
  // search_path reset that stops one run's schema leaking into the next.
  const target = { conn: c, database: "postgres", schema: "tedi_probe", table: "t" };
  r = await call("/table-insert", { ...target, values: { id: 5, note: "five" } });
  r = await call("/table-update", { ...target, pk: { id: 5 }, values: { note: null } });
  check("row update (to NULL) reports one affected row", r.affected === 1);
  r = await call("/table-update", { ...target, pk: { id: 999 }, values: { note: "x" } });
  check("a stale key reports zero affected, not success", r.affected === 0);
  r = await call("/table-delete", { ...target, pk: { id: 5 } });
  check("row delete", r.affected === 1);
  r = await call(`/columns?conn=${c}&database=postgres&schema=tedi_probe&table=t`);
  check("columns list with the primary key", r.columns.find((x) => x.name === "id")?.is_primary === true);
  r = await call(`/indexes?conn=${c}&database=postgres&schema=tedi_probe&table=t`);
  check("indexes list the primary key", r.indexes.some((i) => i.primary));
  r = await call(`/ddl?conn=${c}&database=postgres&schema=tedi_probe&table=t`);
  check("DDL is reconstructed", /CREATE TABLE/i.test(r.ddl));
  r = await q(c, "SELECT count(*) FROM t");
  check("a one-off run naming no schema does not inherit tedi_probe", first(r).kind === "error");
  r = await q(c, "SELECT count(*) FROM t", { schema: "tedi_probe" });
  check("...while naming it resolves", Number(scalar(r)) === 1);

  await q(c, "DROP SCHEMA tedi_probe CASCADE");
  await call("/disconnect", { id: c });
  await call("/disconnect", { id: "pg-ro" });
}

async function probeMysql(url) {
  console.log("MySQL");
  const c = "my";
  await call("/connect", { id: c, kind: "mysql", url, allow_writes: true });
  await q(c, "DROP DATABASE IF EXISTS tedi_probe; CREATE DATABASE tedi_probe");
  const S = { session: true, database: "tedi_probe" };
  await q(c, "CREATE TABLE t (id int PRIMARY KEY, note text, data blob) ENGINE=InnoDB", S);

  let r = await q(c, "SELECT 1 # it's a comment;\n; SELECT 2", S);
  check("# comments do not swallow the next statement", r.statements.length === 2 && r.statements[1].rows?.[0]?.[0] === 2, JSON.stringify(r.statements.map((s) => s.error ?? s.kind)));

  r = await q(c, "START TRANSACTION; INSERT INTO t VALUES (1, 'a', x'0102')", S);
  check("START TRANSACTION leaves the editor session in a transaction", r.in_transaction === true);
  r = await q(c, "SELECT count(*) FROM tedi_probe.t");
  check("an uncommitted insert is invisible to a one-off query", Number(scalar(r)) === 0);
  r = await q(c, "ROLLBACK", S);
  check("ROLLBACK in a later run discards it", r.in_transaction === false && Number(scalar(await q(c, "SELECT count(*) FROM tedi_probe.t"))) === 0);

  await q(c, "INSERT INTO t VALUES (1, 'a', x'0102')", S);
  r = await q(c, "SELECT count(*) FROM t", S);
  check("the editor session keeps USE between runs", Number(scalar(r)) === 1);

  r = await q(c, "BEGIN; DELETE FROM tedi_probe.t");
  check("a one-off batch left in a transaction is rolled back", /rolled back/.test(r.notice ?? "") && Number(scalar(await q(c, "SELECT count(*) FROM tedi_probe.t"))) === 1);

  r = await q(c, "BEGIN; CREATE TABLE t3 (a int)", S);
  check("MySQL DDL ends the transaction implicitly", r.in_transaction === false);

  r = await q(c, "SELECT data FROM t", S);
  const cell = first(r).rows[0][0];
  check("display rows omit blob bytes", cell?.__type === "bytes" && cell.size === 2 && !("b64" in cell));
  const res = await call("/export", { conn: c, sql: "SELECT * FROM t", database: "tedi_probe", format: "csv" }, true);
  check("raw-SQL export runs in the sent database", res.ok && res.headers.get("x-export-rows") === "1", await res.clone().text());

  const run = q(c, "SELECT SLEEP(10)", { ...S, request_id: "my-cancel" });
  await sleep(400);
  const cancel = await call("/cancel", { request_id: "my-cancel" });
  const t0 = Date.now();
  await run;
  check("Stop cancels on the server (KILL QUERY)", cancel.server_canceled && Date.now() - t0 < 3000);

  const target = { conn: c, database: "tedi_probe", schema: "tedi_probe", table: "t" };
  r = await call("/table-insert", { ...target, values: { id: 5, note: "five" } });
  r = await call("/table-update", { ...target, pk: { id: 5 }, values: { note: "5" } });
  check("row update", r.affected === 1);
  r = await call("/table-delete", { ...target, pk: { id: 5 } });
  check("row delete", r.affected === 1);
  r = await call("/table-rows", { conn: c, database: "tedi_probe", schema: "tedi_probe", table: "t", search: "a", search_columns: ["note"] });
  check("table browse with a search", r.result.rows.length === 1 && r.result.total === 1);

  await q(c, "DROP DATABASE tedi_probe");
  await call("/disconnect", { id: c });
}

try {
  if (process.env.PG_URL) await probePostgres(process.env.PG_URL);
  if (process.env.MYSQL_URL) await probeMysql(process.env.MYSQL_URL);
} catch (e) {
  failed++;
  console.log(`  FAIL  probe aborted: ${e.message}`);
} finally {
  child.kill();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
