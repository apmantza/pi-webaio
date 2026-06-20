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

// ─── Caches ────────────────────────────────────────────────────────

export const sessionStore = new Map<string, StoredContent>();

export const searchCache = new Map<
	string,
	{ query: string; results: SearchResult[]; timestamp: number }
>();

export const summaryCache = new Map<string, string>(); // url -> AI summary, session-scoped

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

export function cleanupSessionCache(): void {
	pruneExpiredSessionEntries();
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

// ─── Search result caching (memory + disk) ─────────────────────────

export function storeSearchResults(query: string, results: SearchResult[]) {
	const entry = { query, results, timestamp: Date.now() };
	searchCache.set(query, entry);
	saveSearchCacheToDisk().catch(() => {});
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
