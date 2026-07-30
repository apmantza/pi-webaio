// ─── Context7 library-docs extractor ───────────────────────────────
// Fetches up-to-date library documentation and code examples from
// Context7 (https://context7.com). Keyless by design; honors an optional
// CONTEXT7_API_KEY (Bearer) when set for higher rate limits.
//
// Two-step flow (mirrors the reference implementations):
//   1. Resolve a library name → Context7 library ID via the search API
//      (GET /api/v1/search?query=<name>). The search hit also carries
//      Context7's own trustScore / benchmarkScore / version signals.
//   2. Fetch the docs for that ID as text
//      (GET /api/v1/<libraryId>?type=txt&tokens=<n>).
//
// Context7's txt endpoint sometimes lies about content-type (serves JSON
// with a text/plain header, or vice-versa), so we sniff a leading "{" to
// decide JSON vs plain text rather than trusting the header alone.

import type { VerticalResult } from "./types.ts";

const CONTEXT7_API = "https://context7.com/api/v1";
const DEFAULT_TOKENS = 10000;

interface Context7LibraryMeta {
	name?: string;
	version?: string;
	trustScore?: number;
	benchmarkScore?: number;
}

interface Context7Docs {
	content: string;
	title: string;
	sourceUrl: string;
}

/**
 * Match Context7 library pages, e.g. https://context7.com/reactjs/react.dev
 * or https://context7.com/library/react. Requires a non-empty path so the
 * bare marketing site (context7.com/) is left to the normal HTML pipeline.
 */
export function matchesContext7(url: string): boolean {
	return parseContext7Url(url) !== null;
}

/**
 * Derive the Context7 library path (the API library ID, leading slash) and a
 * searchable query string from a Context7 URL.
 */
export function parseContext7Url(
	url: string,
): { libraryPath: string; query: string } | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (!/(^|\.)context7\.com$/i.test(u.hostname)) return null;

	const path = decodeURIComponent(u.pathname)
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
	if (!path) return null;

	// /library/<slug> pages — the slug is the human-readable search name.
	const libMatch = path.match(/^library\/(.+)$/i);
	const query = libMatch
		? libMatch[1].replace(/\//g, " ").trim()
		: (path.split("/").pop() || path).trim();

	return { libraryPath: `/${path}`, query: query || path };
}

function authHeaders(): Record<string, string> {
	const key = process.env.CONTEXT7_API_KEY;
	return key ? { Authorization: `Bearer ${key}` } : {};
}

function requestHeaders(): Record<string, string> {
	return { "User-Agent": "pi-webaio", Accept: "*/*", ...authHeaders() };
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse a Context7 docs body. Sniffs a leading "{" (or a JSON content-type)
 * to decide JSON vs plain text. Handles both the v1 txt-as-JSON shape
 * ({ content, metadata }) and the v2 context shape ({ codeSnippets,
 * infoSnippets }). Always falls back to treating the body as plain text.
 */
export function parseContext7Body(
	body: string,
	contentType: string | null,
	libraryId: string,
): Context7Docs {
	const fallback: Context7Docs = {
		content: body,
		title: libraryId.replace(/^\//, ""),
		sourceUrl: `https://context7.com${libraryId}`,
	};

	const trimmed = body.trimStart();
	const looksJson =
		(contentType !== null && contentType.includes("application/json")) ||
		trimmed.startsWith("{");
	if (!looksJson) return fallback;

	let json: unknown;
	try {
		json = JSON.parse(trimmed);
	} catch {
		// Context7 lied about content-type — treat as plain text.
		return fallback;
	}
	if (!json || typeof json !== "object") return fallback;

	const j = json as Record<string, unknown>;
	const metadata =
		j.metadata && typeof j.metadata === "object"
			? (j.metadata as Record<string, unknown>)
			: null;

	const title =
		(metadata && typeof metadata.title === "string" && metadata.title) ||
		(typeof j.libraryName === "string" && j.libraryName) ||
		libraryId.replace(/^\//, "");
	const sourceUrl =
		(metadata && typeof metadata.url === "string" && metadata.url) ||
		fallback.sourceUrl;

	// v1 txt-as-JSON: a single `content` string.
	if (typeof j.content === "string" && j.content.trim()) {
		return { content: j.content, title, sourceUrl };
	}

	// v2 context: arrays of code/info snippets.
	const snippets: string[] = [];
	for (const key of ["codeSnippets", "infoSnippets"]) {
		const arr = j[key];
		if (!Array.isArray(arr)) continue;
		for (const s of arr) {
			if (!s || typeof s !== "object") continue;
			const so = s as Record<string, unknown>;
			const text =
				(typeof so.content === "string" && so.content) ||
				(typeof so.text === "string" && so.text) ||
				"";
			if (text.trim()) snippets.push(text.trim());
		}
	}
	if (snippets.length) {
		return { content: snippets.join("\n\n"), title, sourceUrl };
	}

	return fallback;
}

/**
 * Extract Context7 library docs for a Context7 URL.
 */
export async function extractContext7(
	url: string,
): Promise<VerticalResult | null> {
	const parsed = parseContext7Url(url);
	if (!parsed) return null;
	const headers = requestHeaders();

	// ── Step 1: resolve name → library ID (+ trust/benchmark signals) ──
	let libraryId = parsed.libraryPath;
	const meta: Context7LibraryMeta = {};
	try {
		const searchUrl = `${CONTEXT7_API}/search?query=${encodeURIComponent(parsed.query)}`;
		const res = await fetch(searchUrl, { headers });
		if (res.ok) {
			const data = (await res.json()) as {
				results?: Array<Record<string, unknown>>;
			};
			const first = Array.isArray(data.results) ? data.results[0] : null;
			if (first && typeof first.id === "string" && first.id) {
				libraryId = first.id.startsWith("/") ? first.id : `/${first.id}`;
				if (typeof first.name === "string") meta.name = first.name;
				if (typeof first.version === "string") meta.version = first.version;
				meta.trustScore = asNumber(first.trustScore);
				meta.benchmarkScore = asNumber(first.benchmarkScore);
			}
		}
	} catch {
		// Search is best-effort; fall back to the URL-derived library ID.
	}

	// ── Step 2: fetch the docs for the resolved ID ─────────────────────
	let res: Response;
	try {
		const docsUrl = `${CONTEXT7_API}${libraryId}?type=txt&tokens=${DEFAULT_TOKENS}`;
		res = await fetch(docsUrl, { headers });
	} catch (err) {
		return {
			ok: false,
			url,
			content: "",
			error: `Context7 docs request failed: ${(err as Error).message}`,
		};
	}

	if (!res.ok) {
		if (res.status === 404) {
			return {
				ok: false,
				url,
				content: "",
				error: `No Context7 documentation found for ${libraryId}.`,
			};
		}
		return {
			ok: false,
			url,
			content: "",
			error: `Context7 docs request failed with HTTP ${res.status}.`,
		};
	}

	const body = await res.text();
	const docs = parseContext7Body(
		body,
		res.headers.get("content-type"),
		libraryId,
	);

	// ── Build markdown ─────────────────────────────────────────────────
	let md = `# ${docs.title}\n\n`;
	if (meta.name) md += `- **Library:** ${meta.name}\n`;
	if (meta.version) md += `- **Version:** ${meta.version}\n`;
	if (meta.trustScore !== undefined)
		md += `- **Trust score:** ${meta.trustScore}\n`;
	if (meta.benchmarkScore !== undefined)
		md += `- **Benchmark score:** ${meta.benchmarkScore}\n`;
	md += `- **Source:** ${docs.sourceUrl}\n`;
	md += `\n## Documentation\n\n${docs.content.trim() || "(no content returned)"}\n`;

	return {
		ok: true,
		url,
		title: docs.title,
		content: md,
	};
}
