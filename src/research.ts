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
	const n = typeof value === "number" && Number.isFinite(value)
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
	if (input.statusCode !== undefined && ANTI_BOT_STATUS_CODES.has(input.statusCode)) {
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

const PRIMARY_DOMAIN_SUFFIXES = [
	".gov",
	".edu",
	".mil",
];

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
		let p = u.pathname.replace(/\/$/, "");
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
export function rankSources(perQuery: QueryResults[]): RankedSource[] {
	interface Acc {
		url: string;
		title: string;
		domain?: string;
		snippet?: string;
		engines: Set<string>;
		queries: Set<string>;
		bestRank: number;
		score: number;
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
		});
	}

	const list = [...byKey.values()].map((acc) => {
		const consensusBonus = Math.max(0, acc.queries.size - 1) * 0.5;
		return { ...acc, score: acc.score + consensusBonus };
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
}

export function buildStatusMd(summary: BundleSummary): string {
	const okCount = summary.fetched.filter((f) => f.reachability === "ok").length;
	const skippedCount = summary.fetched.filter((f) => f.reachability === "skipped").length;
	const deadCount = summary.fetched.filter((f) => f.reachability === "dead").length;
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

	lines.push(
		`## Next steps for the agent`,
		``,
		`- Fill in \`reports/CLAIMS.md\` with claims cited by source ID (S1, S2, ...), using \`reports/EVIDENCE.md\` and \`data/evidence.json\`.`,
		`- Review \`reports/GAPS.md\` for sub-queries with weak or no coverage.`,
		`- This is a single-round MVP bundle — no iterative follow-up round was run.`,
		``,
	);

	return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

export function buildEvidenceMd(
	evidence: EvidenceEntry[],
	fetched: FetchedSourceRecord[],
): string {
	const byId = new Map(fetched.map((f) => [f.id, f]));
	const lines: string[] = [`# Evidence`, ``];
	if (evidence.length === 0) {
		lines.push(`_No evidence extracted — no sources were successfully fetched._`, ``);
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
	return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

export function buildClaimsMdScaffold(query: string, fetched: FetchedSourceRecord[]): string {
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
				(f) => `- ${f.id} (${f.reachability}): ${f.url}${f.errorMessage ? ` — ${f.errorMessage}` : ""}`,
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

	if (zeroResultQueries.length === 0 && skippedOrDead.length === 0 && summary.unfetchedRanked.length === 0) {
		lines.push(`_No gaps detected in this single-round MVP run._`, ``);
	}

	lines.push(
		``,
		`_This is a single-round MVP — an iterative research loop (follow-up`,
		`sub-queries to close these gaps) is planned as a follow-up, not part of`,
		`this bundle._`,
		``,
	);

	return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
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
		counts: {
			sourcesConsulted: params.consulted,
			sourcesFetched: params.fetched.length,
			sourcesOk: ok,
			sourcesSkipped: skipped,
			sourcesDead: dead,
			primarySources: primary,
		},
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

export function buildEvidenceJson(evidence: EvidenceEntry[]): Record<string, unknown> {
	return { version: 1, evidence };
}

// ─── Disk writer ────────────────────────────────────────────────────────

export interface WriteBundleInput {
	bundleDir: string;
	statusMd: string;
	evidenceMd: string;
	claimsMd: string;
	gapsMd: string;
	manifest: Record<string, unknown>;
	sourcesJson: Record<string, unknown>;
	evidenceJson: Record<string, unknown>;
}

/** Write the full bundle skeleton to disk. Assumes `sources/*.md` were already written by the caller. */
export async function writeBundle(input: WriteBundleInput): Promise<void> {
	const reportsDir = join(input.bundleDir, "reports");
	const dataDir = join(input.bundleDir, "data");
	await mkdir(reportsDir, { recursive: true });
	await mkdir(dataDir, { recursive: true });

	await Promise.all([
		writeFile(join(input.bundleDir, "STATUS.md"), input.statusMd, "utf8"),
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
	]);
}
