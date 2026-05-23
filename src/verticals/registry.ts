// ─── Vertical extractor registry ───────────────────────────────────
// Pattern-matches URLs and routes to API-first extractors for known sites.

import type { VerticalResult } from "./types.js";
import { matchesNpm, extractNpm } from "./npm.js";
import { matchesPyPI, extractPyPI } from "./pypi.js";
import { matchesHackerNews, extractHackerNews } from "./hackernews.js";
import { matchesReddit, extractReddit } from "./reddit.js";
import { matchesArxiv, extractArxiv } from "./arxiv.js";
import { matchesDocsSite, extractDocsSite } from "./docs-site.js";
import { matchesYouTube, extractYouTube } from "./youtube.js";
import { matchesWikipedia, extractWikipedia } from "./wikipedia.js";
import { matchesStackExchange, extractStackExchange } from "./stackexchange.js";
import { matchesOpenLibrary, extractOpenLibrary } from "./openlibrary.js";
import { matchesDevTo, extractDevTo } from "./devto.js";
import { matchesSonarCloud, extractSonarCloud } from "./sonarcloud.js";
import { matchesCratesIo, extractCratesIo } from "./cratesio.js";
import { matchesRubyGems, extractRubyGems } from "./rubygems.js";
import { matchesPackagist, extractPackagist } from "./packagist.js";
import { matchesPubDev, extractPubDev } from "./pubdev.js";
import { matchesGoPackages, extractGoPackages } from "./gopackages.js";
import { matchesNuGet, extractNuGet } from "./nuget.js";
import { matchesGitLab, extractGitLab } from "./gitlab.js";

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
