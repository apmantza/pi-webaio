// ─── Perf: pull concurrency sizing (P4) + cache/revalidation audit (P5) ──
//
// P4 — aio-webpull used `concurrency = max(4, cpus*2)` = 32 workers on a
// 16-core host, but a single-host pull is rate-limiter-bound (per-host
// TokenBucket burst 10 / 5 req/s sustains ~6 req/s regardless of workers).
// Measured: 32 workers = 6.37 pages/s vs 4 workers = 4.03 pages/s — 8×
// workers for 1.58× throughput. computePullConcurrency right-sizes workers:
// ~10 for a single host, scaling with distinct-host count for multi-host
// pulls (each host has its own bucket), bounded by CPU headroom + a ceiling.
//
// P5 — a warm session-cache hit is ~5000× cheaper than a live fetch. The
// revalidation path (conditional 304 request) used to be dead code: the tool
// called getStoredContent() — which DELETES expired entries as a side effect
// — immediately before peeking for an expired entry to revalidate, so the
// peek always saw null. getRevalidationCandidate() centralizes the correct
// peek-first logic. These tests are pure/offline (no network).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	computePullConcurrency,
	countDistinctHosts,
	PULL_CONCURRENCY_FLOOR,
	PULL_CONCURRENCY_CEILING,
} from "../src/tools/webpull.ts";

import { getRevalidationCandidate } from "../src/http-validators.ts";

import {
	sessionStore,
	normalizeCacheKey,
	getStoredContent,
	SESSION_CACHE_TTL_MS,
} from "../src/session-store.ts";

// ─── countDistinctHosts ─────────────────────────────────────────────────

test("countDistinctHosts: counts unique hosts across http/https", () => {
	assert.equal(
		countDistinctHosts(["https://a.com/x", "https://a.com/y", "http://b.com/"]),
		2,
	);
});

test("countDistinctHosts: empty input is 0", () => {
	assert.equal(countDistinctHosts([]), 0);
});

test("countDistinctHosts: ignores unparseable URLs", () => {
	assert.equal(countDistinctHosts(["not a url ::", "https://c.com/"]), 1);
});

// ─── computePullConcurrency: single host ────────────────────────────────

test("computePullConcurrency: single host, many URLs → ~8-12 (not 32)", () => {
	const urls = Array.from(
		{ length: 200 },
		(_, i) => `https://docs.example.com/page/${i}`,
	);
	const n = computePullConcurrency(urls, 16);
	assert.ok(n >= 8 && n <= 12, `expected 8-12 workers, got ${n}`);
	assert.ok(n < 32, "must not be the old 32-worker over-provisioning");
});

test("computePullConcurrency: single host is independent of URL count", () => {
	const few = computePullConcurrency(
		["https://x.com/1", "https://x.com/2"],
		16,
	);
	const many = computePullConcurrency(
		Array.from({ length: 500 }, (_, i) => `https://x.com/${i}`),
		16,
	);
	assert.equal(
		few,
		many,
		"same host → same worker count regardless of URL count",
	);
});

// ─── computePullConcurrency: multi host scales up ───────────────────────

test("computePullConcurrency: more distinct hosts → more workers", () => {
	const n1 = computePullConcurrency(["https://a.com/1"], 16);
	const n2 = computePullConcurrency(["https://a.com/1", "https://b.com/1"], 16);
	const n3 = computePullConcurrency(
		["https://a.com/1", "https://b.com/1", "https://c.com/1"],
		16,
	);
	assert.ok(n2 > n1, `2 hosts (${n2}) should exceed 1 host (${n1})`);
	assert.ok(n3 > n2, `3 hosts (${n3}) should exceed 2 hosts (${n2})`);
});

// ─── computePullConcurrency: floor + ceiling ────────────────────────────

test("computePullConcurrency: floor ≥4 respected (low-CPU multi-host)", () => {
	const urls = ["https://a.com/", "https://b.com/", "https://c.com/"];
	const n = computePullConcurrency(urls, 1);
	assert.ok(
		n >= PULL_CONCURRENCY_FLOOR,
		`expected ≥${PULL_CONCURRENCY_FLOOR}, got ${n}`,
	);
	assert.equal(n, PULL_CONCURRENCY_FLOOR);
});

test("computePullConcurrency: empty input still yields a sane floored value", () => {
	assert.ok(computePullConcurrency([], 16) >= PULL_CONCURRENCY_FLOOR);
});

test("computePullConcurrency: respects the ceiling (huge multi-host + many CPUs)", () => {
	const urls = Array.from(
		{ length: 100 },
		(_, i) => `https://host${i}.example.com/`,
	);
	const n = computePullConcurrency(urls, 64);
	assert.equal(n, PULL_CONCURRENCY_CEILING);
	assert.ok(n <= PULL_CONCURRENCY_CEILING);
});

// ─── P5: getRevalidationCandidate (peek-first revalidation) ─────────────

function seed(url, overrides = {}) {
	const entry = {
		url,
		content: "# Cached\n\nStale body.",
		timestamp: Date.now(),
		...overrides,
	};
	sessionStore.set(normalizeCacheKey(url), entry);
	return entry;
}

const EXPIRED_TS = () => Date.now() - SESSION_CACHE_TTL_MS - 5000;

test("getRevalidationCandidate: expired entry WITH validators is a candidate", () => {
	const url = "https://example.com/p5-expired-validators";
	seed(url, { timestamp: EXPIRED_TS(), etag: '"v1"' });
	const cand = getRevalidationCandidate(url);
	assert.ok(cand, "expired + validators should be a revalidation candidate");
	assert.equal(cand.etag, '"v1"');
});

test("getRevalidationCandidate: fresh entry with validators is NOT a candidate", () => {
	const url = "https://example.com/p5-fresh";
	seed(url, { timestamp: Date.now(), etag: '"v1"' });
	assert.equal(getRevalidationCandidate(url), null);
});

test("getRevalidationCandidate: expired entry WITHOUT validators is NOT a candidate", () => {
	const url = "https://example.com/p5-no-validators";
	seed(url, { timestamp: EXPIRED_TS() });
	assert.equal(getRevalidationCandidate(url), null);
});

test("getRevalidationCandidate: absent entry is NOT a candidate", () => {
	assert.equal(getRevalidationCandidate("https://example.com/p5-absent"), null);
});

test("getRevalidationCandidate PEEKS without deleting (root-cause regression)", () => {
	const url = "https://example.com/p5-peek-survives";
	seed(url, { timestamp: EXPIRED_TS(), etag: '"v1"' });
	const key = normalizeCacheKey(url);
	const cand = getRevalidationCandidate(url);
	assert.ok(cand, "candidate returned");
	// The entry must survive the peek so the subsequent conditional 304
	// request can refresh it. The old bug deleted it before the peek saw it.
	assert.ok(sessionStore.has(key), "entry must survive the peek for refresh");
});

test("contrast: getStoredContent DELETES an expired entry (why peek-first is required)", () => {
	const url = "https://example.com/p5-get-deletes";
	seed(url, { timestamp: EXPIRED_TS(), etag: '"v1"' });
	const key = normalizeCacheKey(url);
	// getStoredContent treats expired as a miss and evicts the entry...
	assert.equal(getStoredContent(url), null);
	assert.equal(
		sessionStore.has(key),
		false,
		"getStoredContent evicts expired entries",
	);
	// ...so calling it before the peek (the old code) left nothing to
	// revalidate. getRevalidationCandidate must therefore peek, not get.
});
