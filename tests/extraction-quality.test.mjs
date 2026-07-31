// ─── Extraction-quality tests (frugal selection, CSS cruft, heading fallback) ─
//
// Offline tests for three extraction-quality fixes surfaced during live
// verification of the UX work. The consumer of aio-webfetch is a coding
// AGENT, so the goal is cleaner, more useful extracted markdown:
//
//   Fix 1 — selectFrugalSection(): the frugal preview showcases the largest
//           *content* section, skipping low-value tail sections (References,
//           External links, …) and CSS/link-heavy bodies.
//   Fix 2 — stripCssCruft(): leaked `<style>` blocks and standalone CSS rules
//           are removed from the markdown — but fenced ```css code blocks are
//           preserved verbatim.
//   Fix 3 — extractOutline() heading fallback: a document with ZERO ATX
//           headings (e.g. expressjs.com via Readability's plain textContent)
//           gets conservative heading detection; normal prose and documents
//           with real `#` headings are untouched.
//
// All fixtures are offline and shaped like the real cases. An optional live
// test (network permitting) verifies the real expressjs routing page; it skips
// — never fails — when the network is unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	extractOutline,
	isLowValueHeading,
	isMostlyNonProse,
	selectFrugalSection,
	splitSections,
} from "../src/outline.ts";
import { stripCssCruft } from "../src/content.ts";

// ─── Fix 1: selectFrugalSection ──────────────────────────────────────

test("selectFrugalSection: empty sections → null", () => {
	assert.equal(selectFrugalSection([]), null);
});

test("selectFrugalSection: skips References / External links, picks largest content section", () => {
	const md = [
		"## Summary",
		"A short summary of the topic.",
		"## History",
		"The history section " + "word ".repeat(40).trim(),
		"## References",
		"citation ".repeat(200).trim(), // largest by raw count, but low-value
		"## External links",
		"link ".repeat(150).trim(), // also low-value
	].join("\n\n");
	const sections = splitSections(md);
	const top = selectFrugalSection(sections);
	assert.ok(top);
	assert.equal(top.text, "History"); // largest *content* section
});

test("selectFrugalSection: earlier position breaks a word-count tie", () => {
	const md = [
		"## Alpha",
		"one two three four five",
		"## Beta",
		"six seven eight nine ten", // same 5 words, later in the doc
	].join("\n\n");
	const sections = splitSections(md);
	const top = selectFrugalSection(sections);
	assert.ok(top);
	assert.equal(top.text, "Alpha");
});

test("selectFrugalSection: CSS-heavy section is skipped even when it is the largest", () => {
	const css =
		".mw-parser-output .hlist dl,.mw-parser-output .hlist ol{margin:0;padding:0}";
	const md = [
		"## Overview",
		"A genuinely useful overview paragraph with real prose in it.",
		"## External links",
		// Mostly CSS tokens → non-prose, AND a low-value heading.
		[...Array(30)].map(() => css).join("\n"),
	].join("\n\n");
	const sections = splitSections(md);
	const top = selectFrugalSection(sections);
	assert.ok(top);
	assert.equal(top.text, "Overview");
});

test("selectFrugalSection: a CSS-heavy body under a normal heading is still skipped", () => {
	const cssLine = ".foo{color:#fff;margin:0;padding:0}.bar{display:block}";
	const md = [
		"## Real Prose",
		"This section has ordinary readable prose that an agent would value.",
		"## Styles Dump",
		[...Array(40)].map(() => cssLine).join("\n"),
	].join("\n\n");
	const top = selectFrugalSection(splitSections(md));
	assert.ok(top);
	assert.equal(top.text, "Real Prose");
});

test("selectFrugalSection: all sections low-value → falls back to the FIRST section", () => {
	const md = [
		"## References",
		"citation one two three",
		"## External links",
		"link one two three four five six",
	].join("\n\n");
	const sections = splitSections(md);
	const top = selectFrugalSection(sections);
	assert.ok(top);
	assert.equal(top.text, "References"); // first section, not the largest
});

test("isLowValueHeading: case-insensitive, trailing-punctuation tolerant", () => {
	assert.ok(isLowValueHeading("References"));
	assert.ok(isLowValueHeading("external links"));
	assert.ok(isLowValueHeading("Further Reading:"));
	assert.ok(isLowValueHeading("See also"));
	assert.ok(!isLowValueHeading("History"));
	assert.ok(!isLowValueHeading("References in popular culture")); // not an exact match
});

test("isMostlyNonProse: CSS/link bodies flagged, prose not", () => {
	assert.ok(
		isMostlyNonProse(
			".mw-parser-output .x{margin:0;padding:0} .y{color:#fff;display:block}",
		),
	);
	assert.ok(
		isMostlyNonProse("https://a.com https://b.com https://c.com www.d.com"),
	);
	assert.ok(
		!isMostlyNonProse("This is a normal prose paragraph about a topic."),
	);
	assert.ok(!isMostlyNonProse("")); // empty → not non-prose
});

// ─── Fix 2: stripCssCruft ────────────────────────────────────────────

test("stripCssCruft: removes .mw-parser-output rule cruft + <style> blocks", () => {
	const input = [
		"# Express.js",
		"",
		"<style>.mw-parser-output .infobox{border:1px solid #a2a9b1}</style>",
		"Express.js is a web framework for Node.js.",
		".mw-parser-output .hlist dl,.mw-parser-output .hlist ol{margin:0;padding:0}",
		"It runs on the server.",
	].join("\n");
	const out = stripCssCruft(input);
	assert.ok(out.includes("# Express.js"));
	assert.ok(out.includes("Express.js is a web framework for Node.js."));
	assert.ok(out.includes("It runs on the server."));
	assert.ok(!out.includes(".mw-parser-output"));
	assert.ok(!out.includes("<style>"));
	assert.ok(!out.includes("infobox"));
});

test("stripCssCruft: removes @media/@supports at-rules with nested braces", () => {
	const input = [
		"# Page",
		"",
		"@media(min-width:640px){.mw-parser-output .infobox{margin-left:1em;float:right}}",
		"Real prose here.",
		"@media screen{html.skin-theme-clientpref-night .mw-parser-output .infobox{background:#1f1f23!important}}",
		"@supports (display:grid){.x{display:grid}}",
		"More prose.",
	].join("\n");
	const out = stripCssCruft(input);
	assert.ok(out.includes("# Page"));
	assert.ok(out.includes("Real prose here."));
	assert.ok(out.includes("More prose."));
	assert.ok(!out.includes("@media"));
	assert.ok(!out.includes("@supports"));
	assert.ok(!out.includes("mw-parser-output"));
});

test("stripCssCruft: removes a MULTI-LINE @media at-rule via brace tracking", () => {
	const input = [
		"Before.",
		"@media (min-width: 640px) {",
		"  .mw-parser-output .infobox { margin-left: 1em; }",
		"}",
		"After.",
	].join("\n");
	const out = stripCssCruft(input);
	assert.ok(out.includes("Before."));
	assert.ok(out.includes("After."));
	assert.ok(!out.includes("@media"));
	assert.ok(!out.includes("mw-parser-output"));
});

test("stripCssCruft: leaves prose merely mentioning '@media' untouched", () => {
	const input = "Use @media queries in CSS for responsive design.";
	assert.strictEqual(stripCssCruft(input), input);
});

test("stripCssCruft: removes a multi-line <style> block", () => {
	const input = [
		"Before prose.",
		"<style>",
		".a { color: red; }",
		".b { margin: 0; }",
		"</style>",
		"After prose.",
	].join("\n");
	const out = stripCssCruft(input);
	assert.ok(out.includes("Before prose."));
	assert.ok(out.includes("After prose."));
	assert.ok(!out.includes("color: red"));
	assert.ok(!out.includes("<style>"));
});

test("stripCssCruft: PRESERVES a fenced ```css code block verbatim", () => {
	const cssBlock = [
		"```css",
		".mw-parser-output .hlist dl { margin: 0; padding: 0; }",
		"#id { color: #fff; }",
		"```",
	].join("\n");
	const input = ["Some prose.", "", cssBlock, "", "More prose."].join("\n");
	const out = stripCssCruft(input);
	assert.ok(
		out.includes(cssBlock),
		"fenced css block must be byte-for-byte kept",
	);
	assert.ok(out.includes("Some prose."));
	assert.ok(out.includes("More prose."));
});

test("stripCssCruft: PRESERVES ```scss and ```less fences too", () => {
	for (const lang of ["scss", "less"]) {
		const block = ["```" + lang, ".x { .y { color: red; } }", "```"].join("\n");
		const out = stripCssCruft(["intro", block, "outro"].join("\n"));
		assert.ok(out.includes(block), `${lang} fence preserved`);
	}
});

test("stripCssCruft: leaves normal prose + non-CSS braces untouched", () => {
	const input = [
		"## Heading",
		"A paragraph of ordinary prose that mentions if (x) { y } inline.",
		"- a list item",
		"Another sentence ends here.",
	].join("\n");
	assert.equal(stripCssCruft(input), input);
});

test("stripCssCruft: is idempotent", () => {
	const input = [
		"Prose line.",
		".mw-parser-output .x{margin:0;padding:0}",
		"```css",
		".keep { me: intact; }",
		"```",
		"Trailing prose.",
	].join("\n");
	const once = stripCssCruft(input);
	const twice = stripCssCruft(once);
	assert.equal(twice, once);
});

// ─── Fix 3: heading fallback in extractOutline ───────────────────────

// Shaped like expressjs.com's routing guide as it arrives via Readability's
// plain textContent: clear section titles as short plain-text lines, each
// immediately followed by longer prose, and ZERO ATX (`#`) headings.
const EXPRESSJS_SHAPED = [
	"Routing refers to how an application's endpoints respond to client requests, and this opening paragraph is deliberately long enough to read as prose.",
	"Route methods",
	"A route method is derived from one of the HTTP methods and is attached to an instance of the Express class, which makes this line long enough to be prose.",
	"Route paths",
	"Route paths, in combination with a request method, define the endpoints at which requests can be made, and this sentence is also comfortably long.",
	"String paths",
	"String paths match requests exactly, and the dot and hyphen are interpreted literally, so this line is long enough to count as a prose paragraph.",
	"Regular expressions",
	"Route paths can be regular expressions, which lets you match multiple URLs at once, and again this line is long enough to read as ordinary prose text.",
].join("\n");

test("heading fallback: expressjs-shaped doc (zero #) → headings detected", () => {
	const { headings } = extractOutline(EXPRESSJS_SHAPED);
	const texts = headings.map((h) => h.text);
	assert.ok(texts.includes("Route methods"), `got: ${texts.join(", ")}`);
	assert.ok(texts.includes("Route paths"));
	assert.ok(texts.includes("String paths"));
	assert.ok(texts.includes("Regular expressions"));
	// Inferred level is a sensible 2; word counts are populated.
	for (const h of headings) {
		assert.equal(h.level, 2);
		assert.ok((h.words ?? 0) > 0, `heading "${h.text}" should have a body`);
	}
});

test("heading fallback: normal prose doc with no headings → NO false positives", () => {
	const md = [
		"The quick brown fox jumps over the lazy dog and then keeps running across the field for quite a long distance indeed.",
		"",
		"Meanwhile the second paragraph continues the story with several more clauses, all of which are properly punctuated sentences.",
		"",
		"In the final paragraph the author wraps things up neatly, ending the article with a clear and decisive concluding statement.",
	].join("\n");
	const { headings } = extractOutline(md);
	assert.deepEqual(headings, []);
});

test("heading fallback: does NOT activate when real # headings exist", () => {
	const md = [
		"# Real Heading",
		"",
		"Some prose paragraph that is long enough to be ordinary body text under the heading.",
		"Route methods", // short line that WOULD match the fallback
		"More prose that follows the short line and is long enough to read as a normal paragraph.",
	].join("\n");
	const { headings } = extractOutline(md);
	// Only the real ATX heading — the fallback must stay dormant.
	assert.deepEqual(
		headings.map((h) => h.text),
		["Real Heading"],
	);
});

test("heading fallback: ignores heading-like lines inside fenced code", () => {
	const md = [
		"An opening prose paragraph that is long enough to be treated as ordinary body text by the detector.",
		"```",
		"Route methods",
		"String paths",
		"```",
		"A closing prose paragraph that is also long enough to read as ordinary prose text in the document.",
	].join("\n");
	const { headings } = extractOutline(md);
	assert.deepEqual(headings, []);
});

// ─── Integration: Wikipedia-shaped fixture → clean word counts ───────

test("integration: extractOutline on a Wikipedia-shaped fixture does not count CSS", () => {
	// Run the real extraction step the pipeline uses, then the outline.
	const raw = [
		"## Summary",
		"Express.js is a backend web application framework for Node.js, released as free and open-source software.",
		"## History",
		"Express was created by TJ Holowaychuk and first released in the early 2010s as a lightweight routing layer.",
		"## External links",
		".mw-parser-output .hlist dl,.mw-parser-output .hlist ol{margin:0;padding:0}",
		".mw-parser-output .navbar{display:inline;font-size:88%}",
		".mw-parser-output .infobox{border:1px solid #a2a9b1;background:#f8f9fa}",
	].join("\n");
	const cleaned = stripCssCruft(raw);
	const outline = extractOutline(cleaned);
	const ext = outline.headings.find((h) => h.text === "External links");
	assert.ok(ext, "External links heading still present");
	// The CSS tokens must NOT inflate the section's word count.
	assert.equal(ext.words, 0, `CSS should not be counted, got ${ext.words}`);
	// And a frugal selection must not showcase the CSS-filled section.
	const top = selectFrugalSection(splitSections(cleaned));
	assert.ok(top);
	assert.notEqual(top.text, "External links");
});

// ─── Optional live verification (network permitting) ─────────────────

test("live: extractOutline finds sections on the real expressjs routing page", async (t) => {
	let html;
	try {
		const res = await fetch("https://expressjs.com/en/5x/guide/routing/", {
			headers: { "User-Agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		html = await res.text();
	} catch (err) {
		t.skip(`network unavailable: ${err.message}`);
		return;
	}
	// Mirror the pipeline's local extraction choice (Readability first).
	const { extractReadability, preCleanHtml } = await import(
		"../src/content.ts"
	);
	const r = extractReadability(preCleanHtml(html), "https://expressjs.com/");
	if (!r) {
		t.skip("Readability produced no article for the live page");
		return;
	}
	const { headings } = extractOutline(r.content);
	const texts = headings.map((h) => h.text);
	assert.ok(
		texts.some((x) => /route methods/i.test(x)),
		`expected a Route methods heading, got: ${texts.slice(0, 12).join(", ")}`,
	);
});
