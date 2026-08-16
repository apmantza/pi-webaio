// ─── Search "goggles" — named rerank profiles (issue #72) ──────────
// Inspired by wd041216-bit/zero-api-key-web-search's GOGGLES_PRESETS /
// _apply_goggles: small, swappable boost/demote rule sets that bias
// `scoreAndRankResults` toward docs, academic/repo sources, or news,
// on top of (not instead of) the existing composite score.
//
// A goggle is just data: a list of rules, each optionally matching by
// domain, a domain substring marker (e.g. "docs."), a URL substring
// marker (e.g. "/reference/"), or a title term, with a signed weight
// that's summed additively into the ranking score.

/** A single boost/demote rule. Any of the match fields may be combined;
 * the rule fires (contributing `weight` once) if ANY field matches. */
interface GogglesRule {
	/** Exact-or-subdomain domain match, e.g. "arxiv.org" also matches "www.arxiv.org". */
	domains?: string[];
	/** Case-insensitive substrings checked against the bare hostname (e.g. "docs.", ".gov"). */
	domainMarkers?: string[];
	/** Case-insensitive substrings checked against the result URL (e.g. "/reference/"). */
	urlMarkers?: string[];
	/** Case-insensitive substrings checked against the result title. */
	titleTerms?: string[];
	/** Score delta applied when this rule matches. Positive boosts, negative demotes. */
	weight: number;
	/** Human-readable label surfaced in the per-source debug breakdown. */
	label?: string;
}

export interface GogglesProfile {
	name: string;
	rules: GogglesRule[];
}

interface GogglesMatch {
	label: string;
	weight: number;
}

export interface GogglesScoreResult {
	bonus: number;
	matches: GogglesMatch[];
}

/** Accepted shapes for the `goggles` tool parameter, pre-resolution. */
export type GogglesInput =
	| string
	| GogglesRule[]
	| { name?: string; rules?: GogglesRule[] }
	| undefined
	| null;

// ─── Built-in presets ───────────────────────────────────────────────

const DOCS_FIRST: GogglesProfile = {
	name: "docs-first",
	rules: [
		{
			domainMarkers: ["docs.", "developer.", "developers.", "api."],
			weight: 6,
			label: "docs-subdomain",
		},
		{
			urlMarkers: ["/reference/", "/docs/", "/api/"],
			weight: 4,
			label: "docs-path",
		},
		{
			titleTerms: ["documentation", "reference", "docs"],
			weight: 3,
			label: "docs-title",
		},
		{
			domains: [
				"arstechnica.com",
				"techcrunch.com",
				"theverge.com",
				"venturebeat.com",
				"wired.com",
				"zdnet.com",
			],
			weight: -4,
			label: "news-demote",
		},
		{
			domains: [
				"facebook.com",
				"instagram.com",
				"linkedin.com",
				"pinterest.com",
				"tiktok.com",
				"twitter.com",
				"x.com",
			],
			weight: -6,
			label: "social-demote",
		},
	],
};

const RESEARCH: GogglesProfile = {
	name: "research",
	rules: [
		{
			domains: [
				"arxiv.org",
				"doi.org",
				"semanticscholar.org",
				"github.com",
				"gitlab.com",
			],
			weight: 6,
			label: "academic-repo",
		},
		{
			urlMarkers: ["/paper/", "/pdf/", "/abs/"],
			weight: 3,
			label: "academic-path",
		},
		{
			titleTerms: ["paper", "study", "research", "proceedings"],
			weight: 3,
			label: "research-title",
		},
		{
			domains: [
				"facebook.com",
				"instagram.com",
				"linkedin.com",
				"pinterest.com",
				"tiktok.com",
				"twitter.com",
				"x.com",
			],
			weight: -4,
			label: "social-demote",
		},
	],
};

const NEWS_BALANCED: GogglesProfile = {
	name: "news-balanced",
	rules: [
		{
			domains: [
				"arstechnica.com",
				"techcrunch.com",
				"theverge.com",
				"venturebeat.com",
				"wired.com",
				"zdnet.com",
			],
			weight: 6,
			label: "news-boost",
		},
		{
			titleTerms: ["breaking", "announces", "announcement"],
			weight: 2,
			label: "news-title",
		},
	],
};

/** Built-in named presets, keyed by lowercase preset name. */
export const GOGGLES_PRESETS: Record<string, GogglesProfile> = {
	"docs-first": DOCS_FIRST,
	research: RESEARCH,
	"news-balanced": NEWS_BALANCED,
};

// ─── Resolution ─────────────────────────────────────────────────────

function normalizeCustomRules(data: unknown): GogglesProfile | undefined {
	if (Array.isArray(data)) {
		return { name: "custom", rules: data as GogglesRule[] };
	}
	if (
		data !== null &&
		typeof data === "object" &&
		Array.isArray((data as { rules?: unknown }).rules)
	) {
		const obj = data as { name?: string; rules: GogglesRule[] };
		return { name: obj.name ?? "custom", rules: obj.rules };
	}
	return undefined;
}

/**
 * Resolve a `goggles` input synchronously: a built-in preset name, an
 * inline JSON string of custom rules, or an already-parsed rules
 * object/array. Does NOT touch the filesystem — a bare string that
 * isn't a known preset or valid JSON is left unresolved (returns
 * undefined) so callers can try `loadGoggles` for file-path support.
 */
export function resolveGogglesSync(
	input: GogglesInput,
): GogglesProfile | undefined {
	if (input === undefined || input === null) return undefined;
	if (typeof input === "object") return normalizeCustomRules(input);

	const trimmed = input.trim();
	if (!trimmed) return undefined;

	const preset = GOGGLES_PRESETS[trimmed.toLowerCase()];
	if (preset) return preset;

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return normalizeCustomRules(JSON.parse(trimmed));
		} catch {
			return undefined;
		}
	}

	return undefined;
}

/**
 * Full `goggles` resolution: built-in preset, inline JSON, or a file
 * path to a JSON file of custom rules (resolved relative to cwd).
 * Invalid or unresolvable input resolves to undefined rather than
 * throwing — an unknown goggle degrades to "no goggle applied" instead
 * of failing the whole search.
 */
export async function loadGoggles(
	input: GogglesInput,
): Promise<GogglesProfile | undefined> {
	const sync = resolveGogglesSync(input);
	if (sync) return sync;
	if (typeof input !== "string") return undefined;

	const trimmed = input.trim();
	if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return undefined;
	}

	try {
		const { readFile } = await import("node:fs/promises");
		const { resolve } = await import("node:path");
		const text = await readFile(resolve(process.cwd(), trimmed), "utf8");
		return normalizeCustomRules(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function stripWwwLocal(domain: string): string {
	return domain.replace(/^www\./, "");
}

/**
 * Additive score contribution for a single result under an active
 * goggle profile, plus a per-rule match breakdown for debug
 * transparency. Every matching rule's weight is summed (a result can
 * match more than one rule).
 */
export function computeGogglesBonus(
	profile: GogglesProfile | undefined,
	domain: string,
	title = "",
	url = "",
): GogglesScoreResult {
	if (!profile) return { bonus: 0, matches: [] };

	const d = stripWwwLocal((domain || "").toLowerCase());
	const lowerTitle = title.toLowerCase();
	const lowerUrl = url.toLowerCase();

	let bonus = 0;
	const matches: GogglesMatch[] = [];

	for (const rule of profile.rules) {
		const domainHit = rule.domains?.some(
			(dom) => d === dom.toLowerCase() || d.endsWith(`.${dom.toLowerCase()}`),
		);
		const markerHit = rule.domainMarkers?.some((m) => d.includes(m.toLowerCase()));
		const urlHit = rule.urlMarkers?.some((m) => lowerUrl.includes(m.toLowerCase()));
		const titleHit = rule.titleTerms?.some((t) => lowerTitle.includes(t.toLowerCase()));

		if (domainHit || markerHit || urlHit || titleHit) {
			bonus += rule.weight;
			matches.push({
				label:
					rule.label ??
					`${rule.weight >= 0 ? "boost" : "demote"}:${
						rule.domains?.[0] ?? rule.domainMarkers?.[0] ?? rule.urlMarkers?.[0] ?? rule.titleTerms?.[0] ?? "rule"
					}`,
				weight: rule.weight,
			});
		}
	}

	return { bonus, matches };
}
