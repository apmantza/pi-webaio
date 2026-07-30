import assert from "node:assert";
import test from "node:test";
import {
	buildEngineStatusMap,
	classifyEngineStatus,
	engineStatusNotes,
	describeEngineStatus,
	formatEngineLatency,
	searchWeb,
} from "../src/search.ts";
import { storeSearchResults } from "../src/session-store.ts";

// ─── classifyEngineStatus — one test per outcome (P2) ──────────────
// The classifier is the pure core of the per-engine status map, so each
// mocked engine outcome is asserted here in isolation. Everything is offline:
// outcomes are plain objects shaped like `searchWeb`'s internal records.

test("classifyEngineStatus: ok when results parsed (HTTP 200, count > 0)", () => {
	assert.strictEqual(
		classifyEngineStatus({
			id: "ddg",
			httpStatus: 200,
			count: 10,
			latencyMs: 800,
		}),
		"ok",
	);
});

test("classifyEngineStatus: empty when HTTP 200 but 0 results parsed", () => {
	assert.strictEqual(
		classifyEngineStatus({
			id: "yahoo",
			httpStatus: 200,
			count: 0,
			latencyMs: 500,
		}),
		"empty",
	);
});

test("classifyEngineStatus: cooled_down skip reason takes precedence", () => {
	assert.strictEqual(
		classifyEngineStatus({
			id: "brave",
			httpStatus: null,
			count: 0,
			latencyMs: 0,
			skipReason: "cooled_down",
		}),
		"cooled_down",
	);
});

test("classifyEngineStatus: quota when the response is flagged as rate-limit", () => {
	assert.strictEqual(
		classifyEngineStatus({
			id: "brave",
			httpStatus: 429,
			count: 0,
			latencyMs: 300,
			quota: true,
		}),
		"quota",
	);
});

test("classifyEngineStatus: http_<code> for non-quota HTTP >= 400", () => {
	assert.strictEqual(
		classifyEngineStatus({
			id: "bing",
			httpStatus: 429,
			count: 0,
			latencyMs: 300,
		}),
		"http_429",
	);
	assert.strictEqual(
		classifyEngineStatus({
			id: "bing",
			httpStatus: 503,
			count: 0,
			latencyMs: 300,
		}),
		"http_503",
	);
});

test("classifyEngineStatus: error when the request threw", () => {
	assert.strictEqual(
		classifyEngineStatus({
			id: "ddg",
			httpStatus: null,
			count: 0,
			latencyMs: 120,
			skipReason: "error",
		}),
		"error",
	);
});

// ─── buildEngineStatusMap — shape, counts, latency (P2 + P5) ───────

test("buildEngineStatusMap: records status, count, and a numeric latencyMs per engine", () => {
	const map = buildEngineStatusMap([
		{ id: "ddg", httpStatus: 200, count: 10, latencyMs: 1200 },
		{
			id: "brave",
			httpStatus: null,
			count: 0,
			latencyMs: 0,
			skipReason: "cooled_down",
		},
		{ id: "yahoo", httpStatus: 429, count: 0, latencyMs: 350 },
		{ id: "bing", httpStatus: 200, count: 0, latencyMs: 480 },
	]);

	assert.strictEqual(map.ddg.status, "ok");
	assert.strictEqual(map.ddg.count, 10);
	assert.strictEqual(typeof map.ddg.latencyMs, "number");
	assert.strictEqual(map.ddg.latencyMs, 1200);

	assert.strictEqual(map.brave.status, "cooled_down");
	assert.strictEqual(map.brave.count, 0);
	assert.strictEqual(typeof map.brave.latencyMs, "number");

	assert.strictEqual(map.yahoo.status, "http_429");
	assert.strictEqual(map.yahoo.count, 0);
	assert.strictEqual(typeof map.yahoo.latencyMs, "number");
	assert.strictEqual(map.yahoo.latencyMs, 350);

	assert.strictEqual(map.bing.status, "empty");
	assert.strictEqual(map.bing.count, 0);
	assert.strictEqual(typeof map.bing.latencyMs, "number");
});

test("buildEngineStatusMap: always completes the map, defaulting unattempted engines to disabled", () => {
	const map = buildEngineStatusMap([
		{ id: "ddg", httpStatus: 200, count: 5, latencyMs: 0 },
	]);
	assert.strictEqual(map.ddg.status, "ok");
	for (const id of ["brave", "yahoo", "bing"]) {
		assert.strictEqual(map[id].status, "disabled");
		assert.strictEqual(map[id].count, 0);
		assert.strictEqual(map[id].latencyMs, 0);
	}
});

// ─── engineStatusNotes — the rendered note string (P2) ─────────────

test("engineStatusNotes: emits a note per non-ok engine, skips ok and disabled", () => {
	const map = buildEngineStatusMap([
		{ id: "ddg", httpStatus: 200, count: 10, latencyMs: 900 },
		{
			id: "brave",
			httpStatus: null,
			count: 0,
			latencyMs: 0,
			skipReason: "cooled_down",
		},
		{ id: "yahoo", httpStatus: 429, count: 0, latencyMs: 300 },
		// bing absent → disabled → no note
	]);
	const notes = engineStatusNotes(map);
	assert.ok(
		notes.some((n) => n === "_(Brave: cooled down after recent failures)_"),
		`expected a Brave cooled-down note, got: ${JSON.stringify(notes)}`,
	);
	assert.ok(
		notes.some((n) => n === "_(Yahoo: HTTP 429)_"),
		`expected a Yahoo HTTP 429 note, got: ${JSON.stringify(notes)}`,
	);
	assert.ok(
		!notes.some((n) => n.includes("DDG")),
		"ok engine must not be noted",
	);
	assert.ok(
		!notes.some((n) => n.includes("Bing")),
		"disabled engine must not be noted",
	);
});

test("engineStatusNotes: a legitimately-empty engine is distinguished from a failure", () => {
	const map = buildEngineStatusMap([
		{ id: "yahoo", httpStatus: 200, count: 0, latencyMs: 400 },
	]);
	assert.deepStrictEqual(engineStatusNotes(map), [
		"_(Yahoo: returned 0 results)_",
	]);
});

test("engineStatusNotes: all-ok map produces no notes", () => {
	const map = buildEngineStatusMap([
		{ id: "ddg", httpStatus: 200, count: 10, latencyMs: 900 },
		{ id: "brave", httpStatus: 200, count: 8, latencyMs: 700 },
	]);
	assert.deepStrictEqual(engineStatusNotes(map), []);
});

// ─── describeEngineStatus / formatEngineLatency helpers ────────────

test("describeEngineStatus: maps statuses to human-readable reasons", () => {
	assert.strictEqual(
		describeEngineStatus("quota"),
		"rate-limited / quota exhausted",
	);
	assert.strictEqual(describeEngineStatus("error"), "network error");
	assert.strictEqual(
		describeEngineStatus("cooled_down"),
		"cooled down after recent failures",
	);
	assert.strictEqual(describeEngineStatus("http_503"), "HTTP 503");
});

test("formatEngineLatency: renders ms below 1s and seconds at/above 1s", () => {
	assert.strictEqual(formatEngineLatency(340), "340ms");
	assert.strictEqual(formatEngineLatency(1200), "1.2s");
});

// ─── searchWeb backward-compat (offline, cache-served path) ────────
// Priming the search cache makes searchWeb return via its cached branch with
// no network I/O, letting us assert the return shape keeps the legacy count
// fields AND carries the new engineStatus map.

test("searchWeb: keeps backward-compat count fields and adds a complete engineStatus map", async () => {
	const query = "engine-status-backcompat-probe";
	storeSearchResults(query, [
		{
			title: "Example",
			url: "https://example.com/",
			snippet: "s",
			domain: "example.com",
		},
	]);
	const r = await searchWeb(query);

	// Legacy per-engine count fields are still present and numeric.
	assert.strictEqual(typeof r.ddgCount, "number");
	assert.strictEqual(typeof r.braveCount, "number");
	assert.strictEqual(typeof r.yahooCount, "number");
	assert.strictEqual(typeof r.bingCount, "number");
	assert.strictEqual(r.ddgCount, 1);

	// New per-engine status map is present and complete for all four engines.
	assert.ok(r.engineStatus, "engineStatus map must be present");
	for (const id of ["ddg", "brave", "yahoo", "bing"]) {
		const entry = r.engineStatus[id];
		assert.ok(entry, `engineStatus.${id} must be present`);
		assert.strictEqual(typeof entry.count, "number");
		assert.strictEqual(typeof entry.latencyMs, "number");
		assert.strictEqual(typeof entry.status, "string");
	}
	assert.strictEqual(r.engineStatus.ddg.status, "ok");
});
