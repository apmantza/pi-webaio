// ─── Discovery ─────────────────────────────────────────────────────
// Extracted from index.ts. Sitemap parsing, nav link extraction, crawling.

import { parseHTML } from "linkedom";
import { smartFetch } from "./fetch.ts";
import { runInBatches } from "./tools/utils.ts";
import type { FetchOpts } from "./types.ts";

// ─── Constants ─────────────────────────────────────────────────────

const IGNORED =
	/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|mp[34]|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i;

// A hostile <sitemapindex> can list tens of thousands of nested sitemaps;
// bound both the fan-out width per level and the concurrency so a single
// hostile site can't exhaust sockets/memory or crash the process.
const MAX_CHILD_SITEMAPS = 50;
const SITEMAP_CONCURRENCY = 5;
const MAX_SITEMAP_URLS = 5000;
const MAX_SITEMAP_FETCHES = 100;

const NAV_SELECTORS = [
	"nav a[href]",
	"aside a[href]",
	'[class*="sidebar"] a[href]',
	'[class*="Sidebar"] a[href]',
	'[class*="navigation"] a[href]',
	'[class*="toc"] a[href]',
	'[class*="menu"] a[href]',
	'[role="navigation"] a[href]',
];

// ─── Low-level helpers ─────────────────────────────────────────────

async function tryFetch(
	url: string,
	opts?: FetchOpts,
): Promise<{ text: string; url: string } | null> {
	try {
		const r = await smartFetch(url, opts);
		return r?.status && r.status < 400 ? { text: r.text, url: r.url } : null;
	} catch {
		// Discovery is best-effort: one unavailable sitemap must not prevent
		// navigation extraction or bounded crawling from running.
		return null;
	}
}

/**
 * A `<url>` entry from a sitemap urlset (or a `<sitemap>` from an index).
 *
 * `lastmod` is retained deliberately. `parseLocs` used to return bare strings and
 * threw it away, which is the root cause of issue #132: the recency information
 * was present in the response body and discarded at the parse step, so a
 * budget-limited pull could not rank by it and landed entirely on the archive
 * floor.
 */
export type SitemapEntry = { loc: string; lastmod?: string };

export function parseLocs(xml: string): SitemapEntry[] {
	const out: SitemapEntry[] = [];
	// Spans covered by a <url>/<sitemap> block. Anything matched outside them is a
	// bare <loc>, which the pre-#132 parser tolerated and still must.
	const wrapped: Array<[number, number]> = [];
	for (const item of xml.matchAll(/<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi)) {
		const block = item[1] ?? "";
		wrapped.push([item.index, item.index + item[0].length]);
		// One <lastmod> per block, applied to every <loc> inside it. Pairing must
		// stay inside the block: zipping a global loc list against a global
		// lastmod list would hand an undated entry its neighbour's date and
		// silently invent recency.
		const lastmod = /<lastmod>([^<]*)<\/lastmod>/i.exec(block)?.[1]?.trim();
		// Every <loc> in the block, not just the first. The old global regex
		// returned all of them, so keeping only the first turned malformed
		// multi-<loc> input into a silent discovery loss.
		for (const locMatch of block.matchAll(/<loc>([^<]*)<\/loc>/gi)) {
			const loc = locMatch[1]?.trim();
			if (!loc) continue;
			out.push(lastmod ? { loc, lastmod } : { loc });
		}
	}
	// Bare <loc> entries that sit outside every block. The fallback used to be
	// `if (out.length > 0) return out`, so it only ran when NOTHING wrapped
	// parsed and a sitemap mixing both shapes silently dropped every bare entry.
	// Real malformed sitemaps mix, so collection is additive rather than exclusive.
	const isWrapped = (index: number) =>
		wrapped.some(([start, end]) => index >= start && index < end);
	for (const locMatch of xml.matchAll(/<loc>([^<]*)<\/loc>/gi)) {
		if (isWrapped(locMatch.index)) continue;
		const loc = locMatch[1]?.trim();
		if (!loc) continue;
		// No enclosing block means no reliable pairing: emit undated so it ranks
		// after dated entries instead of guessing at a date.
		out.push({ loc });
	}
	return out;
}

/**
 * Newest first, using only cheap signals, and degrading to "we do not know".
 *
 * Order of preference is the one issue #132 specifies: sitemap `lastmod`, then a
 * conservative `/YYYY/MM/` URL pattern, then the document order the site gave us.
 * The non-goal is equally load-bearing: no content-based recency guessing, because
 * a wrong "recency" guess is worse than serving an old page.
 *
 * Reordering is gated on the sitemap actually being date-structured. A docs site
 * mixes a few dated changelog entries with undated evergreen reference pages; if
 * those few dated entries were floated to the top, a budget-limited pull would
 * spend everything on the changelog and drop the pages the caller wanted — worse
 * than the document order master used. So reordering happens only when a STRICT
 * MAJORITY of entries carry a usable date (a blog is ~100% dated; a docs sitemap
 * is not), and otherwise the site's own order is preserved untouched.
 *
 * Within the reordered case, undated entries sort after dated ones and keep their
 * relative order (a stable partition, not an alphabetical or random tiebreak).
 */
export function rankByRecency(entries: SitemapEntry[]): SitemapEntry[] {
	const dated: Array<{ entry: SitemapEntry; time: number; i: number }> = [];
	const undated: SitemapEntry[] = [];
	entries.forEach((entry, i) => {
		const time = recencyTime(entry);
		if (time === undefined) undated.push(entry);
		else dated.push({ entry, time, i });
	});
	if (dated.length === 0 || dated.length * 2 <= entries.length) {
		// Not a date-structured sitemap: leave the site's order alone.
		return entries;
	}
	dated.sort((a, b) => b.time - a.time || a.i - b.i);
	return [...dated.map((d) => d.entry), ...undated];
}

/**
 * Milliseconds for the recency of one entry, or undefined when nothing cheap
 * establishes it.
 *
 * Sitemaps are untrusted input, so a `lastmod` that does not parse to a real date
 * (`not-a-date`, `0000-00-00`, epoch zero) is treated as ABSENT rather than as a
 * very old or very new value — otherwise a malformed stamp could outrank a real
 * one.
 */
function recencyTime(entry: SitemapEntry): number | undefined {
	const stamp = entry.lastmod;
	if (stamp) {
		// Only accept a date-shaped prefix; sitemaps legally carry full ISO
		// datetimes with offsets as well as bare dates.
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
		if (m) {
			const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
			if (y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
				const t = Date.UTC(y, mo - 1, d);
				// Date.UTC NORMALIZES an impossible date into a real one, so
				// 2024-02-31 silently becomes a March date and can outrank a genuine
				// 2024-03-01. Re-read the components and require them to round-trip:
				// a stamp that does not exist on a calendar is treated as absent.
				const dt = new Date(t);
				if (
					dt.getUTCFullYear() === y &&
					dt.getUTCMonth() === mo - 1 &&
					dt.getUTCDate() === d &&
					Number.isFinite(t) &&
					t > 0
				)
					return t;
			}
		}
	}
	// Conservative fallback: a `/YYYY/MM/` blog-style slug. Deliberately requires
	// both year and month so a bare `/2014/` archive index is not mistaken for a
	// dated post.
	const slug = /\/((?:19|20)\d{2})\/(\d{1,2})(?:\/|$)/.exec(entry.loc);
	if (slug) {
		const [y, mo] = [Number(slug[1]), Number(slug[2])];
		if (mo >= 1 && mo <= 12) {
			const t = Date.UTC(y, mo - 1, 1);
			if (Number.isFinite(t) && t > 0) return t;
		}
	}
	return undefined;
}

// ─── Sitemap fetching (recursive, handles index sitemaps) ──────────

type SitemapBudget = { remaining: number };

function isApprovedSitemapUrl(
	raw: string,
	allowedOrigins: Set<string>,
): boolean {
	try {
		const url = new URL(raw);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			allowedOrigins.has(url.origin)
		);
	} catch {
		return false;
	}
}

function consumeSitemapBudget(budget: SitemapBudget): boolean {
	if (budget.remaining <= 0) return false;
	budget.remaining--;
	return true;
}

async function fetchSitemap(
	url: string,
	depth: number,
	allowedOrigins: Set<string>,
	budget: SitemapBudget,
): Promise<SitemapEntry[]> {
	if (
		depth > 3 ||
		!isApprovedSitemapUrl(url, allowedOrigins) ||
		!consumeSitemapBudget(budget)
	)
		return [];

	const r = await tryFetch(url);
	if (!r?.text.includes("<")) return [];
	const entries = parseLocs(r.text);
	const isIndex =
		r.text.includes("<sitemapindex") ||
		(r.text.includes("<sitemap>") && !r.text.includes("<urlset"));

	if (isIndex) {
		// Cap fan-out width and run with bounded concurrency — an index
		// listing thousands of nested sitemaps must not spawn an
		// unbounded (and at depth 3, exponential) burst of fetches.
		const children = entries
			.map((e) => e.loc)
			.filter((child) => isApprovedSitemapUrl(child, allowedOrigins))
			.slice(0, MAX_CHILD_SITEMAPS);
		const nested = await runInBatches(children, SITEMAP_CONCURRENCY, (u) =>
			fetchSitemap(u, depth + 1, allowedOrigins, budget),
		);
		return nested.flat().slice(0, MAX_SITEMAP_URLS);
	}
	return entries.slice(0, MAX_SITEMAP_URLS);
}

async function sitemapFromRobots(
	origin: string,
	allowedOrigins: Set<string>,
	budget: SitemapBudget,
): Promise<SitemapEntry[]> {
	const robotsUrl = `${origin}/robots.txt`;
	if (
		!isApprovedSitemapUrl(robotsUrl, allowedOrigins) ||
		!consumeSitemapBudget(budget)
	)
		return [];
	const r = await tryFetch(robotsUrl);
	if (!r) return [];
	const urls = (r.text.match(/^Sitemap:\s*([^\n]{1,2000})$/gim) ?? []).map(
		(l: string) => l.replace(/^Sitemap:\s*/i, "").trim(),
	);
	if (!urls.length) return [];
	// robots.txt can list an arbitrary number of "Sitemap:" lines — bound
	// the same way as nested sitemap indexes.
	const sitemaps = urls
		.filter((sitemap) => isApprovedSitemapUrl(sitemap, allowedOrigins))
		.slice(0, MAX_CHILD_SITEMAPS);
	const results = await runInBatches(sitemaps, SITEMAP_CONCURRENCY, (u) =>
		fetchSitemap(u, 0, allowedOrigins, budget),
	);
	return results.flat().slice(0, MAX_SITEMAP_URLS);
}

// ─── Navigation link extraction ────────────────────────────────────

function extractNav(base: URL, html: string): string[] {
	const { document } = parseHTML(html);
	const urls = new Set<string>();
	for (const sel of NAV_SELECTORS) {
		for (const link of document.querySelectorAll(sel)) {
			const href = link.getAttribute("href");
			if (
				!href ||
				href.startsWith("#") ||
				href.startsWith("javascript:") ||
				href.startsWith("data:") ||
				href.startsWith("vbscript:") ||
				href.startsWith("mailto:")
			)
				continue;
			try {
				const r = new URL(href, base);
				r.hash = r.search = "";
				if (
					(r.protocol === "http:" || r.protocol === "https:") &&
					!IGNORED.test(r.pathname)
				)
					urls.add(r.href);
			} catch {
				/* ignore */
			}
		}
	}
	urls.add(base.href);
	return [...urls];
}

// ─── Crawl link extraction ─────────────────────────────────────────

export function extractLinks(
	html: string,
	base: URL,
	visited: Set<string>,
	scope: string,
): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/href=["'](.*?)["']/gi)) {
		try {
			const r = new URL(m[1]!, base);
			r.hash = r.search = "";
			if (
				(r.protocol === "http:" || r.protocol === "https:") &&
				r.hostname === base.hostname &&
				isInScopePath(r.pathname, scope) &&
				!IGNORED.test(r.pathname) &&
				!visited.has(r.href)
			)
				out.push(r.href);
		} catch {
			/* ignore */
		}
	}
	return [...new Set(out)];
}

// ─── Scope helper ──────────────────────────────────────────────────

export function getScopePath(pathname: string): string {
	if (pathname === "/") return "/";
	if (/\.\w+$/.test(pathname)) return pathname.replace(/\/[^/]*$/, "/");
	if (pathname.endsWith("/")) return pathname;
	const segs = pathname.split("/").filter(Boolean);
	return segs.length <= 1 ? pathname : `/${segs.slice(0, -1).join("/")}/`;
}

function isInScopePath(pathname: string, scope: string): boolean {
	if (scope === "/") return pathname.startsWith("/");
	const prefix = scope.endsWith("/") ? scope : `${scope}/`;
	return pathname === scope || pathname.startsWith(prefix);
}

// ─── Filtering / dedup ─────────────────────────────────────────────

export function filterAndDedupe(
	urls: string[],
	hosts: Set<string>,
	scope: string,
	max: number,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of urls) {
		try {
			const u = new URL(raw);
			if (
				(u.protocol !== "http:" && u.protocol !== "https:") ||
				!hosts.has(u.hostname) ||
				!isInScopePath(u.pathname, scope) ||
				IGNORED.test(u.pathname)
			)
				continue;
			u.hash = u.search = "";
			if (!seen.has(u.pathname)) {
				seen.add(u.pathname);
				out.push(u.href);
			}
		} catch {
			/* ignore */
		}
	}
	return out.slice(0, max);
}

/** Ensure a pull always includes the page the caller explicitly requested. */
export function includeDiscoverySeed(
	seedUrl: string,
	discoveredUrls: string[],
	hosts: Set<string>,
	scope: string,
	max: number,
): string[] {
	let seed: string | undefined;
	let seedPath: string | undefined;
	try {
		const parsed = new URL(seedUrl);
		parsed.hash = parsed.search = "";
		if (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			hosts.has(parsed.hostname)
		) {
			// The caller explicitly requested this URL, so do not apply IGNORED.
			seed = parsed.href;
			seedPath = parsed.pathname;
		}
	} catch {
		/* ignore malformed seeds */
	}

	const discovered = filterAndDedupe(discoveredUrls, hosts, scope, max).filter(
		(url) => {
			try {
				return !seedPath || new URL(url).pathname !== seedPath;
			} catch {
				return true;
			}
		},
	);
	return (seed ? [seed, ...discovered] : discovered).slice(0, max);
}

// ─── Crawl ─────────────────────────────────────────────────────────

async function crawl(
	base: URL,
	max: number,
	scope: string,
	opts?: FetchOpts,
): Promise<string[]> {
	const visited = new Set<string>();
	const queue = [base.href];
	const found: string[] = [];

	while (queue.length > 0 && found.length < max) {
		const batch = queue
			.splice(0, Math.min(20, max - found.length))
			.filter((u) => !visited.has(u));
		for (const u of batch) visited.add(u);

		const results = await Promise.all(
			batch.map(async (url) => {
				const r = await tryFetch(url, opts);
				if (!r?.text.includes("</html")) return [];
				found.push(r.url);
				return extractLinks(r.text, base, visited, scope);
			}),
		);

		for (const links of results) {
			for (const link of links) {
				if (!visited.has(link) && found.length + queue.length < max)
					queue.push(link);
			}
		}
	}
	return found;
}

// ─── Discover (main entry point) ───────────────────────────────────

export async function discover(
	baseUrl: string,
	max: number,
	opts?: FetchOpts,
): Promise<string[]> {
	let original: URL;
	try {
		original = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid base URL: ${baseUrl}`);
	}
	if (original.protocol !== "http:" && original.protocol !== "https:")
		throw new Error(`Unsupported discovery URL scheme: ${original.protocol}`);

	const r = await smartFetch(baseUrl, opts);
	if (!r || r.status >= 400)
		throw new Error(`HTTP ${r?.status ?? "unknown"}: ${baseUrl}`);

	// A malformed response URL must not crash discovery — fall back to the
	// validated base URL's own components.
	let actual: URL;
	try {
		const responseUrl = new URL(r.url);
		actual =
			responseUrl.protocol === "http:" || responseUrl.protocol === "https:"
				? responseUrl
				: original;
	} catch {
		actual = new URL(original.href);
	}
	const html = r.text;

	const hosts = new Set([original.hostname, actual.hostname]);
	const scope = getScopePath(actual.pathname);
	const includeSeed = (urls: string[]) =>
		includeDiscoverySeed(
			original.href,
			includeDiscoverySeed(actual.href, urls, hosts, scope, max),
			hosts,
			scope,
			max,
		);

	const origins = [...new Set([original.origin, actual.origin])];
	const allowedSitemapOrigins = new Set(origins);
	const sitemapBudget: SitemapBudget = { remaining: MAX_SITEMAP_FETCHES };
	const basePaths = [
		...new Set([actual.pathname.replace(/\/[^/]*$/, "/"), "/"]),
	];

	const strategies: Promise<SitemapEntry[]>[] = [];
	for (const o of origins) {
		strategies.push(sitemapFromRobots(o, allowedSitemapOrigins, sitemapBudget));
		for (const bp of basePaths) {
			for (const name of ["sitemap.xml", "sitemap_index.xml", "sitemap-0.xml"]) {
				strategies.push(
					fetchSitemap(`${o}${bp}${name}`, 0, allowedSitemapOrigins, sitemapBudget),
				);
			}
		}
	}

	const results = await Promise.all(strategies);

	let best: string[] = [];
	for (const entries of results) {
		if (!entries.length) continue;
		// Rank BEFORE filtering/capping: `filterAndDedupe` truncates to `max`, so
		// ordering after it would rank only the pages that already survived —
		// which is exactly how issue #132's budget landed on the 2014 archive.
		// Sitemap contents are untrusted data. Keep the allow-list restricted to
		// the requested and redirect destination hosts; never authorize a host
		// merely because it appeared in a sitemap.
		const filtered = filterAndDedupe(
			rankByRecency(entries).map((e) => e.loc),
			hosts,
			scope,
			max,
		);
		if (filtered.length > 0) {
			const candidate = includeSeed(filtered);
			if (candidate.length > best.length) best = candidate;
		}
	}

	if (best.length > 0) return best;

	const nav = extractNav(actual, html);
	if (nav.length > 5) {
		const filtered = filterAndDedupe(nav, hosts, scope, max);
		if (filtered.length > 0) return includeSeed(filtered);
	}

	return includeSeed(await crawl(actual, max, scope, opts));
}
