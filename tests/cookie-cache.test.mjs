// ─── Tests for the per-origin cookie cache (issue #71) ─────────────
//
// Covers:
//   - cookie-cache.ts: set/get, TTL expiry, LRU eviction (+ recency
//     bump on read), key isolation by origin/proxy/browser profile,
//     the Cookie-header helper, and clear-cookie signal detection.
//   - fetch.ts smartFetch integration: a headless render populates the
//     cache, and a *second*, independent smartFetch call to the same
//     origin (fresh wreq-js session, fresh browser pool) reuses the
//     cached cookies at the cheap tier instead of launching a browser.
//
// All network tiers are mocked (fake wreqSession.fetch + fake
// browserPool.acquirePage) — no live network, matching the pattern used
// by tests/reddit-block.test.mjs and tests/unit.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	clearCookieCache,
	cookieCacheKey,
	cookieCacheSize,
	cookiesToHeader,
	getCachedCookies,
	hasClearCookieSignal,
	invalidateCachedCookies,
	MAX_COOKIE_CACHE_ENTRIES,
	setCachedCookies,
} from "../src/cookie-cache.ts";

import { smartFetch } from "../src/fetch.ts";

// ─── cookieCacheKey ─────────────────────────────────────────────────

test("cookieCacheKey: builds a stable key from origin + proxy + profile", () => {
	const k1 = cookieCacheKey("https://example.com/a", "proxy1", "chrome_145");
	const k2 = cookieCacheKey("https://example.com/b", "proxy1", "chrome_145");
	assert.equal(k1, k2, "same origin+proxy+profile should collapse to one key");
});

test("cookieCacheKey: different proxy => different key (key isolation)", () => {
	const k1 = cookieCacheKey("https://example.com", "proxy1", "chrome_145");
	const k2 = cookieCacheKey("https://example.com", "proxy2", "chrome_145");
	assert.notEqual(k1, k2);
});

test("cookieCacheKey: different browser profile => different key (key isolation)", () => {
	const k1 = cookieCacheKey("https://example.com", "proxy1", "chrome_145");
	const k2 = cookieCacheKey("https://example.com", "proxy1", "firefox_147");
	assert.notEqual(k1, k2);
});

test("cookieCacheKey: different origin => different key", () => {
	const k1 = cookieCacheKey("https://a.example.com");
	const k2 = cookieCacheKey("https://b.example.com");
	assert.notEqual(k1, k2);
});

test("cookieCacheKey: returns null for unparseable URLs", () => {
	assert.equal(cookieCacheKey("not a url"), null);
});

// ─── set/get ────────────────────────────────────────────────────────

test("setCachedCookies/getCachedCookies: round-trips cookies for a key", () => {
	clearCookieCache();
	const key = cookieCacheKey("https://roundtrip.test");
	setCachedCookies(key, [{ name: "session", value: "abc123" }]);
	const cookies = getCachedCookies(key);
	assert.ok(cookies);
	assert.equal(cookies.length, 1);
	assert.equal(cookies[0].name, "session");
	assert.equal(cookies[0].value, "abc123");
});

test("getCachedCookies: returns null for a key never set", () => {
	clearCookieCache();
	assert.equal(getCachedCookies(cookieCacheKey("https://never-set.test")), null);
});

test("getCachedCookies: returns null for a null/undefined key", () => {
	assert.equal(getCachedCookies(null), null);
	assert.equal(getCachedCookies(undefined), null);
});

test("setCachedCookies: ignores empty cookie arrays (no-op)", () => {
	clearCookieCache();
	const key = cookieCacheKey("https://empty-cookies.test");
	setCachedCookies(key, []);
	assert.equal(getCachedCookies(key), null);
});

test("invalidateCachedCookies: removes an entry", () => {
	clearCookieCache();
	const key = cookieCacheKey("https://invalidate.test");
	setCachedCookies(key, [{ name: "a", value: "b" }]);
	assert.ok(getCachedCookies(key));
	invalidateCachedCookies(key);
	assert.equal(getCachedCookies(key), null);
});

// ─── key isolation (functional, not just string comparison) ────────

test("key isolation: cookies cached under one proxy are not visible under another", () => {
	clearCookieCache();
	const keyA = cookieCacheKey("https://iso.test", "proxyA", "chrome_145");
	const keyB = cookieCacheKey("https://iso.test", "proxyB", "chrome_145");
	setCachedCookies(keyA, [{ name: "s", value: "onlyA" }]);
	assert.equal(getCachedCookies(keyB), null);
	assert.equal(getCachedCookies(keyA)[0].value, "onlyA");
});

test("key isolation: cookies cached under one browser profile are not visible under another", () => {
	clearCookieCache();
	const keyChrome = cookieCacheKey("https://iso2.test", undefined, "chrome_145");
	const keyFirefox = cookieCacheKey("https://iso2.test", undefined, "firefox_147");
	setCachedCookies(keyChrome, [{ name: "s", value: "chromeOnly" }]);
	assert.equal(getCachedCookies(keyFirefox), null);
});

// ─── TTL expiry ─────────────────────────────────────────────────────

test("getCachedCookies: expires entries after the TTL", (t) => {
	clearCookieCache();
	t.mock.timers.enable({ apis: ["Date"] });
	const key = cookieCacheKey("https://ttl.test");
	setCachedCookies(key, [{ name: "s", value: "v" }]);
	assert.ok(getCachedCookies(key), "fresh entry should be readable");

	// Advance just past the 10-minute TTL.
	t.mock.timers.tick(10 * 60 * 1000 + 1);
	assert.equal(getCachedCookies(key), null, "entry should expire after TTL");
});

test("getCachedCookies: entry is still valid just before TTL", (t) => {
	clearCookieCache();
	t.mock.timers.enable({ apis: ["Date"] });
	const key = cookieCacheKey("https://ttl-almost.test");
	setCachedCookies(key, [{ name: "s", value: "v" }]);

	t.mock.timers.tick(10 * 60 * 1000 - 1000);
	assert.ok(getCachedCookies(key), "entry should still be valid just under TTL");
});

// ─── LRU eviction ───────────────────────────────────────────────────

test("LRU eviction: cache is bounded at MAX_COOKIE_CACHE_ENTRIES", () => {
	clearCookieCache();
	for (let i = 0; i < MAX_COOKIE_CACHE_ENTRIES + 10; i++) {
		setCachedCookies(cookieCacheKey(`https://lru-${i}.test`), [
			{ name: "s", value: String(i) },
		]);
	}
	assert.equal(cookieCacheSize(), MAX_COOKIE_CACHE_ENTRIES);
});

test("LRU eviction: oldest untouched entry is evicted first", () => {
	clearCookieCache();
	const firstKey = cookieCacheKey("https://lru-oldest.test");
	setCachedCookies(firstKey, [{ name: "s", value: "old" }]);
	for (let i = 0; i < MAX_COOKIE_CACHE_ENTRIES; i++) {
		setCachedCookies(cookieCacheKey(`https://lru-filler-${i}.test`), [
			{ name: "s", value: String(i) },
		]);
	}
	assert.equal(
		getCachedCookies(firstKey),
		null,
		"the never-touched oldest entry should have been evicted",
	);
});

test("LRU eviction: reading an entry bumps its recency and saves it from eviction", () => {
	clearCookieCache();
	const survivorKey = cookieCacheKey("https://lru-survivor.test");
	setCachedCookies(survivorKey, [{ name: "s", value: "keep-me" }]);

	// Fill most of the cache, periodically re-reading survivorKey so it
	// stays "recently used" and is never the oldest entry.
	for (let i = 0; i < MAX_COOKIE_CACHE_ENTRIES + 10; i++) {
		if (i % 5 === 0) getCachedCookies(survivorKey);
		setCachedCookies(cookieCacheKey(`https://lru-bump-${i}.test`), [
			{ name: "s", value: String(i) },
		]);
	}
	assert.ok(
		getCachedCookies(survivorKey),
		"repeatedly-read entry should survive eviction",
	);
});

// ─── Cookie header helper ───────────────────────────────────────────

test("cookiesToHeader: serializes cookies as a Cookie header value", () => {
	const header = cookiesToHeader([
		{ name: "a", value: "1" },
		{ name: "b", value: "2" },
	]);
	assert.equal(header, "a=1; b=2");
});

test("cookiesToHeader: empty array yields empty string", () => {
	assert.equal(cookiesToHeader([]), "");
});

// ─── Clear-cookie signal detection ──────────────────────────────────

test("hasClearCookieSignal: detects Max-Age=0", () => {
	assert.equal(hasClearCookieSignal("session=; Max-Age=0; Path=/"), true);
});

test("hasClearCookieSignal: detects an expired 1970 Expires date", () => {
	assert.equal(
		hasClearCookieSignal("session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
		true,
	);
});

test("hasClearCookieSignal: normal Set-Cookie header is not a clear signal", () => {
	assert.equal(
		hasClearCookieSignal("session=abc123; Max-Age=3600; Path=/"),
		false,
	);
});

test("hasClearCookieSignal: null/undefined header is not a clear signal", () => {
	assert.equal(hasClearCookieSignal(null), false);
	assert.equal(hasClearCookieSignal(undefined), false);
});

// ─── Integration: smartFetch reuses cached cookies across calls ────
//
// Simulates two *independent* aio-webfetch-style calls to the same
// bot-protected origin: each gets its own fresh wreq-js session and
// browser pool (as tools/webfetch.ts and tools/webpull.ts create per
// call), mirroring how nothing would otherwise persist between them.

/** Bot-block markers from src/bot-detection.ts's GENERIC_BOT_MARKERS. */
const BLOCK_HTML =
	"<html><body>checking your browser, please enable javascript and cookies to continue</body></html>";
const REAL_HTML = "<html><body>Welcome to the real page</body></html>";

function fakeHeaders(setCookie = null) {
	return { get: (name) => (name === "set-cookie" ? setCookie : null) };
}

/** A fresh fake wreq-js session: only serves REAL_HTML once "session" cookie is set. */
function makeFakeSession() {
	const cookies = new Map();
	return {
		setCookie(name, value) {
			cookies.set(name, value);
		},
		async fetch(url, init) {
			const cookieHeader = init?.headers?.Cookie ?? "";
			const authorized =
				cookies.get("session") === "abc123" || /session=abc123/.test(cookieHeader);
			return {
				ok: true,
				status: 200,
				url,
				headers: fakeHeaders(),
				body: null,
				text: async () => (authorized ? REAL_HTML : BLOCK_HTML),
			};
		},
	};
}

/** A fresh fake browser pool that records how many times a page was acquired. */
function makeFakeBrowserPool() {
	let acquireCount = 0;
	return {
		get acquireCount() {
			return acquireCount;
		},
		async acquirePage() {
			acquireCount++;
			const page = {
				async addInitScript() {},
				async goto() {},
				context: () => ({
					async cookies() {
						return [
							{ name: "session", value: "abc123", domain: "example.com", path: "/" },
						];
					},
				}),
				async content() {
					return REAL_HTML;
				},
			};
			return { page, browser: {}, release() {} };
		},
	};
}

test("smartFetch: second same-origin call reuses cached cookies instead of launching a browser", async () => {
	clearCookieCache();
	const origin = "https://example.com";

	// ── Call 1: no cached cookies yet — the plain/TLS-fingerprint tier
	// stays blocked, so smartFetch escalates all the way to the browser
	// pool, which "renders" the page and yields the session cookie.
	const session1 = makeFakeSession();
	const pool1 = makeFakeBrowserPool();
	const result1 = await smartFetch(`${origin}/page1`, {
		wreqSession: session1,
		browserPool: pool1,
		browser: "chrome_145",
	});

	assert.ok(result1, "first call should succeed via the browser tier");
	assert.equal(result1.text, REAL_HTML);
	assert.equal(pool1.acquireCount, 1, "first call must launch the browser once");

	const cacheKey = cookieCacheKey(origin, undefined, "chrome_145");
	const cached = getCachedCookies(cacheKey);
	assert.ok(cached && cached.length > 0, "browser render should populate the cookie cache");

	// ── Call 2: an independent session + pool (as a separate tool call
	// would create), same origin/proxy/profile. The warm cache should let
	// the cheap tier succeed directly — no browser launch at all.
	const session2 = makeFakeSession();
	const pool2 = makeFakeBrowserPool();
	const result2 = await smartFetch(`${origin}/page2`, {
		wreqSession: session2,
		browserPool: pool2,
		browser: "chrome_145",
	});

	assert.ok(result2, "second call should succeed via warmed cookies");
	assert.equal(result2.text, REAL_HTML);
	assert.equal(
		pool2.acquireCount,
		0,
		"second call must NOT launch a browser — cached cookies should carry it",
	);
});

test("smartFetch: cached cookies are not reused under a different browser profile", async () => {
	clearCookieCache();
	const origin = "https://example.com";

	const session1 = makeFakeSession();
	const pool1 = makeFakeBrowserPool();
	await smartFetch(`${origin}/page1`, {
		wreqSession: session1,
		browserPool: pool1,
		browser: "chrome_145",
	});
	assert.equal(pool1.acquireCount, 1);

	// Different browser profile => different cache key => no warm cookies,
	// so the second call must escalate to the browser again.
	const session2 = makeFakeSession();
	const pool2 = makeFakeBrowserPool();
	const result2 = await smartFetch(`${origin}/page2`, {
		wreqSession: session2,
		browserPool: pool2,
		browser: "firefox_147",
	});

	assert.ok(result2);
	assert.equal(
		pool2.acquireCount,
		1,
		"a different browser profile must not reuse the chrome-profile cookie cache entry",
	);
});
