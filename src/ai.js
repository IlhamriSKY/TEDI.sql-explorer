/**
 * AI tools for SQL Explorer.
 *
 * Until now this extension registered NONE, which meant neither TEDI's own agent
 * nor an outside AI CLI could open a database or run a query - the panel could be
 * toggled and "Run query" could be pressed on whatever happened to be in the
 * editor, and that was the whole surface. Everything here is a thin wrapper over
 * the same sidecar calls the UI makes, so there is one implementation of a query
 * and not two.
 *
 * SAFETY IS THE EXTENSION'S OWN, NOT A SECOND SET OF RULES:
 *   - `isReadOnly(connId)` is the connection's write gate, exactly as the grid
 *     editor uses it. A read-only connection refuses a write here too.
 *   - `destructiveReason(sql)` is the same check the Run button raises a
 *     confirmation for. A model does not get to click through it: the statement
 *     is REFUSED and the reason returned, and only an explicit `confirm: true`
 *     from the caller lets it proceed.
 * Anything that mutates is declared `approval: "needsApproval"` so the host
 * raises a card regardless - an extension tool runs unvetted third-party code
 * with the app's own privileges, and a prompt-injected model must not be able to
 * drop a table quietly.
 */
import { ctx, state } from "./runtime.js";
import { fetchJson, ensureSidecar } from "./sidecar.js";
import { destructiveReason, isReadOnly } from "./sql.js";
import { ensureConnected, treeLoadDatabases, treeLoadDbChildren, treeLoadTables } from "./tree/data.js";

/** Cap on rows handed back to a model. A SELECT with no LIMIT against a real
 *  table is megabytes, and nobody reading a tool result wants it. */
const MAX_ROWS = 200;

function connOr(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) {
    const have = state.connections.map((c) => c.id).join(", ") || "(none saved)";
    throw new Error(`No saved connection "${id}". Have: ${have}`);
  }
  return conn;
}

/**
 * Annotated, because in a bare array literal `approval: "needsApproval"` widens
 * to `string` and stops satisfying the union the host declares.
 * @type {(import("../tedi").ContributedAiTool & { handler: (args: any) => any })[]}
 */
const TOOLS = [
  {
    name: "sql_connections",
    description:
      "List the saved database connections: id, name, engine, host, database, and whether writes are allowed. Read-only. Start here - every other sql_* tool takes a connection id from this list.",
    parameters: { type: "object", properties: {} },
    handler: () => ({
      connections: state.connections.map((c) => ({
        id: c.id,
        name: c.name,
        engine: c.kind,
        host: c.host ?? null,
        database: c.database ?? null,
        user: c.user ?? null,
        writesAllowed: !isReadOnly(c.id),
      })),
    }),
  },

  {
    name: "sql_schema",
    description:
      "Browse a connection's structure: its databases, a database's schemas, or a schema's tables and views. Connects first if needed. Read-only. Use it to find real table names before writing a query, rather than guessing them.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "From sql_connections." },
        database: { type: "string", description: "Omit to list databases." },
        schema: { type: "string", description: "With database: list that schema's tables." },
      },
      required: ["connectionId"],
    },
    handler: async (args) => {
      const conn = connOr(args.connectionId);
      await ensureSidecar();
      await ensureConnected(conn.id);
      if (!args.database) return { databases: await treeLoadDatabases(conn.id) };
      if (!args.schema) return { children: await treeLoadDbChildren(conn.id, args.database) };
      return { tables: await treeLoadTables(conn.id, args.database, args.schema) };
    },
  },

  {
    name: "sql_query",
    description:
      "Run SQL against a saved connection and return the rows. Connects first if needed. A read-only connection refuses anything that writes. A statement that drops or empties an object, or an UPDATE/DELETE with no WHERE, is REFUSED with the reason and needs an explicit confirm to run - the same guard the Run button raises, which a model may not click through. Rows are capped; add your own LIMIT for more control.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "From sql_connections." },
        sql: { type: "string" },
        database: { type: "string", description: "Run against this database/schema context." },
        schema: { type: "string" },
        confirm: {
          type: "boolean",
          description: "Required to run a statement the destructive check refused.",
        },
      },
      required: ["connectionId", "sql"],
    },
    // Mutating, and the model does not get to decide otherwise. The host
    // raises its card regardless; this states the intent in the manifest too.
    approval: "needsApproval",
    handler: async (args) => {
      const conn = connOr(args.connectionId);
      const sql = String(args.sql ?? "").trim();
      if (!sql) return { error: "empty sql" };

      // The connection's own write gate, before anything is sent.
      const writes = /^\s*(insert|update|delete|drop|truncate|alter|create|replace|grant|revoke)\b/i;
      if (isReadOnly(conn.id) && writes.test(sql)) {
        return { error: `Connection "${conn.name}" is read-only, so this statement was not run.` };
      }
      const danger = destructiveReason(sql);
      if (danger && args.confirm !== true) {
        return { error: `Refused: ${danger} Pass confirm: true to run it anyway.`, needsConfirm: true };
      }

      await ensureSidecar();
      await ensureConnected(conn.id);
      const resp = await fetchJson("/query", {
        method: "POST",
        body: {
          conn: conn.id,
          sql,
          request_id: `ai-${Date.now().toString(36)}`,
          database: args.database ?? state.sessions[conn.id]?.currentDatabase ?? undefined,
          schema: args.schema ?? state.sessions[conn.id]?.currentSchema ?? undefined,
        },
      });

      // The sidecar answers with ONE ENTRY PER STATEMENT, not a flat result:
      // `{ statements: [{ kind: "rows" | "exec" | "error", ... }] }`. Reading it
      // as a flat `{rows, columns}` returned a tidy object of nulls for a query
      // that had actually succeeded - a silent wrong answer, which is the one
      // failure mode this whole surface is built to avoid.
      const statements = Array.isArray(resp?.statements) ? resp.statements : [];
      return {
        statements: statements.map((s) => {
          if (s.kind === "rows") {
            const rows = Array.isArray(s.rows) ? s.rows : [];
            return {
              kind: "rows",
              columns: (s.columns ?? []).map((c) => c.name ?? c),
              rowCount: rows.length,
              // `truncated` from the sidecar means IT capped the read; this
              // second flag means the tool result was capped on the way out.
              truncatedBySource: Boolean(s.truncated),
              truncatedHere: rows.length > MAX_ROWS,
              rows: rows.slice(0, MAX_ROWS),
              elapsedMs: s.elapsed_ms ?? null,
            };
          }
          if (s.kind === "exec") {
            return { kind: "exec", affected: s.rows_affected ?? null, elapsedMs: s.elapsed_ms ?? null };
          }
          return { kind: "error", error: s.error ?? "unknown error", elapsedMs: s.elapsed_ms ?? null };
        }),
      };
    },
  },
];

/**
 * Register with the host. Mirrors `tedi.api-client`: the DECLARATIONS go to
 * `ctx.contribute.aiTools` and the handlers to `registerAiToolHandler`, both at
 * runtime from `activate()` - the manifest never carries AI tools, which is why
 * reading `manifest.contributes.aiTools` reports an empty list for every
 * extension that actually ships some.
 */
export function registerAiTools() {
  if (typeof ctx?.contribute?.aiTools !== "function") return false;
  ctx.contribute.aiTools(TOOLS.map(({ handler: _handler, ...declaration }) => declaration));
  for (const tool of TOOLS) ctx.registerAiToolHandler?.(tool.name, tool.handler);
  return true;
}
