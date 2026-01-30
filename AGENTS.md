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
- **Tools**: `pg-schema` (get table schemas), `query` (run read-only SQL)
- **Resources**: Table schema as JSON
- **Prompts**: `pg-schema` prompt for retrieving table schemas
- **Completions**: Table name autocompletion

### Database Connection

- Connection is lazy-loaded on first use (not at startup)
- Supports 1Password references (`op://...`) for secure credential storage
- All queries run in read-only transactions with prepared statements

### Security

- Queries execute within `BEGIN TRANSACTION READ ONLY`
- Uses prepared statements to prevent multiple statement execution
- Sessions are destroyed after each query
