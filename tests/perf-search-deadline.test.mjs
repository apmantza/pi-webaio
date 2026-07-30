import assert from "node:assert";
import test from "node:test";
import {
	searchWeb,
	engineStatusNotes,
	sessionEngineHealth,
	ENGINE_DEADLINE_MS,
} from "../src/search.ts";

// ─── Per-engine deadline (P3) ──────────────────────────────────────
// `searchWeb` used to await ALL four engines via `Promise.all` with no
// per-engine deadline, so one stalled / rate-limited engine (a Brave HTTP 429
// stuck in fetchWithRetry's backoff) bounded the whole merge — measured 8.5s
// vs ~1.3s normal. These tests inject a mock fetch via `searchWeb`'s
// `fetchFn` option and a short `engineDeadlineMs` to prove, fully offline,
// that a slow engine is now cut off at the deadline (status `timeout`) while
// fast engines still return normally.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal DDG HTML that `parseDuckDuckGoResults` turns into exactly one result.
const DDG_HTML =
	'<div class="result"><a class="result__a" href="https://example.com/">Example</a>' +
	'<span class="result__snippet">snip</span></div>';

// Map an engine URL to its id (the mock branches on this, so engine reordering
// by rankEngines is irrelevant to the test).
function idForUrl(url) {
	if (url.includes("duckduckgo")) return "ddg";
	if (url.includes("brave")) return "brave";
	if (url.includes("yahoo")) return "yahoo";
	if (url.includes("bing")) return "bing";
	return null;
}

// Build a mock fetchFn shaped like smartFetch. `behaviors[id]` controls each
// engine: { delayMs, status, text, neverResolve }. Unlisted engines return an
// empty HTTP 200 (parsed to 0 results → status `empty`).
function makeFetchFn(behaviors) {
	return async (url) => {
		const id = idForUrl(url);
		const b = (id && behaviors[id]) || {};
		if (b.neverResolve) return new Promise(() => {}); // never settles
		if (b.delayMs) await sleep(b.delayMs);
		return {
			text: b.text ?? "",
			url,
			status: b.status ?? 200,
			headers: { get: () => null },
			downloadedBytes: 0,
			contentLength: null,
			elapsedMs: b.delayMs ?? 0,
		};
	};
}

// Engine health is module-global; a timeout records a failure, so clear it
// before each test to keep statuses deterministic (no cross-test cooldown).
function resetEngineHealth() {
	sessionEngineHealth.clear();
}

test("ENGINE_DEADLINE_MS: exposes a sane per-engine deadline constant", () => {
	assert.strictEqual(typeof ENGINE_DEADLINE_MS, "number");
	assert.ok(ENGINE_DEADLINE_MS >= 3000 && ENGINE_DEADLINE_MS <= 6000);
});

test("a stalled engine is cut off at the deadline; the merge completes promptly with the others' results", async () => {
	resetEngineHealth();
	const fetchFn = makeFetchFn({
		ddg: { delayMs: 10, text: DDG_HTML }, // fast, ok
		brave: { neverResolve: true }, // stalls forever
	});
	const start = Date.now();
	const r = await searchWeb("deadline-stalled-engine-probe", undefined, {
		fetchFn,
		engineDeadlineMs: 250,
	});
	const elapsed = Date.now() - start;

	// The merge did NOT wait for the never-resolving engine.
	assert.ok(
		elapsed < 1200,
		`search should complete promptly, took ${elapsed}ms`,
	);
	// The fast engine's results still made it into the merge.
	assert.ok(r.results.length >= 1, "fast engine results must be merged");
	assert.strictEqual(r.ddgCount, 1);
	assert.strictEqual(r.engineStatus.ddg.status, "ok");
	// The stalled engine is recorded as a timeout, not hung / not empty.
	assert.strictEqual(r.engineStatus.brave.status, "timeout");
	assert.strictEqual(r.engineStatus.brave.count, 0);
	assert.ok(
		r.engineStatus.brave.latencyMs >= 200,
		`timeout latency should reflect the deadline, got ${r.engineStatus.brave.latencyMs}ms`,
	);
});

test("a fast engine still returns its results normally (status ok)", async () => {
	resetEngineHealth();
	const fetchFn = makeFetchFn({
		ddg: { delayMs: 5, text: DDG_HTML },
		bing: { delayMs: 5, text: DDG_HTML }, // bing parser yields 0 here → empty
	});
	const r = await searchWeb("deadline-fast-engine-probe", undefined, {
		fetchFn,
		engineDeadlineMs: 2000,
	});
	assert.strictEqual(r.engineStatus.ddg.status, "ok");
	assert.strictEqual(r.engineStatus.ddg.count, 1);
	assert.ok(r.results.some((x) => x.url === "https://example.com/"));
});

test("a 429 engine fails fast and is recorded as quota, not hung", async () => {
	resetEngineHealth();
	const fetchFn = makeFetchFn({
		ddg: { delayMs: 5, text: DDG_HTML },
		brave: { delayMs: 10, status: 429, text: "rate limit exceeded" },
	});
	const start = Date.now();
	const r = await searchWeb("deadline-429-failfast-probe", undefined, {
		fetchFn,
		engineDeadlineMs: 2000,
	});
	const elapsed = Date.now() - start;

	assert.strictEqual(r.engineStatus.brave.status, "quota");
	assert.strictEqual(r.engineStatus.brave.count, 0);
	assert.ok(elapsed < 1000, `429 should fail fast, took ${elapsed}ms`);
});

test("a slow engine that exceeds the deadline is recorded as timeout (429 retry cycle surrogate)", async () => {
	resetEngineHealth();
	// Simulates a 429 stuck in fetchWithRetry's backoff: the response only
	// arrives after the deadline, so the cutoff must win and record `timeout`.
	const fetchFn = makeFetchFn({
		ddg: { delayMs: 5, text: DDG_HTML },
		brave: { delayMs: 1200, status: 429, text: "rate limit exceeded" },
	});
	const start = Date.now();
	const r = await searchWeb("deadline-slow-429-probe", undefined, {
		fetchFn,
		engineDeadlineMs: 250,
	});
	const elapsed = Date.now() - start;

	assert.strictEqual(r.engineStatus.brave.status, "timeout");
	assert.ok(
		elapsed < 1000,
		`deadline should bound the search, took ${elapsed}ms`,
	);
});

test("engineStatusNotes renders a timeout note with the measured latency", async () => {
	resetEngineHealth();
	const fetchFn = makeFetchFn({
		ddg: { delayMs: 5, text: DDG_HTML },
		brave: { neverResolve: true },
	});
	const r = await searchWeb("deadline-timeout-note-probe", undefined, {
		fetchFn,
		engineDeadlineMs: 250,
	});
	const notes = engineStatusNotes(r.engineStatus);
	assert.ok(
		notes.some((n) => /^_\(Brave: timed out after .+\)_$/.test(n)),
		`expected a Brave timeout note with latency, got: ${JSON.stringify(notes)}`,
	);
});

test("measured: a slow engine no longer bounds the total search time", async () => {
	// One artificially-slow engine (1500ms). With a generous deadline the slow
	// engine bounds the merge ("before"); with the real deadline it is cut off
	// and the total drops to ~the deadline ("after").
	const behaviors = {
		ddg: { delayMs: 5, text: DDG_HTML },
		yahoo: { delayMs: 1500, text: "" }, // the slow engine
	};

	resetEngineHealth();
	const beforeStart = Date.now();
	await searchWeb("deadline-measure-before-probe", undefined, {
		fetchFn: makeFetchFn(behaviors),
		engineDeadlineMs: 5000, // no effective cutoff → slow engine bounds it
	});
	const beforeMs = Date.now() - beforeStart;

	resetEngineHealth();
	const afterStart = Date.now();
	await searchWeb("deadline-measure-after-probe", undefined, {
		fetchFn: makeFetchFn(behaviors),
		engineDeadlineMs: 300, // tight cutoff → slow engine cut off
	});
	const afterMs = Date.now() - afterStart;

	// eslint-disable-next-line no-console
	console.log(
		`[perf-search-deadline] slow engine (1500ms): before=${beforeMs}ms after=${afterMs}ms`,
	);
	assert.ok(
		beforeMs >= 1400,
		`without a cutoff the slow engine should bound the total (~1500ms), got ${beforeMs}ms`,
	);
	assert.ok(
		afterMs < 1000,
		`with the deadline the slow engine must not bound the total, got ${afterMs}ms`,
	);
	assert.ok(afterMs < beforeMs, "deadline must reduce total search time");
});
