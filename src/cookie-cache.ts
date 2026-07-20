// ─── Per-origin cookie cache ───────────────────────────────────────
// Bridges cookies harvested from a headless Playwright render across
// *separate* fetch calls (aio-webfetch / aio-webpull / aio-webresearch),
// which each build their own short-lived wreq-js session. Without this,
// every call that hits a bot-protected origin re-triggers a full
// Playwright launch even though a previous call already proved a
// headless render works there.
//
// Keyed by origin + proxy + browser profile so cached cookies are never
// replayed under the wrong network/browser identity (a cookie captured
// via one proxy or fingerprint profile is not safe to inject under a
// different one). Bounded (LRU) + short TTL (~10 min, matching the
// search-result cache in session-store.ts) so this never grows without
// bound and never serves stale, likely-expired session cookies.
//
// This module only stores/retrieves cookie data — it does not perform
// any network I/O or own a parallel cookie mechanism. Callers still
// inject cookies via the existing `wreqSession.setCookie()` API (see
// `injectCookiesFromPlaywright` in fetch.ts) or, when no session is
// available, via a `Cookie` header — the same two mechanisms fetch.ts
// already used, just now bridged across calls.

// ─── Types ──────────────────────────────────────────────────────────

export interface CachedCookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
}

interface CacheEntry {
	cookies: CachedCookie[];
	timestamp: number;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Cookies are only trusted for this long after a headless render. */
export const COOKIE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** LRU cap — bounds memory in long-lived processes doing many crawls. */
export const MAX_COOKIE_CACHE_ENTRIES = 50;

// ─── Store ──────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

/**
 * Build the cache key for an origin under a given proxy + browser profile.
 * Returns null if `url` fails to parse (callers should treat that as
 * "no cache available" rather than throwing).
 */
export function cookieCacheKey(
	url: string,
	proxy?: string | null,
	browserProfile?: string | null,
): string | null {
	try {
		const origin = new URL(url).origin;
		return `${origin}|${proxy ?? ""}|${browserProfile ?? ""}`;
	} catch {
		return null;
	}
}

/** Bump `key` to most-recently-used position (re-inserting moves it to the end). */
function touch(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
}

export function getCachedCookies(key: string | null | undefined): CachedCookie[] | null {
	if (!key) return null;
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > COOKIE_CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	// Refresh recency on read so actively-reused origins survive eviction
	// longer than one-off origins that were only ever rendered once.
	touch(key, entry);
	return entry.cookies;
}

export function setCachedCookies(
	key: string | null | undefined,
	cookies: CachedCookie[],
): void {
	if (!key || !cookies.length) return;
	if (!cache.has(key)) {
		while (cache.size >= MAX_COOKIE_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}
	touch(key, { cookies, timestamp: Date.now() });
}

export function invalidateCachedCookies(key: string | null | undefined): void {
	if (!key) return;
	cache.delete(key);
}

/** Test/diagnostic helpers. */
export function cookieCacheSize(): number {
	return cache.size;
}

export function clearCookieCache(): void {
	cache.clear();
}

// ─── Header helper ──────────────────────────────────────────────────

/** Serialize cached cookies into a `Cookie:` header value. */
export function cookiesToHeader(cookies: CachedCookie[]): string {
	return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ─── Clear-cookie signal detection ─────────────────────────────────

/**
 * Detects a server telling the client to drop its cookies (logout,
 * session rotation, anti-bot re-challenge) via a `Set-Cookie` header
 * that expires/clears a cookie (`Max-Age=0` or an already-past
 * `Expires`). Used to invalidate the per-origin cache proactively
 * instead of waiting out the TTL and replaying a now-dead cookie.
 */
export function hasClearCookieSignal(setCookieHeader: string | null | undefined): boolean {
	if (!setCookieHeader) return false;
	const sample = setCookieHeader.toLowerCase();
	if (/max-age=0\b/.test(sample)) return true;
	// Expires=Thu, 01 Jan 1970 ...  (any 1970 date is a clear signal in practice)
	if (/expires=[^;]*1970/.test(sample)) return true;
	return false;
}
