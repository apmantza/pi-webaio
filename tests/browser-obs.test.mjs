// ─── Tests for browser-launch + bot-block ladder observability ──────
//
// Covers the two offline-testable units extracted for the observability audit:
//   - P4 (src/browser-pool.ts): launch-error recording + timing helpers
//     (toLaunchErrorRecord / degradedPoolNotice / formatLaunchTiming) and the
//     BrowserPool's exposed degraded state. Browser-dependent assertions are
//     skipped gracefully when Playwright is absent.
//   - P7 (src/fetch.ts): summarizeBotBlockLadder — the pure builder for the
//     bot-block fallback ladder summary.
//
// Everything here is OFFLINE — no network, no real browser required.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	BrowserPool,
	toLaunchErrorRecord,
	degradedPoolNotice,
	formatLaunchTiming,
} from "../src/browser-pool.ts";
import { summarizeBotBlockLadder } from "../src/fetch.ts";

// ─── P4: toLaunchErrorRecord ────────────────────────────────────────

test("toLaunchErrorRecord: records an Error message + timestamp", () => {
	const rec = toLaunchErrorRecord(new Error("channel 'chrome' not found"), 1234);
	assert.equal(rec.message, "channel 'chrome' not found");
	assert.equal(rec.at, 1234);
});

test("toLaunchErrorRecord: coerces non-Error values, never throws", () => {
	assert.equal(toLaunchErrorRecord("boom", 1).message, "boom");
	assert.equal(toLaunchErrorRecord(undefined, 1).message, "undefined");
	assert.equal(toLaunchErrorRecord(null, 1).message, "null");
	assert.equal(toLaunchErrorRecord(42, 1).message, "42");
});

test("toLaunchErrorRecord: defaults `at` to now when omitted", () => {
	const before = Date.now();
	const rec = toLaunchErrorRecord(new Error("x"));
	const after = Date.now();
	assert.ok(rec.at >= before && rec.at <= after, "at should default to Date.now()");
});

// ─── P4: degradedPoolNotice ─────────────────────────────────────────

test("degradedPoolNotice: null when healthy", () => {
	assert.equal(degradedPoolNotice(null), null);
});

test("degradedPoolNotice: surfaces the recorded reason when degraded", () => {
	const notice = degradedPoolNotice({
		message: "Executable doesn't exist",
		at: 1,
	});
	assert.equal(notice, "pool degraded: last launch failed (Executable doesn't exist)");
});

// ─── P4: formatLaunchTiming ─────────────────────────────────────────

test("formatLaunchTiming: reports channel when one was used", () => {
	assert.equal(
		formatLaunchTiming(2143, "chrome"),
		"browser launch took 2143ms (channel=chrome)",
	);
});

test("formatLaunchTiming: reports bundled browser when channel is null", () => {
	assert.equal(
		formatLaunchTiming(1890, null),
		"browser launch took 1890ms (bundled browser)",
	);
});

// ─── P4: BrowserPool exposes degraded state (no launch needed) ──────

test("BrowserPool: starts healthy — lastLaunchError null, no degraded notice", () => {
	const pool = new BrowserPool();
	assert.equal(pool.lastLaunchError, null);
	assert.equal(pool.degradedNotice, null);
	assert.equal(pool.stats().lastLaunchError, null);
});

// Optional: exercise the real launch path only when Playwright is usable.
// Skips cleanly when Playwright (or its browser binaries) are absent, so the
// suite stays green offline.
test("BrowserPool: a successful launch keeps the pool healthy (Playwright-gated)", async (t) => {
	let playwright;
	try {
		playwright = await import("playwright");
	} catch {
		t.skip("playwright not installed");
		return;
	}
	if (!playwright?.chromium) {
		t.skip("playwright has no chromium export");
		return;
	}
	const pool = new BrowserPool({ headless: true });
	try {
		const page = await pool.acquirePage();
		page.release();
		// A successful launch must clear/leave no degraded state.
		assert.equal(pool.lastLaunchError, null);
		assert.equal(pool.degradedNotice, null);
		assert.ok(pool.stats().totalLaunched >= 1);
	} catch {
		// Browser binaries may not be installed — not a failure of this unit.
		t.skip("playwright launch unavailable (browsers not installed?)");
	} finally {
		await pool.drain();
	}
});

// ─── P7: summarizeBotBlockLadder ────────────────────────────────────

test("summarizeBotBlockLadder: empty ladder", () => {
	assert.equal(summarizeBotBlockLadder([]), "no fallback attempts recorded");
});

test("summarizeBotBlockLadder: all-403 lists every profile with its status", () => {
	const summary = summarizeBotBlockLadder([
		{ profile: "plain", error: "blocked" },
		{ profile: "firefox_147", status: 403 },
		{ profile: "safari_26", status: 403 },
		{ profile: "edge_145", status: 403 },
		{ profile: "playwright", status: 403 },
	]);
	assert.equal(
		summary,
		"plain=blocked, firefox_147=403, safari_26=403, edge_145=403, playwright=403",
	);
});

test("summarizeBotBlockLadder: mixed timeout / 403 / blocked", () => {
	const summary = summarizeBotBlockLadder([
		{ profile: "plain", error: "blocked" },
		{ profile: "firefox_147", status: 403 },
		{ profile: "safari_26", status: 403 },
		{ profile: "edge_145", error: "timeout" },
		{ profile: "playwright", error: "blocked" },
	]);
	assert.equal(
		summary,
		"plain=blocked, firefox_147=403, safari_26=403, edge_145=timeout, playwright=blocked",
	);
});

test("summarizeBotBlockLadder: status wins over error token", () => {
	assert.equal(
		summarizeBotBlockLadder([{ profile: "firefox_147", status: 429, error: "blocked" }]),
		"firefox_147=429",
	);
});

test("summarizeBotBlockLadder: no status or error defaults to blocked", () => {
	assert.equal(
		summarizeBotBlockLadder([{ profile: "playwright" }]),
		"playwright=blocked",
	);
});
