// ─── Vertical extractor registry ───────────────────────────────────
// Pattern-matches URLs and routes to API-first extractors for known sites.
// User-defined extractors (loaded from ~/.pi/agent/webaio/verticals/*.mjs)
// are consulted BEFORE built-ins so users can override built-in behavior.

import type { VerticalResult } from "./types.ts";
import { debug } from "../debug.ts";
import {
	loadUserExtractors,
	type RegisteredUserExtractor,
} from "./user-loader.ts";
export {
	initUserHooks,
	getUserHooks,
	runAfterFetchHooks,
	runAfterExtractHooks,
} from "../hooks.ts";
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
import { matchesContext7, extractContext7 } from "./context7.ts";
import { matchesDeepWiki, extractDeepWiki } from "./deepwiki.ts";

export interface ExtractorMatch {
	name: string;
	matcher: (url: string) => boolean;
}

// ─── User extractor registry ─────────────────────────────────────────
// Populated once at startup by calling initUserExtractors().
// User extractors are checked BEFORE built-ins so users can override
// built-in behavior for a given URL pattern.
let _userExtractors: RegisteredUserExtractor[] = [];

/**
 * Load user extractors from the config directory and register them.
 * Should be called once at extension startup. Safe to call multiple times;
 * subsequent calls replace the previous set.
 *
 * A loader failure (bad path, syntax error in a custom vertical) is a
 * user-actionable config error, NOT a best-effort background task: it is
 * surfaced via console.warn and the registry is left empty rather than
 * silently dropping the user's extractors (observability audit P6).
 *
 * @param dirPath Optional override for the config directory path (for tests).
 * @param loader  Optional injectable loader (for tests). Defaults to
 *                loadUserExtractors.
 */
export async function initUserExtractors(
	dirPath?: string,
	loader: (
		dirPath?: string,
	) => Promise<RegisteredUserExtractor[]> = loadUserExtractors,
): Promise<void> {
	try {
		_userExtractors = await loader(dirPath);
	} catch (err) {
		console.warn(
			`[user-verticals] Failed to load user extractors: ${(err as Error).message ?? String(err)}`,
		);
		_userExtractors = [];
	}
}

/**
 * Returns a copy of the currently registered user extractors.
 * Primarily useful for tests and diagnostics.
 */
export function getUserExtractors(): RegisteredUserExtractor[] {
	return [..._userExtractors];
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
	{ name: "context7", matcher: matchesContext7 },
	{ name: "deepwiki", matcher: matchesDeepWiki },
];

/**
 * Find which vertical extractor matches a URL.
 * User extractors are checked before built-ins.
 */
export function findVerticalExtractor(url: string): string | null {
	for (const u of _userExtractors) {
		try {
			if (u.matchUrl(url)) return u.name;
		} catch (err) {
			// Attribution is best-effort, but don't swallow silently — leave a
			// debug trail so a broken user matcher is diagnosable (audit P6).
			debug(
				"verticals",
				`${u.name} (${u.filePath}) match() threw during attribution: ${(err as Error).message}`,
			);
		}
	}
	for (const v of VERTICAL_EXTRACTORS) {
		if (v.matcher(url)) return v.name;
	}
	return null;
}

/**
 * Run the appropriate vertical extractor for a URL.
 * User extractors are checked before built-ins.
 * Runtime errors from user extractors are caught and logged; the function
 * then falls through to the built-in pipeline rather than crashing.
 * Returns null if no extractor matches or extraction fails.
 */
export async function runVerticalExtractor(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
	fetchText: (url: string) => Promise<string | null>,
	fetchHtml: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	// User extractors take priority — checked before any built-in
	for (const u of _userExtractors) {
		let matches = false;
		try {
			matches = u.matchUrl(url);
		} catch (err) {
			console.warn(
				`[user-verticals] ${u.name} (${u.filePath}) match() threw: ${(err as Error).message}`,
			);
			continue;
		}
		if (!matches) continue;

		try {
			const result = await u.extract(url, fetchJson, fetchText, fetchHtml);
			if (result !== null) return result;
		} catch (err) {
			console.warn(
				`[user-verticals] ${u.name} (${u.filePath}) extract() threw for ${url}: ${(err as Error).message} — falling through to built-in pipeline`,
			);
			// Fall through: do not return, continue to built-ins below
		}
	}

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
	if (matchesContext7(url)) {
		return extractContext7(url);
	}
	if (matchesDeepWiki(url)) {
		return extractDeepWiki(url);
	}
	return null;
}
