// ─── Session store ─────────────────────────────────────────────────
// Extracted from index.ts. In-memory caches for fetched content, search
// results, and AI summaries, with background persistence to disk.

import {
	mkdir,
	open,
	readFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";

import { readFileSync } from "node:fs";

import { join } from "node:path";
import { tmpdir } from "node:os";
import { scoreRelevance } from "./bm25.ts";
import type { StoredContent, SearchResult } from "./types.ts";

// ─── Constants ─────────────────────────────────────────────────────

export const BASE_TEMP = join(tmpdir(), "pi-webaio");
export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const SEARCH_CACHE_FILE = join(BASE_TEMP, "search-cache.json");
export const SEARCH_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const SEARCH_CONTEXT_KEY = "__webaio_search_context__";

export const SESSION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_SESSION_CACHE_ENTRIES = 100;
export const SESSION_CACHE_CLEANUP_MS = 5 * 60 * 1000; // 5 minutes

export const MAX_SUMMARY_CACHE_ENTRIES = 100;
export const MAX_SEARCH_CACHE_ENTRIES = 100;

// ─── Caches ────────────────────────────────────────────────────────

export const sessionStore = new Map<string, StoredContent>();

export const searchCache = new Map<
	string,
	{ query: string; results: SearchResult[]; timestamp: number }
>();

// Bounded Map: same get/set/has/delete/size surface as a plain Map, but
// evicts the oldest entry (insertion order) once the cap is reached, so a
// long-lived process can't grow this without limit. Mirrors the eviction
// pattern used for `sessionStore` above (see storeContent).
class BoundedMap<K, V> extends Map<K, V> {
	private readonly maxEntries: number;

	constructor(maxEntries: number) {
		super();
		this.maxEntries = maxEntries;
	}

	override set(key: K, value: V): this {
		// Re-inserting an existing key just refreshes its value in place;
		// only new keys count against the cap.
		if (!this.has(key)) {
			while (this.size >= this.maxEntries) {
				const oldest = this.keys().next().value;
				if (oldest === undefined) break;
				this.delete(oldest);
			}
		}
		return super.set(key, value);
	}
}

export const summaryCache: Map<string, string> = new BoundedMap<
	string,
	string
>(MAX_SUMMARY_CACHE_ENTRIES); // url -> AI summary, session-scoped

// ─── Cache key normalization ───────────────────────────────────────

export function normalizeCacheKey(url: string): string {
	if (url.startsWith("http://")) {
		url = url.replace(/^http:/i, "https:");
	}
	try {
		const u = new URL(url);
		if (u.pathname === "/" && url.endsWith("/")) {
			return url.slice(0, -1);
		}
	} catch {
		/* ignore */
	}
	return url;
}

// ─── Content store / retrieve ──────────────────────────────────────

/**
 * Peek at a session-store entry by URL without applying TTL eviction.
 * Returns the raw entry (which may be expired) or null if absent.
 * Used by revalidation and diff logic to inspect stale entries.
 */
export function peekStoredContent(url: string): StoredContent | null {
	const key = normalizeCacheKey(url);
	return sessionStore.get(key) ?? null;
}

export function getStoredContent(url: string): StoredContent | null {
	const key = normalizeCacheKey(url);
	const entry = sessionStore.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > SESSION_CACHE_TTL_MS) {
		sessionStore.delete(key);
		return null;
	}
	// Lazy-load content from disk if entry has a filePath but no content loaded yet.
	if (!entry.content && entry.filePath) {
		try {
			const raw = readFileSync(entry.filePath, "utf8");
			entry.content = stripFrontmatter(raw);
		} catch {
			sessionStore.delete(key);
			return null;
		}
	}
	return entry;
}

export function storeContent(
	url: string,
	title: string | undefined,
	content: string,
	filePath?: string,
	metadata?: {
		author?: string;
		published?: string;
		site?: string;
		language?: string;
		wordCount?: number;
	},
) {
	const key = normalizeCacheKey(url);
	pruneExpiredSessionEntries();
	// Enforce max size with simple LRU (delete oldest)
	while (sessionStore.size >= MAX_SESSION_CACHE_ENTRIES) {
		const first = sessionStore.keys().next().value;
		if (first !== undefined) sessionStore.delete(first);
	}
	sessionStore.set(key, {
		url,
		title,
		content,
		filePath,
		timestamp: Date.now(),
		...(metadata
			? {
					author: metadata.author,
					published: metadata.published,
					site: metadata.site,
					language: metadata.language,
					wordCount: metadata.wordCount,
				}
			: {}),
	});
}

// ─── Frontmatter helpers ───────────────────────────────────────────

export function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---\n")) return raw;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return raw;
	return raw.slice(end + 5).trimStart();
}

export function parseFrontmatterUrl(raw: string): string | null {
	if (!raw.startsWith("---\n")) return null;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return null;
	const fm = raw.slice(4, end);
	const m = fm.match(/^url: "([^"]+)"$/m);
	return m ? m[1] : null;
}

// ─── Session cache cleanup ─────────────────────────────────────────

function pruneExpiredSessionEntries(now = Date.now()): void {
	for (const [url, entry] of sessionStore) {
		if (now - entry.timestamp > SESSION_CACHE_TTL_MS) {
			sessionStore.delete(url);
		}
	}
}

function pruneExpiredSearchEntries(now = Date.now()): void {
	for (const [query, entry] of searchCache) {
		if (now - entry.timestamp > SEARCH_CACHE_TTL_MS) {
			searchCache.delete(query);
		}
	}
}

// Extends cleanup to every in-memory cache in this module so that if this
// is ever wired up (e.g. behind SESSION_CACHE_CLEANUP_MS), it does the
// full job. `summaryCache` self-bounds via BoundedMap so there's nothing
// to expire there beyond its size cap; sweeping is a no-op unless entries
// exceed the cap, which `.set` already prevents.
export function cleanupSessionCache(): void {
	pruneExpiredSessionEntries();
	pruneExpiredSearchEntries();
}

// ─── Disk persistence (content cache) ──────────────────────────────

async function readFrontmatterHead(path: string): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "r");
		const buf = Buffer.alloc(512);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		return buf.toString("utf8", 0, bytesRead);
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export function loadContentCacheFromDisk(): void {
	const root = BASE_TEMP;

	async function scan(dir: string): Promise<number> {
		let items: string[];
		try {
			items = await readdir(dir, { encoding: "utf8" });
		} catch {
			return 0;
		}

		let entries = 0;
		for (const name of items) {
			const full = join(dir, name);
			let st: Awaited<ReturnType<typeof stat>>;
			try {
				st = await stat(full);
			} catch {
				continue;
			}

			if (st.isDirectory()) {
				entries += await scan(full);
			} else if (st.isFile() && name.endsWith(".md")) {
				const head = await readFrontmatterHead(full);
				if (!head) continue;
				const fmUrl = parseFrontmatterUrl(head);
				if (!fmUrl) continue;

				const key = normalizeCacheKey(fmUrl);
				if (!sessionStore.has(key)) {
					sessionStore.set(key, {
						url: fmUrl,
						content: "",
						filePath: full,
						timestamp: Date.now(),
					});
					entries++;
				}
			}
		}
		return entries;
	}

	setImmediate(() => {
		scan(root).catch(() => {});
	});
}

// ─── Search context (bridging) ─────────────────────────────────────

export function getSearchContext(): { query: string } | null {
	const entry = sessionStore.get(SEARCH_CONTEXT_KEY);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > SEARCH_CONTEXT_TTL_MS) {
		sessionStore.delete(SEARCH_CONTEXT_KEY);
		return null;
	}
	try {
		return JSON.parse(entry.content);
	} catch {
		return null;
	}
}

export function setSearchContext(query: string): void {
	sessionStore.delete(SEARCH_CONTEXT_KEY);
	sessionStore.set(SEARCH_CONTEXT_KEY, {
		url: SEARCH_CONTEXT_KEY,
		title: "search context",
		content: JSON.stringify({ query }),
		timestamp: Date.now(),
	});
}

// ─── Search-context relatedness gate ───────────────────────────────
//
// The prior search query is only injected into a page's AI summary when
// it is actually related to that page. Relatedness is scored with the
// same BM25 machinery used for query-aware pruning (src/bm25.ts), run
// over a tiny "document" built from the page's URL + title + first
// heading.
//
// With a single-document corpus one overlapping query term scores ~0.29
// and a strong match (repeated term, or several overlapping terms) scores
// ~0.4-1.0+. A threshold of 0.35 sits between those: a lone weak/ambiguous
// term overlap is skipped, while a genuine topical match injects. This is
// deliberately conservative: a false skip only loses a "focused" summary,
// whereas a false injection biases the summary toward an unrelated topic
// (the bug this gate fixes).
export const SEARCH_CONTEXT_RELATEDNESS_THRESHOLD = 0.35;

/**
 * Decide whether the prior search `query` is related enough to `page`
 * that it should be injected into the page's AI summary prompt.
 *
 * Pure and side-effect free (unit-testable). Returns false for an empty
 * query, a page with no signal to match against, or a BM25 overlap score
 * below `threshold`.
 */
export function shouldInjectSearchContext(
	query: string,
	page: { url?: string; title?: string; heading?: string },
	threshold: number = SEARCH_CONTEXT_RELATEDNESS_THRESHOLD,
): boolean {
	if (!query || !query.trim()) return false;
	const doc = [page.url ?? "", page.title ?? "", page.heading ?? ""]
		.join(" ")
		.trim();
	if (!doc) return false;
	return scoreRelevance(doc, query) >= threshold;
}

/**
 * Annotation appended to a summary that was focused on a prior search
 * query, so a downstream agent knows the summary is not neutral. Returns
 * the empty string for an empty query (callers append unconditionally).
 */
export function focusedSummaryAnnotation(query: string): string {
	const q = query?.trim();
	if (!q) return "";
	return `\n\n_[focused on prior search: "${q}"]_`;
}

// ─── Summary cache keying ────────────────────────────────────────────
//
// A summary produced WITH a search context is focused/biased toward that
// context, so it must never be served for a context-free request (or for
// a different context). Key the summary cache by URL + normalized context
// so each context gets its own slot. The no-context case maps to the bare
// normalized URL, which can never collide with a context key because
// context keys always carry the `\u0000ctx:` separator (a null byte never
// appears in a real URL).
export function summaryCacheKey(url: string, context?: string): string {
	const base = normalizeCacheKey(url);
	if (!context || !context.trim()) return base;
	const norm = context.trim().toLowerCase().replace(/\s+/g, " ");
	return `${base}\u0000ctx:${norm}`;
}

// ─── Search result caching (memory + disk) ─────────────────────────

const SEARCH_CACHE_WRITE_DEBOUNCE_MS = 500;
let searchCacheWriteTimer: NodeJS.Timeout | null = null;

// Coalesces bursts of storeSearchResults() calls (e.g. several searches in
// quick succession) into a single disk write instead of rewriting the
// whole cache file per store. Timer is unref'd so it never keeps the
// process alive on its own.
function scheduleSearchCacheWrite(): void {
	if (searchCacheWriteTimer) return;
	searchCacheWriteTimer = setTimeout(() => {
		searchCacheWriteTimer = null;
		saveSearchCacheToDisk().catch(() => {});
	}, SEARCH_CACHE_WRITE_DEBOUNCE_MS);
	searchCacheWriteTimer.unref?.();
}

export function storeSearchResults(query: string, results: SearchResult[]) {
	const entry = { query, results, timestamp: Date.now() };
	pruneExpiredSearchEntries();
	// Enforce max size with simple oldest-first eviction (insertion order),
	// mirroring the sessionStore cap in storeContent above.
	if (!searchCache.has(query)) {
		while (searchCache.size >= MAX_SEARCH_CACHE_ENTRIES) {
			const oldest = searchCache.keys().next().value;
			if (oldest === undefined) break;
			searchCache.delete(oldest);
		}
	}
	searchCache.set(query, entry);
	scheduleSearchCacheWrite();
}

export function getCachedSearch(query: string): SearchResult[] | null {
	const cached = searchCache.get(query);
	if (!cached) return null;
	if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
		searchCache.delete(query);
		return null;
	}
	return cached.results;
}

export async function saveSearchCacheToDisk(): Promise<void> {
	try {
		const data = Object.fromEntries(searchCache.entries());
		await mkdir(BASE_TEMP, { recursive: true });
		await writeFile(SEARCH_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
	} catch {
		// ignore
	}
}

export async function loadSearchCacheFromDisk(): Promise<void> {
	try {
		const text = await readFile(SEARCH_CACHE_FILE, "utf8");
		const data = JSON.parse(text);
		const now = Date.now();
		for (const [query, entry] of Object.entries(data)) {
			const e = entry as {
				query: string;
				results: SearchResult[];
				timestamp: number;
			};
			if (now - e.timestamp < SEARCH_CACHE_TTL_MS) {
				searchCache.set(query, e);
			}
		}
	} catch {
		// ignore
	}
}
