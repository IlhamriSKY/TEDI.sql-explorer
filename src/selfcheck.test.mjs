// SQL Explorer self-checks. `npm test`, and nothing needs a database.
//
// One thing is checked here, because one thing in this extension can go wrong
// with nothing on screen to say so: the databases handed over by the Dev
// Environment extension. That handoff crosses two repositories that never
// import each other, so a renamed field or a number where a string was expected
// produces an empty Databases list and no error anywhere. The fixture below is
// the file `tedi.devenv` actually writes, copied verbatim.
//
// The merge is the other half. Only the ADDRESS may be taken from the file:
// losing someone's rename, row limit or write permission every time a port
// moved would make a handed-over connection worse than one typed by hand.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCtx, state } from "./runtime.js";
import { readOfferedConnections, syncManagedConnections } from "./connections/managed.js";

let passed = 0;
/** @param {string} name @param {() => unknown | Promise<unknown>} fn */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const home = mkdtempSync(join(tmpdir(), "sqlx-selfcheck-"));
const file = join(home, ".tedi", "dev-environment.json");
mkdirSync(join(home, ".tedi"), { recursive: true });

setCtx(
  /** @type {any} */ ({
    os: { platform: process.platform === "win32" ? "windows" : "linux" },
    paths: { home },
    logger: { warn: () => {} },
    settings: { get: async () => undefined, set: async () => {} },
    async invoke(cmd, args) {
      if (cmd !== "fs_read_file") throw new Error(`unexpected invoke ${cmd}`);
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(args.path)) throw new Error("not found");
      return { kind: "text", content: readFileSync(args.path, "utf8") };
    },
  }),
);

/** Exactly what `tedi.devenv`'s `manager/handoff.js` writes.
 *  @param {number} mysqlPort */
const handoff = (mysqlPort = 3306) => ({
  kind: "tedi-dev-environment",
  version: 1,
  root: "D:\\DEV ENV",
  connections: [
    {
      id: "devenv:mysql",
      kind: "mysql",
      name: "MySQL (Dev Environment)",
      host: "127.0.0.1",
      port: String(mysqlPort),
      user: "root",
      database: "",
      sslMode: "none",
    },
    {
      id: "devenv:postgres",
      kind: "postgres",
      name: "PostgreSQL (Dev Environment)",
      host: "127.0.0.1",
      port: "5432",
      user: "postgres",
      database: "postgres",
      sslMode: "none",
    },
  ],
});

/** @param {unknown} body */
const publish = (body) => writeFileSync(file, JSON.stringify(body, null, 2));

console.log("\nthe Dev Environment handoff");

await test("the file that extension writes parses into connections", async () => {
  publish(handoff());
  const offered = await readOfferedConnections();
  assert.equal(offered.length, 2, "a connection was dropped by the sanitiser");
  const mysql = offered.find((c) => c.kind === "mysql");
  assert.equal(mysql?.host, "127.0.0.1");
  assert.equal(mysql?.port, "3306");
  assert.equal(mysql?.user, "root");
  // PostgreSQL binds ONE database per connection, so a blank target cannot
  // connect at all.
  assert.equal(offered.find((c) => c.kind === "postgres")?.database, "postgres");
});

await test("no file, no offer, and no error", async () => {
  rmSync(file);
  assert.deepEqual(await readOfferedConnections(), []);
  publish(handoff());
});

await test("a file claiming to be something else is refused", async () => {
  publish({ ...handoff(), kind: "something-else" });
  assert.deepEqual(await readOfferedConnections(), []);
  // And one from a newer writer, whose records this cannot be sure it reads.
  publish({ ...handoff(), version: 99 });
  assert.deepEqual(await readOfferedConnections(), []);
  publish(handoff());
});

await test("it cannot rewrite a connection the user typed", async () => {
  // The whole file is a trust boundary. An id outside the prefix would let it
  // point someone's own saved connection at a host of its choosing.
  const evil = handoff();
  evil.connections[0].id = "my-production-db";
  publish(evil);
  const offered = await readOfferedConnections();
  assert.deepEqual(
    offered.map((c) => c.id),
    ["devenv:postgres"],
  );
  publish(handoff());
});

console.log("\nmerging them into the saved list");

await test("they are added beside what the user already has", async () => {
  state.connections = [{ id: "mine", kind: "mysql", name: "My own", host: "db.example" }];
  assert.equal(await syncManagedConnections(), true);
  assert.equal(state.connections.length, 3);
  assert.equal(state.connections[0].id, "mine", "a hand-typed connection was disturbed");
});

await test("a second sync with nothing new reports no change", async () => {
  assert.equal(await syncManagedConnections(), false, "an idle sync would repaint every launch");
});

await test("a moved port arrives, and the user's own settings survive it", async () => {
  const row = state.connections.find((c) => c.id === "devenv:mysql");
  row.name = "Renamed by me";
  row.allow_writes = true;
  row.row_limit = 500;
  publish(handoff(3399));
  assert.equal(await syncManagedConnections(), true);
  const after = state.connections.find((c) => c.id === "devenv:mysql");
  assert.equal(after.port, "3399", "the new port did not reach the saved connection");
  assert.equal(after.name, "Renamed by me", "the rename was reset");
  assert.equal(after.allow_writes, true, "the write permission was reset");
  assert.equal(after.row_limit, 500, "the row limit was reset");
});

await test("removing the databases removes the connections", async () => {
  rmSync(file);
  assert.equal(await syncManagedConnections(), true);
  assert.deepEqual(
    state.connections.map((c) => c.id),
    ["mine"],
    "only what the user typed should be left",
  );
});

rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}\n`);
