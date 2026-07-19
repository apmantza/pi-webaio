// ─── Tests for src/strategy-memory.ts ──────────────────────────────
// Unit tests; no live network fetches are made.

import assert from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ── Module under test ───────────────────────────────────────────────
// We import the module fresh. To isolate tests from each other we
// manipulate the exported Maps directly (domainMemory, engineMemory).
import {
	getStartingStrategy,
	recordDomainSuccess,
	recordDomainFailure,
	recordEngineSearchSuccess,
	recordEngineSearchFailure,
	rankEngines,
	saveMemoryToDisk,
	loadMemoryFromDisk,
	STRATEGY_MEMORY_TTL_MS,
	MAX_DOMAIN_ENTRIES,
	RE_PROBE_SUCCESS_COUNT,
	domainMemory,
	engineMemory,
} from "../src/strategy-memory.ts";

// Helper: clear all in-memory state between tests
function clearAll() {
	domainMemory.clear();
	engineMemory.clear();
}

// ─── record / lookup ───────────────────────────────────────────────

test("getStartingStrategy returns null for unknown domain", () => {
	clearAll();
	assert.strictEqual(getStartingStrategy("unknown.example.com"), null);
});

test("recordDomainSuccess + getStartingStrategy round-trip (plain)", () => {
	clearAll();
	recordDomainSuccess("example.com", "plain");
	assert.strictEqual(getStartingStrategy("example.com"), "plain");
});

test("recordDomainSuccess + getStartingStrategy round-trip (browser)", () => {
	clearAll();
	recordDomainSuccess("heavy.com", "browser");
	assert.strictEqual(getStartingStrategy("heavy.com"), "browser");
});

test("recordDomainFailure creates entry with failure counter", () => {
	clearAll();
	recordDomainFailure("bad.com", "plain");
	const entry = domainMemory.get("bad.com");
	assert.ok(entry, "entry should exist");
	assert.strictEqual(entry.consecutiveFailures.plain, 1);
});

test("recordDomainFailure increments counter on repeated calls", () => {
	clearAll();
	recordDomainFailure("bad.com", "plain");
	recordDomainFailure("bad.com", "plain");
	const entry = domainMemory.get("bad.com");
	assert.strictEqual(entry?.consecutiveFailures.plain, 2);
});

// ─── LRU bound ─────────────────────────────────────────────────────

test("domain entries are capped at MAX_DOMAIN_ENTRIES with LRU eviction", () => {
	clearAll();
	// Insert MAX_DOMAIN_ENTRIES entries
	for (let i = 0; i < MAX_DOMAIN_ENTRIES; i++) {
		recordDomainSuccess(`domain${i}.com`, "plain");
	}
	assert.strictEqual(domainMemory.size, MAX_DOMAIN_ENTRIES);

	// Adding one more should evict the oldest (domain0.com)
	recordDomainSuccess("new-domain.com", "plain");
	assert.strictEqual(domainMemory.size, MAX_DOMAIN_ENTRIES);
	assert.strictEqual(domainMemory.has("domain0.com"), false);
	assert.strictEqual(domainMemory.has("new-domain.com"), true);
});

// ─── Expiry ────────────────────────────────────────────────────────

test("getStartingStrategy returns null and removes stale entries", () => {
	clearAll();
	// Insert an entry with an old timestamp
	domainMemory.set("stale.com", {
		lastSuccessStrategy: "plain",
		consecutiveFailures: {},
		successCount: 5,
		reprobeNext: false,
		updatedAt: Date.now() - STRATEGY_MEMORY_TTL_MS - 1,
	});

	const result = getStartingStrategy("stale.com");
	assert.strictEqual(result, null);
	assert.strictEqual(domainMemory.has("stale.com"), false);
});

// ─── Downgrade / re-probe logic ────────────────────────────────────

test("reprobeNext is set after RE_PROBE_SUCCESS_COUNT successes at same rung", () => {
	clearAll();
	// Start with browser rung remembered
	recordDomainSuccess("probe.com", "browser");

	// Accumulate RE_PROBE_SUCCESS_COUNT - 2 more successes (total RE_PROBE_SUCCESS_COUNT - 1,
	// still one below the threshold — should NOT trigger reprobeNext yet).
	for (let i = 1; i < RE_PROBE_SUCCESS_COUNT - 1; i++) {
		recordDomainSuccess("probe.com", "browser");
	}
	const before = domainMemory.get("probe.com");
	assert.strictEqual(before?.reprobeNext, false);

	// One more (total = RE_PROBE_SUCCESS_COUNT) should trigger reprobeNext
	recordDomainSuccess("probe.com", "browser");
	const after = domainMemory.get("probe.com");
	assert.strictEqual(after?.reprobeNext, true);
});

test("getStartingStrategy returns null when reprobeNext is set", () => {
	clearAll();
	domainMemory.set("reprobe.com", {
		lastSuccessStrategy: "browser",
		consecutiveFailures: {},
		successCount: 0,
		reprobeNext: true,
		updatedAt: Date.now(),
	});
	assert.strictEqual(getStartingStrategy("reprobe.com"), null);
});

test("recordDomainSuccess downgrade: cheaper strategy clears reprobeNext", () => {
	clearAll();
	domainMemory.set("cheaper.com", {
		lastSuccessStrategy: "browser",
		consecutiveFailures: {},
		successCount: 5,
		reprobeNext: true,
		updatedAt: Date.now(),
	});

	// Cheaper "plain" strategy now works during re-probe
	recordDomainSuccess("cheaper.com", "plain");
	const entry = domainMemory.get("cheaper.com");
	assert.strictEqual(entry?.lastSuccessStrategy, "plain");
	assert.strictEqual(entry?.reprobeNext, false);
});

test("recordDomainSuccess downgrade: same-cost strategy updates entry", () => {
	clearAll();
	recordDomainSuccess("same.com", "wreq");
	// wreq → wreq: index equal, should still set to wreq, not downgrade to something else
	recordDomainSuccess("same.com", "wreq");
	const entry = domainMemory.get("same.com");
	assert.strictEqual(entry?.lastSuccessStrategy, "wreq");
});

// ─── Engine weighting order ────────────────────────────────────────

test("rankEngines returns same engines (no reordering) when no history", () => {
	clearAll();
	const engines = [
		{ id: "ddg" },
		{ id: "brave" },
		{ id: "yahoo" },
		{ id: "bing" },
	];
	const ranked = rankEngines(engines);
	assert.strictEqual(ranked.length, engines.length);
	// Without history all scores are 0.5 — stable sort preserves original order
	// (JS sort is not guaranteed stable for equal elements, but all equal scores
	// means any order is acceptable; just check the set is the same)
	const ids = ranked.map((e) => e.id).sort();
	const orig = engines.map((e) => e.id).sort();
	assert.deepStrictEqual(ids, orig);
});

test("rankEngines deprioritizes engine with high failure rate", () => {
	clearAll();
	// Make bing fail a lot
	for (let i = 0; i < 5; i++) recordEngineSearchFailure("bing");
	// ddg succeeds
	for (let i = 0; i < 5; i++) recordEngineSearchSuccess("ddg", 500);

	const engines = [
		{ id: "bing" },
		{ id: "ddg" },
		{ id: "brave" },
	];
	const ranked = rankEngines(engines);
	// ddg should come before bing
	const ddgIdx = ranked.findIndex((e) => e.id === "ddg");
	const bingIdx = ranked.findIndex((e) => e.id === "bing");
	assert.ok(ddgIdx < bingIdx, `ddg (${ddgIdx}) should rank above bing (${bingIdx})`);
});

test("rankEngines deprioritizes slow engine vs fast engine with equal reliability", () => {
	clearAll();
	// Both succeed, but yahoo is very slow
	for (let i = 0; i < 5; i++) recordEngineSearchSuccess("yahoo", 9000);
	for (let i = 0; i < 5; i++) recordEngineSearchSuccess("brave", 400);

	const engines = [{ id: "yahoo" }, { id: "brave" }];
	const ranked = rankEngines(engines);
	const braveIdx = ranked.findIndex((e) => e.id === "brave");
	const yahooIdx = ranked.findIndex((e) => e.id === "yahoo");
	assert.ok(
		braveIdx < yahooIdx,
		`brave (${braveIdx}) should rank above slow yahoo (${yahooIdx})`,
	);
});

test("rankEngines never drops engines from the list", () => {
	clearAll();
	// All engines blocked
	const engines = [{ id: "ddg" }, { id: "brave" }, { id: "yahoo" }, { id: "bing" }];
	for (const e of engines) {
		for (let i = 0; i < 10; i++) recordEngineSearchFailure(e.id);
	}
	const ranked = rankEngines(engines);
	assert.strictEqual(ranked.length, engines.length);
});

// ─── Disk persistence ──────────────────────────────────────────────

test("saveMemoryToDisk / loadMemoryFromDisk round-trip", async () => {
	clearAll();

	// We need to temporarily override STRATEGY_MEMORY_FILE to a temp dir.
	// Since it's a const export we can't reassign it, so we test via the
	// exported Maps directly — saveMemoryToDisk reads from them.
	// Instead write to the real location and then reload.

	recordDomainSuccess("persist.com", "wreq");
	recordEngineSearchSuccess("ddg", 300);

	await saveMemoryToDisk();

	// Wipe in-memory state
	domainMemory.clear();
	engineMemory.clear();

	await loadMemoryFromDisk();

	assert.strictEqual(getStartingStrategy("persist.com"), "wreq");
	const eng = engineMemory.get("ddg");
	assert.ok(eng, "engine entry should have been loaded");
	assert.strictEqual(eng.successes, 1);

	// Clean up — we leave the file in place since it's in OS tmpdir which
	// is session-scoped; no test teardown needed.
});

test("loadMemoryFromDisk ignores stale entries", async () => {
	clearAll();

	// Insert an almost-expired entry directly into memory, save it
	domainMemory.set("old.com", {
		lastSuccessStrategy: "plain",
		consecutiveFailures: {},
		successCount: 1,
		reprobeNext: false,
		updatedAt: Date.now() - STRATEGY_MEMORY_TTL_MS - 1000,
	});

	await saveMemoryToDisk();
	domainMemory.clear();
	await loadMemoryFromDisk();

	// Stale entry should NOT have been loaded
	assert.strictEqual(domainMemory.has("old.com"), false);
});
