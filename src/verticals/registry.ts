// ─── Vertical extractor registry ───────────────────────────────────
// Pattern-matches URLs and routes to API-first extractors for known sites.
// User-defined extractors (loaded from ~/.pi/agent/webaio/verticals/*.mjs)
// are consulted BEFORE built-ins so users can override built-in behavior.

import type {
	VerticalFetchHtml,
	VerticalFetchJson,
	VerticalFetchText,
	VerticalResult,
} from "./types.ts";
import { debug } from "../debug.ts";
import {
	loadUserExtractors,
	type RegisteredUserExtractor,
} from "./user-loader.ts";
// Matchers are tiny regexes — keep eager for fast findVerticalExtractor.
// Extractors are heavy (API clients, parsers) — lazy via dynamic import
// so cold `pi -p` pays ~0ms for the 21 verticals until a URL actually matches.
import { matchesNpm } from "./npm.ts";
import { matchesPyPI } from "./pypi.ts";
import { matchesHackerNews } from "./hackernews.ts";
import { matchesReddit } from "./reddit.ts";
import { matchesArxiv } from "./arxiv.ts";
import { matchesDocsSite } from "./docs-site.ts";
import { matchesYouTube } from "./youtube.ts";
import { matchesWikipedia } from "./wikipedia.ts";
import { matchesStackExchange } from "./stackexchange.ts";
import { matchesOpenLibrary } from "./openlibrary.ts";
import { matchesDevTo } from "./devto.ts";
import { matchesSonarCloud } from "./sonarcloud.ts";
import { matchesCratesIo } from "./cratesio.ts";
import { matchesRubyGems } from "./rubygems.ts";
import { matchesPackagist } from "./packagist.ts";
import { matchesPubDev } from "./pubdev.ts";
import { matchesGoPackages } from "./gopackages.ts";
import { matchesNuGet } from "./nuget.ts";
import { matchesGitLab } from "./gitlab.ts";
import { matchesContext7 } from "./context7.ts";
import { matchesDeepWiki } from "./deepwiki.ts";

interface ExtractorMatch {
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

const VERTICAL_EXTRACTORS: ExtractorMatch[] = [
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
	fetchJson: VerticalFetchJson,
	fetchText: VerticalFetchText,
	fetchHtml: VerticalFetchHtml,
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

	// Lazy extract imports — ~80ms cold start saved for pi -p (life-depends)
	if (matchesNpm(url)) {
		const { extractNpm } = await import("./npm.ts");
		return extractNpm(url, fetchJson);
	}
	if (matchesPyPI(url)) {
		const { extractPyPI } = await import("./pypi.ts");
		return extractPyPI(url, fetchJson);
	}
	if (matchesHackerNews(url)) {
		const { extractHackerNews } = await import("./hackernews.ts");
		return extractHackerNews(url, fetchJson);
	}
	if (matchesReddit(url)) {
		const { extractReddit } = await import("./reddit.ts");
		return extractReddit(url, fetchJson);
	}
	if (matchesArxiv(url)) {
		const { extractArxiv } = await import("./arxiv.ts");
		return extractArxiv(url, fetchText);
	}
	if (matchesYouTube(url)) {
		const { extractYouTube } = await import("./youtube.ts");
		return extractYouTube(url, fetchJson, fetchText, fetchHtml);
	}
	if (matchesDocsSite(url)) {
		const html = await fetchHtml(url);
		if (html) {
			const { extractDocsSite } = await import("./docs-site.ts");
			return extractDocsSite(html, url);
		}
	}
	if (matchesWikipedia(url)) {
		const { extractWikipedia } = await import("./wikipedia.ts");
		return extractWikipedia(url, fetchJson);
	}
	if (matchesStackExchange(url)) {
		const { extractStackExchange } = await import("./stackexchange.ts");
		return extractStackExchange(url, fetchJson);
	}
	if (matchesOpenLibrary(url)) {
		const { extractOpenLibrary } = await import("./openlibrary.ts");
		return extractOpenLibrary(url, fetchJson);
	}
	if (matchesDevTo(url)) {
		const { extractDevTo } = await import("./devto.ts");
		return extractDevTo(url, fetchJson);
	}
	if (matchesSonarCloud(url)) {
		const { extractSonarCloud } = await import("./sonarcloud.ts");
		return extractSonarCloud(url, fetchJson);
	}
	if (matchesCratesIo(url)) {
		const { extractCratesIo } = await import("./cratesio.ts");
		return extractCratesIo(url, fetchJson);
	}
	if (matchesRubyGems(url)) {
		const { extractRubyGems } = await import("./rubygems.ts");
		return extractRubyGems(url, fetchJson);
	}
	if (matchesPackagist(url)) {
		const { extractPackagist } = await import("./packagist.ts");
		return extractPackagist(url, fetchJson);
	}
	if (matchesPubDev(url)) {
		const { extractPubDev } = await import("./pubdev.ts");
		return extractPubDev(url, fetchJson);
	}
	if (matchesGoPackages(url)) {
		const { extractGoPackages } = await import("./gopackages.ts");
		return extractGoPackages(url, fetchJson, fetchText);
	}
	if (matchesNuGet(url)) {
		const { extractNuGet } = await import("./nuget.ts");
		return extractNuGet(url, fetchJson);
	}
	if (matchesGitLab(url)) {
		const { extractGitLab } = await import("./gitlab.ts");
		return extractGitLab(url, fetchJson, fetchText);
	}
	if (matchesContext7(url)) {
		const { extractContext7 } = await import("./context7.ts");
		return extractContext7(url);
	}
	if (matchesDeepWiki(url)) {
		const { extractDeepWiki } = await import("./deepwiki.ts");
		return extractDeepWiki(url);
	}
	return null;
}
