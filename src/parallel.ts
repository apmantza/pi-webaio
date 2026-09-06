/**
 * parallel.ts — Parallel Search & Extract API client
 *
 * Parallel (https://parallel.ai) provides an LLM-oriented web Search API
 * (objective + keyword queries → LLM-optimized excerpts) and an Extract API
 * (URLs → clean markdown, handles JS pages and PDFs server-side).
 * Both require an API key (https://platform.parallel.ai), resolved from:
 *   1. The `apiKey` parameter (explicit override)
 *   2. `~/.piwebaio/config` file (JSON, key: `parallel.apiKey`)
 *   3. `~/.piwebaio/.env` (key=value, `PARALLEL_API_KEY=...`)
 *   4. The `PARALLEL_API_KEY` environment variable
 *
 * Search API:  POST https://api.parallel.ai/v1/search   body: { objective, search_queries, mode }
 * Extract API: POST https://api.parallel.ai/v1/extract  body: { urls, advanced_settings: { full_content } }
 * Auth:        `x-api-key` header
 *
 * Rate-limit handling: 429 responses trigger an in-memory cooldown so
 * subsequent requests are skipped until the cooldown expires (same pattern
 * as the FireCrawl client).
 *
 * https://docs.parallel.ai/
 */

import { debug } from "./debug.ts";
import { resolveParallelConfigKey } from "./config.ts";

/** Default search mode: `basic` balances latency and quality (turbo is fastest but shallow; advanced is highest quality but slower). */
const DEFAULT_SEARCH_MODE = "basic";

/** Maximum URLs per Extract call (server-side limit per the OpenAPI spec). */
const MAX_EXTRACT_URLS = 20;

// ─── Rate-limit cooldown (in-memory) ───────────────────────────────

let rateLimitedUntil = 0;

/** True when Parallel is in a rate-limit cooldown. */
export function isParallelRateLimited(): boolean {
	return Date.now() < rateLimitedUntil;
}

/** Record a rate-limit hit with the server's retry-after (or 10min default). */
function recordRateLimit(retryAfterSeconds = 600): void {
	rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
	debug(
		"parallel",
		`rate-limited for ${retryAfterSeconds}s (until ${new Date(rateLimitedUntil).toISOString()})`,
	);
}

/** Reset the rate-limit cooldown (used by tests). */
export function resetParallelRateLimit(): void {
	rateLimitedUntil = 0;
}

/**
 * Parse the server's retry-after hint off a 429 response body (best-effort)
 * and enter the rate-limit cooldown. Mirrors the FireCrawl client's handling.
 */
async function handleRateLimitResponse(res: Response): Promise<void> {
	let retryAfter = 600;
	try {
		const body = (await res.json()) as { retry_after?: number };
		if (body.retry_after) retryAfter = body.retry_after;
	} catch {
		/* ignore parse error */
	}
	recordRateLimit(retryAfter);
}

// ─── API key resolution ────────────────────────────────────────────

/**
 * Resolve the Parallel API key, checked in order:
 *   1. Explicit `apiKey` parameter
 *   2. `~/.piwebaio/config` file (JSON, key: `parallel.apiKey`)
 *   3. `~/.piwebaio/.env` (key=value, `PARALLEL_API_KEY=...`)
 *   4. `PARALLEL_API_KEY` environment variable
 */
export function resolveParallelApiKey(override?: string): string | null {
	return override ?? resolveParallelConfigKey();
}

/** True when a Parallel API key is available. */
export function parallelAvailable(apiKey?: string): boolean {
	return resolveParallelApiKey(apiKey) !== null;
}

function buildHeaders(apiKey: string): Record<string, string> {
	return {
		"x-api-key": apiKey,
		"Content-Type": "application/json",
	};
}

// ─── Search API ─────────────────────────────────────────────────────

export type ParallelSearchMode = "turbo" | "fast" | "basic" | "advanced";

export interface ParallelSearchResult {
	title: string;
	url: string;
	snippet: string;
	domain: string;
}

interface ParallelRawSearchResult {
	url?: string;
	title?: string;
	publish_date?: string;
	excerpts?: string[];
}

interface ParallelSearchResponseBody {
	search_id?: string;
	results?: ParallelRawSearchResult[];
}

/**
 * Search via the Parallel Search API.
 * Returns parsed search results, or null when no API key is available.
 * Per-query keyword search: the raw query is sent both as the objective and
 * as the single keyword query; Parallel's own docs recommend 2-3 queries for
 * best recall, but a single query is valid.
 */
export async function searchParallel(
	query: string,
	options: {
		maxResults?: number;
		mode?: ParallelSearchMode;
		maxCharsTotal?: number;
		apiKey?: string;
	} = {},
): Promise<{ results: ParallelSearchResult[]; latencyMs: number } | null> {
	const apiKey = resolveParallelApiKey(options.apiKey);
	if (!apiKey) {
		debug("parallel", "search skipped: no API key");
		return null;
	}
	// Skip if rate-limited
	if (isParallelRateLimited()) {
		debug("parallel", "search skipped: rate-limited cooldown");
		return { results: [], latencyMs: 0 };
	}

	const body: Record<string, unknown> = {
		objective: query,
		search_queries: [query],
		mode: options.mode ?? DEFAULT_SEARCH_MODE,
	};
	if (options.maxCharsTotal !== undefined) {
		body.max_chars_total = options.maxCharsTotal;
	}

	const start = Date.now();
	try {
		const res = await fetch("https://api.parallel.ai/v1/search", {
			method: "POST",
			headers: buildHeaders(apiKey),
			body: JSON.stringify(body),
		});
		const latencyMs = Date.now() - start;

		// Handle 429 rate-limit
		if (res.status === 429) {
			await handleRateLimitResponse(res);
			return { results: [], latencyMs };
		}

		if (!res.ok) {
			debug("parallel", `search HTTP ${res.status}`);
			return { results: [], latencyMs };
		}

		const respBody = (await res.json()) as ParallelSearchResponseBody;
		if (!Array.isArray(respBody.results)) {
			debug("parallel", "search returned no results array");
			return { results: [], latencyMs };
		}

		const results = respBody.results
			.map((r) => ({
				title: (r.title ?? "").trim(),
				url: (r.url ?? "").trim(),
				snippet: (r.excerpts ?? []).join(" ").trim().slice(0, 300),
				domain: extractDomain(r.url ?? ""),
			}))
			.filter((r) => r.title && r.url)
			.slice(0, options.maxResults ?? 15);

		debug(
			"parallel",
			`search returned ${results.length} results in ${latencyMs}ms`,
		);
		return { results, latencyMs };
	} catch (err) {
		const latencyMs = Date.now() - start;
		debug(
			"parallel",
			`search error: ${String(err instanceof Error ? err.message : err)}`,
		);
		return { results: [], latencyMs };
	}
}

// ─── Extract API ────────────────────────────────────────────────────

export interface ParallelExtractResult {
	url: string;
	title?: string;
	publishDate?: string;
	/** Full markdown content when requested; otherwise the joined excerpts. */
	text: string;
}

export interface ParallelExtractError {
	url: string;
	error: string;
}

/**
 * Fetch one or more URLs via the Parallel Extract API.
 * Returns clean markdown full content (server-side JS rendering + PDF
 * extraction). Up to 20 URLs per call. Per-URL failures appear in the
 * errors array rather than rejecting the whole request — each URL is
 * processed independently. Returns null when no API key is available.
 */
export async function fetchParallel(
	urls: string[],
	options: {
		/** Cap on full-content characters per URL (server-side truncation). */
		maxCharsPerResult?: number;
		apiKey?: string;
	} = {},
): Promise<{
	results: ParallelExtractResult[];
	errors: ParallelExtractError[];
} | null> {
	if (!urls.length) {
		return { results: [], errors: [] };
	}
	const apiKey = resolveParallelApiKey(options.apiKey);
	if (!apiKey) {
		debug("parallel", "extract skipped: no API key");
		return null;
	}
	// Skip if rate-limited
	if (isParallelRateLimited()) {
		debug("parallel", "extract skipped: rate-limited cooldown");
		return null;
	}

	const advancedSettings: Record<string, unknown> = { full_content: true };
	if (options.maxCharsPerResult !== undefined) {
		advancedSettings.full_content = {
			max_chars_per_result: options.maxCharsPerResult,
		};
	}

	try {
		const res = await fetch("https://api.parallel.ai/v1/extract", {
			method: "POST",
			headers: buildHeaders(apiKey),
			body: JSON.stringify({
				urls: urls.slice(0, MAX_EXTRACT_URLS),
				advanced_settings: advancedSettings,
			}),
		});

		// Handle 429 rate-limit
		if (res.status === 429) {
			await handleRateLimitResponse(res);
			return null;
		}

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			debug("parallel", `extract HTTP ${res.status}: ${text.slice(0, 200)}`);
			return null;
		}

		const data = (await res.json()) as {
			results?: Array<{
				url?: string;
				title?: string;
				publish_date?: string;
				excerpts?: string[];
				full_content?: string | null;
			}>;
			errors?: Array<{
				url?: string;
				error_type?: string;
				http_status_code?: number | null;
				content?: string | null;
			}>;
		};
		const results = (data.results ?? [])
			.filter((r) => r.url)
			.map((r) => ({
				url: r.url as string,
				title: r.title ?? undefined,
				publishDate: r.publish_date ?? undefined,
				text: (r.full_content ?? (r.excerpts ?? []).join("\n\n")).trim(),
			}))
			.filter((r) => r.text.length > 0);
		const errors = (data.errors ?? [])
			.filter((e) => e.url)
			.map((e) => ({
				url: e.url as string,
				error: [
					e.error_type,
					e.http_status_code ? `HTTP ${e.http_status_code}` : null,
				]
					.filter(Boolean)
					.join(" "),
			}));
		debug(
			"parallel",
			`extract returned ${results.length} results, ${errors.length} errors`,
		);
		return { results, errors };
	} catch (err) {
		const msg = String(err instanceof Error ? err.message : err);
		debug("parallel", `extract error: ${msg}`);
		return null;
	}
}

// ─── Helpers ───────────────────────────────────────────────────────

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}
