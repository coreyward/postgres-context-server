import { execFile } from "child_process";
import { promisify } from "util";
import pg from "pg";
import type { PoolClient } from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  type CallToolResult,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "postgres-context-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
      completions: {},
    },
  },
);

const rawDatabaseUrl = process.env.DATABASE_URL;
if (rawDatabaseUrl == null || rawDatabaseUrl.trim().length === 0) {
  console.error("Please provide a DATABASE_URL environment variable");
  process.exit(1);
}
// TypeScript doesn't narrow after process.exit, so we assert the type
const databaseUrl: string = rawDatabaseUrl;

// Every wait below is bounded so a stuck dependency surfaces as an error
// instead of a request that never returns.

// Allows time to approve a 1Password authorization prompt.
const OP_READ_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
// Server-side limit per statement; Postgres cancels anything slower.
const STATEMENT_TIMEOUT_MS = 60_000;
// Client-side backstop for when the server never answers (e.g. a dead socket).
const QUERY_READ_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 10_000;

const seconds = (ms: number): string => `${ms / 1000}s`;

const execFileAsync = promisify(execFile);

async function resolveDatabaseUrl(): Promise<string> {
  if (!databaseUrl.startsWith("op://")) {
    return databaseUrl;
  }

  process.stderr.write("Resolving database URL from 1Password...\n");
  try {
    // Async so the server keeps answering other requests while `op` waits.
    const { stdout } = await execFileAsync("op", ["read", databaseUrl], {
      encoding: "utf-8",
      timeout: OP_READ_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (error) {
    if ((error as { killed?: boolean }).killed) {
      throw new Error(
        `1Password didn't return the database URL within ${seconds(OP_READ_TIMEOUT_MS)}. ` +
          "It may be waiting for an authorization prompt to be approved. Try again once it's approved.",
      );
    }
    throw new Error(
      `Failed to resolve 1Password reference: ${(error as Error).message}`,
    );
  }
}

/**
 * Rewrites errors from the limits above into messages that name the limit and
 * what to do next, or returns null for any other error.
 */
function explainTimeout(error: Error): Error | null {
  // 57014 is query_canceled; this server never cancels queries itself, so it
  // means the statement timeout. Matching the code rather than the message
  // text keeps this working when the server's messages aren't in English.
  if ((error as { code?: string }).code === "57014") {
    return new Error(
      `Query cancelled after hitting the ${seconds(STATEMENT_TIMEOUT_MS)} statement timeout. ` +
        "Make it cheaper and retry: filter on indexed columns, narrow the range, " +
        "aggregate before joining, or sample with LIMIT/TABLESAMPLE. " +
        "EXPLAIN (without ANALYZE) shows the plan without running it.",
    );
  }
  if (error.message === "Query read timeout") {
    return new Error(
      `The database didn't respond within ${seconds(QUERY_READ_TIMEOUT_MS)}; ` +
        "the connection may have dropped. Retry the query.",
    );
  }
  if (error.message === "timeout exceeded when trying to connect") {
    return new Error(
      `No database connection became free within ${seconds(CONNECT_TIMEOUT_MS)} ` +
        "because other queries are still running. Retry shortly.",
    );
  }
  if (error.message.includes("connection timeout")) {
    return new Error(
      `Couldn't connect to the database within ${seconds(CONNECT_TIMEOUT_MS)}. ` +
        "Check the network connection and retry.",
    );
  }
  return null;
}

/**
 * Whether the connection itself failed, as opposed to the statement:
 * - SQLSTATE class 08 (connection exceptions) and 57P (the server shutting
 *   down, crashing, or ending the session)
 * - pg's errors for a socket that closed or failed ("Connection terminated…",
 *   "…is not queryable")
 * - Node system errors from the socket, such as ECONNRESET, EPIPE, or
 *   ERR_STREAM_DESTROYED
 */
function isConnectionError(error: Error): boolean {
  if (error instanceof pg.DatabaseError) {
    return /^(08|57P)/.test(error.code ?? "");
  }
  if (
    error.message.startsWith("Connection terminated") ||
    error.message.endsWith("is not queryable")
  ) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z_]+$/.test(code);
}

/** The optional fields Postgres attaches to errors and notices, one per line. */
function serverMessageDetails(message: {
  detail?: string;
  hint?: string;
}): string[] {
  const lines: string[] = [];
  if (message.detail) lines.push(`Detail: ${message.detail}`);
  if (message.hint) lines.push(`Hint: ${message.hint}`);
  return lines;
}

/**
 * Rewrites an error into a message for the model calling the tool, which
 * needs to know what failed and whether a retry can help. Everything this
 * server runs is read-only, so a retry is always safe. In order:
 * - Hitting one of the limits above names the limit and what to do next.
 * - Failing to get a connection (stage "connect") says so, with no retry
 *   hint, since the cause is usually configuration, credentials, or
 *   reachability.
 * - Losing the connection mid-query says so and suggests a retry.
 * - An SQL error carries its SQLSTATE, position, detail, hint, and context.
 * Other errors pass through unchanged.
 */
function describeError(error: unknown, stage: "connect" | "query"): unknown {
  if (!(error instanceof Error)) return error;

  const timeout = explainTimeout(error);
  if (timeout) return timeout;

  const reason =
    error instanceof pg.DatabaseError
      ? `${error.code}: ${error.message}`
      : error.message;
  if (stage === "connect") {
    return new Error(`Couldn't connect to the database (${reason}).`);
  }
  if (isConnectionError(error)) {
    return new Error(
      `The database connection failed, so the query didn't finish (${reason}). Retry the query.`,
    );
  }

  if (error instanceof pg.DatabaseError) {
    const lines = [`SQL error ${reason}`];
    if (error.position) lines.push(`Position: character ${error.position}`);
    if (error.internalQuery) lines.push(`Internal query: ${error.internalQuery}`);
    if (error.internalPosition) {
      lines.push(`Internal position: character ${error.internalPosition}`);
    }
    lines.push(...serverMessageDetails(error));
    if (error.where) lines.push(`Where: ${error.where}`);
    return new Error(lines.join("\n"));
  }
  return error;
}

let pool: pg.Pool | null = null;
let poolPromise: Promise<pg.Pool> | null = null;

async function createPool(): Promise<pg.Pool> {
  const newPool = new pg.Pool({
    connectionString: await resolveDatabaseUrl(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_READ_TIMEOUT_MS,
    keepAlive: true,
  });

  // An idle client losing its connection emits this; unhandled, it would crash
  // the process.
  newPool.on("error", (error) =>
    process.stderr.write(`Idle database client error: ${error.message}\n`),
  );

  pool = newPool;
  return newPool;
}

function getPool(): Promise<pg.Pool> {
  // Concurrent first calls share one resolution; a failure is retried on the
  // next call rather than cached.
  poolPromise ??= createPool().catch((error) => {
    poolPromise = null;
    throw error;
  });
  return poolPromise;
}

/**
 * Runs `fn` with a pooled client inside a read-only transaction. The statement
 * timeout is set with SET LOCAL, so it applies under any connection pooler
 * (including PgBouncer in transaction mode) and never outlives the call.
 *
 * If the MCP request is cancelled, the connection is destroyed at once so its
 * pool slot doesn't stay occupied by a query nobody is waiting for. A client
 * that saw an error is also destroyed, since it may still have a query in
 * flight. `destroy` discards the session even on success.
 */
async function withReadOnlyTransaction<T>(
  signal: AbortSignal,
  fn: (client: PoolClient) => Promise<T>,
  { destroy = false } = {},
): Promise<T> {
  const client = await (await getPool()).connect().catch((error) => {
    throw describeError(error, "connect");
  });

  let released = false;
  const release = (destroyReason?: Error | boolean) => {
    if (released) return;
    released = true;
    client.release(destroyReason);
  };

  if (signal.aborted) {
    // Nothing has run on this connection, so it can go back to the pool.
    release();
    throw new Error("Request cancelled");
  }

  const onAbort = () => release(new Error("Request cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });

  // pg-pool only listens for errors on idle clients. Without this, a connection
  // dropping mid-request would be an unhandled 'error' event and crash the
  // process; the in-flight query rejects as well, and that's handled below.
  const onClientError = (error: Error) =>
    process.stderr.write(`Database client error: ${error.message}\n`);
  client.on("error", onClientError);

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await fn(client);
    if (!destroy) {
      // End the transaction before the client returns to the pool. It's read
      // only, so there's nothing to commit.
      await client.query("ROLLBACK");
    }
    return result;
  } catch (error) {
    release(error as Error);
    throw describeError(error, "query");
  } finally {
    signal.removeEventListener("abort", onAbort);
    client.off("error", onClientError);
    release(destroy);
  }
}

// Use a placeholder URL for resource URIs (actual connection happens lazily)
const resourceBaseUrl = new URL(
  databaseUrl.startsWith("op://") ? "postgres://placeholder/db" : databaseUrl,
);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

process.stderr.write("starting server\n");

const SCHEMA_PATH = "schema";
const SCHEMA_PROMPT_NAME = "pg-schema";
const OVERVIEW_TOOL_NAME = "pg-schema-overview";

server.setRequestHandler(
  ListResourcesRequestSchema,
  async (_request, extra) => {
    // Don't trigger database connection on startup - return empty until first tool use
    if (!pool) {
      return { resources: [] };
    }

    return withReadOnlyTransaction(extra.signal, async (client) => {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      return {
        resources: result.rows.map((row: { table_name: string }) => ({
          uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl)
            .href,
          mimeType: "text/markdown",
          name: `"${row.table_name}" database schema`,
        })),
      };
    });
  },
);

server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }
  if (typeof tableName !== "string" || tableName.length === 0) {
    throw new Error("Invalid resource URI");
  }

  return withReadOnlyTransaction(extra.signal, async (client) => {
    const sql = await getSchema(client, [decodeURIComponent(tableName)]);

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/markdown",
          text: sql,
        },
      ],
    };
  });
});

// Every tool only reads, which lets clients skip write-approval prompts.
const READ_ONLY_TOOL = { readOnlyHint: true, destructiveHint: false };

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: OVERVIEW_TOOL_NAME,
        description:
          "Lists every table and view in the database with its description. " +
          "Use this first to find the relations you need, then call pg-schema " +
          "for their full definitions.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
        annotations: READ_ONLY_TOOL,
      },
      {
        name: "pg-schema",
        description:
          "Returns the full definition (columns, constraints, indexes, and " +
          "comments) for one or more named tables or views. Call " +
          `${OVERVIEW_TOOL_NAME} first if you don't know which to request.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            tableNames: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "Names of the tables or views to describe.",
            },
          },
          required: ["tableNames"],
        },
        annotations: READ_ONLY_TOOL,
      },
      {
        name: "query",
        description:
          "Run a read-only SQL query. Each statement is limited to " +
          `${seconds(STATEMENT_TIMEOUT_MS)} and cancelled if it runs longer, ` +
          "so filter, aggregate, or sample large tables rather than scanning them whole. " +
          "Notices the query raises (e.g. RAISE NOTICE in a DO block) are returned " +
          "after the rows, and errors include their SQLSTATE.",
        inputSchema: {
          type: "object" as const,
          properties: {
            sql: { type: "string" },
          },
        },
        annotations: READ_ONLY_TOOL,
      },
    ],
  };
});

// Total length (in JavaScript string length) of the notices returned for one
// query, so a query raising notices in a loop can't exhaust memory or flood
// the caller.
const NOTICE_LIMIT = 64_000;

/**
 * Collects the notices, warnings, and info messages the server sends while a
 * query runs (`RAISE NOTICE`, for example), so they reach the caller along with
 * the result or the error. Notices are kept whole, in order, until the next one
 * would pass NOTICE_LIMIT; that one and every later one are only counted, so
 * what's returned is never truncated or out of order.
 */
class NoticeLog {
  private notices: string[] = [];
  private length = 0;
  private omitted = 0;

  add = (notice: {
    severity?: string;
    message?: string;
    detail?: string;
    hint?: string;
  }): void => {
    if (this.omitted === 0) {
      const text = [
        `${notice.severity ?? "NOTICE"}: ${notice.message ?? ""}`,
        ...serverMessageDetails(notice),
      ].join("\n");
      if (this.length + text.length <= NOTICE_LIMIT) {
        this.notices.push(text);
        this.length += text.length;
        return;
      }
    }
    this.omitted++;
  };

  isEmpty(): boolean {
    return this.notices.length === 0 && this.omitted === 0;
  }

  render(): string {
    const lines = ["Server notices:", ...this.notices];
    if (this.omitted > 0) {
      lines.push(
        `(${this.omitted} notice${this.omitted === 1 ? "" : "s"} not shown: ` +
          `notices are limited to ${NOTICE_LIMIT.toLocaleString("en-US")} characters per query)`,
      );
    }
    return lines.join("\n");
  }
}

async function callTool(
  params: CallToolRequest["params"],
  signal: AbortSignal,
): Promise<CallToolResult> {
  if (params.name === OVERVIEW_TOOL_NAME) {
    return withReadOnlyTransaction(signal, async (client) => {
      const overview = await getOverview(client);

      return {
        content: [{ type: "text" as const, text: overview }],
      };
    });
  }

  if (params.name === "pg-schema") {
    const tableNames = parseTableNames(params.arguments?.tableNames);

    return withReadOnlyTransaction(signal, async (client) => {
      const sql = await getSchema(client, tableNames);

      return {
        content: [{ type: "text" as const, text: sql }],
      };
    });
  }

  if (params.name === "query") {
    const sql = params.arguments?.sql as string;
    const notices = new NoticeLog();

    try {
      // The session is destroyed afterwards, which also discards the
      // transaction, so there's no need to roll it back.
      return await withReadOnlyTransaction(
        signal,
        async (client) => {
          client.on("notice", notices.add);
          // Force a prepared statement: Prevents multiple statements in the same query.
          // Name is unique per session, but we use a single session per query.
          const result = await client.query({
            name: "sandboxed-statement",
            text: sql,
            values: [],
          });
          const content = [
            {
              type: "text" as const,
              text: JSON.stringify(result.rows, undefined, 2),
            },
          ];
          if (!notices.isEmpty()) {
            content.push({ type: "text" as const, text: notices.render() });
          }
          return { content };
        },
        { destroy: true },
      );
    } catch (error) {
      // Notices raised before a failure often explain it.
      if (error instanceof Error && !notices.isEmpty()) {
        throw new Error(`${error.message}\n\n${notices.render()}`);
      }
      throw error;
    }
  }

  throw new Error(`Tool not found: ${params.name}`);
}

// A failing tool reports the failure in its result rather than as a protocol
// error, which clients may read as a broken server: Claude's desktop app
// restarted this server on the call after each protocol error, and every
// restart asked 1Password for the database URL again. The MCP spec asks for
// this for tool execution errors. It calls an unknown tool name a protocol
// error, but that's reported the same way to avoid the restart.
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    return await callTool(request.params, extra.signal);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
});

server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
  process.stderr.write("Handling completions/complete request\n");

  const ref = request.params.ref;
  if (ref.type === "ref/prompt" && ref.name === SCHEMA_PROMPT_NAME) {
    const tableNameQuery = request.params.argument.value;
    const alreadyHasArg = /\S*\s/.test(tableNameQuery);

    if (alreadyHasArg) {
      return {
        completion: {
          values: [],
        },
      };
    }

    return withReadOnlyTransaction(extra.signal, async (client) => {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const tables = result.rows.map(
        (row: { table_name: string }) => row.table_name,
      );
      return {
        completion: {
          values: tables,
        },
      };
    });
  }

  // Nothing to suggest for other arguments, and an error here would be a
  // protocol error (see the tools/call handler).
  return { completion: { values: [] } };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  process.stderr.write("Handling prompts/list request\n");

  return {
    prompts: [
      {
        name: SCHEMA_PROMPT_NAME,
        description:
          "Retrieve the schema for a given table in the postgres database",
        arguments: [
          {
            name: "tableName",
            description: "the table to describe",
            required: true,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
  process.stderr.write("Handling prompts/get request\n");

  if (request.params.name === SCHEMA_PROMPT_NAME) {
    const tableName = request.params.arguments?.tableName;

    if (typeof tableName !== "string" || tableName.length === 0) {
      throw new Error(`Invalid tableName: ${tableName}`);
    }

    return withReadOnlyTransaction(extra.signal, async (client) => {
      const sql = await getSchema(client, [tableName]);

      return {
        description: `${tableName} schema`,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: sql,
            },
          },
        ],
      };
    });
  }

  throw new Error(`Prompt '${request.params.name}' not implemented`);
});

// Schema introspection reads the system catalog (pg_catalog) rather than
// information_schema: it exposes accurate, modifier-preserving type names via
// format_type, a real boolean for NOT NULL, and Postgres' own renderers for
// constraints, indexes, and view definitions. Everything is scoped to the
// "public" schema to match the resource and completion handlers.

type RelationKind = "r" | "p" | "v" | "m";

interface RelationRow {
  oid: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  view_def: string | null;
}

interface ColumnRow {
  oid: string;
  name: string;
  type: string;
  not_null: boolean;
  default_expr: string | null;
  comment: string | null;
}

type ConstraintType = "p" | "f" | "u" | "x" | "c";

interface ConstraintRow {
  oid: string;
  type: ConstraintType;
  definition: string;
}

interface IndexRow {
  oid: string;
  definition: string;
}

const isTableKind = (kind: RelationKind): boolean =>
  kind === "r" || kind === "p";

// Render order within a table body: primary key, foreign keys, unique,
// exclusion, then check constraints.
const CONSTRAINT_PRIORITY: Record<ConstraintType, number> = {
  p: 0,
  f: 1,
  u: 2,
  x: 3,
  c: 4,
};

function groupByOid<T extends { oid: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.oid);
    if (list) {
      list.push(row);
    } else {
      map.set(row.oid, [row]);
    }
  }
  return map;
}

/** Removes `public.` schema qualifiers, which add noise without meaning here. */
const stripSchema = (text: string): string =>
  text.replaceAll(/\bpublic\./g, "");

/**
 * Strips PostgreSQL `::type` cast suffixes, including precision (`::numeric`),
 * array (`::text[]`), quoted (`::"MyEnum"`), and multi-word
 * (`::character varying`) forms. Ported from the schema-reference generator.
 */
const stripCasts = (text: string): string =>
  text.replaceAll(
    /::(?:"[^"]*"|[a-zA-Z_]\w*)(?:\s+(?:varying|precision|with\s+time\s+zone|without\s+time\s+zone))?(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?/g,
    "",
  );

const cleanExpression = (text: string): string => stripCasts(stripSchema(text));

/**
 * Renders a column default for display, or null to omit it. `nextval(...)`
 * defaults are serial/identity boilerplate and are dropped.
 */
function cleanDefault(expr: string | null): string | null {
  if (expr === null || expr.startsWith("nextval(")) {
    return null;
  }
  return cleanExpression(expr);
}

/** Renders comment text as one or more indented `--` lines. */
function commentLines(text: string, indent: number): string[] {
  const pad = " ".repeat(indent);
  return text
    .split("\n")
    .map((line) => (line === "" ? `${pad}--` : `${pad}-- ${line}`));
}

function renderColumn(column: ColumnRow): string {
  let line = `    "${column.name}" ${column.type}`;
  if (column.not_null) {
    line += " not null";
  }
  const defaultValue = cleanDefault(column.default_expr);
  if (defaultValue !== null) {
    line += ` default ${defaultValue}`;
  }
  return line;
}

function renderTable(
  relation: RelationRow,
  columns: ColumnRow[],
  constraints: ConstraintRow[],
): string {
  // Each entry is a column (or constraint) together with its own comment lines,
  // so the comma separating entries lands after the definition, never after a
  // comment line.
  const entries: string[] = [];
  for (const column of columns) {
    const lines = column.comment ? commentLines(column.comment, 4) : [];
    lines.push(renderColumn(column));
    entries.push(lines.join("\n"));
  }
  for (const constraint of [...constraints].sort(
    (a, b) => CONSTRAINT_PRIORITY[a.type] - CONSTRAINT_PRIORITY[b.type],
  )) {
    entries.push(`    ${stripSchema(constraint.definition)}`);
  }

  const header = relation.comment
    ? `${commentLines(relation.comment, 0).join("\n")}\n`
    : "";
  return `${header}create table "${relation.name}" (\n${entries.join(",\n")}\n);`;
}

function renderView(relation: RelationRow): string {
  const header = relation.comment
    ? `${commentLines(relation.comment, 0).join("\n")}\n`
    : "";
  const keyword =
    relation.kind === "m" ? "create materialized view" : "create view";
  const definition = stripSchema(relation.view_def ?? "").trimEnd();
  return `${header}${keyword} "${relation.name}" as\n${definition}`;
}

/**
 * Validates the `tableNames` argument of a pg-schema call into a non-empty list
 * of names. A bare string is accepted as a single name for convenience.
 */
function parseTableNames(raw: unknown): string[] {
  const names = (Array.isArray(raw) ? raw : [raw]).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
  if (names.length === 0) {
    throw new Error("pg-schema requires a non-empty 'tableNames' array");
  }
  return names;
}

async function getSchema(
  client: PoolClient,
  tableNames: string[],
): Promise<string> {
  // Every query is filtered to the requested relations by name. `= ANY($1)`
  // takes the name array as a single parameter.
  const filter = "AND c.relname = ANY($1)";
  const params = [tableNames];

  const relations = (
    await client.query<RelationRow>(
      /*sql*/ `
      SELECT c.oid::text AS oid, c.relname AS name, c.relkind AS kind,
        obj_description(c.oid, 'pg_class') AS comment,
        CASE
          WHEN c.relkind IN ('v', 'm')
          THEN pg_get_viewdef(c.oid, true)
        END AS view_def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        ${filter}
      `,
      params,
    )
  ).rows;

  const found = new Set(relations.map((relation) => relation.name));
  const missing = tableNames.filter((name) => !found.has(name));

  if (relations.length === 0) {
    return `No tables or views found in the public schema matching: ${missing.join(", ")}`;
  }

  const columns = (
    await client.query<ColumnRow>(
      /*sql*/ `
      SELECT a.attrelid::text AS oid, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr,
              col_description(a.attrelid, a.attnum) AS comment
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm')
          AND a.attnum > 0
          AND NOT a.attisdropped
          ${filter}
        ORDER BY a.attrelid, a.attnum`,
      params,
    )
  ).rows;

  const constraints = (
    await client.query<ConstraintRow>(
      /*sql*/ `
      SELECT con.conrelid::text AS oid, con.contype AS type,
              pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND con.contype IN ('p', 'f', 'u', 'x', 'c')
          ${filter}`,
      params,
    )
  ).rows;

  const indexes = (
    await client.query<IndexRow>(
      /*sql*/ `
      SELECT i.indrelid::text AS oid, pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT i.indisprimary
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid
          )
          ${filter}
        ORDER BY ic.relname`,
      params,
    )
  ).rows;

  const columnsByOid = groupByOid(columns);
  const constraintsByOid = groupByOid(constraints);
  const indexesByOid = groupByOid(indexes);

  relations.sort((a, b) => a.name.localeCompare(b.name));

  const relationBlock = (relation: RelationRow): string => {
    const base = isTableKind(relation.kind)
      ? renderTable(
          relation,
          columnsByOid.get(relation.oid) ?? [],
          constraintsByOid.get(relation.oid) ?? [],
        )
      : renderView(relation);
    // Drop the implicit `USING btree` access method; non-default methods
    // (gin, gist, ...) are kept.
    const indexStatements = (indexesByOid.get(relation.oid) ?? []).map(
      (index) =>
        `${stripSchema(index.definition).replace(" USING btree ", " ")};`,
    );
    return [base, ...indexStatements].join("\n");
  };

  const tableBlocks = relations
    .filter((r) => isTableKind(r.kind))
    .map(relationBlock);
  const viewBlocks = relations
    .filter((r) => !isTableKind(r.kind))
    .map(relationBlock);

  const sections = [...tableBlocks];
  if (viewBlocks.length > 0) {
    if (tableBlocks.length > 0) {
      sections.push("-- Views");
    }
    sections.push(...viewBlocks);
  }

  const schema = `\`\`\`sql\n${sections.join("\n\n")}\n\`\`\``;
  return missing.length > 0
    ? `${schema}\n\n_Not found in the public schema: ${missing.join(", ")}_`
    : schema;
}

interface OverviewRow {
  name: string;
  kind: RelationKind;
  comment: string | null;
}

/**
 * Lists every table and view in the public schema with its comment collapsed to
 * a single line — a directory for choosing which relations to fetch in full via
 * pg-schema.
 */
async function getOverview(client: PoolClient): Promise<string> {
  const relations = (
    await client.query<OverviewRow>(/*sql*/ `
      SELECT c.relname AS name, c.relkind AS kind,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
      ORDER BY c.relname`)
  ).rows;

  if (relations.length === 0) {
    return "No tables or views found in the public schema.";
  }

  const entry = (relation: OverviewRow): string => {
    const comment = relation.comment
      ? ` — ${relation.comment.replaceAll(/\s+/g, " ").trim()}`
      : "";
    return `- ${relation.name}${comment}`;
  };

  const tables = relations.filter((relation) => isTableKind(relation.kind));
  const views = relations.filter((relation) => !isTableKind(relation.kind));

  const sections: string[] = [];
  if (tables.length > 0) {
    sections.push(
      `## Tables (${tables.length})\n${tables.map(entry).join("\n")}`,
    );
  }
  if (views.length > 0) {
    sections.push(`## Views (${views.length})\n${views.map(entry).join("\n")}`);
  }
  return sections.join("\n\n");
}

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
