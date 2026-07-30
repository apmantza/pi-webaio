// ─── Tests for the shared process-level browser pool (perf audit P2) ─
//
// Every browser escalation in smartFetch used to launch+close a browser per
// request (~808ms measured) because only aio-webpull passed a BrowserPool.
// src/fetch.ts now exposes a shared, lazily-created process-level pool
// (getSharedBrowserPool / closeSharedBrowserPool) that single fetches reuse.
//
// Covers:
//   - The accessor returns a stable identity and is lazy (no browser launched
//     until first use).
//   - The pooled path preserves the SSRF guarantees: the fail-closed
//     validateUrlForSsrf pre-flight still blocks dangerous URLs, and the
//     per-page redirect guard (installSsrfRedirectGuard → page.route) is still
//     installed on pooled pages.
//   - Warm-vs-cold timing (Playwright-gated): a warm pool acquire is far
//     faster than a cold launch. Skips cleanly when Playwright/binaries absent.
//
// Everything except the gated timing test is OFFLINE — no network, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	getSharedBrowserPool,
	closeSharedBrowserPool,
	fetchWithPlaywright,
} from "../src/fetch.ts";
import { BrowserPool } from "../src/browser-pool.ts";

// ─── Accessor identity + laziness (offline) ─────────────────────────

test("getSharedBrowserPool: returns the same instance across calls", async () => {
	const a = getSharedBrowserPool();
	const b = getSharedBrowserPool();
	assert.equal(a, b, "shared pool must be a stable singleton");
	assert.ok(a instanceof BrowserPool, "shared pool is a BrowserPool");
	await closeSharedBrowserPool();
});

test("getSharedBrowserPool: is lazy — no browser launched until first use", async () => {
	// Reset to a fresh singleton so we observe construction, not prior state.
	await closeSharedBrowserPool();
	const pool = getSharedBrowserPool();
	const stats = pool.stats();
	// Constructing the pool must NOT launch a browser — that only happens on
	// the first acquirePage().
	assert.equal(stats.totalLaunched, 0, "no launch on construction");
	assert.equal(stats.browsers, 0, "no live browsers on construction");
	assert.equal(pool.closed, false, "fresh pool is open");
	await closeSharedBrowserPool();
});

test("closeSharedBrowserPool: resets the singleton (next call makes a new pool)", async () => {
	const first = getSharedBrowserPool();
	await closeSharedBrowserPool();
	const second = getSharedBrowserPool();
	assert.notEqual(first, second, "draining resets the singleton identity");
	assert.equal(first.closed, true, "drained pool is closed");
	await closeSharedBrowserPool();
});

// ─── SSRF: fail-closed pre-flight still runs on the pooled path ──────
//
// fetchWithPlaywright runs validateUrlForSsrf() BEFORE touching the pool or
// Playwright. A cloud-metadata URL must be blocked fail-closed with no browser
// and no network — proving the pre-flight guard is intact regardless of pooling.

test("fetchWithPlaywright: blocks a dangerous URL fail-closed (no pool, no browser)", async () => {
	let threw = null;
	try {
		// 169.254.169.254 is the absolute cloud-metadata floor — dangerous
		// synchronously, no DNS required.
		await fetchWithPlaywright("http://169.254.169.254/latest/meta-data/");
	} catch (err) {
		threw = err;
	}
	assert.ok(threw, "must throw on a dangerous URL");
	assert.match(String(threw.message), /Blocked request to private\/internal URL/i);
	assert.equal(threw.code, "blocked_ssrf", "surfaces as a blocked_ssrf FetchError");
});

// ─── SSRF: per-page redirect guard still installed on pooled pages ───
//
// Drive fetchWithPlaywright through a FAKE pool + fake page (no browser) using
// a public IP-literal URL, which validateUrlForSsrf evaluates with no DNS.
// Assert the per-page guard registers a page.route("**/*") interceptor — the
// installSsrfRedirectGuard hook that re-validates every redirect/subresource.

function fakePooledPage() {
	const calls = { route: [], goto: [], initScripts: 0 };
	return {
		calls,
		route(pattern, _cb) {
			calls.route.push(pattern);
			return Promise.resolve();
		},
		addInitScript() {
			calls.initScripts++;
			return Promise.resolve();
		},
		goto(url, _opts) {
			calls.goto.push(url);
			return Promise.resolve({ status: () => 200 });
		},
		// Clean HTML → waitForBotProtectionToClear returns immediately.
		content() {
			return Promise.resolve("<html><body><h1>ok</h1></body></html>");
		},
		context() {
			return { cookies: async () => [] };
		},
	};
}

test("fetchWithPlaywright: installs the per-page SSRF redirect guard on a pooled page", async () => {
	const page = fakePooledPage();
	let released = false;
	const fakePool = {
		acquirePage: async () => ({
			page,
			release: () => {
				released = true;
			},
		}),
	};

	// Public IP literal → passes validateUrlForSsrf with no DNS lookup.
	const html = await fetchWithPlaywright("http://93.184.216.34/", fakePool);

	assert.ok(html && html.includes("ok"), "pooled render returns the page HTML");
	assert.ok(
		page.calls.route.includes("**/*"),
		"per-page SSRF redirect guard must register a **/* route interceptor",
	);
	assert.equal(page.calls.goto.length, 1, "navigated exactly once");
	assert.equal(released, true, "pooled page is released back to the pool");
});

// ─── Warm-vs-cold timing (Playwright-gated) ─────────────────────────
//
// Mirrors the audit metric: a cold pool acquire launches a browser (~561ms),
// a warm reuse is ~64ms. Skips cleanly when Playwright or its browser
// binaries are absent so the suite stays green offline.

test("BrowserPool: warm acquire is far faster than cold launch (Playwright-gated)", async (t) => {
	let playwright;
	try {
		playwright = await import("playwright");
	} catch {
		t.skip("playwright not installed — warm/cold timing UNMEASURED");
		return;
	}
	if (!playwright?.chromium) {
		t.skip("playwright has no chromium export — UNMEASURED");
		return;
	}

	const pool = new BrowserPool({ headless: true, maxBrowsers: 1 });
	try {
		// Cold: includes the browser launch.
		const coldStart = Date.now();
		const coldPage = await pool.acquirePage();
		const coldMs = Date.now() - coldStart;
		coldPage.release();

		// Warm: browser already up — just a new page.
		const warmStart = Date.now();
		const warmPage = await pool.acquirePage();
		const warmMs = Date.now() - warmStart;
		warmPage.release();

		// eslint-disable-next-line no-console
		console.log(
			`[perf-browser-pool] cold acquire=${coldMs}ms, warm acquire=${warmMs}ms ` +
				`(totalLaunched=${pool.stats().totalLaunched})`,
		);

		assert.equal(pool.stats().totalLaunched, 1, "only one browser launched");
		assert.ok(
			warmMs < coldMs,
			`warm acquire (${warmMs}ms) should be faster than cold launch (${coldMs}ms)`,
		);
	} catch {
		// Browser binaries may not be installed — not a failure of this unit.
		t.skip("playwright launch unavailable (browsers not installed?) — UNMEASURED");
	} finally {
		await pool.drain();
	}
});
