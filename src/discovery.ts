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
export const MAX_SITEMAP_URLS = 5000;
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
	// One ascending pass over every <loc>, with a cursor over the already-ordered
	// <url>/<sitemap> spans. That single shape buys three properties at once:
	//
	//  * document order is preserved across bare and wrapped locations (the
	//    additive "wrapped first, then bare" merge put a leading bare <loc> last,
	//    which is wrong whenever the majority gate preserves input order);
	//  * lookup is linear, where `wrapped.some(...)` per location was O(bare x
	//    wrapped) — measured 237ms / 758ms / 3263ms at 20k / 40k / 80k entries;
	//  * every <loc> in a block is emitted, not just the first.
	//
	// Pairing stays inside the block: zipping a global loc list against a global
	// lastmod list would hand an undated entry its neighbour's date and silently
	// invent recency.
	type Span = { start: number; end: number; lastmod?: string };
	const spans: Span[] = [];
	for (const item of xml.matchAll(/<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi)) {
		const start = item.index;
		spans.push({
			start,
			end: start + item[0].length,
			lastmod: /<lastmod>([^<]*)<\/lastmod>/i.exec(item[1] ?? "")?.[1]?.trim(),
		});
	}

	const out: SitemapEntry[] = [];
	let cursor = 0;
	for (const locMatch of xml.matchAll(/<loc>([^<]*)<\/loc>/gi)) {
		const loc = locMatch[1]?.trim();
		if (!loc) continue;
		const pos = locMatch.index;
		// Spans are ascending and matchAll scans ascending, so the cursor only
		// ever moves forward.
		while (cursor < spans.length && pos >= spans[cursor]!.end) cursor++;
		const span = cursor < spans.length && pos >= spans[cursor]!.start ? spans[cursor] : undefined;
		// A loc with no enclosing block has nothing to pair it with, so it is
		// emitted undated and ranks after dated entries instead of guessing.
		out.push(span?.lastmod ? { loc, lastmod: span.lastmod } : { loc });
	}
	return out;
}

/**
 * Rank, THEN truncate. Order matters and is the whole point of this helper.
 *
 * `MAX_SITEMAP_URLS` predates issue #132, but ranking only the entries that
 * survive it reintroduces the original bug one level up: a sitemap larger than
 * the cap loses its newest pages before `rankByRecency` ever sees them. Every
 * sitemap path (direct, nested index, robots.txt) must go through here.
 */
export function capRanked(entries: SitemapEntry[]): SitemapEntry[] {
	return rankByRecency(entries).slice(0, MAX_SITEMAP_URLS);
}

/**
 * Newest usable timestamp among a strategy's entries, or undefined.
 *
 * `discover` runs several discovery strategies and keeps the best candidate. The
 * old rule was "longest wins, first on a tie", which is arbitrary once ordering
 * carries meaning: an earlier strategy serving `max` old pages beat a later one
 * serving `max` newer pages purely on arrival order. Ties are now broken by
 * recency.
 */
export function newestRecency(entries: SitemapEntry[]): number | undefined {
	let newest: number | undefined;
	for (const entry of entries) {
		const t = recencyTime(entry);
		if (t !== undefined && (newest === undefined || t > newest)) newest = t;
	}
	return newest;
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
		return capRanked(nested.flat());
	}
	return capRanked(entries);
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
	return capRanked(results.flat());
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

/**
 * The one eligibility rule: is this URL pullable, and under what dedupe key?
 *
 * Returns the normalized pathname (hash and query stripped) when the URL passes
 * host / scope / IGNORED / scheme, otherwise undefined. `filterAndDedupe` and
 * `selectRankedEntries` BOTH consult this, because matching a filtered result
 * back to a source entry by pathname alone is not enough: if a disallowed entry
 * shares a pathname with an eligible one, pathname matching selects whichever
 * came first, and a foreign-host URL can be emitted as a result while the
 * in-scope page is suppressed.
 */
function eligibleUrl(
	raw: string,
	hosts: Set<string>,
	scope: string,
): { pathname: string; href: string } | undefined {
	try {
		const u = new URL(raw);
		if (
			(u.protocol !== "http:" && u.protocol !== "https:") ||
			!hosts.has(u.hostname) ||
			!isInScopePath(u.pathname, scope) ||
			IGNORED.test(u.pathname)
		)
			return undefined;
		// Normalized the same way as before: hash and query stripped.
		u.hash = u.search = "";
		return { pathname: u.pathname, href: u.href };
	} catch {
		return undefined;
	}
}

export function filterAndDedupe(
	urls: string[],
	hosts: Set<string>,
	scope: string,
	max: number,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of urls) {
		const hit = eligibleUrl(raw, hosts, scope);
		if (hit === undefined || seen.has(hit.pathname)) continue;
		seen.add(hit.pathname);
		out.push(hit.href);
	}
	return out.slice(0, max);
}

/**
 * Eligibility FIRST, then recency, then the budget.
 *
 * `filterAndDedupe` and `rankByRecency` each make sense alone, but the ORDER of
 * the two decides whether recency works at all. Ranking the raw sitemap made
 * `rankByRecency`'s majority gate count entries that can never be pulled —
 * out-of-scope hosts and ignored paths — so a sitemap with a few hundred
 * undated foreign entries refused to reorder a scoped set that was entirely
 * dated, and `newestRecency` let an excluded page win a strategy tie.
 *
 * So: filter to what is actually eligible, rank THAT (which is what the majority
 * gate should be judging), and only then spend the `max` budget.
 *
 * Entries are matched back to the filtered result by the same key
 * `filterAndDedupe` uses — pathname after stripping hash and query — keeping the
 * first variant, so dedupe behaviour is unchanged.
 */
export function selectRankedEntries(
	entries: SitemapEntry[],
	hosts: Set<string>,
	scope: string,
	max: number,
): SitemapEntry[] {
	// Eligibility is evaluated on the SOURCE entry with the same rule
	// `filterAndDedupe` uses, rather than matching a filtered result back by
	// pathname afterwards — so a disallowed entry that shares a pathname with an
	// eligible one cannot take its place.
	const kept: SitemapEntry[] = [];
	const emitted = new Set<string>();
	for (const entry of entries) {
		const hit = eligibleUrl(entry.loc, hosts, scope);
		if (hit === undefined || emitted.has(hit.pathname)) continue;
		emitted.add(hit.pathname);
		kept.push(entry);
	}
	return rankByRecency(kept).slice(0, max);
}

/**
 * Recency of the pages that ACTUALLY survive to the candidate.
 *
 * `includeSeed` may insert the caller's requested page and evict the last picked
 * one. Scoring the pre-seed pick therefore let a strategy win a tie on a page it
 * was never going to serve — and when the majority gate preserves document
 * order, the evicted page is exactly the kind that carried the newest date.
 */
export function newestRecencyForUrls(
	urls: string[],
	entries: SitemapEntry[],
): number | undefined {
	const want = new Set<string>();
	for (const url of urls) {
		try {
			const u = new URL(url);
			u.hash = u.search = "";
			want.add(u.href);
		} catch {
			/* not a candidate we produced */
		}
	}
	const surviving: SitemapEntry[] = [];
	// Keep the FIRST entry per normalized URL, which is the variant
	// `selectRankedEntries` actually keeps: it dedupes by pathname BEFORE ranking,
	// so a newer twin later in the document is discarded and must not set the score.
	const counted = new Set<string>();
	for (const entry of entries) {
		try {
			const u = new URL(entry.loc);
			u.hash = u.search = "";
			const href = u.href;
			if (!want.has(href) || counted.has(href)) continue;
			counted.add(href);
			surviving.push(entry);
		} catch {
			/* ignore */
		}
	}
	return newestRecency(surviving);
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
	let bestNewest: number | undefined;
	for (const entries of results) {
		if (!entries.length) continue;
		// Eligibility, then recency, then budget — see `selectRankedEntries`. The
		// earlier shape ranked the raw sitemap, so the majority gate judged
		// entries that could never be pulled.
		// Sitemap contents are untrusted data. Keep the allow-list restricted to
		// the requested and redirect destination hosts; never authorize a host
		// merely because it appeared in a sitemap.
		const picked = selectRankedEntries(entries, hosts, scope, max);
		if (picked.length === 0) continue;
		const filtered = picked.map((e) => e.loc);
		const candidate = includeSeed(filtered);
		// Length still decides. What changed is the TIE: "keep the first" was
		// arbitrary once ordering carried meaning, so an earlier strategy serving
		// `max` stale pages used to beat a later one serving `max` fresh ones.
		// Ties now go to the strategy with the newest usable date AMONG THE
		// SELECTED entries — a page that was filtered out is not evidence that
		// this strategy is fresh. A strategy with no dates at all keeps the
		// previous candidate, because no date is not evidence of staleness.
		const newest = newestRecencyForUrls(candidate, entries);
		const longer = candidate.length > best.length;
		const newerOnTie =
			candidate.length === best.length &&
			newest !== undefined &&
			(bestNewest === undefined || newest > bestNewest);
		if (longer || newerOnTie) {
			best = candidate;
			bestNewest = newest;
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
