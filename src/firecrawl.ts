/**
 * firecrawl.ts — Firecrawl Search & Scrape API client
 *
 * Firecrawl Keyless works without an API key — just POST to the endpoint.
 * Free tier: 1,000 credits/month (no signup needed).
 *
 * Search API:  POST https://api.firecrawl.dev/v1/search  body: { query, limit }
 * Scrape API:  POST https://api.firecrawl.dev/v1/scrape  body: { url, formats }
 *
 * https://docs.firecrawl.dev/
 */

import { debug } from "./debug.ts";

// ─── Search API ─────────────────────────────────────────────────────

export interface FirecrawlSearchResult {
	title: string;
	url: string;
	snippet: string;
	domain: string;
}

/**
 * Search via Firecrawl Keyless Search API.
 * No API key needed — works out of the box.
 */
export async function searchFirecrawl(
	query: string,
	options: { maxResults?: number } = {},
): Promise<{ results: FirecrawlSearchResult[]; latencyMs: number } | null> {
	const start = Date.now();
	try {
		const res = await fetch("https://api.firecrawl.dev/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				limit: options.maxResults ?? 10,
			}),
		});
		const latencyMs = Date.now() - start;
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
				snippet: (r.description ?? "").trim().slice(0, 300),
				domain: extractDomain(r.url ?? ""),
			}))
			.filter((r) => r.title && r.url);
		debug(
			"firecrawl",
			`search returned ${results.length} results in ${latencyMs}ms`,
		);
		return { results, latencyMs };
	} catch (err) {
		const latencyMs = Date.now() - start;
		debug(
			"firecrawl",
			`search error: ${String(err instanceof Error ? err.message : err)}`,
		);
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
 * Fetch a URL via Firecrawl Keyless Scrape API.
 * No API key needed — works out of the box.
 */
export async function fetchFirecrawl(
	url: string,
	options: { formats?: Array<"markdown" | "html"> } = {},
): Promise<FirecrawlScrapeResult | null> {
	try {
		const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url,
				formats: options.formats ?? ["markdown"],
			}),
		});
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
		debug(
			"firecrawl",
			`scrape error: ${String(err instanceof Error ? err.message : err)}`,
		);
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
