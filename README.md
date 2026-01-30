# postgres-context-server

This module implements a Model Context Protocol server for a PostgreSQL database.

## Setup

Set the `DATABASE_URL` environment variable to your PostgreSQL connection string.

### 1Password Integration

This server supports lazy-loading secrets from 1Password. Instead of a raw connection string, you can use an `op://` reference:

```
DATABASE_URL="op://Vault Name/Item Name/field"
```

The secret is only resolved when the first database operation is requested, avoiding Touch ID prompts just to start the server.

### Wrapper Script

A wrapper script (`postgres-mcp`) is provided for easy use with MCP clients. It:

1. Resolves symlinks to find the real script directory
2. Loads environment variables from `.env`
3. Executes the compiled binary

To set up:

1. Create a `.env` file in the project directory with your `DATABASE_URL`
2. Build the binary: `bun run build`
3. Symlink the wrapper to your PATH: `ln -s /path/to/postgres-mcp /usr/local/bin/postgres-mcp`

Then configure your MCP client:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "postgres-mcp"
    }
  }
}
```

## Tools

- **pg-schema** - Returns the schema for tables in the database
- **query** - Run a read-only SQL query
