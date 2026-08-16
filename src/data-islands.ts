// ─── SPA data-island recovery ──────────────────────────────────────
// Extracts JSON hydration data, application state, and structured data
// from HTML that frameworks inject into the page for client-side hydration.

import { parseHTML } from "linkedom";

interface DataIsland {
	/** Source identifier: the script ID or global variable name. */
	source: string;
	/** Parsed data payload. */
	data: unknown;
	/** Estimated size of the raw payload in bytes. */
	size: number;
}

export interface DataIslandResult {
	/** Whether any data islands were found. */
	found: boolean;
	/** Discovered islands, sorted by size descending. */
	islands: DataIsland[];
	/** A markdown representation of the most useful island(s). */
	markdown?: string;
}

// Known global variables used by frameworks for server → client state transfer.
// Each entry is a tuple: [name, windowRegex, varRegex] where both regexes are
// pre-compiled constants to avoid dynamic RegExp construction.
type GlobalPattern = [name: string, windowRe: RegExp, varRe: RegExp];

const GLOBAL_PATTERNS: GlobalPattern[] = [
	[
		"__DATA__",
		/window\.__DATA__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__DATA__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__INITIAL_STATE__",
		/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__INITIAL_STATE__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__APOLLO_STATE__",
		/window\.__APOLLO_STATE__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__APOLLO_STATE__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__PRELOADED_STATE__",
		/window\.__PRELOADED_STATE__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__PRELOADED_STATE__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__NEXT_DATA__",
		/window\.__NEXT_DATA__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__NEXT_DATA__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__NUXT__",
		/window\.__NUXT__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__NUXT__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__GATSBY__",
		/window\.__GATSBY__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__GATSBY__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__SHOPIFY_SDA__",
		/window\.__SHOPIFY_SDA__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__SHOPIFY_SDA__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__remixContext",
		/window\.__remixContext\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__remixContext\s*=\s*(\{.*?\});?/s,
	],
	[
		"__reactServerManifest",
		/window\.__reactServerManifest\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__reactServerManifest\s*=\s*(\{.*?\});?/s,
	],
	[
		"__remixRouteModules",
		/window\.__remixRouteModules\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__remixRouteModules\s*=\s*(\{.*?\});?/s,
	],
	[
		"__vite_plugin_react_preamble_installed__",
		/window\.__vite_plugin_react_preamble_installed__\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__vite_plugin_react_preamble_installed__\s*=\s*(\{.*?\});?/s,
	],
	[
		"__sveltekit_",
		/window\.__sveltekit_\w+\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__sveltekit_\w+\s*=\s*(\{.*?\});?/s,
	],
	[
		"_env_",
		/window\._env_\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+_env_\s*=\s*(\{.*?\});?/s,
	],
	[
		"window._data",
		/window\._data\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+_data\s*=\s*(\{.*?\});?/s,
	],
	[
		"window.__store",
		/window\.__store\s*=\s*(\{.*?\});?/s,
		/(?:var|const|let)\s+__store\s*=\s*(\{.*?\});?/s,
	],
];

// Known script IDs that contain application/json data
const KNOWN_SCRIPT_IDS = [
	"__NEXT_DATA__",
	"__NUXT_DATA__",
	"__GATSBY_DATA__",
	"__REMIX_DATA__",
	"__APOLLO_STATE__",
	"__INITIAL_STATE__",
	"__PRELOADED_STATE__",
	"__DATA__",
	"__SHOPIFY_SDA__",
	"bootstrap-data",
	"initial-state",
	"app-data",
	"server-data",
	"hydration-data",
	"page-props",
];

/**
 * Try to parse a string as JSON, returning null on failure.
 */
function tryParseJSON(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Extract JSON from inline <script> tags with type="application/json"
 * or type="application/ld+json".
 */
function extractScriptDataIslands(html: string): DataIsland[] {
	const islands: DataIsland[] = [];
	const { document } = parseHTML(html);

	for (const script of document.querySelectorAll("script")) {
		const type = script.getAttribute("type") || "";
		const id = script.getAttribute("id") || "";
		const text = script.textContent || "";
		if (!text.trim()) continue;

		// JSON scripts
		if (
			type === "application/json" ||
			type === "application/ld+json" ||
			type === "text/json"
		) {
			const parsed = tryParseJSON(text);
			if (parsed !== null) {
				islands.push({
					source: id || `script[type="${type}"]`,
					data: parsed,
					size: text.length,
				});
			}
			continue;
		}

		// Check for known script IDs even without explicit JSON type
		if (
			id &&
			KNOWN_SCRIPT_IDS.some((k) => id.toLowerCase().includes(k.toLowerCase()))
		) {
			const parsed = tryParseJSON(text);
			if (parsed !== null) {
				islands.push({
					source: id,
					data: parsed,
					size: text.length,
				});
			}
		}
	}

	return islands;
}

/**
 * Extract state from global window.* variables by pattern matching in the HTML.
 * We look for assignments like `window.__DATA__ = {...}` or `var __DATA__ = {...}`.
 */
function extractGlobalState(html: string): DataIsland[] {
	const islands: DataIsland[] = [];

	for (const [name, windowRe, varRe] of GLOBAL_PATTERNS) {
		for (const pattern of [windowRe, varRe]) {
			const match = html.match(pattern);
			if (match && match[1]) {
				// For nested objects, we need to be careful — try to find the
				// balanced closing brace. The regex above is greedy and may
				// overshoot. We attempt parse; if it fails, we try progressive
				// truncation.
				const jsonStr = match[1];
				let parsed: unknown | null = null;
				for (let len = jsonStr.length; len > 10; len -= 100) {
					parsed = tryParseJSON(jsonStr.slice(0, len));
					if (parsed !== null) break;
				}
				if (parsed !== null) {
					islands.push({
						source: name,
						data: parsed,
						size: match[0].length,
					});
					break; // Found via this pattern, try next global
				}
			}
		}
	}

	return islands;
}

/**
 * Extract React Server Component flight data (Next.js specific).
 */
function extractRSC(html: string): DataIsland[] {
	const matches = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)/gs)];
	if (!matches.length) return [];

	const chunks: string[] = [];
	for (const m of matches) {
		try {
			const data = JSON.parse(m[1]!);
			if (Array.isArray(data) && data.length >= 2) {
				const payload =
					typeof data[1] === "string" ? data[1] : JSON.stringify(data[1]);
				// Extract human-readable strings (heuristic)
				const readable = payload
					.split(/["\n]/)
					.filter(
						(s: string) =>
							s.length > 30 &&
							/[a-z]{3,}/.test(s) &&
							!s.startsWith("$") &&
							!s.startsWith("@"),
					)
					.join("\n\n");
				if (readable) chunks.push(readable);
			}
		} catch {
			// Malformed RSC chunk — skip silently; we expect some chunks
			// to be binary or truncated.
		}
	}

	if (!chunks.length) return [];

	return [
		{
			source: "__next_f (RSC)",
			data: chunks.join("\n\n").slice(0, 20000),
			size: chunks.join("").length,
		},
	];
}

/**
 * Recursively flatten a JSON object into a readable markdown-like structure.
 * Skips deeply nested objects beyond maxDepth.
 */
function flattenToMarkdown(
	obj: unknown,
	depth = 0,
	maxDepth = 3,
	maxItems = 50,
): string {
	if (depth > maxDepth) {
		if (Array.isArray(obj)) return `\`[array ×${obj.length}]\``;
		if (obj !== null && typeof obj === "object") return `\`{object}\``;
		return String(obj);
	}

	if (obj === null) return "`null`";
	if (typeof obj === "string") {
		// If it's a long text block, return as-is
		if (obj.length > 200) return obj.slice(0, 2000);
		return obj;
	}
	if (typeof obj === "number" || typeof obj === "boolean") return String(obj);

	if (Array.isArray(obj)) {
		const items = obj.slice(0, maxItems);
		const lines = items.map((item, _i) => {
			const val = flattenToMarkdown(item, depth + 1, maxDepth, maxItems);
			return `- ${val}`;
		});
		if (obj.length > maxItems) {
			lines.push(`- _… and ${obj.length - maxItems} more_`);
		}
		return lines.join("\n");
	}

	if (typeof obj === "object") {
		const entries = Object.entries(obj).slice(0, maxItems);
		const lines = entries.map(([k, v]) => {
			const val = flattenToMarkdown(v, depth + 1, maxDepth, maxItems);
			if (val.includes("\n") && depth < maxDepth - 1) {
				return `**${k}:**\n${val.replace(/^/gm, "  ")}`;
			}
			return `**${k}:** ${val}`;
		});
		if (Object.keys(obj).length > maxItems) {
			lines.push(`_… and ${Object.keys(obj).length - maxItems} more keys_`);
		}
		return lines.join("\n");
	}

	return String(obj);
}

/**
 * Pick the "most useful" island for markdown conversion.
 * Prefers islands with text content, then largest size.
 */
function pickBestIsland(islands: DataIsland[]): DataIsland | null {
	if (!islands.length) return null;

	// Score each island: prefer objects with string values, penalize tiny ones
	const scored = islands.map((island) => {
		let textScore = 0;
		const data = island.data;
		if (typeof data === "string" && data.length > 100) {
			textScore = data.length;
		} else if (Array.isArray(data)) {
			for (const item of data) {
				if (typeof item === "string") textScore += item.length;
				else if (typeof item === "object" && item !== null) {
					for (const v of Object.values(item)) {
						if (typeof v === "string") textScore += v.length;
					}
				}
			}
		} else if (typeof data === "object" && data !== null) {
			for (const v of Object.values(data)) {
				if (typeof v === "string") textScore += v.length;
				else if (Array.isArray(v)) {
					for (const item of v) {
						if (typeof item === "string") textScore += item.length;
					}
				}
			}
		}
		return { island, score: textScore * 2 + island.size };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored[0]!.island;
}

/**
 * Extract data islands from HTML and convert the best one to markdown.
 */
export function extractDataIslands(html: string): DataIslandResult {
	const islands = [
		...extractScriptDataIslands(html),
		...extractGlobalState(html),
		...extractRSC(html),
	];

	if (!islands.length) {
		return { found: false, islands: [] };
	}

	// Deduplicate by source
	const seen = new Set<string>();
	const unique = islands.filter((i) => {
		if (seen.has(i.source)) return false;
		seen.add(i.source);
		return true;
	});

	// Sort by size descending
	unique.sort((a, b) => b.size - a.size);

	const best = pickBestIsland(unique);
	let markdown: string | undefined;

	if (best) {
		markdown = flattenToMarkdown(best.data);
	}

	return {
		found: true,
		islands: unique,
		markdown,
	};
}
