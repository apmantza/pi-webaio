# pi-webaio MCP Server

`pi-webaio` ships a stdio MCP (Model Context Protocol) server that exposes all
eight `aio-*` tools to any MCP client — Claude Code, Claude Desktop, and any
other MCP-compatible host — **without requiring the pi coding-agent runtime**.

> **Primary interface:** The pi extension (`index.ts`) remains the primary way
> to use these tools inside pi. The MCP server is a thin adapter for clients
> that speak MCP natively.

---

## Tools exposed

| MCP tool name    | Description |
|------------------|-------------|
| `aio-websearch`  | Search the web (DDG, Brave, Yahoo, Bing, Google, and Reddit CDP when available) with a hard 7s response deadline |
| `aio-webfetch`   | Fetch one or more URLs and convert to markdown with anti-bot fingerprinting |
| `aio-webcontent` | Retrieve previously fetched content from session cache by URL |
| `aio-webresult`  | Retrieve a stored web scrape result by response ID |
| `aio-webmap`     | Discover pages on a site (robots.txt, sitemaps, nav, llms.txt, GitHub tree) |
| `aio-webpull`    | Pull an entire site into local markdown files |
| `aio-webquery`   | BM25 offline search over a previously pulled corpus |
| `aio-webresearch`| Single-round research bundle: fan out search, rank/dedupe sources, fetch top-N, write a cited evidence bundle to disk |

The MCP server exposes the **same parameters** the pi extension does, since tool
definitions are captured from the shared registration functions. That includes
the newer `aio-webfetch` params (`outline`, `summarize`, `query` answer mode,
multi-source `urls` + `query` cited answers, `budgetTokens`, `diff`,
`localCheck`), the `aio-webcontent` `diff` / `budgetTokens` / `query` params,
and the `aio-websearch` `compact` / `goggles` / `prefetch` params.

---

## Claude Code setup

### Via npx (recommended for most users)

```bash
claude mcp add webaio -- npx -y pi-webaio-mcp
```

### Via local path (for development / offline use)

```bash
claude mcp add webaio -- node /absolute/path/to/pi-webaio/bin/pi-webaio-mcp.mjs
```

After adding, verify with:

```bash
claude mcp list
```

---

## Claude Desktop setup

Add the following to your `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "webaio": {
      "command": "npx",
      "args": ["-y", "pi-webaio-mcp"]
    }
  }
}
```

Or, for a local checkout:

```json
{
  "mcpServers": {
    "webaio": {
      "command": "node",
      "args": ["/absolute/path/to/pi-webaio/bin/pi-webaio-mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

---

## How it works

The MCP server is a **strict thin adapter** — it captures tool definitions
(name, description, JSON Schema, execute function) from the same
`registerXTool()` functions the pi extension uses, via a minimal shim that
implements only the `pi.registerTool()` interface. No tool logic is duplicated.

- TypeBox schemas are passed through as plain JSON Schema (TypeBox `$schema` /
  `$id` metadata is stripped; structural keywords like `type`, `properties`,
  `description`, `default`, `minimum` are preserved).
- Progress callbacks (`onUpdate`) are no-ops; MCP clients receive the final
  text result.
- Errors are returned as `isError: true` with the tool's user-facing error
  summary (same `FetchError` formatting the pi extension uses).
- **stdout is exclusively the MCP protocol channel** — diagnostics go to
  stderr.
