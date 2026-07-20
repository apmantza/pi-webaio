/**
 * MCP stdio server adapter for pi-webaio.
 *
 * Exposes all eight aio-* tools to any MCP client (Claude Code, Claude Desktop, etc.)
 * without requiring the pi coding-agent runtime. All tool logic is shared with the
 * pi extension via a thin ExtensionAPI capture shim — no forking of business logic.
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

import {
	loadContentCacheFromDisk,
	loadSearchCacheFromDisk,
	cleanupSessionCache,
	SESSION_CACHE_CLEANUP_MS,
} from "./session-store.ts";
import { registerWebfetchTool } from "./tools/webfetch.ts";
import { registerWebcontentTool } from "./tools/webcontent.ts";
import { registerWebresultTool } from "./tools/webresult.ts";
import { registerWebsearchTool } from "./tools/websearch.ts";
import { registerWebmapTool } from "./tools/webmap.ts";
import { registerWebpullTool } from "./tools/webpull.ts";
import { registerWebqueryTool } from "./tools/webquery.ts";
import { registerWebresearchTool } from "./tools/webresearch.ts";

// ─── Tool definition shape (subset of pi's registerTool config) ────────────

interface McpToolDef {
	name: string;
	description: string;
	/** Raw TypeBox / JSON Schema for the parameters object. */
	inputSchema: Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

// ─── ExtensionAPI capture shim ─────────────────────────────────────────────
// Mimics the minimal subset of pi's ExtensionAPI that the registerX functions
// actually use. We capture each tool definition without needing pi installed.

function captureTools(): McpToolDef[] {
	const tools: McpToolDef[] = [];

	/** Minimal shim that matches the pi ExtensionAPI surface used by the tools. */
	const piShim = {
		registerTool(config: {
			name: string;
			description?: string;
			parameters?: Record<string, unknown>;
			execute: (...args: unknown[]) => Promise<unknown>;
			// TUI-specific fields — ignored by MCP adapter
			label?: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			renderCall?: unknown;
			renderResult?: unknown;
		}): void {
			const rawSchema =
				config.parameters ?? ({ type: "object", properties: {} } as Record<string, unknown>);

			// Strip TypeBox metadata ($schema, $id, Symbol keys) that MCP clients
			// may not understand. Keep the structural JSON Schema properties.
			const inputSchema = sanitizeJsonSchema(rawSchema as Record<string, unknown>);
			// MCP requires inputSchema to be type:"object" at the top level only —
			// injecting `type` into nested nodes corrupts `properties` maps and unions.
			if (!inputSchema["type"]) inputSchema["type"] = "object";

			tools.push({
				name: config.name,
				description: config.description ?? "",
				inputSchema,
				execute: config.execute as McpToolDef["execute"],
			});
		},
	};

	// Register all eight tools via the same functions the pi extension uses.
	// Cast to unknown first — pi is a peer-dep not required at MCP runtime;
	// the shim satisfies the subset of the interface the tools actually call.
	const pi = piShim as unknown as Parameters<typeof registerWebsearchTool>[0];
	registerWebsearchTool(pi);
	registerWebfetchTool(pi);
	registerWebcontentTool(pi);
	registerWebresultTool(pi);
	registerWebmapTool(pi);
	registerWebpullTool(pi);
	registerWebqueryTool(pi);
	registerWebresearchTool(pi);

	return tools;
}

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
	// Warm up session caches (same as pi extension startup).
	loadSearchCacheFromDisk().catch(() => {});
	loadContentCacheFromDisk();
	setInterval(cleanupSessionCache, SESSION_CACHE_CLEANUP_MS).unref();

	const tools = captureTools();
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
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name;
		const tool = toolMap.get(name);
		if (!tool) {
			return {
				isError: true,
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
			};
		}

		const params = request.params.arguments ?? {};
		const toolCallId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		try {
			// onUpdate progress callbacks are no-ops in MCP context.
			const result = await tool.execute(toolCallId, params, undefined, undefined);
			// result.content is already [{type:"text", text}] — pass through.
			return { content: result.content };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				isError: true,
				content: [{ type: "text", text: `Tool error (${name}): ${msg}` }],
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Server now runs until stdin closes — do not print anything to stdout.
}
