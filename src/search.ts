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
	SourceType,
} from "./types.ts";
import { computeGogglesBonus, type GogglesProfile } from "./goggles.ts";
import { createBM25Scorer } from "./bm25.ts";
import { debug } from "./debug.ts";

// ─── Engine health tracking ────────────────────────────────────────

export const ENGINE_HEALTH_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown
export const ENGINE_FAILURE_THRESHOLD = 2; // consecutive failures before cooldown

/**
 * Per-engine deadline (P3). `searchWeb` fans out to four HTTP engines via
 * `Promise.all`, and each fetch otherwise inherits smartFetch's 30s timeout
 * plus `fetchWithRetry`'s full retry cycle (MAX_RETRIES=2, jittered 1s→2s
 * backoff) — a single rate-limited engine (a Brave HTTP 429) was measured to
 * blow one search to 8.5s vs ~1.3s normal. Each engine fetch is raced against
 * this deadline so a stalled/slow engine resolves to empty (status `timeout`)
 * instead of holding the merge. 4.5s sits above the slowest *healthy* engine
 * (Yahoo ~1.5s) but well under the tool's 7s cap, so one flaky engine can no
 * longer bound the total.
 */
export const ENGINE_DEADLINE_MS = 4500;

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
		debug(
			"search",
			`${engine} cooled down for ${ENGINE_HEALTH_COOLDOWN_MS}ms after ${record.consecutiveFailures} consecutive failures (${reason})`,
		);
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
	debug("search", `${provider} cooled down for ${ttlMs}ms (${reason})`);
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
	_url: string,
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

// ─── Source-type classification (issue #61) ────────────────────────
// Cheap domain/path heuristics that bucket a result into a coarse source
// type, so official docs and repos can outrank SEO blogspam and social
// posts sink to the bottom regardless of how many engines surfaced them.

const COMMUNITY_HOSTS = [
	"dev.to",
	"hashnode.com",
	"medium.com",
	"reddit.com",
	"stackoverflow.com",
	"stackexchange.com",
	"substack.com",
];

const NEWS_HOSTS = [
	"arstechnica.com",
	"techcrunch.com",
	"theverge.com",
	"venturebeat.com",
	"wired.com",
	"zdnet.com",
];

const SOCIAL_HOSTS = [
	"facebook.com",
	"instagram.com",
	"linkedin.com",
	"pinterest.com",
	"tiktok.com",
	"twitter.com",
	"x.com",
];

export function stripWww(domain: string): string {
	return domain.replace(/^www\./, "");
}

function matchesHost(domain: string, hosts: string[]): boolean {
	return hosts.some((host) => domain === host || domain.endsWith(`.${host}`));
}

/**
 * Classify a result into a coarse source type via cheap domain/path/title
 * heuristics. Adapted from greedysearch-pi's `classifySourceType`.
 */
export function classifySourceType(
	domain: string,
	title = "",
	url = "",
): SourceType {
	const d = stripWww(domain.toLowerCase());
	const lowerTitle = title.toLowerCase();
	const lowerUrl = url.toLowerCase();

	if (d === "github.com" || d === "gitlab.com") return "repo";
	if (
		d === "arxiv.org" ||
		d === "doi.org" ||
		d === "semanticscholar.org" ||
		d.endsWith(".semanticscholar.org") ||
		lowerUrl.includes("/paper/") ||
		lowerUrl.includes("/pdf/")
	) {
		return "academic";
	}
	if (matchesHost(d, SOCIAL_HOSTS)) return "social";
	if (matchesHost(d, COMMUNITY_HOSTS)) return "community";
	if (matchesHost(d, NEWS_HOSTS)) return "news";
	if (
		d.startsWith("docs.") ||
		d.startsWith("developer.") ||
		d.startsWith("developers.") ||
		d.startsWith("api.") ||
		lowerTitle.includes("documentation") ||
		lowerTitle.includes("docs") ||
		lowerTitle.includes("reference") ||
		lowerUrl.includes("/docs/") ||
		lowerUrl.includes("/reference/") ||
		lowerUrl.includes("/api/")
	) {
		return "official-docs";
	}
	if (d.startsWith("blog.") || lowerUrl.includes("/blog/"))
		return "maintainer-blog";
	return "website";
}

/**
 * Per-type priority folded into the composite ranking score. Chosen so that
 * a query-relevant official source ranked #1 by a single engine outranks
 * generic multi-engine consensus, while multi-engine consensus still beats
 * a single-engine community post — see `scoreAndRankResults`.
 */
export function sourceTypePriority(sourceType: SourceType): number {
	switch (sourceType) {
		case "official-docs":
			return 5;
		case "repo":
			return 4;
		case "academic":
			return 4;
		case "maintainer-blog":
			return 3;
		case "website":
			return 2;
		case "community":
			return 1;
		case "news":
			return 0;
		case "social":
			return -6;
		default:
			return 0;
	}
}

// ─── Preferred-domain inference (issue #63) ────────────────────────
// Hardcoded query-keyword → canonical official-domain map. Crude but free:
// when a query mentions a known tool/framework/vendor, boost results from
// its canonical domain(s) so official sources surface above lookalikes and
// SEO aggregators for the same query.

interface PreferredDomainRule {
	pattern: RegExp;
	domains: string[];
}

const PREFERRED_DOMAIN_RULES: PreferredDomainRule[] = [
	{
		pattern: /\b(openai|gpt|chatgpt)\b/,
		domains: ["openai.com", "platform.openai.com", "help.openai.com"],
	},
	{
		pattern: /\b(anthropic|claude)\b/,
		domains: ["anthropic.com", "docs.anthropic.com"],
	},
	{ pattern: /\bbun\b/, domains: ["bun.sh", "bun.com"] },
	{ pattern: /\b(next\.js|nextjs)\b/, domains: ["nextjs.org", "vercel.com"] },
	{ pattern: /\bplaywright\b/, domains: ["playwright.dev"] },
	{ pattern: /\bsupabase\b/, domains: ["supabase.com", "supabase.io"] },
	{ pattern: /\bprisma\b/, domains: ["prisma.io"] },
	{ pattern: /\btailwind\b/, domains: ["tailwindcss.com"] },
	{ pattern: /\bvite\b/, domains: ["vitejs.dev", "vite.dev"] },
	{ pattern: /\bastro\b/, domains: ["astro.build"] },
	{ pattern: /\bsvelte\b/, domains: ["svelte.dev"] },
	{ pattern: /\bsolid(js)?\b/, domains: ["solidjs.com"] },
	{ pattern: /\b(vue|nuxt)\b/, domains: ["vuejs.org", "nuxt.com"] },
	{
		pattern: /\breact(\s*native)?\b/,
		domains: ["react.dev", "reactnative.dev"],
	},
	{ pattern: /\bangular\b/, domains: ["angular.io", "angular.dev"] },
	{
		pattern: /\bnode(\.js)?\b/,
		domains: ["nodejs.org", "nodejs.dev", "npmjs.com"],
	},
	{
		pattern: /\b(golang|go)\b/,
		domains: ["go.dev", "golang.org", "pkg.go.dev"],
	},
	{ pattern: /\bdeno\b/, domains: ["deno.land", "deno.com"] },
	{ pattern: /\bfresh\b/, domains: ["fresh.deno.dev"] },
	{ pattern: /\btypescript\b/, domains: ["typescriptlang.org"] },
	{ pattern: /\bpython\b/, domains: ["python.org", "docs.python.org"] },
	{ pattern: /\brust\b/, domains: ["rust-lang.org", "docs.rs", "crates.io"] },
	{ pattern: /\bzig\b/, domains: ["ziglang.org"] },
	{
		pattern: /\bdocker\b/,
		domains: ["docker.com", "docs.docker.com", "hub.docker.com"],
	},
	{ pattern: /\b(kubernetes|k8s)\b/, domains: ["kubernetes.io", "k8s.io"] },
	{
		pattern: /\bpostgres(ql)?\b/,
		domains: ["postgresql.org", "neon.tech", "supabase.com"],
	},
	{ pattern: /\bredis\b/, domains: ["redis.io"] },
	{ pattern: /\bsqlite\b/, domains: ["sqlite.org"] },
	{
		pattern: /\bcloudflare\b/,
		domains: ["developers.cloudflare.com", "cloudflare.com"],
	},
	{ pattern: /\bvercel\b/, domains: ["vercel.com", "nextjs.org"] },
	{ pattern: /\bnetlify\b/, domains: ["netlify.com", "docs.netlify.com"] },
	{ pattern: /\bstripe\b/, domains: ["stripe.com", "docs.stripe.com"] },
	{ pattern: /\bgithub\b/, domains: ["github.com", "docs.github.com"] },
	{ pattern: /\bgitlab\b/, domains: ["gitlab.com", "docs.gitlab.com"] },
	{ pattern: /\baws\b/, domains: ["aws.amazon.com", "docs.aws.amazon.com"] },
	{
		pattern: /\bazure\b/,
		domains: ["azure.microsoft.com", "learn.microsoft.com"],
	},
	{
		pattern: /\b(gcp|google cloud)\b/,
		domains: ["cloud.google.com", "developers.google.com"],
	},
	{
		pattern: /\b(gemini|google ai)\b/,
		domains: ["ai.google.dev", "developers.google.com"],
	},
];

/** Boost applied to results whose domain matches an inferred preferred domain. */
export const PREFERRED_DOMAIN_BONUS = 8;

/** Infer canonical official domains implied by keywords in the query. */
export function inferPreferredDomains(query: string): string[] {
	const normalized = query.toLowerCase();
	const matches: string[] = [];
	for (const rule of PREFERRED_DOMAIN_RULES) {
		if (rule.pattern.test(normalized)) matches.push(...rule.domains);
	}
	return [...new Set(matches)];
}

function domainMatchesPreferred(domain: string, preferred: string[]): boolean {
	const d = stripWww(domain.toLowerCase());
	return preferred.some((p) => d === p || d.endsWith(`.${p}`));
}

// ─── Cross-engine result scoring ───────────────────────────────────

export const ENGINE_WEIGHTS: Record<string, number> = {
	google: 5,
	bing: 3,
	ddg: 2,
	brave: 2,
	yahoo: 1,
};

/** Multiplier applied to `sourceTypePriority` when composing the score. */
const SOURCE_TYPE_WEIGHT = 2;

/**
 * Multiplier applied to the BM25 query-relevance score (over title+snippet)
 * when composing the rank score (F5). Deliberately small so it strengthens
 * relevance ordering among similarly-scored results without overturning the
 * stronger engine-consensus / sourceType / preferred-domain / goggles signals.
 */
const RELEVANCE_WEIGHT = 1;

/**
 * Per-domain diversity cap (F5, inspired by Hound's max-2-per-domain): no
 * single domain may occupy more than this many slots in the top slice of the
 * ranked list. Excess same-domain results are demoted below the cap rather
 * than dropped, so recall is preserved. Applies as a final reordering pass
 * after all scoring composes.
 */
export const DOMAIN_DIVERSITY_CAP = 2;

/**
 * Merge cross-engine buckets into a ranked result list. Score composes:
 *   engine weight sum + consensus bonus (existing) +
 *   sourceType priority * SOURCE_TYPE_WEIGHT (#61) +
 *   PREFERRED_DOMAIN_BONUS when the domain matches a query-inferred
 *   canonical official domain (#63) +
 *   goggles bonus when an optional named/custom rerank profile is active
 *   (#72) +
 *   BM25 query-relevance bonus * RELEVANCE_WEIGHT over title+snippet (F5).
 *
 * After scoring, a final per-domain diversity cap (F5) reorders the list so
 * no single domain occupies more than `DOMAIN_DIVERSITY_CAP` top slots;
 * excess same-domain results are demoted below the cap, never dropped.
 *
 * `query` is optional so existing callers that don't have one (or don't
 * care about preferred-domain boosting) keep working unchanged. `goggles`
 * is likewise optional and purely additive — omitting it leaves scoring
 * byte-for-byte identical to before #72. `options.domainCap` overrides the
 * diversity cap (set to 0 to disable the cap entirely).
 */
export function scoreAndRankResults(
	buckets: Map<string, EngineSource[]>,
	query = "",
	goggles?: GogglesProfile,
	options: { domainCap?: number } = {},
): { result: SearchResult; score: number; sources: string[] }[] {
	const preferredDomains = inferPreferredDomains(query);
	const scored: { result: SearchResult; score: number; sources: string[] }[] =
		[];
	for (const [url, entries] of buckets) {
		const sources = entries.map((e) => e.engine);
		const weightSum = entries.reduce((sum, e) => sum + e.weight, 0);
		const consensusBonus = Math.max(0, sources.length - 1) * 2;

		entries.sort((a, b) => b.weight - a.weight);
		const best = entries[0]!.result;

		const domain = best.domain || extractDomain(url) || "";
		const sourceType = classifySourceType(domain, best.title, url);
		const typeBonus = sourceTypePriority(sourceType) * SOURCE_TYPE_WEIGHT;
		const preferredBonus = domainMatchesPreferred(domain, preferredDomains)
			? PREFERRED_DOMAIN_BONUS
			: 0;
		const gogglesResult = goggles
			? computeGogglesBonus(goggles, domain, best.title, url)
			: undefined;
		const gogglesBonus = gogglesResult?.bonus ?? 0;

		const score =
			weightSum + consensusBonus + typeBonus + preferredBonus + gogglesBonus;

		const result: SearchResult = { ...best, url, sources, sourceType };
		if (goggles && gogglesResult) {
			result.goggles = {
				profile: goggles.name,
				bonus: gogglesResult.bonus,
				matches: gogglesResult.matches,
			};
		}

		scored.push({ result, score, sources });
	}

	// F5: fold in BM25 query-relevance over title+snippet. A single scorer
	// shares IDF across the whole result set; an empty query is a no-op (the
	// scorer returns 0 for every document).
	if (query) {
		const scorer = createBM25Scorer(query);
		const relevance = scorer.scoreAll(
			scored.map((s) => `${s.result.title} ${s.result.snippet}`),
		);
		for (let i = 0; i < scored.length; i++) {
			scored[i]!.score += RELEVANCE_WEIGHT * (relevance[i] ?? 0);
		}
	}

	scored.sort((a, b) => b.score - a.score);

	const domainCap = options.domainCap ?? DOMAIN_DIVERSITY_CAP;
	return applyDomainDiversityCap(scored, domainCap);
}

/**
 * Per-domain diversity cap (F5). Walks the score-sorted list in order, keeping
 * the first `cap` results per domain in place and deferring any excess
 * same-domain results to the end (in their original score order). Nothing is
 * dropped — recall is preserved — but the top slice is diversified so one
 * domain cannot dominate it. A `cap` <= 0 disables the cap (returns as-is).
 */
export function applyDomainDiversityCap<T extends { result: SearchResult }>(
	scored: T[],
	cap: number = DOMAIN_DIVERSITY_CAP,
): T[] {
	if (cap <= 0) return scored;
	const kept: T[] = [];
	const deferred: T[] = [];
	const counts = new Map<string, number>();
	for (const entry of scored) {
		const domain = stripWww(
			(
				entry.result.domain ||
				extractDomain(entry.result.url) ||
				""
			).toLowerCase(),
		);
		const seen = counts.get(domain) || 0;
		if (seen < cap) {
			counts.set(domain, seen + 1);
			kept.push(entry);
		} else {
			deferred.push(entry);
		}
	}
	return [...kept, ...deferred];
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

// ─── Per-engine status (observability P2/P5) ───────────────────────
// `searchWeb` historically returned only result counts, so a down,
// rate-limited, or cooled-down engine was indistinguishable from one that
// legitimately found nothing — the TUI drops any engine with a zero count.
// This map records *why* each engine contributed what it did (plus the
// already-measured latency, P5) so callers can surface a compact note instead
// of a silent zero.

export type EngineId = "ddg" | "brave" | "yahoo" | "bing";

/**
 * Outcome of a single engine in one search round. `http_<code>` covers any
 * non-quota HTTP ≥ 400 (e.g. `http_429`, `http_503`).
 */
export type EngineStatus =
	| "ok"
	| "empty"
	| "quota"
	| "cooled_down"
	| "error"
	| "timeout"
	| "disabled"
	| `http_${number}`;

export interface EngineStatusEntry {
	/** Number of results this engine contributed (0 when it failed/skipped). */
	count: number;
	status: EngineStatus;
	/** Wall time for this engine's request, in milliseconds (P5). */
	latencyMs: number;
}

export type EngineStatusMap = Record<EngineId, EngineStatusEntry>;

export const ENGINE_DISPLAY_NAMES: Record<EngineId, string> = {
	ddg: "DDG",
	brave: "Brave",
	yahoo: "Yahoo",
	bing: "Bing",
};

const ENGINE_IDS: readonly EngineId[] = ["ddg", "brave", "yahoo", "bing"];

/**
 * A single engine's observed outcome, as collected by `searchWeb`. `httpStatus`
 * is null when no usable response arrived (network error / cooled-down skip);
 * `skipReason` carries the pre-response cause when one applies.
 */
export interface EngineOutcome {
	id: EngineId;
	httpStatus: number | null;
	count: number;
	latencyMs: number;
	/** True when the response body looked like a quota/rate-limit error. */
	quota?: boolean;
	skipReason?: "cooled_down" | "error" | "disabled" | "timeout";
}

/** Reduce one engine outcome to its coarse status label. */
export function classifyEngineStatus(outcome: EngineOutcome): EngineStatus {
	if (outcome.skipReason) return outcome.skipReason;
	if (outcome.httpStatus !== null && outcome.httpStatus >= 400) {
		return outcome.quota ? "quota" : `http_${outcome.httpStatus}`;
	}
	return outcome.count > 0 ? "ok" : "empty";
}

/**
 * Build the full four-engine status map from a list of outcomes. Engines with
 * no outcome (not attempted, e.g. a cache-served search) default to
 * `disabled` so the map shape is always complete.
 */
export function buildEngineStatusMap(
	outcomes: EngineOutcome[],
): EngineStatusMap {
	const map = {} as EngineStatusMap;
	for (const id of ENGINE_IDS) {
		map[id] = { count: 0, status: "disabled", latencyMs: 0 };
	}
	for (const o of outcomes) {
		map[o.id] = {
			count: o.count,
			status: classifyEngineStatus(o),
			latencyMs: o.latencyMs,
		};
	}
	return map;
}

/** Format a latency in milliseconds as a compact `1.2s` / `340ms` string. */
export function formatEngineLatency(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Human-readable reason for a non-ok engine status. */
export function describeEngineStatus(status: EngineStatus): string {
	switch (status) {
		case "ok":
			return "ok";
		case "empty":
			return "returned 0 results";
		case "quota":
			return "rate-limited / quota exhausted";
		case "cooled_down":
			return "cooled down after recent failures";
		case "error":
			return "network error";
		case "timeout":
			return "timed out";
		case "disabled":
			return "not attempted";
		default:
			// `http_<code>`
			return `HTTP ${status.slice("http_".length)}`;
	}
}

/**
 * Compact `_(Engine: reason)_` notes for every engine that did not return
 * results normally (status neither `ok` nor `disabled`). Mirrors the
 * `googleStatus` note style so a down/rate-limited/empty engine stays visible
 * instead of vanishing from the result header (P2).
 */
export function engineStatusNotes(engineStatus: EngineStatusMap): string[] {
	const notes: string[] = [];
	for (const id of ENGINE_IDS) {
		const entry = engineStatus[id];
		if (!entry || entry.status === "ok" || entry.status === "disabled")
			continue;
		// A deadline cutoff carries the measured latency so the note reads
		// `_(Bing: timed out after 4.5s)_` rather than a bare "timed out" (P3).
		const reason =
			entry.status === "timeout" && entry.latencyMs > 0
				? `timed out after ${formatEngineLatency(entry.latencyMs)}`
				: describeEngineStatus(entry.status);
		notes.push(`_(${ENGINE_DISPLAY_NAMES[id]}: ${reason})_`);
	}
	return notes;
}

// ─── Result rendering (UX3 compact mode) ───────────────────────────
// The per-result rendering used to live inline in the websearch tool,
// which made it untestable offline. This pure helper renders just the
// numbered result list so compact vs default output can be asserted
// without touching the network or the TUI.

/**
 * Render the numbered result list portion of a search response (UX3).
 *
 * Default (`compact` false/omitted) preserves the historical three-line
 * format — bold title + domain/source tags, then URL, then snippet — so
 * existing consumers see byte-for-byte identical output.
 *
 * Compact mode renders ONE line per result with just title + URL +
 * sourceType and no snippet body, for agents that are only scouting URLs
 * to fetch. The source type falls back to a fresh classification when a
 * result did not carry one (e.g. a Google-sourced result).
 */
export function renderSearchResults(
	results: SearchResult[],
	options: { compact?: boolean } = {},
): string {
	const compact = options.compact === true;
	return results
		.map((r, i) => {
			if (compact) {
				const sourceType =
					r.sourceType ??
					classifySourceType(
						r.domain || extractDomain(r.url) || "",
						r.title,
						r.url,
					);
				return `${i + 1}. **${r.title}** — ${r.url} [${sourceType}]`;
			}
			const domainTag = r.domain ? ` *(${r.domain})*` : "";
			const srcTag =
				r.sources && r.sources.length > 1 ? ` — ${r.sources.join("+")}` : "";
			return `${i + 1}. **${r.title}**${domainTag}${srcTag}\n   ${r.url}\n   ${r.snippet}`;
		})
		.join("\n");
}

// ─── Search web (main entry point) ─────────────────────────────────

export async function searchWeb(
	query: string,
	goggles?: GogglesProfile,
	options: {
		/**
		 * Per-engine fetch implementation. Defaults to `smartFetch`; injectable
		 * so tests can mock engine responses/delays offline. Same contract as
		 * `smartFetch` (resolves to a result or null, throws on hard failure).
		 */
		fetchFn?: typeof smartFetch;
		/** Override the per-engine deadline (P3). Defaults to ENGINE_DEADLINE_MS. */
		engineDeadlineMs?: number;
	} = {},
): Promise<{
	results: SearchResult[];
	ddgCount: number;
	braveCount: number;
	yahooCount: number;
	bingCount: number;
	engineStatus: EngineStatusMap;
}> {
	const cached = getCachedSearch(query);
	if (cached)
		return {
			results: cached,
			ddgCount: cached.length,
			braveCount: 0,
			yahooCount: 0,
			bingCount: 0,
			// Served from cache: no engines actually ran this round. Attribute
			// the cached results to DDG (mirroring ddgCount above) and mark the
			// rest as not-attempted so no misleading notes are rendered.
			engineStatus: buildEngineStatusMap([
				{ id: "ddg", httpStatus: 200, count: cached.length, latencyMs: 0 },
			]),
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

	const fetchFn = options.fetchFn ?? smartFetch;
	const deadlineMs = options.engineDeadlineMs ?? ENGINE_DEADLINE_MS;

	const promises = engines.map((engine) => {
		if (!isEngineAvailable(engine.id)) {
			debug(
				"search",
				`${engine.id} skipped: cooled down after recent failures`,
			);
			return Promise.resolve({
				id: engine.id,
				res: null,
				latencyMs: 0,
				skipReason: "cooled_down" as const,
			});
		}
		const start = Date.now();
		// P3: race the fetch against a per-engine deadline so a stalled or
		// rate-limited engine (e.g. a 429 stuck in fetchWithRetry's backoff)
		// resolves to empty with status `timeout` instead of holding the merge.
		// This subsumes a search-specific fail-fast: a 429 retry cycle is cut
		// off at the deadline rather than running to its full ~8s.
		let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<true>((resolve) => {
			deadlineHandle = setTimeout(() => resolve(true), deadlineMs);
			deadlineHandle.unref?.();
		});
		const attempt = fetchFn(engine.url, { headers: commonHeaders })
			.then((res) => ({
				res,
				timedOut: false as const,
				err: undefined as unknown,
			}))
			.catch((err) => ({ res: null, timedOut: false as const, err }));
		return Promise.race([
			attempt,
			deadline.then(() => ({
				res: null,
				timedOut: true as const,
				err: undefined as unknown,
			})),
		]).then((outcome) => {
			clearTimeout(deadlineHandle);
			const latencyMs = Date.now() - start;
			if (outcome.timedOut) {
				recordEngineFailure(engine.id, `timed out after ${deadlineMs}ms`);
				debug(
					"search",
					`${engine.id} timed out after ${deadlineMs}ms (deadline cutoff)`,
				);
				return {
					id: engine.id,
					res: null,
					latencyMs,
					skipReason: "timeout" as const,
				};
			}
			if (outcome.err !== undefined) {
				recordEngineFailure(engine.id, String(outcome.err));
				debug(
					"search",
					`${engine.id} fetch error: ${String(outcome.err).slice(0, 160)}`,
				);
				return {
					id: engine.id,
					res: null,
					latencyMs,
					skipReason: "error" as const,
				};
			}
			return {
				id: engine.id,
				res: outcome.res,
				latencyMs,
				skipReason: undefined,
			};
		});
	});

	const settled = await Promise.all(promises);

	const counts = { ddg: 0, brave: 0, yahoo: 0, bing: 0 };
	const engineResults = new Map<string, EngineSource[]>();
	const outcomes: EngineOutcome[] = [];

	for (const s of settled) {
		const engine = engines.find((e) => e.id === s.id);
		if (!engine || !s.res || s.res.status >= 400) {
			let quota = false;
			if (s.res && isQuotaError(s.res.status, s.res.text)) {
				quota = true;
				recordEngineFailure(s.id, `HTTP ${s.res.status}`);
				recordEngineSearchFailure(s.id);
				debug("search", `${s.id} quota/rate-limit (HTTP ${s.res.status})`);
			} else if (s.res) {
				debug("search", `${s.id} failed with HTTP ${s.res.status}`);
			}
			outcomes.push({
				id: s.id,
				httpStatus: s.res ? s.res.status : null,
				count: 0,
				latencyMs: s.latencyMs,
				quota,
				skipReason: s.skipReason,
			});
			continue;
		}

		const parsed = engine.parser(s.res.text);
		if (parsed.length > 0) {
			recordEngineSuccess(s.id, s.latencyMs);
			recordEngineSearchSuccess(s.id, s.latencyMs);
		} else {
			recordEngineFailure(s.id, "no results parsed");
			recordEngineSearchFailure(s.id);
			debug("search", `${s.id} parsed 0 results (HTTP ${s.res.status})`);
		}
		counts[s.id] = parsed.length;
		outcomes.push({
			id: s.id,
			httpStatus: s.res.status,
			count: parsed.length,
			latencyMs: s.latencyMs,
		});

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

	const scored = scoreAndRankResults(engineResults, query, goggles);
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
		engineStatus: buildEngineStatusMap(outcomes),
	};
}
