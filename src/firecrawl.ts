/**
 * firecrawl.ts — Firecrawl Search & Scrape API client
 *
 * Firecrawl Keyless works without an API key (1k free credits/month, rate-limited).
 * For higher rate limits, set `FIRECRAWL_API_KEY` in `~/.piwebaio/config`,
 * `~/.piwebaio/.env`, or the environment.
 *
 * Search API:  POST https://api.firecrawl.dev/v1/search  body: { query, limit }
 * Scrape API:  POST https://api.firecrawl.dev/v1/scrape  body: { url, formats }
 *
 * Rate-limit handling: 429 responses trigger an in-memory cooldown so
 * subsequent requests are skipped until the cooldown expires.
 *
 * https://docs.firecrawl.dev/
 */

import { debug } from "./debug.ts";
import { resolveFirecrawlConfigKey } from "./config.ts";

// ─── Rate-limit cooldown (in-memory) ───────────────────────────────

let rateLimitedUntil = 0;

/** True when FireCrawl is in a rate-limit cooldown. */
export function isFirecrawlRateLimited(): boolean {
	return Date.now() < rateLimitedUntil;
}

/** Record a rate-limit hit with the server's retry-after (or 10min default). */
function recordRateLimit(retryAfterSeconds = 600): void {
	rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
	debug("firecrawl", `rate-limited for ${retryAfterSeconds}s (until ${new Date(rateLimitedUntil).toISOString()})`);
}

// ─── API key resolution ────────────────────────────────────────────

function resolveApiKey(): string | null {
	return resolveFirecrawlConfigKey();
}

function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const apiKey = resolveApiKey();
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	return headers;
}

// ─── Search API ─────────────────────────────────────────────────────

export interface FirecrawlSearchResult {
	title: string;
	url: string;
	snippet: string;
	domain: string;
}

/**
 * Search via Firecrawl Search API.
 * Works keyless (rate-limited) or with an API key for higher limits.
 */
export async function searchFirecrawl(
	query: string,
	options: { maxResults?: number } = {},
): Promise<{ results: FirecrawlSearchResult[]; latencyMs: number } | null> {
	// Skip if rate-limited
	if (isFirecrawlRateLimited()) {
		debug("firecrawl", "search skipped: rate-limited cooldown");
		return { results: [], latencyMs: 0 };
	}

	const start = Date.now();
	try {
		const res = await fetch("https://api.firecrawl.dev/v1/search", {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				query,
				limit: options.maxResults ?? 10,
			}),
		});
		const latencyMs = Date.now() - start;

		// Handle 429 rate-limit
		if (res.status === 429) {
			let retryAfter = 600;
			try {
				const body = (await res.json()) as { retry_after_seconds?: number };
				if (body.retry_after_seconds) retryAfter = body.retry_after_seconds;
			} catch { /* ignore parse error */ }
			recordRateLimit(retryAfter);
			return { results: [], latencyMs };
		}

		if (!res.ok) {
			debug("firecrawl", `search HTTP ${res.status}`);
			return { results: [], latencyMs };
		}

		const body = (await res.json()) as {
			success: boolean;
			data?: Array<{
				title?: string;
				url?: string;
				description?: string;
			}>;
		};

		if (!body.success || !Array.isArray(body.data)) {
			debug("firecrawl", "search returned no data array");
			return { results: [], latencyMs };
		}

		const results = body.data
			.map((r) => ({
				title: (r.title ?? "").trim(),
				url: (r.url ?? "").trim(),
				snippet: ((r.description ?? "").trim().slice(0, 300)),
				domain: extractDomain(r.url ?? ""),
			}))
			.filter((r) => r.title && r.url);

		debug("firecrawl", `search returned ${results.length} results in ${latencyMs}ms`);
		return { results, latencyMs };
	} catch (err) {
		const latencyMs = Date.now() - start;
		debug("firecrawl", `search error: ${String(err instanceof Error ? err.message : err)}`);
		return { results: [], latencyMs };
	}
}

// ─── Scrape API ─────────────────────────────────────────────────────

export interface FirecrawlScrapeResult {
	url: string;
	title?: string;
	description?: string;
	markdown?: string;
	language?: string;
}

/**
 * Fetch a URL via Firecrawl Scrape API.
 * Works keyless (rate-limited) or with an API key for higher limits.
 */
export async function fetchFirecrawl(
	url: string,
	options: { formats?: Array<"markdown" | "html"> } = {},
): Promise<FirecrawlScrapeResult | null> {
	// Skip if rate-limited
	if (isFirecrawlRateLimited()) {
		debug("firecrawl", "scrape skipped: rate-limited cooldown");
		return null;
	}

	try {
		const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
			method: "POST",
			headers: buildHeaders(),
			body: JSON.stringify({
				url,
				formats: options.formats ?? ["markdown"],
			}),
		});

		// Handle 429 rate-limit
		if (res.status === 429) {
			let retryAfter = 600;
			try {
				const body = (await res.json()) as { retry_after_seconds?: number };
				if (body.retry_after_seconds) retryAfter = body.retry_after_seconds;
			} catch { /* ignore parse error */ }
			recordRateLimit(retryAfter);
			return null;
		}

		if (!res.ok) {
			debug("firecrawl", `scrape HTTP ${res.status}`);
			return null;
		}

		const body = (await res.json()) as {
			success: boolean;
			data?: {
				markdown?: string;
				html?: string;
				metadata?: {
					title?: string;
					description?: string;
					language?: string;
					sourceURL?: string;
				};
			};
		};

		if (!body.success || !body.data) {
			debug("firecrawl", "scrape returned no data");
			return null;
		}

		return {
			url: body.data.metadata?.sourceURL ?? url,
			title: body.data.metadata?.title,
			description: body.data.metadata?.description,
			markdown: body.data.markdown,
			language: body.data.metadata?.language,
		};
	} catch (err) {
		debug("firecrawl", `scrape error: ${String(err instanceof Error ? err.message : err)}`);
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