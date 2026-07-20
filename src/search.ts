// ─── Web search ────────────────────────────────────────────────────
// Extracted from index.ts. Multi-engine search (DDG, Brave, Yahoo, Bing)
// with engine health tracking, caching, dedup and cross-engine scoring.

import { parseHTML } from "linkedom";
import { smartFetch } from "./fetch.ts";
import { storeSearchResults, getCachedSearch } from "./session-store.ts";
import {
	recordEngineSearchSuccess,
	recordEngineSearchFailure,
	rankEngines,
} from "./strategy-memory.ts";
import type {
	SearchResult,
	EngineHealthRecord,
	EngineSource,
} from "./types.ts";

// ─── Engine health tracking ────────────────────────────────────────

export const ENGINE_HEALTH_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown
export const ENGINE_FAILURE_THRESHOLD = 2; // consecutive failures before cooldown

export const sessionEngineHealth = new Map<string, EngineHealthRecord>();

export function getOrCreateEngineHealth(engine: string): EngineHealthRecord {
	const existing = sessionEngineHealth.get(engine);
	if (existing) return existing;

	const created: EngineHealthRecord = {
		successes: 0,
		failures: 0,
		consecutiveFailures: 0,
		totalLatencyMs: 0,
		samples: 0,
	};
	sessionEngineHealth.set(engine, created);
	return created;
}

export function recordEngineSuccess(engine: string, latencyMs: number): void {
	const record = getOrCreateEngineHealth(engine);
	record.successes += 1;
	record.consecutiveFailures = 0;
	record.coolDownUntil = undefined;
	record.lastSuccessAt = Date.now();
	record.lastLatencyMs = latencyMs;
	record.totalLatencyMs += latencyMs;
	record.samples += 1;
}

export function recordEngineFailure(engine: string, reason: string): void {
	const record = getOrCreateEngineHealth(engine);
	record.failures += 1;
	record.consecutiveFailures += 1;
	record.lastFailureAt = Date.now();
	record.lastFailureReason = reason;

	if (record.consecutiveFailures >= ENGINE_FAILURE_THRESHOLD) {
		record.coolDownUntil = Date.now() + ENGINE_HEALTH_COOLDOWN_MS;
	}
}

export function isEngineAvailable(engine: string): boolean {
	const record = sessionEngineHealth.get(engine);
	if (!record?.coolDownUntil) return true;
	if (Date.now() >= record.coolDownUntil) {
		record.coolDownUntil = undefined;
		record.consecutiveFailures = 0;
		return true;
	}
	return record.consecutiveFailures >= ENGINE_FAILURE_THRESHOLD;
}

// Backward-compatible aliases
export function isProviderAvailable(provider: string): boolean {
	return isEngineAvailable(provider);
}

export function recordProviderCooldown(
	provider: string,
	reason: string,
	ttlMs: number,
): void {
	const record = getOrCreateEngineHealth(provider);
	record.failures += 1;
	record.consecutiveFailures += 1;
	record.lastFailureAt = Date.now();
	record.lastFailureReason = reason;
	record.coolDownUntil = Date.now() + ttlMs;
}

export function recordProviderNetworkFailure(
	provider: string,
	msg: string,
): void {
	const lower = msg.toLowerCase();
	const isConnFailure =
		lower.includes("econnrefused") ||
		lower.includes("ehostunreach") ||
		lower.includes("enetunreach") ||
		lower.includes("connection refused") ||
		lower.includes("connection reset") ||
		lower.includes("fetch failed") ||
		lower.includes("enotfound") ||
		lower.includes("getaddrinfo");
	recordProviderCooldown(
		provider,
		msg,
		isConnFailure ? 2 * 60 * 1000 : 10 * 60 * 1000,
	);
}

export function isQuotaError(status: number, body: string): boolean {
	return (
		status === 429 ||
		status === 402 ||
		status === 403 ||
		status === 1015 ||
		/rate limit|quota|credits|limit reached|monthly limit/i.test(body)
	);
}

// ─── URL helpers ───────────────────────────────────────────────────

export function extractDdgUrl(href: string): string {
	try {
		const u = new URL(href, "https://duckduckgo.com");
		const real = u.searchParams.get("uddg");
		if (real) return decodeURIComponent(real);
	} catch {
		/* ignore */
	}
	return href;
}

export function extractDomain(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

// ─── Search result parsers ─────────────────────────────────────────

function checkSearchFilters(
	url: string,
	hostname: string,
	engines: string[],
): boolean {
	for (const eng of engines) {
		if (hostname === eng || hostname.endsWith(`.${eng}`)) return false;
	}
	return true;
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];

	for (const el of document.querySelectorAll(".result")) {
		const a = el.querySelector(".result__a");
		const snippet = el.querySelector(".result__snippet");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const url = extractDdgUrl(rawUrl);
		const title = a.textContent?.trim() || "";
		const text = snippet?.textContent?.trim() || "";
		if (url && title) {
			results.push({ title, url, snippet: text, domain: extractDomain(url) });
		}
	}
	return results;
}

export function parseYahooResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];

	for (const el of document.querySelectorAll(
		"#web li, ol.searchCenterMiddle li",
	)) {
		const a = el.querySelector("a");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const title = a.textContent?.trim() || "";
		if (!title || !rawUrl) continue;

		let url: string | undefined;
		try {
			const u = new URL(rawUrl, "https://search.yahoo.com");
			const ru = u.searchParams.get("RU") || u.searchParams.get("ru");
			if (ru) {
				url = decodeURIComponent(ru);
			} else if (u.hostname === "r.search.yahoo.com") {
				const match = u.pathname.match(/\/RU=([^/]+)\//);
				if (match?.[1]) url = decodeURIComponent(match[1]);
			} else {
				url = rawUrl;
			}
		} catch {
			url = rawUrl;
		}

		if (!url || !/^https?:/i.test(url)) continue;
		if (
			!checkSearchFilters(url, new URL(url).hostname, [
				"search.yahoo.com",
				"video.search.yahoo.com",
				"r.search.yahoo.com",
			])
		)
			continue;

		const snippet = el.querySelector(".compText, p")?.textContent?.trim() || "";
		results.push({ title, url, snippet, domain: extractDomain(url) });
	}
	return results;
}

export function parseBingResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];

	for (const el of document.querySelectorAll("li.b_algo")) {
		const a = el.querySelector("h2 a");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const title = a.textContent?.trim() || "";
		if (!title || !rawUrl) continue;

		let url: string | undefined;
		try {
			const u = new URL(rawUrl, "https://www.bing.com");
			if (u.pathname.startsWith("/ck/a") && u.searchParams.has("u")) {
				const encoded = u.searchParams.get("u")!;
				const normalized = encoded.startsWith("a1")
					? encoded.slice(2)
					: encoded;
				const decoded = Buffer.from(normalized, "base64").toString("utf8");
				url = /^https?:/i.test(decoded) ? decoded : undefined;
			} else {
				url = rawUrl;
			}
		} catch {
			url = rawUrl;
		}

		if (!url || !/^https?:/i.test(url)) continue;
		if (!checkSearchFilters(url, new URL(url).hostname, ["bing.com"])) continue;

		const snippet = el.querySelector(".b_caption p")?.textContent?.trim() || "";
		results.push({ title, url, snippet, domain: extractDomain(url) });
	}
	return results;
}

export function parseBraveResults(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	let pos = 0;
	while (pos < html.length) {
		const dataAttr = html.indexOf('data-type="web"', pos);
		if (dataAttr === -1) break;

		const divStart = html.lastIndexOf("<div", dataAttr);
		if (divStart === -1) {
			pos = dataAttr + 1;
			continue;
		}

		let depth = 0;
		let divEnd = -1;
		for (let i = divStart + 4; i < html.length; i++) {
			if (html.slice(i, i + 4) === "<div") {
				depth++;
				i += 3;
			}
			if (html.slice(i, i + 5) === "</div") {
				if (depth === 0) {
					divEnd = i + 5;
					break;
				}
				depth--;
				i += 4;
			}
		}

		if (divEnd === -1) {
			pos = dataAttr + 1;
			continue;
		}

		const block = html.slice(divStart, divEnd + 1);

		const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
		if (!urlMatch) {
			pos = divEnd + 1;
			continue;
		}
		const url = urlMatch[1]!;

		const titleMatch = block.match(/search-snippet-title[^>]*>([^<]+)<\/div>/);
		const title =
			titleMatch?.[1]?.trim() ||
			block.match(/title="([^"]+)"/)?.[1]?.trim() ||
			"";

		const gsMatch = block.match(
			/generic-snippet[^>]*>[\s\S]*?content[^>]*>([\s\S]*?)<\/div>/,
		);
		const snippet = gsMatch
			? gsMatch[1]!
					.replace(/<![^>]*-->/g, "")
					.replace(/[<>]/g, "")
					.replace(/\s+/g, " ")
					.trim()
			: "";

		if (url && title) {
			results.push({ title, url, snippet, domain: extractDomain(url) });
		}

		pos = divEnd + 1;
	}

	return results;
}

// ─── Cross-engine result scoring ───────────────────────────────────

export const ENGINE_WEIGHTS: Record<string, number> = {
	google: 5,
	bing: 3,
	ddg: 2,
	brave: 2,
	yahoo: 1,
};

// Query keyword → canonical official domain(s). Crude but free: when a query
// clearly targets a known tool/framework/vendor, results hosted on its
// official domain get a ranking boost over generic (e.g. SEO blogspam)
// results with equal engine consensus.
// Ported from greedysearch-pi's `inferPreferredDomains` (src/search/sources.mjs).
const PREFERRED_DOMAIN_RULES: {
	keywords: string[];
	domains: string[];
	test?: RegExp;
}[] = [
	{ keywords: ["openai", "gpt", "chatgpt"], domains: ["openai.com", "platform.openai.com", "help.openai.com"] },
	{ keywords: ["anthropic", "claude"], domains: ["anthropic.com", "docs.anthropic.com"] },
	{ keywords: ["bun"], domains: ["bun.sh", "bun.com"] },
	{ keywords: ["next.js", "nextjs"], domains: ["nextjs.org", "vercel.com"] },
	{ keywords: ["playwright"], domains: ["playwright.dev"] },
	{ keywords: ["supabase"], domains: ["supabase.com", "supabase.io"] },
	{ keywords: ["prisma"], domains: ["prisma.io"] },
	{ keywords: ["tailwind"], domains: ["tailwindcss.com"] },
	{ keywords: ["vite"], domains: ["vitejs.dev", "vite.dev"] },
	{ keywords: ["astro"], domains: ["astro.build"] },
	{ keywords: ["svelte"], domains: ["svelte.dev"] },
	{ keywords: ["solid"], domains: ["solidjs.com"] },
	{ keywords: ["vue", "nuxt"], domains: ["vuejs.org", "nuxt.com"] },
	{ keywords: ["react", "react native"], domains: ["react.dev", "reactnative.dev"] },
	{ keywords: ["angular"], domains: ["angular.io", "angular.dev"] },
	{ keywords: ["node.js", "nodejs"], domains: ["nodejs.org", "nodejs.dev", "npmjs.com"] },
	{ keywords: ["golang"], domains: ["go.dev", "golang.org", "pkg.go.dev"], test: /\bgo\b/ },
	{ keywords: ["deno"], domains: ["deno.land", "deno.com"] },
	{ keywords: ["fresh"], domains: ["fresh.deno.dev"] },
	{ keywords: ["typescript"], domains: ["typescriptlang.org"] },
	{ keywords: ["python"], domains: ["python.org", "docs.python.org"] },
	{ keywords: ["rust"], domains: ["rust-lang.org", "docs.rs", "crates.io"] },
	{ keywords: ["zig"], domains: ["ziglang.org"] },
	{ keywords: ["docker"], domains: ["docker.com", "docs.docker.com", "hub.docker.com"] },
	{ keywords: ["kubernetes", "k8s"], domains: ["kubernetes.io", "k8s.io"] },
	{ keywords: ["postgres", "postgresql"], domains: ["postgresql.org", "neon.tech", "supabase.com"] },
	{ keywords: ["redis"], domains: ["redis.io"] },
	{ keywords: ["sqlite"], domains: ["sqlite.org"] },
	{ keywords: ["cloudflare"], domains: ["developers.cloudflare.com", "cloudflare.com"] },
	{ keywords: ["vercel"], domains: ["vercel.com", "nextjs.org"] },
	{ keywords: ["netlify"], domains: ["netlify.com", "docs.netlify.com"] },
	{ keywords: ["stripe"], domains: ["stripe.com", "docs.stripe.com"] },
	{ keywords: ["github"], domains: ["github.com", "docs.github.com"] },
	{ keywords: ["gitlab"], domains: ["gitlab.com", "docs.gitlab.com"] },
	{ keywords: ["aws"], domains: ["aws.amazon.com", "docs.aws.amazon.com"] },
	{ keywords: ["azure"], domains: ["azure.microsoft.com", "learn.microsoft.com"] },
	{ keywords: ["gcp", "google cloud"], domains: ["cloud.google.com", "developers.google.com"] },
	{ keywords: ["gemini", "google ai"], domains: ["ai.google.dev", "developers.google.com"] },
];

/**
 * Infer canonical official domains implied by a search query's keywords
 * (e.g. "prisma migrate guide" → ["prisma.io"]). Returns an empty array
 * when nothing matches — callers should treat that as "no boost".
 */
export function inferPreferredDomains(query: string): string[] {
	const normalized = query.toLowerCase();
	const matches: string[] = [];

	for (const rule of PREFERRED_DOMAIN_RULES) {
		const matched =
			rule.keywords.some((kw) => normalized.includes(kw)) ||
			(rule.test?.test(normalized) ?? false);
		if (matched) matches.push(...rule.domains);
	}

	return [...new Set(matches)];
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

// Boost applied when a result's host matches a query-inferred preferred
// domain. Chosen to be additive/small so it composes cleanly with the
// existing engine-weight + consensus scoring instead of overriding it.
export const PREFERRED_DOMAIN_BOOST = 4;

export function scoreAndRankResults(
	buckets: Map<string, EngineSource[]>,
	query = "",
): { result: SearchResult; score: number; sources: string[] }[] {
	const preferredDomains = inferPreferredDomains(query);
	const scored: { result: SearchResult; score: number; sources: string[] }[] =
		[];
	for (const [url, entries] of buckets) {
		const sources = entries.map((e) => e.engine);
		const weightSum = entries.reduce((sum, e) => sum + e.weight, 0);
		const consensusBonus = Math.max(0, sources.length - 1) * 2;

		let domainBoost = 0;
		if (preferredDomains.length > 0) {
			const hostname = extractDomain(url)?.replace(/^www\./, "") || "";
			if (
				hostname &&
				preferredDomains.some((d) => hostMatchesDomain(hostname, d))
			) {
				domainBoost = PREFERRED_DOMAIN_BOOST;
			}
		}

		const score = weightSum + consensusBonus + domainBoost;

		entries.sort((a, b) => b.weight - a.weight);
		const best = entries[0]!.result;

		scored.push({ result: { ...best, url, sources }, score, sources });
	}

	scored.sort((a, b) => b.score - a.score);
	return scored;
}

export function buildResultBuckets(
	results: SearchResult[],
	engine: string,
): Map<string, EngineSource[]> {
	const buckets = new Map<string, EngineSource[]>();
	const weight = ENGINE_WEIGHTS[engine] || 1;
	for (const r of results) {
		const list = buckets.get(r.url) || [];
		list.push({ result: r, engine, weight });
		buckets.set(r.url, list);
	}
	return buckets;
}

// ─── Search web (main entry point) ─────────────────────────────────

export async function searchWeb(query: string): Promise<{
	results: SearchResult[];
	ddgCount: number;
	braveCount: number;
	yahooCount: number;
	bingCount: number;
}> {
	const cached = getCachedSearch(query);
	if (cached)
		return {
			results: cached,
			ddgCount: cached.length,
			braveCount: 0,
			yahooCount: 0,
			bingCount: 0,
		};

	const encoded = encodeURIComponent(query);

	const commonHeaders = {
		Accept: "text/html",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
	};

	const enginesBase = [
		{
			id: "ddg" as const,
			url: `https://html.duckduckgo.com/html/?q=${encoded}`,
			parser: parseDuckDuckGoResults,
		},
		{
			id: "brave" as const,
			url: `https://search.brave.com/search?q=${encoded}`,
			parser: parseBraveResults,
		},
		{
			id: "yahoo" as const,
			url: `https://search.yahoo.com/search?p=${encoded}&region=us&lang=en`,
			parser: parseYahooResults,
		},
		{
			id: "bing" as const,
			url: `https://www.bing.com/search?q=${encoded}`,
			parser: parseBingResults,
		},
	];

	// Reorder engines by persistent reliability stats (best first); engines
	// with no history stay at their original relative position (score 0.5).
	const engines = rankEngines(enginesBase);

	const promises = engines.map((engine) => {
		if (!isEngineAvailable(engine.id)) {
			return Promise.resolve({
				id: engine.id,
				res: null,
				latencyMs: 0,
			});
		}
		const start = Date.now();
		return smartFetch(engine.url, { headers: commonHeaders })
			.then((res) => ({
				id: engine.id,
				res,
				latencyMs: Date.now() - start,
			}))
			.catch((err) => {
				recordEngineFailure(engine.id, String(err));
				return {
					id: engine.id,
					res: null,
					latencyMs: Date.now() - start,
				};
			});
	});

	const settled = await Promise.all(promises);

	const counts = { ddg: 0, brave: 0, yahoo: 0, bing: 0 };
	const engineResults = new Map<string, EngineSource[]>();

	for (const s of settled) {
		const engine = engines.find((e) => e.id === s.id);
		if (!engine || !s.res || s.res.status >= 400) {
			if (s.res && isQuotaError(s.res.status, s.res.text)) {
				recordEngineFailure(s.id, `HTTP ${s.res.status}`);
				recordEngineSearchFailure(s.id);
			}
			continue;
		}

		const parsed = engine.parser(s.res.text);
		if (parsed.length > 0) {
			recordEngineSuccess(s.id, s.latencyMs);
			recordEngineSearchSuccess(s.id, s.latencyMs);
		} else {
			recordEngineFailure(s.id, "no results parsed");
			recordEngineSearchFailure(s.id);
		}
		counts[s.id] = parsed.length;

		for (const r of parsed) {
			const list = engineResults.get(r.url) || [];
			list.push({
				result: r,
				engine: s.id,
				weight: ENGINE_WEIGHTS[s.id] || 1,
			});
			engineResults.set(r.url, list);
		}
	}

	const scored = scoreAndRankResults(engineResults, query);
	const merged = scored.map((s) => s.result);

	if (merged.length > 0) {
		storeSearchResults(query, merged);
	}
	return {
		results: merged,
		ddgCount: counts.ddg,
		braveCount: counts.brave,
		yahooCount: counts.yahoo,
		bingCount: counts.bing,
	};
}
