// ─── Source trust-tier + evidence-quality grading (roadmap F2) ──────────
// A higher-level layer built ON TOP of the existing `sourceType` classifier
// in search.ts (issue #61). It does NOT re-derive source types — it reuses
// `classifySourceType` and maps each type onto a coarse trust tier, then
// computes set-level evidence-quality caveats (community-only, low-diversity,
// bot-check, possible-conflict) for use in source selection now and the
// planned iterative research loop (F1) later.
//
// Everything here is pure and deterministic — no network, no LLM calls.

import { classifySourceType, extractDomain } from "./search.ts";
import type { SourceType } from "./types.ts";

/**
 * Coarse trust tier a source maps onto. Ordered most → least trustworthy:
 * authoritative > credible > mixed > community.
 */
export type TrustTier = "authoritative" | "credible" | "mixed" | "community";

/**
 * Reachability signal for a source, mirroring `ReachabilityStatus` in
 * research.ts (structurally identical so a value from `classifyReachability`
 * can be passed straight through). Declared locally to avoid a runtime
 * import cycle with research.ts.
 */
export type SourceReachability = "ok" | "skipped" | "dead" | "unknown";

/** The four evidence-quality caveat reasons this module can emit. */
export type SourceCaveat =
	| "community-only"
	| "low-diversity"
	| "bot-check"
	| "possible-conflict";

/**
 * Minimal structural input accepted by the grader. Matches both
 * `SearchResult` (search.ts) and `RankedSource` (research.ts) shapes — both
 * carry `url`/`title`/`domain` and optionally `sourceType`. `sourceType`,
 * when present, is trusted as-is; otherwise it is derived via
 * `classifySourceType`. `reachability` is optional caller-supplied data —
 * this module never invents it.
 */
export interface TrustSourceInput {
	url?: string;
	title?: string;
	domain?: string;
	sourceType?: SourceType;
	reachability?: SourceReachability;
}

export interface SourceProfile {
	sourceType: SourceType;
	tier: TrustTier;
	domain?: string;
}

export interface SourceDiversity {
	/** Count of distinct resolved domains (sources with no domain ignored). */
	uniqueDomains: number;
	/**
	 * Share (0..1) of the whole set held by the single most common domain.
	 * 0 for an empty set or a set with no resolvable domains.
	 */
	topDomainShare: number;
}

export interface SourceProfileSummary {
	/** Count of sources in each trust tier (all four keys always present). */
	tierDistribution: Record<TrustTier, number>;
	/** Deduped evidence-quality caveats for the set (stable order). */
	caveats: SourceCaveat[];
	diversity: SourceDiversity;
}

export interface ClassifySourceProfileOpts {
	/**
	 * Research query, used only for the conservative `possible-conflict`
	 * heuristic (a vendor domain token overlapping a query term). Omit to
	 * skip that caveat entirely.
	 */
	query?: string;
	/**
	 * Optional reachability keyed by source URL, for callers (e.g.
	 * research.ts) that compute reachability separately from the source
	 * record. A source-level `reachability` field takes precedence.
	 */
	reachabilityByUrl?: Record<string, SourceReachability>;
}

/**
 * Map an existing `sourceType` onto a trust tier.
 * - official-docs / academic → authoritative
 * - repo / maintainer-blog   → credible
 * - news / website           → mixed
 * - community / social       → community
 */
const TIER_FOR_SOURCE_TYPE: Record<SourceType, TrustTier> = {
	"official-docs": "authoritative",
	academic: "authoritative",
	repo: "credible",
	"maintainer-blog": "credible",
	news: "mixed",
	website: "mixed",
	community: "community",
	social: "community",
};

export function trustTierForSourceType(sourceType: SourceType): TrustTier {
	return TIER_FOR_SOURCE_TYPE[sourceType] ?? "mixed";
}

/**
 * Small additive ranking boost per tier, for optional fold-in to research
 * ranking. Purely a boost (no penalty) so enabling it can only lift
 * authoritative/credible sources, never demote others.
 */
const BOOST_FOR_TIER: Record<TrustTier, number> = {
	authoritative: 0.1,
	credible: 0.05,
	mixed: 0,
	community: 0,
};

export function trustTierBoost(tier: TrustTier): number {
	return BOOST_FOR_TIER[tier] ?? 0;
}

/** Resolve the domain for a source, preferring an explicit `domain` field. */
function resolveDomain(source: TrustSourceInput): string | undefined {
	if (source.domain) return source.domain;
	if (source.url) return extractDomain(source.url);
	return undefined;
}

/**
 * Resolve a single source's profile: its `sourceType` (trusted if present,
 * otherwise derived via the shared `classifySourceType`) and its trust tier.
 */
export function profileFor(source: TrustSourceInput): SourceProfile {
	const domain = resolveDomain(source);
	const sourceType =
		source.sourceType ??
		classifySourceType(domain ?? "", source.title ?? "", source.url ?? "");
	return { sourceType, tier: trustTierForSourceType(sourceType), domain };
}

// ─── possible-conflict tokenization ─────────────────────────────────────

/** Generic domain labels that must never count as a vendor identity. */
const CONFLICT_STOP_TOKENS = new Set([
	"www",
	"com",
	"org",
	"net",
	"io",
	"dev",
	"api",
	"docs",
	"doc",
	"blog",
	"app",
	"apps",
	"reference",
	"html",
	"index",
	"home",
	"main",
]);

function stripWww(domain: string): string {
	return domain.startsWith("www.") ? domain.slice(4) : domain;
}

/**
 * Identity-bearing tokens of a domain: drop the TLD, split on non-alphanumerics,
 * and keep only tokens ≥ 4 chars that are not generic labels. Conservative by
 * design so short/generic fragments never trigger a conflict.
 */
function domainIdentityTokens(domain: string): string[] {
	const labels = stripWww(domain.toLowerCase()).split(".");
	const body = labels.length > 1 ? labels.slice(0, -1).join(".") : labels[0];
	return body
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 4 && !CONFLICT_STOP_TOKENS.has(t));
}

function queryTokens(query: string): Set<string> {
	return new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length >= 4),
	);
}

// ─── Individual caveat checks (each pure; keep classifySourceProfile small) ─

/** community-only: non-empty set, every source is community tier. */
function hasCommunityOnly(profiles: SourceProfile[]): boolean {
	return profiles.length > 0 && profiles.every((p) => p.tier === "community");
}

/**
 * low-diversity: ≥2 sources concentrated on one domain (>half share) OR all
 * sharing a single sourceType.
 */
function hasLowDiversity(profiles: SourceProfile[], topDomainShare: number): boolean {
	if (profiles.length < 2) return false;
	const distinctTypes = new Set(profiles.map((p) => p.sourceType));
	return topDomainShare > 0.5 || distinctTypes.size === 1;
}

/** Resolve a source's reachability: source-level field wins over the URL map. */
function reachabilityOf(
	source: TrustSourceInput,
	byUrl: Record<string, SourceReachability> | undefined,
): SourceReachability | undefined {
	return source.reachability ?? (source.url ? byUrl?.[source.url] : undefined);
}

/**
 * bot-check: any source carries a bot-block / unreachable reachability signal.
 * Never fires without caller-supplied reachability data.
 */
function hasBotCheck(
	sources: TrustSourceInput[],
	byUrl: Record<string, SourceReachability> | undefined,
): boolean {
	return sources.some((s) => {
		const r = reachabilityOf(s, byUrl);
		return r === "skipped" || r === "dead";
	});
}

/**
 * possible-conflict: conservative — a source's identity-bearing domain token
 * appears as a whole query term (both ≥4 chars, generic labels excluded).
 */
function hasPossibleConflict(profiles: SourceProfile[], query: string): boolean {
	const qTokens = queryTokens(query);
	return profiles.some((p) =>
		p.domain ? domainIdentityTokens(p.domain).some((t) => qTokens.has(t)) : false,
	);
}

/**
 * Grade a result set: per-tier distribution, evidence-quality caveats, and
 * diversity metrics. Pure and deterministic. See `SourceCaveat` for the four
 * caveat reasons and how each is computed.
 */
export function classifySourceProfile(
	sources: TrustSourceInput[],
	opts: ClassifySourceProfileOpts = {},
): SourceProfileSummary {
	const tierDistribution: Record<TrustTier, number> = {
		authoritative: 0,
		credible: 0,
		mixed: 0,
		community: 0,
	};

	const profiles = sources.map((s) => profileFor(s));
	for (const p of profiles) tierDistribution[p.tier]++;

	// ── Diversity ──
	const domainCounts = new Map<string, number>();
	for (const p of profiles) {
		if (!p.domain) continue;
		const d = stripWww(p.domain.toLowerCase());
		domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
	}
	const uniqueDomains = domainCounts.size;
	let topDomainCount = 0;
	for (const c of domainCounts.values()) topDomainCount = Math.max(topDomainCount, c);
	const topDomainShare =
		sources.length > 0 && topDomainCount > 0 ? topDomainCount / sources.length : 0;

	// ── Caveats (fixed order, naturally deduped) ──
	const caveats: SourceCaveat[] = [];
	if (hasCommunityOnly(profiles)) caveats.push("community-only");
	if (hasLowDiversity(profiles, topDomainShare)) caveats.push("low-diversity");
	if (hasBotCheck(sources, opts.reachabilityByUrl)) caveats.push("bot-check");
	if (opts.query && hasPossibleConflict(profiles, opts.query)) {
		caveats.push("possible-conflict");
	}

	return {
		tierDistribution,
		caveats,
		diversity: { uniqueDomains, topDomainShare },
	};
}
