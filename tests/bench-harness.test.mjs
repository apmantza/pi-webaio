// ─── Bench harness unit tests ──────────────────────────────────────
// Tests corpus validation, scorecard computation, and baseline diffing.
// Does NOT hit the network — uses synthetic fake run data.

import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	validateCorpusEntry,
	validateCorpus,
	computeScorecard,
	diffAgainstBaseline,
	benchmarkUrl,
	parseArgs,
	formatScorecard,
} from "../scripts/bench-extraction.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Corpus validation ─────────────────────────────────────────────

test("validateCorpusEntry: valid entry passes", () => {
	const entry = {
		url: "https://en.wikipedia.org/wiki/Python_(programming_language)",
		category: "wikipedia",
		markers: { title: "Python", required: ["Guido van Rossum"] },
	};
	assert.strictEqual(validateCorpusEntry(entry), null);
});

test("validateCorpusEntry: missing url fails", () => {
	const entry = { category: "wikipedia", markers: { required: ["foo"] } };
	assert.ok(validateCorpusEntry(entry));
});

test("validateCorpusEntry: invalid url fails", () => {
	const entry = { url: "not-a-url", category: "wikipedia", markers: { required: ["foo"] } };
	assert.ok(validateCorpusEntry(entry));
});

test("validateCorpusEntry: missing category fails", () => {
	const entry = { url: "https://example.com", markers: { required: ["foo"] } };
	assert.ok(validateCorpusEntry(entry));
});

test("validateCorpusEntry: missing markers fails", () => {
	const entry = { url: "https://example.com", category: "general-web" };
	assert.ok(validateCorpusEntry(entry));
});

test("validateCorpusEntry: empty required markers fails", () => {
	const entry = {
		url: "https://example.com",
		category: "general-web",
		markers: { required: [] },
	};
	assert.ok(validateCorpusEntry(entry));
});

test("validateCorpus: valid array passes", () => {
	const corpus = [
		{
			url: "https://example.com",
			category: "general-web",
			markers: { required: ["foo"] },
		},
	];
	const errors = validateCorpus(corpus);
	assert.strictEqual(errors.length, 0);
});

test("validateCorpus: non-array fails", () => {
	const errors = validateCorpus("not an array");
	assert.ok(errors.length > 0);
});

test("validateCorpus: array with bad entry reports index", () => {
	const corpus = [
		{ url: "https://example.com", category: "x", markers: { required: ["f"] } },
		{ url: "bad-url", category: "x", markers: { required: ["f"] } },
	];
	const errors = validateCorpus(corpus);
	assert.ok(errors.some((e) => e.includes("entry[1]")));
});

// ─── Load and validate the real corpus file ────────────────────────

test("real corpus file validates", async () => {
	const raw = await readFile(join(__dirname, "../scripts/bench-corpus.json"), "utf8");
	const corpus = JSON.parse(raw);
	const errors = validateCorpus(corpus);
	assert.strictEqual(errors.length, 0, `Corpus errors: ${errors.join("; ")}`);
});

test("real corpus has at least 20 entries", async () => {
	const raw = await readFile(join(__dirname, "../scripts/bench-corpus.json"), "utf8");
	const corpus = JSON.parse(raw);
	assert.ok(corpus.length >= 20, `Expected >=20 entries, got ${corpus.length}`);
});

test("real corpus covers all major verticals", async () => {
	const raw = await readFile(join(__dirname, "../scripts/bench-corpus.json"), "utf8");
	const corpus = JSON.parse(raw);
	const categories = new Set(corpus.map((e) => e.category));
	const expectedVerticals = [
		"wikipedia",
		"arxiv",
		"hackernews",
		"npm",
		"pypi",
		"stackexchange",
		"reddit",
		"cratesio",
	];
	for (const v of expectedVerticals) {
		assert.ok(categories.has(v), `Missing vertical: ${v}`);
	}
});

// ─── Scorecard computation ─────────────────────────────────────────

function makeFakeResult(overrides = {}) {
	return {
		url: "https://example.com",
		category: "general-web",
		description: "test",
		success: true,
		networkError: false,
		markersFound: ["foo", "bar"],
		markersMissed: [],
		markerHitRate: 1,
		tokens: 1000,
		latencyMs: 500,
		error: null,
		...overrides,
	};
}

test("computeScorecard: empty results", () => {
	const sc = computeScorecard([]);
	assert.strictEqual(sc.totalUrls, 0);
	assert.strictEqual(sc.successRate, 0);
});

test("computeScorecard: all successes", () => {
	const results = [
		makeFakeResult({ tokens: 100, latencyMs: 200 }),
		makeFakeResult({ tokens: 200, latencyMs: 400 }),
		makeFakeResult({ tokens: 300, latencyMs: 600 }),
	];
	const sc = computeScorecard(results);
	assert.strictEqual(sc.totalUrls, 3);
	assert.strictEqual(sc.successRate, 1);
	assert.strictEqual(sc.markerHitRate, 1);
	assert.strictEqual(sc.networkFailures, 0);
	assert.strictEqual(sc.extractionFailures, 0);
	// median tokens = 200 (middle of 100,200,300)
	assert.strictEqual(sc.medianTokens, 200);
});

test("computeScorecard: mixed success/failure", () => {
	const results = [
		makeFakeResult({ success: true }),
		makeFakeResult({ success: false, networkError: true, tokens: 0, markersFound: [], markersMissed: ["foo"] }),
		makeFakeResult({ success: false, networkError: false, tokens: 0, markersFound: [], markersMissed: ["foo"] }),
	];
	const sc = computeScorecard(results);
	assert.ok(sc.successRate < 1);
	assert.strictEqual(sc.networkFailures, 1);
	assert.strictEqual(sc.extractionFailures, 1);
});

test("computeScorecard: byCategory aggregation", () => {
	const results = [
		makeFakeResult({ category: "npm", url: "https://npmjs.com/a", tokens: 500, latencyMs: 300 }),
		makeFakeResult({ category: "npm", url: "https://npmjs.com/b", tokens: 700, latencyMs: 700 }),
		makeFakeResult({ category: "pypi", url: "https://pypi.org/a", tokens: 900, latencyMs: 200 }),
	];
	const sc = computeScorecard(results);
	assert.ok(sc.byCategory["npm"]);
	assert.strictEqual(sc.byCategory["npm"].total, 2);
	assert.strictEqual(sc.byCategory["npm"].success, 2);
	assert.ok(sc.byCategory["pypi"]);
	assert.strictEqual(sc.byCategory["pypi"].total, 1);
});

test("computeScorecard: partial marker hits", () => {
	const results = [
		makeFakeResult({ markersFound: ["foo"], markersMissed: ["bar"], markerHitRate: 0.5 }),
	];
	const sc = computeScorecard(results);
	assert.strictEqual(sc.markerHitRate, 0.5);
});

// ─── Baseline diff ─────────────────────────────────────────────────

test("diffAgainstBaseline: no regressions when identical", () => {
	const base = [makeFakeResult({ url: "https://example.com" })];
	const cur = [makeFakeResult({ url: "https://example.com" })];
	const regressions = diffAgainstBaseline(cur, base);
	assert.strictEqual(regressions.length, 0);
});

test("diffAgainstBaseline: detects success->failure", () => {
	const base = [makeFakeResult({ url: "https://example.com", success: true })];
	const cur = [makeFakeResult({ url: "https://example.com", success: false, networkError: false, error: "empty" })];
	const regressions = diffAgainstBaseline(cur, base);
	assert.ok(regressions.some((r) => r.type === "success-failure"));
});

test("diffAgainstBaseline: detects marker loss", () => {
	const base = [makeFakeResult({ url: "https://example.com", success: true, markersFound: ["foo", "bar"], markersMissed: [] })];
	const cur = [makeFakeResult({ url: "https://example.com", success: true, markersFound: ["foo"], markersMissed: ["bar"] })];
	const regressions = diffAgainstBaseline(cur, base);
	assert.ok(regressions.some((r) => r.type === "marker-loss"));
});

test("diffAgainstBaseline: detects >30% token swing", () => {
	const base = [makeFakeResult({ url: "https://example.com", success: true, tokens: 1000 })];
	const cur = [makeFakeResult({ url: "https://example.com", success: true, tokens: 200 })];
	const regressions = diffAgainstBaseline(cur, base);
	assert.ok(regressions.some((r) => r.type === "token-swing"));
});

test("diffAgainstBaseline: no regression for <30% token swing", () => {
	const base = [makeFakeResult({ url: "https://example.com", success: true, tokens: 1000 })];
	const cur = [makeFakeResult({ url: "https://example.com", success: true, tokens: 1100 })];
	const regressions = diffAgainstBaseline(cur, base);
	assert.ok(!regressions.some((r) => r.type === "token-swing"));
});

test("diffAgainstBaseline: skips URLs not in baseline", () => {
	const base = [];
	const cur = [makeFakeResult({ url: "https://example.com", success: false })];
	const regressions = diffAgainstBaseline(cur, base);
	assert.strictEqual(regressions.length, 0);
});

// ─── benchmarkUrl with fake extractor ──────────────────────────────

test("benchmarkUrl: success path with fake extractor", async () => {
	const entry = {
		url: "https://example.com",
		category: "general-web",
		markers: { required: ["hello", "world"] },
	};
	const fakeExtraction = async () => ({ text: "hello world this is extracted content with enough length to pass" });
	const result = await benchmarkUrl(entry, { timeout: 5000, runExtraction: fakeExtraction });
	assert.strictEqual(result.success, true);
	assert.ok(result.markersFound.includes("hello"));
	assert.ok(result.markersFound.includes("world"));
	assert.ok(result.tokens > 0);
	assert.ok(result.latencyMs >= 0);
});

test("benchmarkUrl: extraction failure path", async () => {
	const entry = {
		url: "https://example.com",
		category: "general-web",
		markers: { required: ["hello"] },
	};
	const fakeExtraction = async () => ({ text: "" });
	const result = await benchmarkUrl(entry, { timeout: 5000, runExtraction: fakeExtraction });
	assert.strictEqual(result.success, false);
	assert.strictEqual(result.networkError, false);
});

test("benchmarkUrl: network error path", async () => {
	const entry = {
		url: "https://example.com",
		category: "general-web",
		markers: { required: ["hello"] },
	};
	const fakeExtraction = async () => { throw new Error("fetch failed ECONNRESET"); };
	const result = await benchmarkUrl(entry, { timeout: 5000, runExtraction: fakeExtraction });
	assert.strictEqual(result.success, false);
	assert.strictEqual(result.networkError, true);
});

test("benchmarkUrl: timeout path", async () => {
	const entry = {
		url: "https://example.com",
		category: "general-web",
		markers: { required: ["hello"] },
	};
	const fakeExtraction = async () => {
		await new Promise((r) => setTimeout(r, 10_000));
		return { text: "done" };
	};
	const result = await benchmarkUrl(entry, { timeout: 50, runExtraction: fakeExtraction });
	assert.strictEqual(result.success, false);
	assert.strictEqual(result.networkError, true); // timeout is treated as network
});

test("benchmarkUrl: missing markers reported", async () => {
	const entry = {
		url: "https://example.com",
		category: "general-web",
		markers: { required: ["found-marker", "missing-marker"] },
	};
	const fakeExtraction = async () => ({ text: "found-marker is here, content is long enough to pass the threshold for sure" });
	const result = await benchmarkUrl(entry, { timeout: 5000, runExtraction: fakeExtraction });
	assert.ok(result.markersFound.includes("found-marker"));
	assert.ok(result.markersMissed.includes("missing-marker"));
});

// ─── parseArgs ─────────────────────────────────────────────────────

test("parseArgs: defaults", () => {
	const args = parseArgs([]);
	assert.strictEqual(args.json, false);
	assert.strictEqual(args.baseline, null);
	assert.strictEqual(args.concurrency, 2);
	assert.strictEqual(args.timeout, 30_000);
});

test("parseArgs: --json flag", () => {
	const args = parseArgs(["--json"]);
	assert.strictEqual(args.json, true);
});

test("parseArgs: --filter", () => {
	const args = parseArgs(["--filter", "wikipedia,arxiv"]);
	assert.deepStrictEqual(args.filter, ["wikipedia", "arxiv"]);
});

test("parseArgs: --update-baseline", () => {
	const args = parseArgs(["--update-baseline"]);
	assert.strictEqual(args.updateBaseline, true);
});

// ─── formatScorecard ───────────────────────────────────────────────

test("formatScorecard: produces non-empty string", () => {
	const results = [makeFakeResult()];
	const sc = computeScorecard(results);
	const output = formatScorecard(sc, null);
	assert.ok(typeof output === "string" && output.length > 0);
	assert.ok(output.includes("Success rate"));
	assert.ok(output.includes("Marker hit rate"));
});

test("formatScorecard: shows regressions when present", () => {
	const results = [makeFakeResult()];
	const sc = computeScorecard(results);
	const regressions = [{ url: "https://example.com", category: "test", type: "success-failure", detail: "now broken" }];
	const output = formatScorecard(sc, regressions);
	assert.ok(output.includes("REGRESSIONS DETECTED"));
});

test("formatScorecard: shows no regressions message when empty", () => {
	const results = [makeFakeResult()];
	const sc = computeScorecard(results);
	const output = formatScorecard(sc, []);
	assert.ok(output.includes("No regressions"));
});
