// ─── aio-webresearch bundle logic (issue #64) ─────────────────────────
// Deterministic retrieval + bookkeeping only — no LLM/API calls live here.
// In pi, the calling agent IS the LLM; this module only ranks/dedupes
// search results, tracks fetch/reachability outcomes, and renders the
// on-disk research bundle (STATUS.md, reports/*, sources/*, data/*.json).
// Synthesis (turning evidence into cited claims) is left to the agent —
// this module only scaffolds reports/CLAIMS.md for it to fill in.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchResult } from "./types.ts";
import { chunkMarkdown } from "./chunker.ts";
import { createBM25Scorer } from "./bm25.ts";
import { trustTierBoost, trustTierForSourceType } from "./source-trust.ts";
import type { SourceType } from "./types.ts";

// ─── Filesystem-safe naming ─────────────────────────────────────────────

/**
 * Slugify a query into a filesystem-safe, lowercase, hyphenated string.
 * Truncated to `maxLen` chars (trimming trailing hyphens after the cut).
 */
export function slugify(input: string, maxLen = 48): string {
	const base = input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // strip diacritics
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const truncated = base.slice(0, maxLen).replace(/-+$/g, "");
	return truncated || "query";
}

/** Deterministic, sortable, filesystem-safe timestamp: YYYYMMDD-HHMMSS (UTC). */
export function timestampForBundle(date: Date = new Date()): string {
	const iso = date.toISOString(); // 2026-07-20T15:30:00.000Z
	const datePart = iso.slice(0, 10).replace(/-/g, "");
	const timePart = iso.slice(11, 19).replace(/:/g, "");
	return `${datePart}-${timePart}`;
}

/** Bundle directory name: `<timestamp>_<slug>`. */
export function bundleDirName(query: string, date: Date = new Date()): string {
	return `${timestampForBundle(date)}_${slugify(query)}`;
}

// ─── maxSources clamping ────────────────────────────────────────────────

export const MIN_MAX_SOURCES = 3;
export const MAX_MAX_SOURCES = 12;
export const DEFAULT_MAX_SOURCES = 6;

export function clampMaxSources(value: unknown): number {
	const n =
		typeof value === "number" && Number.isFinite(value)
			? Math.floor(value)
			: DEFAULT_MAX_SOURCES;
	return Math.min(MAX_MAX_SOURCES, Math.max(MIN_MAX_SOURCES, n));
}

// ─── Reachability / citation audit ─────────────────────────────────────

export type ReachabilityStatus = "ok" | "skipped" | "dead" | "unknown";

/**
 * HTTP statuses that typically indicate anti-bot / access-control
 * responses rather than a genuinely dead resource. These are recorded
 * as "skipped" (URL is reachable, host is just refusing this client)
 * rather than "dead".
 */
const ANTI_BOT_STATUS_CODES = new Set([401, 403, 405, 406, 409, 429, 999]);

/** FetchError codes that indicate bot/paywall gating rather than a dead link. */
const ANTI_BOT_ERROR_CODES = new Set([
	"bot_detected",
	"blocked",
	"paywall",
	"rate_limited",
	"auth_required",
]);

/**
 * Classify a fetch outcome for the citation/reachability audit.
 * - "ok": fetch succeeded.
 * - "skipped": fetch failed with an anti-bot / access-control signal
 *   (403, 429, paywall, etc.) — the URL is not necessarily dead.
 * - "dead": fetch failed for another reason (404, DNS, timeout, 5xx, ...).
 * - "unknown": no status/error information available to classify.
 */
export function classifyReachability(input: {
	ok: boolean;
	statusCode?: number;
	errorCode?: string;
}): ReachabilityStatus {
	if (input.ok) return "ok";
	if (
		input.statusCode !== undefined &&
		ANTI_BOT_STATUS_CODES.has(input.statusCode)
	) {
		return "skipped";
	}
	if (input.errorCode && ANTI_BOT_ERROR_CODES.has(input.errorCode)) {
		return "skipped";
	}
	if (input.statusCode === undefined && !input.errorCode) return "unknown";
	return "dead";
}

// ─── Primary-source heuristic ───────────────────────────────────────────
// Deliberately simple pending #61 (source types) / #63 (domain boosts).
// Marks a source as "primary" (official docs, standards bodies, .gov/.edu,
// package registries, etc.) rather than a secondary write-up/blog.

const PRIMARY_DOMAIN_SUFFIXES = [".gov", ".edu", ".mil"];

const PRIMARY_DOMAIN_PATTERNS: RegExp[] = [
	/^(www\.)?w3\.org$/,
	/^(www\.)?ietf\.org$/,
	/^(www\.)?rfc-editor\.org$/,
	/^(www\.)?iso\.org$/,
	/^(www\.)?wikipedia\.org$/,
	/(^|\.)github\.com$/,
	/(^|\.)developer\.mozilla\.org$/,
	/(^|\.)docs\.python\.org$/,
	/(^|\.)nodejs\.org$/,
	/(^|\.)npmjs\.com$/,
	/(^|\.)pypi\.org$/,
	/(^|\.)arxiv\.org$/,
	/(^|\.)readthedocs\.io$/,
	/^docs\./,
	/^developer\./,
	/^developers\./,
	/^learn\./,
];

export function isPrimarySource(domain: string | undefined): boolean {
	if (!domain) return false;
	const d = domain.toLowerCase();
	if (PRIMARY_DOMAIN_SUFFIXES.some((suf) => d.endsWith(suf))) return true;
	return PRIMARY_DOMAIN_PATTERNS.some((re) => re.test(d));
}

// ─── Multi-query rank aggregation ──────────────────────────────────────

export interface QueryResults {
	query: string;
	results: SearchResult[];
}

/**
 * Optional ranking toggles for `rankSources`. `trustBoost` folds a small
 * additive trust-tier bonus (roadmap F2) into the reciprocal-rank score.
 * Off by default so the historical ranking is unchanged unless opted in.
 */
export interface RankSourcesOpts {
	trustBoost?: boolean;
}

export interface RankedSource {
	id: string;
	url: string;
	title: string;
	domain?: string;
	snippet?: string;
	/** Search engines that surfaced this URL across any sub-query. */
	engines: string[];
	/** Sub-queries that surfaced this URL. */
	queries: string[];
	/**
	 * Best (lowest/best) 1-based rank this URL achieved within any single
	 * sub-query's merged, cross-engine-scored result list. Not a literal
	 * per-engine position (search.ts dedupes across engines before we see
	 * results) — documented here as the closest available proxy.
	 */
	bestRank: number;
	/** Aggregate reciprocal-rank score across all sub-queries (higher = better). */
	score: number;
	primary: boolean;
}

function normalizeUrlForDedupe(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		// Strip a trailing slash for dedupe purposes only (display uses original url).
		const p = u.pathname.replace(/\/$/, "");
		return `${u.origin}${p}${u.search}`;
	} catch {
		return url;
	}
}

/**
 * Merge per-sub-query search results into a single deduped, ranked list.
 * Ranking combines reciprocal rank (1/position) across all sub-queries a
 * URL appeared in, with a small consensus bonus for appearing in more
 * than one sub-query — mirroring the reciprocal-rank-fusion approach
 * already used for cross-engine scoring in search.ts.
 */
export function rankSources(
	perQuery: QueryResults[],
	opts: RankSourcesOpts = {},
): RankedSource[] {
	interface Acc {
		url: string;
		title: string;
		domain?: string;
		snippet?: string;
		engines: Set<string>;
		queries: Set<string>;
		bestRank: number;
		score: number;
		sourceType?: SourceType;
	}
	const byKey = new Map<string, Acc>();

	for (const { query, results } of perQuery) {
		results.forEach((r, i) => {
			const rank = i + 1;
			const key = normalizeUrlForDedupe(r.url);
			let acc = byKey.get(key);
			if (!acc) {
				acc = {
					url: r.url,
					title: r.title,
					domain: r.domain,
					snippet: r.snippet,
					engines: new Set(),
					queries: new Set(),
					bestRank: rank,
					score: 0,
				};
				byKey.set(key, acc);
			}
			acc.bestRank = Math.min(acc.bestRank, rank);
			acc.queries.add(query);
			for (const e of r.sources ?? []) acc.engines.add(e);
			acc.score += 1 / rank;
			if (!acc.title && r.title) acc.title = r.title;
			if (!acc.snippet && r.snippet) acc.snippet = r.snippet;
			if (!acc.sourceType && r.sourceType) acc.sourceType = r.sourceType;
		});
	}

	const list = [...byKey.values()].map((acc) => {
		const consensusBonus = Math.max(0, acc.queries.size - 1) * 0.5;
		const trustBonus =
			opts.trustBoost && acc.sourceType
				? trustTierBoost(trustTierForSourceType(acc.sourceType))
				: 0;
		return { ...acc, score: acc.score + consensusBonus + trustBonus };
	});

	list.sort((a, b) => b.score - a.score);

	return list.map((acc, i) => ({
		id: `S${i + 1}`,
		url: acc.url,
		title: acc.title || acc.url,
		domain: acc.domain,
		snippet: acc.snippet,
		engines: [...acc.engines].sort(),
		queries: [...acc.queries],
		bestRank: acc.bestRank,
		score: Math.round(acc.score * 1000) / 1000,
		primary: isPrimarySource(acc.domain),
	}));
}

// ─── Evidence extraction (deterministic BM25, no LLM) ──────────────────

export interface EvidenceEntry {
	sourceId: string;
	url: string;
	title: string;
	heading?: string;
	quote: string;
	score: number;
}

const EVIDENCE_QUOTE_MAX_CHARS = 700;

/**
 * Pick the single best-matching chunk of `markdown` for `query` via BM25,
 * for use as a deterministic "evidence quote" in EVIDENCE.md / evidence.json.
 * Returns undefined when the body is empty or chunking yields nothing.
 */
export function extractEvidence(
	sourceId: string,
	url: string,
	title: string,
	markdown: string,
	query: string,
): EvidenceEntry | undefined {
	if (!markdown?.trim()) return undefined;
	let chunks;
	try {
		chunks = chunkMarkdown(markdown, { maxTokens: 300, overlapTokens: 0 });
	} catch {
		return undefined;
	}
	if (chunks.length === 0) return undefined;

	const scorer = createBM25Scorer(query);
	const scores = scorer.scoreAll(chunks.map((c) => c.text));
	let bestIdx = 0;
	for (let i = 1; i < scores.length; i++) {
		if ((scores[i] ?? 0) > (scores[bestIdx] ?? 0)) bestIdx = i;
	}
	const best = chunks[bestIdx]!;
	const headingMatch = best.text.match(/^#{1,6}\s+(.+)$/m);
	const quote = best.text.slice(0, EVIDENCE_QUOTE_MAX_CHARS).trim();

	return {
		sourceId,
		url,
		title,
		heading: headingMatch?.[1]?.trim(),
		quote,
		score: Math.round((scores[bestIdx] ?? 0) * 1000) / 1000,
	};
}

// ─── Deterministic claim-stance classification (issue #70) ─────────────
// NOT semantic entailment. This is a keyword-overlap + conflict-marker-word
// + source-quality-tier + freshness heuristic — cheap, explainable, and
// fully offline. It is meant as a *hint* for the calling agent, not a
// fact-check. Always ship the caveat below alongside any stance output.

export const STANCE_CAVEAT =
	"Stance is keyword/pattern-based, not semantic entailment — verify before treating as fact.";

/**
 * English conflict-marker terms/phrases. Matched case-insensitively with
 * word boundaries (see `buildConflictMarkerRegex`). Deliberately small and
 * explicit rather than a statistical sentiment model — auditable, and easy
 * to extend later for other languages.
 */
export const CONFLICT_MARKERS: readonly string[] = [
	"false",
	"debunked",
	"debunks",
	"denied",
	"denies",
	"deny",
	"no evidence",
	"lacks evidence",
	"no proof",
	"retracted",
	"retraction",
	"myth",
	"disproven",
	"disproved",
	"disputed",
	"refuted",
	"refutes",
	"refute",
	"unfounded",
	"baseless",
	"misleading",
	"hoax",
	"fabricated",
	"fake",
	"incorrect",
	"inaccurate",
	"unsubstantiated",
	"contradicts",
	"contradicted",
	"contrary to",
	"not true",
	"not supported",
	"unproven",
	"discredited",
	"misinformation",
	"disinformation",
	"overstated",
	"exaggerated",
	"unverified",
	"rebutted",
	"rebuts",
	"withdrawn",
	"recanted",
	"invalidated",
	"erroneous",
] as const;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a single global, case-insensitive, word-boundary regex from a marker list. */
function buildConflictMarkerRegex(markers: readonly string[]): RegExp {
	const alternation = markers
		.map((m) => escapeRegExp(m).replace(/\s+/g, "\\s+"))
		.join("|");
	return new RegExp(`\\b(${alternation})\\b`, "gi");
}

const CONFLICT_MARKER_REGEX = buildConflictMarkerRegex(CONFLICT_MARKERS);

/**
 * Count conflict-marker matches in `text` (word-boundary, case-insensitive).
 * Returns the raw match count plus the distinct lowercased terms matched.
 */
export function countConflictMarkers(text: string | undefined): {
	count: number;
	matched: string[];
} {
	if (!text) return { count: 0, matched: [] };
	const matches = text.match(CONFLICT_MARKER_REGEX) ?? [];
	const matched = [
		...new Set(matches.map((m) => m.toLowerCase().replace(/\s+/g, " "))),
	].sort();
	return { count: matches.length, matched };
}

/**
 * Fraction (0..1) of the query's BM25-tokenized terms that appear
 * (word-boundary, case-insensitive) in `text`. Reuses the same tokenizer
 * `createBM25Scorer` uses internally, so results are consistent with the
 * evidence-extraction pass above — this is keyword overlap, not semantic
 * similarity.
 */
export function keywordOverlapRatio(
	query: string,
	text: string | undefined,
): number {
	const scorer = createBM25Scorer(query);
	if (scorer.queryTerms.length === 0 || !text?.trim()) return 0;
	const lower = text.toLowerCase();
	const present = scorer.queryTerms.filter((term) =>
		new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(lower),
	);
	return present.length / scorer.queryTerms.length;
}

/**
 * Freshness score in [0, 1] from a (possibly missing/unparsable) published
 * date. Unknown dates are neutral (0.5) rather than penalized — freshness
 * is a soft signal, not a requirement.
 */
export function freshnessScore(
	publishedAt: string | undefined,
	now: Date = new Date(),
): number {
	if (!publishedAt) return 0.5;
	const t = Date.parse(publishedAt);
	if (Number.isNaN(t)) return 0.5;
	const ageDays = (now.getTime() - t) / (1000 * 60 * 60 * 24);
	if (ageDays < 0) return 0.5; // future-dated — don't reward or punish
	if (ageDays <= 365) return 1;
	if (ageDays <= 3 * 365) return 0.7;
	if (ageDays <= 7 * 365) return 0.4;
	return 0.2;
}

export type SourceStanceLabel = "supporting" | "conflicting" | "neutral";

export interface SourceStance {
	sourceId: string;
	url: string;
	title: string;
	label: SourceStanceLabel;
	keywordOverlap: number;
	conflictMarkerCount: number;
	conflictMarkersMatched: string[];
	primary: boolean;
	freshness: number;
	/** Signed magnitude: positive = supporting weight, negative = conflicting weight, 0 = neutral. */
	evidenceStrength: number;
}

/** Minimum keyword overlap for a source to count as topically on-point at all. */
const OVERLAP_NEUTRAL_FLOOR = 0.15;
/** Overlap threshold (with no conflict markers) to call a source "supporting". */
const OVERLAP_SUPPORT_THRESHOLD = 0.3;

/**
 * Classify a single fetched source's stance relative to the research query.
 * Deterministic, no LLM calls: combines keyword overlap (BM25 tokenizer),
 * conflict-marker matches, source-quality tier (`primary`), and freshness
 * into a label + a signed `evidenceStrength`.
 */
export function classifySourceStance(input: {
	sourceId: string;
	url: string;
	title: string;
	text: string;
	query: string;
	primary: boolean;
	publishedAt?: string;
	now?: Date;
}): SourceStance {
	const overlap = keywordOverlapRatio(input.query, input.text);
	const { count, matched } = countConflictMarkers(input.text);
	const fresh = freshnessScore(input.publishedAt, input.now);

	let label: SourceStanceLabel;
	if (overlap < OVERLAP_NEUTRAL_FLOOR) {
		label = "neutral";
	} else if (count > 0) {
		label = "conflicting";
	} else if (overlap >= OVERLAP_SUPPORT_THRESHOLD) {
		label = "supporting";
	} else {
		label = "neutral";
	}

	const qualityTier = input.primary ? 1.3 : 1.0;
	const magnitude = (overlap * 0.6 + fresh * 0.4) * qualityTier;
	const conflictBoost = 0.5 + Math.min(1, count * 0.15);

	let evidenceStrength = 0;
	if (label === "supporting") {
		evidenceStrength = Math.round(magnitude * 1000) / 1000;
	} else if (label === "conflicting") {
		evidenceStrength = -Math.round(magnitude * conflictBoost * 1000) / 1000;
	}

	return {
		sourceId: input.sourceId,
		url: input.url,
		title: input.title,
		label,
		keywordOverlap: Math.round(overlap * 1000) / 1000,
		conflictMarkerCount: count,
		conflictMarkersMatched: matched,
		primary: input.primary,
		freshness: fresh,
		evidenceStrength,
	};
}

export type StanceVerdict =
	| "supported"
	| "likely_supported"
	| "contested"
	| "likely_false"
	| "insufficient_evidence";

export interface StanceSummary {
	query: string;
	verdict: StanceVerdict;
	supportScore: number;
	conflictScore: number;
	supportingCount: number;
	conflictingCount: number;
	neutralCount: number;
	sources: SourceStance[];
}

/** Support-score + count threshold for a "strong" (non-"likely") verdict. */
const STRONG_SCORE_THRESHOLD = 1.2;
const STRONG_COUNT_THRESHOLD = 2;
/** Ratio one side must exceed the other by to call the mixed case one-sided rather than contested. */
const DOMINANCE_RATIO = 1.5;

/**
 * Aggregate per-source stances into a single categorical verdict.
 * Purely threshold-based on `supportScore`/`conflictScore` (sums of the
 * signed `evidenceStrength` values) — see module caveat: this is a
 * heuristic hint, not a fact-check.
 */
export function summarizeStance(
	query: string,
	sources: SourceStance[],
): StanceSummary {
	const supportingCount = sources.filter(
		(s) => s.label === "supporting",
	).length;
	const conflictingCount = sources.filter(
		(s) => s.label === "conflicting",
	).length;
	const neutralCount = sources.filter((s) => s.label === "neutral").length;

	const supportScore =
		Math.round(
			sources
				.filter((s) => s.evidenceStrength > 0)
				.reduce((sum, s) => sum + s.evidenceStrength, 0) * 1000,
		) / 1000;
	const conflictScore =
		Math.round(
			Math.abs(
				sources
					.filter((s) => s.evidenceStrength < 0)
					.reduce((sum, s) => sum + s.evidenceStrength, 0),
			) * 1000,
		) / 1000;

	let verdict: StanceVerdict;
	if (supportingCount === 0 && conflictingCount === 0) {
		verdict = "insufficient_evidence";
	} else if (conflictingCount === 0) {
		verdict =
			supportScore >= STRONG_SCORE_THRESHOLD &&
			supportingCount >= STRONG_COUNT_THRESHOLD
				? "supported"
				: "likely_supported";
	} else if (supportingCount === 0) {
		verdict =
			conflictScore >= STRONG_SCORE_THRESHOLD &&
			conflictingCount >= STRONG_COUNT_THRESHOLD
				? "likely_false"
				: "contested";
	} else if (supportScore > conflictScore * DOMINANCE_RATIO) {
		verdict = "likely_supported";
	} else if (conflictScore > supportScore * DOMINANCE_RATIO) {
		verdict = "likely_false";
	} else {
		verdict = "contested";
	}

	return {
		query,
		verdict,
		supportScore,
		conflictScore,
		supportingCount,
		conflictingCount,
		neutralCount,
		sources,
	};
}

// ─── Bundle rendering (pure — returns strings, does not touch disk) ────

export interface FetchedSourceRecord {
	id: string;
	url: string;
	title: string;
	domain?: string;
	primary: boolean;
	ok: boolean;
	statusCode?: number;
	errorCode?: string;
	errorMessage?: string;
	reachability: ReachabilityStatus;
	file?: string;
	wordCount?: number;
	/** Published/updated date as reported by the source, if any (used for freshness scoring). */
	publishedAt?: string;
}

export interface BundleSummary {
	query: string;
	queries: string[];
	startedAt: string;
	finishedAt: string;
	maxSources: number;
	consulted: number;
	fetched: FetchedSourceRecord[];
	unfetchedRanked: RankedSource[];
	/** Optional deterministic stance summary (issue #70) — rendered as a caveat + verdict line when present. */
	stance?: StanceSummary;
}

export function buildStatusMd(summary: BundleSummary): string {
	const okCount = summary.fetched.filter((f) => f.reachability === "ok").length;
	const skippedCount = summary.fetched.filter(
		(f) => f.reachability === "skipped",
	).length;
	const deadCount = summary.fetched.filter(
		(f) => f.reachability === "dead",
	).length;
	const primaryCount = summary.fetched.filter((f) => f.primary && f.ok).length;

	const lines: string[] = [
		`# Research Status`,
		``,
		`- **Query:** ${summary.query}`,
		summary.queries.length > 1
			? `- **Sub-queries:** ${summary.queries.join("; ")}`
			: ``,
		`- **Started:** ${summary.startedAt}`,
		`- **Finished:** ${summary.finishedAt}`,
		`- **Mode:** single-round MVP (search → rank → fetch → bundle + audit)`,
		`- **Sources consulted:** ${summary.consulted}`,
		`- **Sources fetched:** ${summary.fetched.length} (max requested: ${summary.maxSources})`,
		`- **Reachability:** ${okCount} ok, ${skippedCount} skipped (anti-bot), ${deadCount} dead`,
		`- **Primary sources:** ${primaryCount}`,
		``,
		`## Fetch ledger`,
		``,
		`| ID | Status | URL |`,
		`| --- | --- | --- |`,
		...summary.fetched.map(
			(f) => `| ${f.id} | ${f.ok ? "fetched" : f.reachability} | ${f.url} |`,
		),
		``,
	];

	if (summary.unfetchedRanked.length > 0) {
		lines.push(
			`## Ranked but not fetched (beyond maxSources=${summary.maxSources})`,
			``,
			...summary.unfetchedRanked.map((s) => `- ${s.id}: ${s.url}`),
			``,
		);
	}

	if (summary.stance) {
		lines.push(
			`## Claim stance (heuristic, non-authoritative)`,
			``,
			`> ${STANCE_CAVEAT}`,
			``,
			`- **Verdict:** ${summary.stance.verdict}`,
			`- **Support score:** ${summary.stance.supportScore}  |  **Conflict score:** ${summary.stance.conflictScore}`,
			`- **Supporting / conflicting / neutral sources:** ${summary.stance.supportingCount} / ${summary.stance.conflictingCount} / ${summary.stance.neutralCount}`,
			`- See \`STANCE.md\` and \`data/stance.json\` for the per-source breakdown.`,
			``,
		);
	}

	lines.push(
		`## Next steps for the agent`,
		``,
		`- Fill in \`reports/CLAIMS.md\` with claims cited by source ID (S1, S2, ...), using \`reports/EVIDENCE.md\` and \`data/evidence.json\`.`,
		`- Review \`reports/GAPS.md\` for sub-queries with weak or no coverage.`,
		summary.stance
			? `- \`STANCE.md\` offers a candidate (non-authoritative) stance per source — confirm before citing as fact.`
			: ``,
		`- This is a single-round MVP bundle — no iterative follow-up round was run.`,
		``,
	);

	return lines
		.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
		.join("\n");
}

export function buildEvidenceMd(
	evidence: EvidenceEntry[],
	fetched: FetchedSourceRecord[],
): string {
	const byId = new Map(fetched.map((f) => [f.id, f]));
	const lines: string[] = [`# Evidence`, ``];
	if (evidence.length === 0) {
		lines.push(
			`_No evidence extracted — no sources were successfully fetched._`,
			``,
		);
		return lines.join("\n");
	}
	for (const e of evidence) {
		const f = byId.get(e.sourceId);
		lines.push(
			`## [${e.sourceId}] ${e.title}`,
			``,
			`- URL: ${e.url}`,
			f ? `- Reachability: ${f.reachability}` : ``,
			e.heading ? `- Section: ${e.heading}` : ``,
			`- BM25 relevance score: ${e.score}`,
			``,
			`> ${e.quote.replace(/\n/g, "\n> ")}`,
			``,
		);
	}
	return lines
		.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
		.join("\n");
}

export function buildClaimsMdScaffold(
	query: string,
	fetched: FetchedSourceRecord[],
): string {
	const okSources = fetched.filter((f) => f.ok);
	return [
		`# Claims`,
		``,
		`_Scaffold — pi-webaio does not call an LLM internally, so this file is not`,
		`pre-filled. The calling agent should read \`reports/EVIDENCE.md\` and`,
		`\`data/evidence.json\`, then write cited claims below, one per finding._`,
		``,
		`**Research question:** ${query}`,
		``,
		`## Available sources`,
		``,
		...okSources.map((f) => `- ${f.id}: [${f.title}](${f.url})`),
		``,
		`## Claims (fill in)`,
		``,
		`<!-- Example:`,
		`- Claim text here. [S1][S3]`,
		`-->`,
		``,
	].join("\n");
}

export function buildGapsMd(
	summary: BundleSummary,
	zeroResultQueries: string[],
): string {
	const skippedOrDead = summary.fetched.filter((f) => f.reachability !== "ok");
	const lines: string[] = [`# Gaps`, ``];

	if (zeroResultQueries.length > 0) {
		lines.push(
			`## Sub-queries with no search results`,
			``,
			...zeroResultQueries.map((q) => `- ${q}`),
			``,
		);
	}

	if (skippedOrDead.length > 0) {
		lines.push(
			`## Sources not usable as evidence`,
			``,
			...skippedOrDead.map(
				(f) =>
					`- ${f.id} (${f.reachability}): ${f.url}${f.errorMessage ? ` — ${f.errorMessage}` : ""}`,
			),
			``,
		);
	}

	if (summary.unfetchedRanked.length > 0) {
		lines.push(
			`## Ranked candidates left unfetched (maxSources cap)`,
			``,
			...summary.unfetchedRanked.map((s) => `- ${s.id}: ${s.url}`),
			``,
		);
	}

	if (
		zeroResultQueries.length === 0 &&
		skippedOrDead.length === 0 &&
		summary.unfetchedRanked.length === 0
	) {
		lines.push(`_No gaps detected in this single-round MVP run._`, ``);
	}

	lines.push(
		``,
		`_This is a single-round MVP — an iterative research loop (follow-up`,
		`sub-queries to close these gaps) is planned as a follow-up, not part of`,
		`this bundle._`,
		``,
	);

	return lines
		.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
		.join("\n");
}

export function buildStanceMd(summary: StanceSummary): string {
	const lines: string[] = [
		`# Claim Stance (heuristic, non-authoritative)`,
		``,
		`> ${STANCE_CAVEAT}`,
		``,
		`This is a deterministic, keyword/pattern-based heuristic — it does **not**`,
		`perform semantic entailment or fact-checking. It combines keyword overlap`,
		`with the query, English conflict-marker words, source-quality tier, and`,
		`freshness into a per-source stance and an aggregate verdict. Treat every`,
		`row below as a candidate lead for the agent to confirm, not a conclusion.`,
		``,
		`- **Research question:** ${summary.query}`,
		`- **Verdict:** ${summary.verdict}`,
		`- **Support score:** ${summary.supportScore}  |  **Conflict score:** ${summary.conflictScore}`,
		`- **Supporting sources:** ${summary.supportingCount}  |  **Conflicting:** ${summary.conflictingCount}  |  **Neutral:** ${summary.neutralCount}`,
		``,
		`## Candidate claim table (non-authoritative — confirm before citing)`,
		``,
	];

	if (summary.sources.length === 0) {
		lines.push(
			`_No fetched sources with extractable content were available for stance classification._`,
			``,
		);
		return lines
			.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
			.join("\n");
	}

	lines.push(
		`| Source | Stance | Overlap | Conflict markers | Primary | Evidence strength |`,
		`| --- | --- | --- | --- | --- | --- |`,
		...summary.sources.map(
			(s) =>
				`| ${s.sourceId} | ${s.label} | ${s.keywordOverlap} | ${s.conflictMarkersMatched.join(", ") || "—"} | ${s.primary ? "yes" : "no"} | ${s.evidenceStrength} |`,
		),
		``,
		`_Rows above are candidate leads only — always open the source and read`,
		`\`reports/EVIDENCE.md\` before treating a "supporting"/"conflicting" label`,
		`as fact._`,
		``,
	);

	return lines
		.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
		.join("\n");
}

export function buildStanceJson(
	summary: StanceSummary,
): Record<string, unknown> {
	return {
		version: 1,
		caveat: STANCE_CAVEAT,
		query: summary.query,
		verdict: summary.verdict,
		supportScore: summary.supportScore,
		conflictScore: summary.conflictScore,
		counts: {
			supporting: summary.supportingCount,
			conflicting: summary.conflictingCount,
			neutral: summary.neutralCount,
		},
		sources: summary.sources,
	};
}

// ─── Manifest / registry JSON builders ─────────────────────────────────

export interface CitationAuditDetail {
	id: string;
	url: string;
	statusCode?: number;
	errorCode?: string;
	classification: ReachabilityStatus;
}

export function buildManifest(params: {
	query: string;
	queries: string[];
	maxSources: number;
	startedAt: string;
	finishedAt: string;
	consulted: number;
	fetched: FetchedSourceRecord[];
	bundleDir: string;
	/** Optional deterministic stance summary (issue #70) — extends `counts` when present. */
	stance?: StanceSummary;
}): Record<string, unknown> {
	const audit: CitationAuditDetail[] = params.fetched.map((f) => ({
		id: f.id,
		url: f.url,
		statusCode: f.statusCode,
		errorCode: f.errorCode,
		classification: f.reachability,
	}));

	const ok = audit.filter((a) => a.classification === "ok").length;
	const skipped = audit.filter((a) => a.classification === "skipped").length;
	const dead = audit.filter((a) => a.classification === "dead").length;
	const primary = params.fetched.filter((f) => f.primary && f.ok).length;

	const counts: Record<string, unknown> = {
		sourcesConsulted: params.consulted,
		sourcesFetched: params.fetched.length,
		sourcesOk: ok,
		sourcesSkipped: skipped,
		sourcesDead: dead,
		primarySources: primary,
	};
	if (params.stance) {
		counts.stanceVerdict = params.stance.verdict;
		counts.supportingSources = params.stance.supportingCount;
		counts.conflictingSources = params.stance.conflictingCount;
		counts.neutralSources = params.stance.neutralCount;
	}

	return {
		version: 1,
		tool: "aio-webresearch",
		query: params.query,
		queries: params.queries,
		startedAt: params.startedAt,
		finishedAt: params.finishedAt,
		durationMs: Date.parse(params.finishedAt) - Date.parse(params.startedAt),
		maxSources: params.maxSources,
		stopReason: "single_round_complete",
		bundleDir: params.bundleDir,
		counts,
		citationAudit: {
			checked: audit.length,
			ok,
			skipped,
			dead,
			details: audit,
		},
	};
}

export function buildSourcesJson(
	ranked: RankedSource[],
	fetched: FetchedSourceRecord[],
): Record<string, unknown> {
	const fetchedById = new Map(fetched.map((f) => [f.id, f]));
	return {
		version: 1,
		sources: ranked.map((s) => {
			const f = fetchedById.get(s.id);
			return {
				...s,
				fetched: !!f,
				fetchOk: f?.ok ?? null,
				reachability: f?.reachability ?? "unknown",
				statusCode: f?.statusCode,
				file: f?.file,
				wordCount: f?.wordCount,
			};
		}),
	};
}

export function buildEvidenceJson(
	evidence: EvidenceEntry[],
): Record<string, unknown> {
	return { version: 1, evidence };
}

// ─── Disk writer ────────────────────────────────────────────────────────

export interface WriteBundleInput {
	bundleDir: string;
	statusMd: string;
	evidenceMd: string;
	claimsMd: string;
	gapsMd: string;
	stanceMd: string;
	manifest: Record<string, unknown>;
	sourcesJson: Record<string, unknown>;
	evidenceJson: Record<string, unknown>;
	stanceJson: Record<string, unknown>;
}

/** Write the full bundle skeleton to disk. Assumes `sources/*.md` were already written by the caller. */
export async function writeBundle(input: WriteBundleInput): Promise<void> {
	const reportsDir = join(input.bundleDir, "reports");
	const dataDir = join(input.bundleDir, "data");
	await mkdir(reportsDir, { recursive: true });
	await mkdir(dataDir, { recursive: true });

	await Promise.all([
		writeFile(join(input.bundleDir, "STATUS.md"), input.statusMd, "utf8"),
		writeFile(join(input.bundleDir, "STANCE.md"), input.stanceMd, "utf8"),
		writeFile(join(reportsDir, "EVIDENCE.md"), input.evidenceMd, "utf8"),
		writeFile(join(reportsDir, "CLAIMS.md"), input.claimsMd, "utf8"),
		writeFile(join(reportsDir, "GAPS.md"), input.gapsMd, "utf8"),
		writeFile(
			join(dataDir, "manifest.json"),
			JSON.stringify(input.manifest, null, 2),
			"utf8",
		),
		writeFile(
			join(dataDir, "sources.json"),
			JSON.stringify(input.sourcesJson, null, 2),
			"utf8",
		),
		writeFile(
			join(dataDir, "evidence.json"),
			JSON.stringify(input.evidenceJson, null, 2),
			"utf8",
		),
		writeFile(
			join(dataDir, "stance.json"),
			JSON.stringify(input.stanceJson, null, 2),
			"utf8",
		),
	]);
}
