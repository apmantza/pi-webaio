// ─── Bench harness unit tests ──────────────────────────────────────
// Tests corpus validation, scorecard computation, and baseline diffing.
// Does NOT hit the network — uses synthetic fake run data.

import assert from "node:assert";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blankCommentsAndStrings } from "./helpers.mjs";
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

// ─── #177: documented capability must exist ────────────────────────
// Recurrence this guards: the bench header advertised
// `npm run bench -- --baseline scripts/bench-baseline.json` for a file that was
// never in the tree. The comparison path was unreachable, the flags advertised a
// gate that did not exist, and `.github/workflows/bench.yml` ended the run with
// `|| true`, so the scheduled job could report but never fail. It also cost time
// during #162: the one artefact that looked like a drift gate was not one.

const BENCH_SCRIPT = join(__dirname, "..", "scripts", "bench-extraction.mjs");const BENCH_WF = join(__dirname, "..", ".github", "workflows", "bench.yml");

test("#177: a missing baseline and a broken baseline get different guidance", async () => {
	// The old path printed one message for both, so a caller whose baseline file
	// existed but did not parse was told "no baseline is committed" and told to
	// regenerate — over the one record they were comparing against. Asserted by
	// running the script, not by grepping for a sentence: the previous version of
	// this test matched a string, and would have passed for any wording that kept
	// the substring while still giving the wrong advice.
	const missing = join(tmpdir(), `no-such-baseline-${process.pid}.json`);
	const broken = join(tmpdir(), `broken-baseline-${process.pid}.json`);
	await writeFile(broken, "{ this is not json");
	const run = (p) =>
		spawnSync(
			process.execPath,
			["--experimental-strip-types", BENCH_SCRIPT, "--baseline", p],
			{ encoding: "utf8", timeout: 60_000 },
		);
	try {
		const a = run(missing);
		assert.notEqual(a.status, 0, "a missing baseline must fail, not silently proceed");
		assert.match(a.stderr, /No baseline at /, "missing must read as missing");
		assert.match(
			a.stderr,
			new RegExp(`--update-baseline --baseline ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
			"the fix command must name the path the caller asked for — telling them to generate the default leaves their own command still failing",
		);
		assert.match(a.stderr, /--update-baseline/, "missing must name the generator");

		const b = run(broken);
		assert.notEqual(b.status, 0, "an unparseable baseline must fail too");
		assert.match(
			b.stderr,
		/could not be read/,
			"a broken baseline must report the real problem",
		);
		assert.doesNotMatch(
			b.stderr,
		/No baseline at |None is committed/,
			"a file that exists must never be reported as absent — the advice would send the caller to regenerate over it",
		);
	} finally {
		await rm(broken, { force: true });
	}
});

test("#177: --help says which check blocks a PR and which one is only a report", () => {
	// Someone reading the help to find out what gates their merge could not tell
	// the live benchmark from the offline suite.
	const h = spawnSync(
		process.execPath,
		["--experimental-strip-types", BENCH_SCRIPT, "--help"],
		{ encoding: "utf8", timeout: 60_000 },
	).stdout;
	assert.match(h, /markdown-shape\.test\.mjs/, "help must name the offline gate");
	assert.match(h, /test:all/, "and say where it runs");
	assert.match(h, /not\s+the gate/, "and say the benchmark itself is not it");
});

test("#177: the scorecard artifact survives a failing second invocation", async () => {
	// #177 removed `|| true`, so the second invocation can now fail — and by
	// default GitHub skips later steps, meaning the run that most needs the
	// artifact is the one that loses it.
	const wf = await readFile(BENCH_WF, "utf8");
	const upload = wf.slice(wf.indexOf("Upload scorecard artifact"));
	assert.ok(upload.length > 0, "the upload step must exist");
	assert.match(
		upload.slice(0, 900),
		/if: always\(\)/,
		"the upload must run after a failed bench step, or the scorecard is lost exactly when it matters",
	);
	assert.match(
		upload.slice(0, 1200),
		/if-no-files-found: ignore/,
		"a failed FIRST invocation must not replace the real red with an upload error",
	);
});

test("#177: creating a baseline may not be blocked by loading it first", async () => {
	// `--update-baseline` writes to the path named by `--baseline`, so the command
	// the missing-baseline message tells the caller to run must actually run. With
	// the load unguarded, `--baseline X --update-baseline` died on ENOENT before
	// it could write X — the advice was self-defeating. Behavioural coverage would
	// need a live-network run, so the guard is pinned by shape over blanked source
	// (comments and strings cannot satisfy it).
	const src = await blankCommentsAndStrings(BENCH_SCRIPT);
	const m = src.match(/if \(args\.baseline([^)]*)\) \{/);
	assert.ok(m, "the baseline load block must exist");
	assert.ok(
		m[1].includes("!args.updateBaseline"),
		"the load must be skipped when the caller is creating the baseline",
	);
});

test("#177: a documented baseline path either exists or the docs name the generator", async () => {
	const src = await readFile(BENCH_SCRIPT, "utf8");
	let committed = true;
	try {
		await readFile(join(__dirname, "..", "scripts", "bench-baseline.json"), "utf8");
	} catch {
		committed = false;
	}
	if (committed) return; // a real baseline makes the documented path honest
	// No baseline in the tree: every place the path is advertised must also say
	// how it comes to exist, or the flag is a trap.
	const advertises = src.includes("bench-baseline.json");
	assert.ok(
		!advertises || /--update-baseline/.test(src),
		"the bench names a baseline path that does not exist without documenting --update-baseline",
	);
	assert.match(
		src,
		/[Nn]o baseline is committed/,
		"the bench must say plainly that no baseline ships, so a reader does not run --baseline expecting a gate",
	);
});

// The grep version of "a missing baseline error names the generator" is gone,
// superseded by the behavioural test above: it sliced 900 characters around a
// literal string, so it verified wording rather than advice, and it broke the
// moment the message was legitimately re-split into missing vs broken.

test("#177: the scheduled bench cannot swallow its own exit status", async () => {
	const wf = await readFile(BENCH_WF, "utf8");
	// Join backslash continuations FIRST. The step wraps across lines, so a
	// same-line scan for `|| true` misses exactly the shape that ships:
	//   node ... bench-extraction.mjs \
	//     "${ARGS[@]}" || true
	// That was the first version of this test, and it passed green while the
	// swallow was restored under it.
	const joined = wf.replace(/\\[ \t]*\n[ \t]*/g, " ");
	const offenders = joined
		.split("\n")
		.map((l, i) => ({ l, i }))
		.filter(
			({ l }) => /bench-extraction\.mjs/.test(l) && /\|\|\s*true/.test(l),
		);
	assert.deepEqual(
		offenders.map((o) => o.l.trim()),
		[],
		"bench.yml must not `|| true` the bench invocation: a job that cannot fail is not a signal",
	);
});

test("#177: baseline diffing compares quality, never latency", async () => {
	// #162 measured identical quality columns and p95 2.5s vs 3.8s on the same
	// code inside one hour, so timing must never become the pass/fail axis.
	// This asserts the axis set, so adding a latency rule is a deliberate edit.
	const src = await readFile(BENCH_SCRIPT, "utf8");
	const fn = src.slice(
		src.indexOf("export function diffAgainstBaseline"),
		src.indexOf("export function diffAgainstBaseline") + 2000,
	);
	for (const type of ['"success-failure"', '"marker-loss"', '"token-swing"']) {
		assert.ok(
			fn.includes(type),
			`the quality axis ${type} must stay in the baseline diff`,
		);
	}
	assert.ok(
		!/type:\s*"(latency|timing|slow)/.test(fn),
		"latency must not become a regression axis (live-network flaps, #162)",
	);
});

// ─── bench-full-search: operator surface (#97) ─────────────────────
// Measured while gathering the n=30 evidence for #97: `--help` is not a mode,
// so the documented entry point runs a LIVE network benchmark instead of printing
// usage — an operator cannot read the flags without spending live samples.
// Quoted pre-fix behaviour:
//   === FULL aio-websearch benchmark: mode=--help (PI_WEBAIO_CDP_BROKER=0), samples=1 ...
//
// Recurrence prevented: a benchmark script whose only "safe" invocation is
// actually a live-network run.
const FULL_BENCH = join(__dirname, "..", "scripts", "bench-full-search.mjs");

test("#97: bench-full-search --help prints usage without sampling", async () => {
	const r = spawnSync(
		process.execPath,
		["--experimental-strip-types", FULL_BENCH, "--help"],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(r.status, 0, `--help must succeed: ${r.stderr}`);
	assert.match(r.stdout, /usage:/i, `no usage block: ${r.stdout.slice(0, 200)}`);
	assert.ok(
		!r.stdout.includes("FULL aio-websearch benchmark"),
		"--help ran a live benchmark instead of printing usage",
	);
});

// The resource section shells out to a `wmic … | find /c /v ""` pipeline that is
// Windows-only. Off Windows it still RUNS: `2>nul` is not a redirect there, so the
// shell creates a file named `nul` and find's errors reach the operator while
// every figure prints as "?". Quoted pre-fix stderr:
//   find: '/c': No such file or directory
//
// Recurrence prevented: a platform-specific measurement that is not gated, so the
// harness #97 depends on reports "?" instead of "not available here".
//
// The check is ordering on blanked source rather than a string match, because
// blankCommentsAndStrings erases literals — `"win32"` becomes `""` — so a
// comparison against the platform name cannot be asserted directly, and a
// comment mentioning win32 must not satisfy the guard either.
test("#97: the Windows-only resource probe is gated before it shells out", async () => {
	const blanked = await blankCommentsAndStrings(FULL_BENCH);
	const fn = blanked.slice(blanked.indexOf("function nodeProcessCount"));
	const body = fn.slice(0, fn.indexOf("\n}") + 2);
	const guard = body.indexOf("platform()");
	const shellout = body.indexOf("execSync");
	assert.ok(shellout >= 0, "the probe no longer shells out — update this test");
	assert.ok(guard >= 0, "nodeProcessCount has no platform() guard");
	assert.ok(
		guard < shellout,
		"the platform guard must precede the first shellout, or the Windows-only " +
			"pipeline runs on POSIX (where `2>nul` creates a file named `nul` and find's " +
			"errors reach the operator)",
	);
});
