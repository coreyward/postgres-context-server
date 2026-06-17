import { execFileSync } from "child_process";
import pg from "pg";
import type { PoolClient } from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
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

let resolvedDatabaseUrl: string | null = null;

async function getDatabaseUrl(): Promise<string> {
  if (resolvedDatabaseUrl) return resolvedDatabaseUrl;

  if (databaseUrl.startsWith("op://")) {
    process.stderr.write("Resolving database URL from 1Password...\n");
    try {
      resolvedDatabaseUrl = execFileSync("op", ["read", databaseUrl], {
        encoding: "utf-8",
      }).trim();
    } catch (error) {
      throw new Error(
        `Failed to resolve 1Password reference: ${(error as Error).message}`,
      );
    }
  } else {
    resolvedDatabaseUrl = databaseUrl;
  }

  return resolvedDatabaseUrl!;
}

let pool: pg.Pool | null = null;

async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const connectionString = await getDatabaseUrl();
  pool = new pg.Pool({ connectionString });
  return pool;
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
const ALL_TABLES = "all-tables";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Don't trigger database connection on startup - return empty until first tool use
  if (!resolvedDatabaseUrl) {
    return { resources: [] };
  }

  const client = await (await getPool()).connect();
  try {
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return {
      resources: result.rows.map((row: { table_name: string }) => ({
        uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "text/markdown",
        name: `"${row.table_name}" database schema`,
      })),
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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

  const client = await (await getPool()).connect();
  try {
    const sql = await getSchema(client, decodeURIComponent(tableName));

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/markdown",
          text: sql,
        },
      ],
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "pg-schema",
        description: "Returns the schema for a Postgres database.",
        inputSchema: {
          type: "object" as const,
          properties: {
            mode: {
              type: "string",
              enum: ["all", "specific"],
              description: "Mode of schema retrieval",
            },
            tableName: {
              type: "string",
              description:
                "Name of the specific table (required if mode is 'specific')",
            },
          },
          required: ["mode"],
          if: {
            properties: { mode: { const: "specific" } },
          },
          // eslint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a Promise
          then: {
            required: ["tableName"],
          },
        },
      },
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object" as const,
          properties: {
            sql: { type: "string" },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "pg-schema") {
    const mode = request.params.arguments?.mode;

    const tableName = (() => {
      switch (mode) {
        case "specific": {
          const tableName = request.params.arguments?.tableName;

          if (typeof tableName !== "string" || tableName.length === 0) {
            throw new Error(`Invalid tableName: ${tableName}`);
          }

          return tableName;
        }
        case "all": {
          return ALL_TABLES;
        }
        default:
          throw new Error(`Invalid mode: ${mode}`);
      }
    })();

    const client = await (await getPool()).connect();

    try {
      const sql = await getSchema(client, tableName);

      return {
        content: [{ type: "text" as const, text: sql }],
      };
    } finally {
      client.release();
    }
  }

  if (request.params.name === "query") {
    const sql = request.params.arguments?.sql as string;

    const client = await (await getPool()).connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      // Force a prepared statement: Prevents multiple statements in the same query.
      // Name is unique per session, but we use a single session per query.
      const result = await client.query({
        name: "sandboxed-statement",
        text: sql,
        values: [],
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.rows, undefined, 2),
          },
        ],
      };
    } finally {
      client
        .query("ROLLBACK")
        .catch((error) =>
          console.warn("Could not roll back transaction:", error),
        );

      // Destroy session to clean up resources.
      client.release(true);
    }
  }

  throw new Error("Tool not found");
});

server.setRequestHandler(CompleteRequestSchema, async (request) => {
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

    const client = await (await getPool()).connect();
    try {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const tables = result.rows.map(
        (row: { table_name: string }) => row.table_name,
      );
      return {
        completion: {
          values: [ALL_TABLES, ...tables],
        },
      };
    } finally {
      client.release();
    }
  }

  throw new Error("unknown prompt");
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

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  process.stderr.write("Handling prompts/get request\n");

  if (request.params.name === SCHEMA_PROMPT_NAME) {
    const tableName = request.params.arguments?.tableName;

    if (typeof tableName !== "string" || tableName.length === 0) {
      throw new Error(`Invalid tableName: ${tableName}`);
    }

    const client = await (await getPool()).connect();

    try {
      const sql = await getSchema(client, tableName);

      return {
        description:
          tableName === ALL_TABLES
            ? "all table schemas"
            : `${tableName} schema`,
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
    } finally {
      client.release();
    }
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

async function getSchema(
  client: PoolClient,
  tableNameOrAll: string,
): Promise<string> {
  const specific = tableNameOrAll !== ALL_TABLES;
  const filter = specific ? "AND c.relname = $1" : "";
  const params = specific ? [tableNameOrAll] : [];

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

  if (relations.length === 0) {
    return specific
      ? `No table or view named "${tableNameOrAll}" in the public schema.`
      : "No tables or views found in the public schema.";
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

  return `\`\`\`sql\n${sections.join("\n\n")}\n\`\`\``;
}

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
