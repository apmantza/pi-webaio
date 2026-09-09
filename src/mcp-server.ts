/**
 * MCP stdio server adapter for pi-webaio.
 *
 * Exposes all eight aio-* tools to any MCP client (Claude Code, Claude Desktop, etc.)
 * without requiring the pi coding-agent runtime. All tool logic is shared with the
 * pi extension via the SDK runtime (src/sdk.ts) — no forking of business logic.
 *
 * stdout is the MCP protocol channel. All diagnostics go to stderr.
 */
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { initRuntime, listTools, runToolFull } from "./sdk.ts";
import { redactSecrets } from "./redact.ts";

// ─── Tool runtime ───────────────────────────────────────────────────────────
// The MCP adapter is a thin JSON-RPC wrapper over the shared SDK runtime
// (src/sdk.ts): it enumerates tools via listTools() and dispatches calls via
// runToolFull(), so the exact business logic the pi extension runs is reused
// with no forking. Tool modules are loaded lazily on first call, and
// initRuntime() warms the session caches AND user-defined verticals — the
// pi-extension startup parity this adapter previously skipped.

/**
 * Strip TypeBox-specific metadata and Symbol keys from a schema object so
 * MCP clients receive clean JSON Schema. We only remove `$schema` and
 * `$id` at the root — other keywords (title, description, default, minimum,
 * etc.) are useful and preserved.
 */
function sanitizeJsonSchema(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const key of Object.keys(schema)) {
		if (key === "$schema" || key === "$id") continue;
		const value = schema[key];
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			cleaned[key] = sanitizeJsonSchema(value as Record<string, unknown>);
		} else if (Array.isArray(value)) {
			cleaned[key] = value.map((v) =>
				v !== null && typeof v === "object"
					? sanitizeJsonSchema(v as Record<string, unknown>)
					: v,
			);
		} else {
			cleaned[key] = value;
		}
	}
	return cleaned;
}

/**
 * Read the package version for serverInfo. The compiled file lives at
 * dist/src/mcp-server.js (two levels below the root) while the source lives at
 * src/mcp-server.ts (one level), so try both relative locations.
 */
function readPackageVersion(): string {
	const req = createRequire(import.meta.url);
	for (const rel of ["../package.json", "../../package.json"]) {
		try {
			const pkg = req(rel) as { name?: string; version?: string };
			if (pkg.name === "pi-webaio" && typeof pkg.version === "string") {
				return pkg.version;
			}
		} catch {
			// try next location
		}
	}
	return "0.0.0";
}

// ─── MCP server ────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
	// Shared SDK runtime startup — warms session caches AND loads user-defined
	// verticals (the pi-extension parity this adapter previously skipped).
	await initRuntime();

	const tools = listTools().map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: sanitizeJsonSchema(t.parameters),
	}));
	const toolMap = new Map(tools.map((t) => [t.name, t]));

	const server = new Server(
		{ name: "pi-webaio", version: readPackageVersion() },
		{ capabilities: { tools: {} } },
	);

	// tools/list — enumerate all seven tools with their JSON Schema.
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
	}));

	// tools/call — dispatch to the matching tool's execute function.
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK request type not re-exported as named type
	server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
		const name = request.params.name;
		const tool = toolMap.get(name);
		if (!tool) {
			return {
				isError: true,
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
			};
		}

		const params = request.params.arguments ?? {};

		try {
			// onUpdate progress callbacks are no-ops in MCP context.
			const result = await runToolFull(name, params);
			// result.content is already [{type:"text", text}] — pass through.
			return {
				content: (result as { content: Array<{ type: string; text: string }> })
					.content,
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// Sanitization parity with the pi-extension path: fetch-error.ts /
			// render-result.ts run redactSecrets() over error messages so a
			// credential echoed in a thrown error never reaches the agent. The
			// MCP path must do the same, or it would leak secrets the TUI path
			// masks. redactSecrets is idempotent and non-destructive to
			// secret-free text.
			return {
				isError: true,
				content: [
					{ type: "text", text: redactSecrets(`Tool error (${name}): ${msg}`) },
				],
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Server now runs until stdin closes — do not print anything to stdout.
}
