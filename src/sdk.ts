/**
 * pi-webaio SDK — the single shared tool runtime for the pi extension, the MCP
 * server, and the CLI.
 *
 * This module is the "everything-as-an-SDK" surface: it exposes all eight
 * aio-* tools as callable functions with the exact same business logic the pi
 * extension runs (no forking). The three surfaces differ only in how they
 * invoke `runTool` / render the returned text:
 *
 *   - pi extension  → registerLazyTools (lazy registration + TUI renderers)
 *   - MCP server    → runTool() wrapped in the MCP JSON-RPC protocol
 *   - CLI           → runTool() behind an argv parser
 *
 * Token economy is inherited, not re-engineered: `runTool` returns the execute
 * output text verbatim, and every tool's execute already shapes it (frugal
 * preview over long webfetch content, answer mode via `query`, `budgetTokens`
 * hard caps, `compact` search lines, `outline` mode). Consumers wanting a
 * tighter budget pass the same params they would to the pi extension.
 *
 * Startup is lazy: tool implementation graphs are imported only on first
 * `runTool`/`listTools` call, and `initRuntime()` warms the session caches and
 * user-defined verticals (parity with the pi extension's startup path).
 */
import {
	lazyTools,
	loadRegisteredTool,
	LAZY_TOOL_NAMES,
} from "./tools/lazy.ts";
import type { RegisteredTool } from "./tools/lazy.ts";
import { initUserExtractors } from "./verticals/registry.ts";
import {
	loadContentCacheFromDisk,
	loadSearchCacheFromDisk,
	cleanupSessionCache,
	SESSION_CACHE_CLEANUP_MS,
} from "./session-store.ts";

// ─── Runtime state ──────────────────────────────────────────────────────────
// Caches are warmed once (idempotent); tool modules are loaded + captured once
// per name on first use. `_loading` separates the in-flight promise from the
// resolved runtime so a failure is retryable on the next call.

let _ready: Promise<void> | undefined;
const _runtimes = new Map<string, RegisteredTool>();
const _loading = new Map<string, Promise<RegisteredTool>>();

export interface RunToolResult {
	/** The token-shaped execute output — identical to what the pi TUI renders. */
	text: string;
	/** Structured metadata (results, sources, stats, hashes, …) when the tool emits it. */
	details: Record<string, unknown> | undefined;
}

export interface RunToolOptions {
	signal?: AbortSignal;
	onUpdate?: (update: unknown) => void;
}

export interface ToolInfo {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	/** Clean JSON Schema (no TypeBox $schema/$id metadata). */
	parameters: Record<string, unknown>;
}

/**
 * Warm the session caches and load user-defined vertical extractors, exactly
 * as the pi extension does at startup. Idempotent — safe to call repeatedly.
 */
export async function initRuntime(): Promise<void> {
	_ready ??= (async () => {
		await Promise.all([loadSearchCacheFromDisk(), loadContentCacheFromDisk()]);
		await initUserExtractors();
		setInterval(cleanupSessionCache, SESSION_CACHE_CLEANUP_MS).unref();
	})();
	return _ready;
}

async function loadTool(name: string): Promise<RegisteredTool> {
	await initRuntime();
	const cached = _runtimes.get(name);
	if (cached) return cached;
	let pending = _loading.get(name);
	if (!pending) {
		const def = lazyTools.find((t) => t.name === name);
		if (!def) throw new Error(`Unknown tool: ${name}`);
		pending = loadRegisteredTool(def.load).then((tool) => {
			_runtimes.set(name, tool);
			return tool;
		});
		_loading.set(name, pending);
	}
	return pending;
}

/** Enumerate all eight tools with their metadata and clean JSON schemas. */
export function listTools(): ToolInfo[] {
	return lazyTools.map((t) => ({
		name: t.name,
		label: t.label,
		description: t.description,
		promptSnippet: t.promptSnippet,
		promptGuidelines: t.promptGuidelines,
		parameters: t.parameters,
	}));
}

/** Clean JSON Schema for a single tool, or undefined if the name is unknown. */
export function getToolSchema(name: string): Record<string, unknown> | undefined {
	const t = lazyTools.find((t) => t.name === name);
	return t?.parameters;
}

export function isTool(name: string): boolean {
	return lazyTools.some((t) => t.name === name);
}

/**
 * Run a tool by name with the given params, returning the token-shaped text
 * result plus structured details. Throws on unknown tool or tool error.
 */
export async function runTool(
	name: string,
	params: Record<string, unknown>,
	opts: RunToolOptions = {},
): Promise<RunToolResult> {
	const tool = await loadTool(name);
	const result = await tool.execute(
		`sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		params,
		opts.signal,
		opts.onUpdate,
	);
	const content = (result as { content?: unknown }).content;
	let text = "";
	if (Array.isArray(content)) {
		const first = content.find(
			(item): item is { text: string } =>
				Boolean(item) &&
				typeof item === "object" &&
				typeof (item as { text?: unknown }).text === "string",
		);
		if (first) text = first.text;
	}
	return {
		text,
		details: (result as { details?: Record<string, unknown> }).details,
	};
}

/**
 * Run a tool and return the full execute result (content array + details) for
 * programmatic consumers that need more than the shaped text.
 */
export async function runToolFull(
	name: string,
	params: Record<string, unknown>,
	opts: RunToolOptions = {},
): Promise<unknown> {
	const tool = await loadTool(name);
	return tool.execute(
		`sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		params,
		opts.signal,
		opts.onUpdate,
	);
}

export { LAZY_TOOL_NAMES };
