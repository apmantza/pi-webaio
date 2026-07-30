// ─── Tests for the observability "small wins" ──────────────────────
// Covers the P1 batch defensive backstops (src/tools/webfetch.ts) and the
// P6 user-vertical load-failure warning (src/verticals/registry.ts) from
// docs/observability-gaps.md. All tests are offline and deterministic.

import assert from "node:assert";
import test from "node:test";

import {
	backfillMissingResults,
	detectErrorMisattribution,
} from "../src/tools/webfetch.ts";
import {
	initUserExtractors,
	getUserExtractors,
} from "../src/verticals/registry.ts";

// ─── P1(a): backfillMissingResults ─────────────────────────────────

test("backfillMissingResults: all slots present → unchanged", () => {
	const targets = ["https://a.example/", "https://b.example/"];
	const results = [
		{ ok: true, url: "https://a.example/", title: "A" },
		{ ok: false, url: "https://b.example/", error: "boom" },
	];
	const out = backfillMissingResults(results, targets);
	assert.strictEqual(out.length, targets.length);
	assert.deepStrictEqual(out, results);
});

test("backfillMissingResults: one undefined slot → explicit error for that target", () => {
	const targets = ["https://a.example/", "https://b.example/"];
	const results = [{ ok: true, url: "https://a.example/", title: "A" }, undefined];
	const out = backfillMissingResults(results, targets);
	assert.strictEqual(out.length, targets.length);
	assert.strictEqual(out[0].ok, true);
	assert.strictEqual(out[1].ok, false);
	assert.strictEqual(out[1].url, "https://b.example/");
	assert.match(out[1].error, /no result recorded/);
});

test("backfillMissingResults: length always === targets.length", () => {
	const targets = ["https://a.example/", "https://b.example/", "https://c.example/"];
	// Shorter results array (a URL was dropped entirely).
	const out = backfillMissingResults([{ ok: true, url: "https://a.example/" }], targets);
	assert.strictEqual(out.length, targets.length);
	assert.strictEqual(out[1].ok, false);
	assert.strictEqual(out[1].url, "https://b.example/");
	assert.strictEqual(out[2].ok, false);
	assert.strictEqual(out[2].url, "https://c.example/");
});

// ─── P1(b): detectErrorMisattribution ──────────────────────────────

test("detectErrorMisattribution: matching URL → false", () => {
	assert.strictEqual(
		detectErrorMisattribution(
			"https://bad.invalid/page",
			"Blocked request to private/internal URL: https://bad.invalid/page [blocked_ssrf]",
		),
		false,
	);
});

test("detectErrorMisattribution: different URL in text → true", () => {
	assert.strictEqual(
		detectErrorMisattribution(
			"https://example.com/",
			"Blocked request to private/internal URL: https://bad.invalid/page [blocked_ssrf]",
		),
		true,
	);
});

test("detectErrorMisattribution: no URL in text → false", () => {
	assert.strictEqual(
		detectErrorMisattribution("https://example.com/", "Fetch failed: timeout"),
		false,
	);
});

test("detectErrorMisattribution: empty inputs → false", () => {
	assert.strictEqual(detectErrorMisattribution(undefined, "https://x.example/"), false);
	assert.strictEqual(detectErrorMisattribution("https://x.example/", undefined), false);
});

// ─── P6: throwing loader produces a console.warn ───────────────────

test("initUserExtractors: a throwing loader warns and leaves registry empty", async () => {
	const warnings = [];
	const origWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		await initUserExtractors(undefined, async () => {
			throw new Error("bad path or syntax error");
		});
	} finally {
		console.warn = origWarn;
	}
	assert.strictEqual(getUserExtractors().length, 0);
	assert.ok(
		warnings.some((w) => w.includes("[user-verticals]") && w.includes("bad path or syntax error")),
		`expected a user-verticals load warning, got: ${JSON.stringify(warnings)}`,
	);
});

test("initUserExtractors: a successful loader registers without warning", async () => {
	const warnings = [];
	const origWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		await initUserExtractors(undefined, async () => [
			{
				name: "custom",
				filePath: "/tmp/custom.mjs",
				matchUrl: () => false,
				extract: async () => null,
			},
		]);
	} finally {
		console.warn = origWarn;
		// Reset registry so we don't leak a fake extractor into other suites.
		await initUserExtractors(undefined, async () => []);
	}
	assert.strictEqual(warnings.length, 0);
});
