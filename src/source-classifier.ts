// ─── Source-type classification ─────────────────────────────────────
// Cheap domain/path heuristics that bucket a search result into one of a
// handful of source types, used by scoreAndRankResults (src/search.ts) to
// fold a per-type priority into the ranking score.
//
// Ported from the sibling project greedysearch-pi
// (src/search/sources.mjs — classifySourceType / sourceTypePriority /
// host lists), same author, MIT-licensed.

import type { SourceType } from "./types.ts";

export const COMMUNITY_HOSTS = [
	"dev.to",
	"hashnode.com",
	"medium.com",
	"reddit.com",
	"stackoverflow.com",
	"stackexchange.com",
	"substack.com",
];

export const NEWS_HOSTS = [
	"arstechnica.com",
	"techcrunch.com",
	"theverge.com",
	"venturebeat.com",
	"wired.com",
	"zdnet.com",
];

export const SOCIAL_HOSTS = [
	"facebook.com",
	"instagram.com",
	"linkedin.com",
	"pinterest.com",
	"tiktok.com",
	"twitter.com",
	"x.com",
];

/** Strips a leading "www." and lowercases, so hosts compare consistently. */
export function normalizeDomain(domain: string): string {
	return domain.toLowerCase().replace(/^www\./, "");
}

export function matchesDomain(domain: string, hosts: string[]): boolean {
	return hosts.some((host) => domain === host || domain.endsWith(`.${host}`));
}

/**
 * Classifies a result into a source type using domain + path heuristics.
 * Order matters: repo/academic/social/community/news are exact-ish host
 * matches checked first, then the broader "official-docs" and
 * "maintainer-blog" path/title heuristics, falling back to "website".
 */
export function classifySourceType(
	rawDomain: string,
	title = "",
	url = "",
): SourceType {
	const domain = normalizeDomain(rawDomain);
	const lowerTitle = title.toLowerCase();
	const lowerUrl = url.toLowerCase();

	if (domain === "github.com" || domain === "gitlab.com") return "repo";
	if (
		domain === "arxiv.org" ||
		domain === "doi.org" ||
		domain === "semanticscholar.org" ||
		domain.endsWith(".semanticscholar.org") ||
		lowerUrl.includes("/paper/") ||
		lowerUrl.includes("/pdf/")
	) {
		return "academic";
	}
	if (matchesDomain(domain, SOCIAL_HOSTS)) return "social";
	if (matchesDomain(domain, COMMUNITY_HOSTS)) return "community";
	if (matchesDomain(domain, NEWS_HOSTS)) return "news";
	if (
		domain.startsWith("docs.") ||
		domain.startsWith("developer.") ||
		domain.startsWith("developers.") ||
		domain.startsWith("api.") ||
		lowerTitle.includes("documentation") ||
		lowerTitle.includes("docs") ||
		lowerTitle.includes("reference") ||
		lowerUrl.includes("/docs/") ||
		lowerUrl.includes("/reference/") ||
		lowerUrl.includes("/api/")
	) {
		return "official-docs";
	}
	if (domain.startsWith("blog.") || lowerUrl.includes("/blog/"))
		return "maintainer-blog";
	return "website";
}

/**
 * Relative priority of each source type, highest first. Mirrors
 * greedysearch-pi's computeCompositeScore ordering:
 *   official-docs > repo == academic > maintainer-blog > website
 *     > community > news > social
 * "social" gets a large negative priority so it sinks below everything
 * else even with multi-engine consensus (see scoreAndRankResults).
 */
export function sourceTypePriority(sourceType: SourceType | undefined): number {
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
