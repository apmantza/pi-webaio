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
	const r = await smartFetch(url, opts);
	return r?.status && r.status < 400 ? { text: r.text, url: r.url } : null;
}

export function parseLocs(xml: string): string[] {
	return [...xml.matchAll(/<loc>([^<]*)<\/loc>/gi)].map((m) => m[1]!.trim());
}

// ─── Sitemap fetching (recursive, handles index sitemaps) ──────────

async function fetchSitemap(url: string, depth = 0): Promise<string[]> {
	if (depth > 3) return [];

	const r = await tryFetch(url);
	if (!r?.text.includes("<")) return [];
	const locs = parseLocs(r.text);
	const isIndex =
		r.text.includes("<sitemapindex") ||
		(r.text.includes("<sitemap>") && !r.text.includes("<urlset"));

	if (isIndex) {
		// Cap fan-out width and run with bounded concurrency — an index
		// listing thousands of nested sitemaps must not spawn an
		// unbounded (and at depth 3, exponential) burst of fetches.
		const children = locs.slice(0, MAX_CHILD_SITEMAPS);
		const nested = await runInBatches(children, SITEMAP_CONCURRENCY, (u) =>
			fetchSitemap(u, depth + 1),
		);
		return nested.flat().slice(0, MAX_SITEMAP_URLS);
	}
	return locs.slice(0, MAX_SITEMAP_URLS);
}

async function sitemapFromRobots(origin: string): Promise<string[]> {
	const r = await tryFetch(`${origin}/robots.txt`);
	if (!r) return [];
	const urls = (r.text.match(/^Sitemap:\s*([^\n]{1,2000})$/gim) ?? []).map(
		(l: string) => l.replace(/^Sitemap:\s*/i, "").trim(),
	);
	if (!urls.length) return [];
	// robots.txt can list an arbitrary number of "Sitemap:" lines — bound
	// the same way as nested sitemap indexes.
	const sitemaps = urls.slice(0, MAX_CHILD_SITEMAPS);
	const results = await runInBatches(sitemaps, SITEMAP_CONCURRENCY, (u) =>
		fetchSitemap(u),
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
				if (!IGNORED.test(r.pathname)) urls.add(r.href);
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
				r.hostname === base.hostname &&
				r.pathname.startsWith(scope) &&
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
				!hosts.has(u.hostname) ||
				!u.pathname.startsWith(scope) ||
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
	const r = await smartFetch(baseUrl, opts);
	if (!r || r.status >= 400)
		throw new Error(`HTTP ${r?.status ?? "unknown"}: ${baseUrl}`);

	// new URL throws on malformed input; a malformed response URL must not
	// crash discovery — fall back to the base URL's own components.
	let actual: URL;
	let original: URL;
	try {
		actual = new URL(r.url);
	} catch {
		actual = new URL(baseUrl);
	}
	try {
		original = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid base URL: ${baseUrl}`);
	}
	const html = r.text;

	const hosts = new Set([original.hostname, actual.hostname]);
	const scope = getScopePath(actual.pathname);

	const origins = [...new Set([original.origin, actual.origin])];
	const basePaths = [
		...new Set([actual.pathname.replace(/\/[^/]*$/, "/"), "/"]),
	];

	const strategies: Promise<string[]>[] = [];
	for (const o of origins) {
		strategies.push(sitemapFromRobots(o));
		for (const bp of basePaths) {
			for (const name of ["sitemap.xml", "sitemap_index.xml", "sitemap-0.xml"]) {
				strategies.push(fetchSitemap(`${o}${bp}${name}`));
			}
		}
	}

	const results = await Promise.all(strategies);

	let best: string[] = [];
	for (const urls of results) {
		if (!urls.length) continue;
		for (const u of urls) {
			try {
				hosts.add(new URL(u).hostname);
			} catch {
				/* ignore */
			}
		}
		const filtered = filterAndDedupe(urls, hosts, scope, max);
		if (filtered.length > best.length) best = filtered;
	}

	if (best.length > 0) return best;

	const nav = extractNav(actual, html);
	if (nav.length > 5) {
		const filtered = filterAndDedupe(nav, hosts, scope, max);
		if (filtered.length > 0) return filtered;
	}

	return crawl(actual, max, scope, opts);
}
