#!/usr/bin/env node
/**
 * pi-webaio MCP server entry point.
 *
 * Runs a stdio MCP server that exposes all seven aio-* tools to any MCP
 * client (Claude Code, Claude Desktop, etc.) without requiring the pi
 * coding-agent runtime.
 *
 * Usage:
 *   npx -y pi-webaio-mcp
 *   node /path/to/bin/pi-webaio-mcp.mjs
 *
 * stdout is the MCP protocol channel — nothing is printed here.
 * All diagnostics go to stderr.
 */

// Resolve dist path relative to this file so the script works both when
// installed globally (node_modules/.bin) and when run from the source tree.
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, "..", "dist", "src", "mcp-server.js");

const { startMcpServer } = await import(pathToFileURL(serverPath).href);

startMcpServer().catch((err) => {
	process.stderr.write(`pi-webaio-mcp fatal error: ${err?.message ?? err}\n`);
	process.exit(1);
});
