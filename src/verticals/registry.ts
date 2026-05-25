// ─── Vertical extractor registry ───────────────────────────────────
// Pattern-matches URLs and routes to API-first extractors for known sites.

import type { VerticalResult } from "./types.ts";
import { matchesNpm, extractNpm } from "./npm.ts";
import { matchesPyPI, extractPyPI } from "./pypi.ts";
import { matchesHackerNews, extractHackerNews } from "./hackernews.ts";
import { matchesReddit, extractReddit } from "./reddit.ts";
import { matchesArxiv, extractArxiv } from "./arxiv.ts";
import { matchesDocsSite, extractDocsSite } from "./docs-site.ts";
import { matchesYouTube, extractYouTube } from "./youtube.ts";
import { matchesWikipedia, extractWikipedia } from "./wikipedia.ts";
import { matchesStackExchange, extractStackExchange } from "./stackexchange.ts";
import { matchesOpenLibrary, extractOpenLibrary } from "./openlibrary.ts";
import { matchesDevTo, extractDevTo } from "./devto.ts";
import { matchesSonarCloud, extractSonarCloud } from "./sonarcloud.ts";
import { matchesCratesIo, extractCratesIo } from "./cratesio.ts";
import { matchesRubyGems, extractRubyGems } from "./rubygems.ts";
import { matchesPackagist, extractPackagist } from "./packagist.ts";
import { matchesPubDev, extractPubDev } from "./pubdev.ts";
import { matchesGoPackages, extractGoPackages } from "./gopackages.ts";
import { matchesNuGet, extractNuGet } from "./nuget.ts";
import { matchesGitLab, extractGitLab } from "./gitlab.ts";

export interface ExtractorMatch {
	name: string;
	matcher: (url: string) => boolean;
}

export const VERTICAL_EXTRACTORS: ExtractorMatch[] = [
	{ name: "npm", matcher: matchesNpm },
	{ name: "pypi", matcher: matchesPyPI },
	{ name: "hackernews", matcher: matchesHackerNews },
	{ name: "reddit", matcher: matchesReddit },
	{ name: "arxiv", matcher: matchesArxiv },
	{ name: "youtube", matcher: matchesYouTube },
	{ name: "docsite", matcher: matchesDocsSite },
	{ name: "wikipedia", matcher: matchesWikipedia },
	{ name: "stackexchange", matcher: matchesStackExchange },
	{ name: "openlibrary", matcher: matchesOpenLibrary },
	{ name: "devto", matcher: matchesDevTo },
	{ name: "sonarcloud", matcher: matchesSonarCloud },
	{ name: "cratesio", matcher: matchesCratesIo },
	{ name: "rubygems", matcher: matchesRubyGems },
	{ name: "packagist", matcher: matchesPackagist },
	{ name: "pubdev", matcher: matchesPubDev },
	{ name: "gopackages", matcher: matchesGoPackages },
	{ name: "nuget", matcher: matchesNuGet },
	{ name: "gitlab", matcher: matchesGitLab },
];

/**
 * Find which vertical extractor matches a URL.
 */
export function findVerticalExtractor(url: string): string | null {
	for (const v of VERTICAL_EXTRACTORS) {
		if (v.matcher(url)) return v.name;
	}
	return null;
}

/**
 * Run the appropriate vertical extractor for a URL.
 * Returns null if no extractor matches or extraction fails.
 */
export async function runVerticalExtractor(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
	fetchText: (url: string) => Promise<string | null>,
	fetchHtml: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	if (matchesNpm(url)) {
		return extractNpm(url, fetchJson);
	}
	if (matchesPyPI(url)) {
		return extractPyPI(url, fetchJson);
	}
	if (matchesHackerNews(url)) {
		return extractHackerNews(url, fetchJson);
	}
	if (matchesReddit(url)) {
		return extractReddit(url, fetchJson);
	}
	if (matchesArxiv(url)) {
		return extractArxiv(url, fetchText);
	}
	if (matchesYouTube(url)) {
		return extractYouTube(url, fetchJson, fetchText, fetchHtml);
	}
	if (matchesDocsSite(url)) {
		const html = await fetchHtml(url);
		if (html) return extractDocsSite(html, url);
	}
	if (matchesWikipedia(url)) {
		return extractWikipedia(url, fetchJson);
	}
	if (matchesStackExchange(url)) {
		return extractStackExchange(url, fetchJson);
	}
	if (matchesOpenLibrary(url)) {
		return extractOpenLibrary(url, fetchJson);
	}
	if (matchesDevTo(url)) {
		return extractDevTo(url, fetchJson);
	}
	if (matchesSonarCloud(url)) {
		return extractSonarCloud(url, fetchJson);
	}
	if (matchesCratesIo(url)) {
		return extractCratesIo(url, fetchJson);
	}
	if (matchesRubyGems(url)) {
		return extractRubyGems(url, fetchJson);
	}
	if (matchesPackagist(url)) {
		return extractPackagist(url, fetchJson);
	}
	if (matchesPubDev(url)) {
		return extractPubDev(url, fetchJson);
	}
	if (matchesGoPackages(url)) {
		return extractGoPackages(url, fetchJson, fetchText);
	}
	if (matchesNuGet(url)) {
		return extractNuGet(url, fetchJson);
	}
	if (matchesGitLab(url)) {
		return extractGitLab(url, fetchJson, fetchText);
	}
	return null;
}
