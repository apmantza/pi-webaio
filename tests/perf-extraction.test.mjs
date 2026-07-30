// Performance regression tests for the extraction pipeline reorder (P0)
// and the Defuddle bound / Readability heuristic tuning (P1).
//
// Background (docs/perf-improvements.md):
//   - P0: runHtmlPipeline used to call fetchJina() UNCONDITIONALLY and
//     FIRST for every non-vertical public URL. Jina re-fetches the page we
//     already downloaded and (when blocked/rate-limited) burns ~4–5.5s
//     before returning null and falling through to local extraction. The
//     pipeline now extracts locally first and only tries Jina as a fallback
//     when the local pass yields too few words.
//   - P1: Defuddle is ~14x slower than Readability on large docs; its
//     timeout was tightened and the "readability failed" heuristic tuned so
//     more pages resolve via the cheaper Readability path.
//
// Everything here is offline: the Jina transport is replaced with a spy via
// __setJinaTransportForTests(), and pages are fed as HTML strings through
// runHtmlPipeline(). URLs use public IP literals so the SSRF guard
// (isDangerousUrl) resolves them without any DNS lookup.
import assert from "node:assert";
import test, { afterEach } from "node:test";
import {
	runHtmlPipeline,
	wordCount,
	DEFUDDLE_TIMEOUT,
	MIN_LOCAL_WORDS,
	READABILITY_MIN_RATIO,
	readabilityRatioFailed,
} from "../src/content.ts";
import {
	__setJinaTransportForTests,
	clearJinaNegativeCache,
	isJinaNegativeCached,
	JINA_TIMEOUT_MS,
} from "../src/fetch-jina.ts";

// ─── Fixtures ───────────────────────────────────────────────────────

// A proper article that Readability extracts to well over MIN_LOCAL_WORDS,
// so the pipeline must resolve locally and never touch Jina.
function articleHtml(words = 120) {
	const sentence =
		"Continuous integration is a software engineering practice where " +
		"developers merge their changes into a shared branch frequently " +
		"and verify them with an automated build and test cycle. ";
	const bodyWords = sentence.split(/\s+/).filter(Boolean);
	const para = [];
	while (para.length < words) para.push(...bodyWords);
	const text = para.slice(0, words).join(" ");
	return [
		"<!DOCTYPE html>",
		"<html><head><title>Continuous Integration</title></head>",
		"<body>",
		"<article>",
		"<h1>Continuous Integration</h1>",
		`<p>${text}</p>`,
		`<p>${text}</p>`,
		"</article>",
		"</body></html>",
	].join("\n");
}

// A JS-heavy SPA shell with no server-rendered text. Every local extractor
// (Readability, RSC, Defuddle, fallback) yields ~0 words, so the pipeline
// must fall back to Jina.
const SPA_SHELL = [
	"<!DOCTYPE html>",
	"<html><head><title>App</title></head>",
	"<body>",
	'<div id="root"></div>',
	'<script src="/assets/app.js"></script>',
	"<script>window.__APP__ = { boot: true };</script>",
	"</body></html>",
].join("\n");

/** Install a Jina transport spy; returns the call log. */
function installJinaSpy(result = null) {
	const calls = [];
	__setJinaTransportForTests(async (url) => {
		calls.push(url);
		return result;
	});
	return calls;
}

afterEach(() => {
	__setJinaTransportForTests(null);
	clearJinaNegativeCache();
});

// ─── P0: extraction order (local-first) ────────────────────────────

test("local-first: a page that extracts well locally never calls Jina", async () => {
	const calls = installJinaSpy(null);
	const url = "https://93.184.216.34/articles/continuousIntegration.html";

	const result = await runHtmlPipeline(articleHtml(), url, url, undefined, undefined);

	assert.strictEqual(result.ok, true);
	assert.ok(
		wordCount(result.content) >= MIN_LOCAL_WORDS,
		`expected a substantial local extraction, got ${wordCount(result.content)} words`,
	);
	assert.strictEqual(calls.length, 0, "Jina must not be called for a locally-extractable page");
});

test("fallback: a page that yields too few words locally calls Jina", async () => {
	const calls = installJinaSpy(null); // Jina returns null (blocked)
	const url = "https://93.184.216.34/dashboard";

	await runHtmlPipeline(SPA_SHELL, url, url, undefined, undefined);

	assert.strictEqual(calls.length, 1, "Jina must be tried when local extraction is too thin");
	assert.strictEqual(calls[0], url);
});

test("fallback: a successful Jina result is preferred over a thin local pass", async () => {
	const jinaContent = "Title: Real Article\n\n" + "recovered content word ".repeat(80);
	installJinaSpy({ ok: true, url: "x", title: "Real Article", content: jinaContent });
	const url = "https://93.184.216.34/post";

	const result = await runHtmlPipeline(SPA_SHELL, url, url, undefined, undefined);

	assert.strictEqual(result.ok, true);
	assert.ok(result.content.includes("recovered content"));
	assert.ok(wordCount(result.content) >= MIN_LOCAL_WORDS);
});

// ─── P0: per-domain negative cache ─────────────────────────────────

test("negative cache: a domain that returned null is skipped on the next page", async () => {
	const calls = installJinaSpy(null); // always null → records a failure
	const domain = "https://93.184.216.34";

	// First page on the domain: Jina is attempted and fails.
	await runHtmlPipeline(SPA_SHELL, `${domain}/page-1`, `${domain}/page-1`, undefined, undefined);
	assert.strictEqual(calls.length, 1, "first page should attempt Jina");
	assert.ok(isJinaNegativeCached(`${domain}/anything`), "domain should be negatively cached");

	// Second page on the SAME domain: Jina is skipped via the negative cache.
	await runHtmlPipeline(SPA_SHELL, `${domain}/page-2`, `${domain}/page-2`, undefined, undefined);
	assert.strictEqual(calls.length, 1, "second page on the same domain must skip Jina");

	// A different domain is unaffected and still attempts Jina.
	await runHtmlPipeline(SPA_SHELL, "https://93.184.216.35/x", "https://93.184.216.35/x", undefined, undefined);
	assert.strictEqual(calls.length, 2, "a fresh domain should still attempt Jina");
});

// ─── P0: Jina timeout is bounded ───────────────────────────────────

test("Jina transport is bounded by a short timeout (not smartFetch's 30s)", () =>
{
	assert.ok(JINA_TIMEOUT_MS > 0);
	assert.ok(JINA_TIMEOUT_MS <= 6000, `Jina timeout ${JINA_TIMEOUT_MS}ms should be a few seconds`);
});

test("a hanging Jina transport resolves to null within the timeout", async () => {
	// Transport that never settles on its own — the timeout wrapper must
	// resolve null rather than hang the pipeline.
	__setJinaTransportForTests(() => new Promise(() => {}));
	const url = "https://93.184.216.34/a";

	const started = Date.now();
	const result = await runHtmlPipeline(SPA_SHELL, url, url, undefined, undefined);
	const elapsed = Date.now() - started;

	assert.strictEqual(result.ok, true); // falls back to the (thin) local result
	assert.ok(elapsed < JINA_TIMEOUT_MS + 2000, `pipeline should not hang (took ${elapsed}ms)`);
});

// ─── P1: Defuddle timeout tightened ────────────────────────────────

test("DEFUDDLE_TIMEOUT is tightened from the previous 8000ms", () => {
	assert.ok(DEFUDDLE_TIMEOUT < 8000, "Defuddle timeout should be tighter than the old 8s");
	assert.strictEqual(DEFUDDLE_TIMEOUT, 4000);
});

// ─── P1: Readability ratio heuristic ───────────────────────────────

test("readabilityRatioFailed: just below vs just above the ratio on large HTML", () => {
	const htmlLength = 100000; // > 10KB guard
	const threshold = READABILITY_MIN_RATIO * htmlLength; // 500 chars

	// Just BELOW the ratio → flagged as failed.
	assert.strictEqual(readabilityRatioFailed(Math.floor(threshold) - 1, htmlLength), true);
	// Just ABOVE the ratio → accepted.
	assert.strictEqual(readabilityRatioFailed(Math.ceil(threshold) + 1, htmlLength), false);
});

test("readabilityRatioFailed: small HTML is never ratio-failed", () => {
	// <= 10KB documents skip the ratio check entirely (a small page can
	// legitimately be mostly content).
	assert.strictEqual(readabilityRatioFailed(1, 5000), false);
	assert.strictEqual(readabilityRatioFailed(0, 10000), false);
});
