# AGENTS.md

This file provides context for AI agents working on this codebase.

## Project Overview

A Model Context Protocol (MCP) server that provides PostgreSQL database introspection and querying capabilities. It exposes database schema information and read-only query execution to MCP clients like Claude Desktop.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Database**: PostgreSQL (via `pg` library)
- **Protocol**: Model Context Protocol SDK (`@modelcontextprotocol/sdk`)
- **Linting**: oxlint (includes oxfmt for formatting)

## Commands

```bash
bun run build      # Compile to standalone binary (.postgres-mcp-bin)
bun run typecheck  # Run TypeScript type checking
bun run lint       # Run oxlint
bun run format     # Run oxlint with --fix for auto-formatting
```

## Project Structure

```
├── index.ts           # Main server implementation (single file)
├── postgres-mcp       # Wrapper shell script for running the binary
├── .postgres-mcp-bin  # Compiled binary (gitignored)
├── package.json
├── tsconfig.json
├── oxlint.json
└── README.md
```

## Key Implementation Details

### MCP Capabilities

The server exposes:
- **Tools**: `pg-schema-overview` (list tables/views with descriptions), `pg-schema` (full definitions for named tables/views), `query` (run read-only SQL)
- **Resources**: Table schema as JSON
- **Prompts**: `pg-schema` prompt for retrieving table schemas
- **Completions**: Table name autocompletion

### Database Connection

- Connection is lazy-loaded on first use (not at startup)
- Supports 1Password references (`op://...`) for secure credential storage
- All queries run in read-only transactions with prepared statements

### Security

- Every database call (schema tools included) runs within `BEGIN TRANSACTION READ ONLY`
- Uses prepared statements to prevent multiple statement execution
- Sessions are destroyed after each query

### Timeouts and Cancellation

- Every wait is bounded: `op read` (60s), pool checkout (15s), and each statement (`SET LOCAL statement_timeout` of 60s per transaction, so it works behind any pooler, with a client-side read timeout as a backstop)
- A cancelled MCP request destroys its connection immediately, so abandoned queries can't hold pool slots and block later requests
- A connection that drops mid-request is logged rather than crashing the process
