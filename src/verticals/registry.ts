// ─── Vertical extractor registry ───────────────────────────────────
// Pattern-matches URLs and routes to API-first extractors for known sites.

import type { VerticalResult } from "./types.js";
import { matchesNpm, extractNpm } from "./npm.js";
import { matchesPyPI, extractPyPI } from "./pypi.js";
import { matchesHackerNews, extractHackerNews } from "./hackernews.js";
import { matchesReddit, extractReddit } from "./reddit.js";
import { matchesArxiv, extractArxiv } from "./arxiv.js";
import { matchesDocsSite, extractDocsSite } from "./docs-site.js";

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
	{ name: "docsite", matcher: matchesDocsSite },
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
	if (matchesDocsSite(url)) {
		const html = await fetchHtml(url);
		if (html) return extractDocsSite(html, url);
	}
	return null;
}
