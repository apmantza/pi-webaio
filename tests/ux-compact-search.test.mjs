import assert from "node:assert";
import test from "node:test";
import {
	renderSearchResults,
	engineStatusNotes,
	buildEngineStatusMap,
} from "../src/search.ts";

// ─── UX3: compact search mode ──────────────────────────────────────
// `aio-websearch` gained an opt-in `compact: true` for URL scouting: one
// line per result (title + URL + sourceType) with no snippet body, while
// the default output stays byte-for-byte unchanged. The per-result
// rendering is the pure `renderSearchResults` helper, so everything here
// is offline — plain result objects, no network, no TUI.

const RESULTS = [
	{
		title: "Playwright Docs",
		url: "https://playwright.dev/docs/intro",
		snippet:
			"Playwright is a framework for Web Testing and Automation. It allows testing across Chromium, WebKit and Firefox.",
		domain: "playwright.dev",
		sources: ["ddg", "brave"],
		sourceType: "official-docs",
	},
	{
		title: "microsoft/playwright",
		url: "https://github.com/microsoft/playwright",
		snippet:
			"Playwright is a Node.js library to automate Chromium, Firefox and WebKit with a single API. Contribute to development.",
		domain: "github.com",
		sources: ["bing"],
		sourceType: "repo",
	},
];

test("compact: each result renders on ONE line with title + URL + sourceType", () => {
	const out = renderSearchResults(RESULTS, { compact: true });
	const lines = out.split("\n");

	// Exactly one line per result — no wrapped URL/snippet continuation lines.
	assert.strictEqual(lines.length, RESULTS.length);

	assert.strictEqual(
		lines[0],
		"1. **Playwright Docs** — https://playwright.dev/docs/intro [official-docs]",
	);
	assert.strictEqual(
		lines[1],
		"2. **microsoft/playwright** — https://github.com/microsoft/playwright [repo]",
	);
});

test("compact: NO snippet body appears in the output", () => {
	const out = renderSearchResults(RESULTS, { compact: true });
	for (const r of RESULTS) {
		assert.ok(!out.includes(r.snippet), `snippet leaked: ${r.snippet}`);
		// The default-mode domain/source tags are also dropped in compact mode.
		assert.ok(!out.includes(`*(${r.domain})*`), "domain tag leaked");
	}
});

test("compact: sourceType falls back to classification when absent", () => {
	// A Google-sourced result carries no pre-classified sourceType; the helper
	// must classify it (github.com → repo) rather than emit "undefined".
	const out = renderSearchResults(
		[
			{
				title: "some repo",
				url: "https://github.com/foo/bar",
				snippet: "should not appear",
				domain: "github.com",
			},
		],
		{ compact: true },
	);
	assert.ok(out.endsWith("[repo]"), `expected [repo] suffix, got: ${out}`);
	assert.ok(!out.includes("undefined"));
});

test("default mode (no compact) is unchanged: snippets + tags present", () => {
	const out = renderSearchResults(RESULTS);
	const lines = out.split("\n");

	// Three lines per result: title line, URL line, snippet line.
	assert.strictEqual(lines.length, RESULTS.length * 3);

	// Title line keeps the historical bold + multi-source tag format.
	assert.strictEqual(
		lines[0],
		"1. **Playwright Docs** *(playwright.dev)* — ddg+brave",
	);
	// URL and snippet are indented on their own lines.
	assert.strictEqual(lines[1], `   ${RESULTS[0].url}`);
	assert.strictEqual(lines[2], `   ${RESULTS[0].snippet}`);

	// Snippet bodies are present in default mode.
	for (const r of RESULTS) assert.ok(out.includes(r.snippet));
});

test("default mode: explicit compact:false matches omitted compact", () => {
	assert.strictEqual(
		renderSearchResults(RESULTS, { compact: false }),
		renderSearchResults(RESULTS),
	);
});

test("compact keeps the non-ok engine note (engineStatusNotes unaffected)", () => {
	// The engine-count header + non-ok notes are assembled in the tool around
	// `renderSearchResults`; compact mode must not suppress them. The notes
	// come from the unchanged `engineStatusNotes` helper, asserted here with a
	// Brave rate-limit + Bing timeout to mirror a real degraded round.
	const status = buildEngineStatusMap([
		{ id: "ddg", httpStatus: 200, count: 20, latencyMs: 1400 },
		{ id: "brave", httpStatus: 429, count: 0, latencyMs: 300, quota: true },
		{
			id: "bing",
			httpStatus: null,
			count: 0,
			latencyMs: 4500,
			skipReason: "timeout",
		},
	]);
	const notes = engineStatusNotes(status);

	// ok (ddg) produces no note; the two degraded engines do.
	assert.deepStrictEqual(notes, [
		"_(Brave: rate-limited / quota exhausted)_",
		"_(Bing: timed out after 4.5s)_",
	]);

	// And the compact result list itself carries none of this — the notes are
	// appended separately by the tool, so compact output stays one-line-per-result.
	const compact = renderSearchResults(RESULTS, { compact: true });
	assert.ok(!compact.includes("Brave"));
	assert.ok(!compact.includes("timed out"));
});
