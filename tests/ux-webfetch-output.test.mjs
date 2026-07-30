// ─── UX webfetch output tests (issue #90: UX1/UX2/UX4/UX5/UX6) ────────
//
// Offline tests for the agent-facing output shaping of aio-webfetch:
//   - UX1: extractOutline() heading tree + outline-only display mode
//   - UX2: frugal default preview (outline + largest section) for long content
//   - UX4: pre-fetch relevance signal (wordCount + outline)
//   - UX5: Response ID de-emphasized in the default markdown render
//   - UX6: low-value frontmatter trimmed from the preview (title/url kept)
//
// The success path of execute() does real network I/O and local URLs are
// SSRF-blocked, so — consistent with webfetch-summary.test.mjs and
// token-budget.test.mjs — we test the exported pure helpers directly, plus
// the real session store to prove "display narrows, full content stays
// cached", plus the TUI renderer for the outline view.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	countWords,
	extractOutline,
	renderOutlineText,
	splitSections,
} from "../src/outline.ts";
import {
	buildFrugalPreview,
	buildOutlineDisplay,
	composeFetchText,
	FRUGAL_PREVIEW_THRESHOLD_CHARS,
	trimPreviewFrontmatter,
} from "../src/tools/webfetch.ts";
import {
	applyFormat,
	createResultComponent,
} from "../src/tools/render-result.ts";
import {
	getStoredContent,
	normalizeCacheKey,
	sessionStore,
	storeContent,
} from "../src/session-store.ts";
import { MAX_PREVIEW_CHARS } from "../src/content.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function drop(url) {
	sessionStore.delete(normalizeCacheKey(url));
}

/** Wrap a body the way content.ts does: frontmatter + safety markers. */
function wrap(title, url, body, extraFm = "") {
	return `---\ntitle: "${title}"\nurl: "${url}"${extraFm}\n---\n\n[UNTRUSTED WEB CONTENT START]\n${body}\n[UNTRUSTED WEB CONTENT END]`;
}

/** Minimal theme stub (sentinel tags) for the TUI renderer. */
function makeTheme() {
	const wrapTag = (color, text) => `<${color}>${text}</${color}>`;
	return {
		fg: wrapTag,
		bg: (_c, text) => `<bg>${text}</bg>`,
		bold: (text) => `<b>${text}</b>`,
	};
}

// ─── UX1: extractOutline ─────────────────────────────────────────────

test("extractOutline: heading tree (levels + text) in document order", () => {
	const md = "# Alpha\n\n## Beta\n\n### Gamma\n\n## Delta";
	const { headings } = extractOutline(md);
	assert.deepEqual(
		headings.map((h) => [h.level, h.text]),
		[
			[1, "Alpha"],
			[2, "Beta"],
			[3, "Gamma"],
			[2, "Delta"],
		],
	);
});

test("extractOutline: per-section word counts (words between one heading and the next)", () => {
	const md = "# A\n\none two three\n\n## B\n\nfour five";
	const { headings } = extractOutline(md);
	assert.equal(headings[0].text, "A");
	assert.equal(headings[0].words, 3);
	assert.equal(headings[1].text, "B");
	assert.equal(headings[1].words, 2);
});

test("extractOutline: totalWords counts content words (heading hashes excluded)", () => {
	const md = "# A\n\none two three\n\n## B\n\nfour five";
	const { totalWords } = extractOutline(md);
	// A, one, two, three, B, four, five = 7 (the `#`/`##` markers don't count)
	assert.equal(totalWords, 7);
});

test("extractOutline: a document with no headings yields empty headings + real totalWords", () => {
	const md = "just some plain prose\nwith two lines of text";
	const { headings, totalWords } = extractOutline(md);
	assert.deepEqual(headings, []);
	assert.equal(totalWords, countWords(md));
	assert.ok(totalWords > 0);
});

test("extractOutline: nested levels are preserved (flat list encodes the tree)", () => {
	const md = "# Top\n\n## Mid\n\n### Leaf\n\n#### DeepLeaf\n\n## Mid2";
	const { headings } = extractOutline(md);
	assert.deepEqual(
		headings.map((h) => h.level),
		[1, 2, 3, 4, 2],
	);
});

test("extractOutline: ignores headings inside fenced code blocks", () => {
	const md =
		"# Real\n\n```bash\n# this is a comment, not a heading\n## nor is this\n```\n\n## AlsoReal";
	const { headings } = extractOutline(md);
	assert.deepEqual(
		headings.map((h) => h.text),
		["Real", "AlsoReal"],
	);
});

test("extractOutline: strips frontmatter + safety markers from the analysis", () => {
	const md = wrap(
		"T",
		"https://x",
		"# Heading\n\nbody words here",
		'\nauthor: "A"\nsite: "S"',
	);
	const { headings, totalWords } = extractOutline(md);
	assert.deepEqual(
		headings.map((h) => h.text),
		["Heading"],
	);
	// frontmatter (title/url/author/site) + marker lines must not inflate the count
	assert.equal(totalWords, countWords("Heading body words here"));
});

test("extractOutline: strips an optional ATX closing hash sequence", () => {
	const { headings } = extractOutline("## Section Title ##\n\nbody");
	assert.equal(headings[0].text, "Section Title");
});

test("splitSections: exposes section bodies for the frugal preview", () => {
	const md =
		"# A\n\nsmall\n\n## B\n\nthe largest body by far goes here and here";
	const sections = splitSections(md);
	assert.equal(sections.length, 2);
	assert.equal(sections[0].body, "small");
	assert.ok(sections[1].body.includes("largest body"));
	assert.ok((sections[1].words ?? 0) > (sections[0].words ?? 0));
});

test("renderOutlineText: compact one-line-per-heading render with word counts", () => {
	const outline = extractOutline(
		"# Top\n\n## Sub\n\n" + "word ".repeat(10).trim(),
	);
	const text = renderOutlineText(outline);
	assert.match(text, /^Outline: \d+ words, 2 sections/);
	assert.ok(text.includes("- Top"));
	assert.ok(text.includes("  - Sub")); // level 2 is indented
	assert.ok(/\(10\)/.test(text)); // per-section word count
});

// ─── UX1: outline-only display mode ──────────────────────────────────

test("buildOutlineDisplay: returns the outline, NOT the body, with safety markers", () => {
	const body =
		"# Intro\n\n" +
		"uniquebodyphrase ".repeat(50).trim() +
		"\n\n## API\n\nmore text";
	const md = wrap("T", "https://x", body);
	const display = buildOutlineDisplay(md, { url: "https://x" });
	// Outline content is present…
	assert.ok(display.includes("Outline:"));
	assert.ok(display.includes("- Intro"));
	assert.ok(display.includes("- API"));
	// …but the body is NOT returned…
	assert.ok(!display.includes("uniquebodyphrase"));
	// …and the safety markers + cached-content footer remain.
	assert.ok(display.includes("[UNTRUSTED WEB CONTENT START]"));
	assert.ok(display.includes("[UNTRUSTED WEB CONTENT END]"));
	assert.ok(display.includes("aio-webcontent"));
});

test("outline mode: full content stays cached while only the outline is returned", () => {
	const url = "https://example.com/ux/outline-cached";
	drop(url);
	const body = "# One\n\nuniquecachedbodyphrase\n\n## Two\n\ntail";
	const full = wrap("T", url, body);
	// The worker stores the FULL content before narrowing the display.
	storeContent(url, "T", full);
	const display = buildOutlineDisplay(full, { url });
	// Returned display is the outline only…
	assert.ok(display.includes("- One"));
	assert.ok(!display.includes("uniquecachedbodyphrase"));
	// …but the cache still holds the complete content.
	const cached = getStoredContent(url);
	assert.ok(cached);
	assert.ok(cached.content.includes("uniquecachedbodyphrase"));
	assert.ok(cached.content.includes("[UNTRUSTED WEB CONTENT START]"));
	drop(url);
});

// ─── UX2: frugal default preview for long content ────────────────────

function makeLongDoc() {
	const sections = [
		"# Introduction\n\nA short intro paragraph.",
		"## Setup\n\n" + "setupword ".repeat(50).trim(),
		// The LARGEST section, deliberately placed late in the document.
		"## DeepReferenceGuide\n\n" + "detailedbody ".repeat(600).trim(),
		// A distinctive heading that sits well beyond char 1800.
		"## ZetaAppendix\n\nAppendix notes live here.",
	];
	return wrap("Long", "https://example.com/long", sections.join("\n\n"));
}

test("frugal preview: long doc returns outline + largest section, not a blind 1800-char head", () => {
	const md = makeLongDoc();
	assert.ok(md.length > FRUGAL_PREVIEW_THRESHOLD_CHARS, "fixture must be long");
	const display = buildFrugalPreview(md, { url: "https://example.com/long" });

	// The outline lists EVERY heading — including ZetaAppendix, which sits far
	// beyond char 1800 and a blind head-truncation would miss entirely.
	assert.ok(display.includes("Outline:"));
	assert.ok(display.includes("- Introduction"));
	assert.ok(display.includes("- ZetaAppendix"));
	const blindHead = md.slice(0, MAX_PREVIEW_CHARS);
	assert.ok(
		!blindHead.includes("ZetaAppendix"),
		"sanity: blind head misses it",
	);

	// The largest section's body is shown (DeepReferenceGuide is the biggest).
	assert.ok(display.includes("## DeepReferenceGuide"));
	assert.ok(display.includes("detailedbody"));

	// Safety markers + cached-content footer remain, and the preview is far
	// smaller than the full document (the whole point: token efficiency).
	assert.ok(display.includes("[UNTRUSTED WEB CONTENT START]"));
	assert.ok(display.includes("[UNTRUSTED WEB CONTENT END]"));
	assert.ok(display.includes("aio-webcontent"));
	assert.ok(display.length < md.length);
});

test("frugal preview: full content stays cached while the preview is narrowed", () => {
	const url = "https://example.com/ux/frugal-cached";
	drop(url);
	const full = makeLongDoc();
	storeContent(url, "Long", full);
	const display = buildFrugalPreview(full, { url });
	assert.ok(display.includes("- ZetaAppendix"));
	// The cache still holds the complete content.
	const cached = getStoredContent(url);
	assert.ok(cached);
	assert.equal(cached.content.length, full.length);
	assert.ok(cached.content.includes("detailedbody"));
	drop(url);
});

test("frugal preview: threshold gates the behavior (short docs are unaffected)", () => {
	// The frugal path only kicks in for content longer than the threshold;
	// shorter content keeps the existing full-preview / fixed-teaser behavior.
	assert.equal(FRUGAL_PREVIEW_THRESHOLD_CHARS, 6000);
	assert.ok(MAX_PREVIEW_CHARS < FRUGAL_PREVIEW_THRESHOLD_CHARS);
	const shortDoc = wrap("S", "https://x", "# H\n\n" + "w ".repeat(100).trim());
	assert.ok(shortDoc.length < FRUGAL_PREVIEW_THRESHOLD_CHARS);
	// A medium doc (over the teaser size but under the frugal threshold) still
	// takes the fixed-teaser path, not the frugal one.
	const mediumDoc = wrap(
		"M",
		"https://x",
		"# H\n\n" + "w ".repeat(1500).trim(),
	);
	assert.ok(mediumDoc.length > MAX_PREVIEW_CHARS);
	assert.ok(mediumDoc.length < FRUGAL_PREVIEW_THRESHOLD_CHARS);
});

// ─── UX4: pre-fetch relevance signal ─────────────────────────────────

test("relevance signal: extractOutline feeds wordCount + a compact heading list", () => {
	const md = wrap("T", "https://x", "# A\n\none two\n\n## B\n\nthree");
	const outline = extractOutline(md);
	// details.wordCount ← outline.totalWords ; details.outline ← outline.headings
	assert.equal(typeof outline.totalWords, "number");
	assert.ok(outline.totalWords > 0);
	assert.ok(Array.isArray(outline.headings));
	assert.deepEqual(
		outline.headings.map((h) => h.text),
		["A", "B"],
	);
	// Compact: each heading is just {level, text, words}.
	for (const h of outline.headings) {
		assert.deepEqual(Object.keys(h).sort(), ["level", "text", "words"]);
	}
});

// ─── UX5: Response ID de-emphasized ──────────────────────────────────

test("composeFetchText: default markdown render omits the Response ID line", () => {
	const text = composeFetchText({
		formatLabel: "✓ Fetched and saved to /tmp/x.md",
		title: "T",
		url: "https://x",
		format: "markdown",
		responseId: "rid-secret-123",
		showResponseId: false,
		displayContent: "body",
	});
	assert.ok(!text.includes("Response ID:"), "no standalone Response ID line");
	assert.ok(
		!text.includes("rid-secret-123"),
		"id not leaked into markdown text",
	);
	// Title/URL/Format header lines remain.
	assert.ok(text.includes("Title: T"));
	assert.ok(text.includes("URL: https://x"));
	assert.ok(text.includes("Format: markdown"));
});

test("composeFetchText: Response ID stays available when requested (json/details path)", () => {
	const text = composeFetchText({
		formatLabel: "✓ Fetched as json (10 chars, result ID rid-keep-9)",
		title: "T",
		url: "https://x",
		format: "json",
		responseId: "rid-keep-9",
		showResponseId: true,
		displayContent: "{}",
	});
	assert.ok(text.includes("Response ID: rid-keep-9"));
});

test("UX5: responseId is retained in details (TUI metadata) and in format:json", () => {
	// The TUI still surfaces the ID from details (backward compatible)…
	const theme = makeTheme();
	const comp = createResultComponent(
		{
			title: "x",
			url: "https://x",
			outPath: "/tmp/x.md",
			responseId: "abc-123-def",
			content: "body",
			format: "markdown",
		},
		false,
		theme,
	);
	assert.ok(comp.render(80).join("\n").includes("abc-123-def"));

	// …and format:json keeps the full structured payload (data not removed).
	const out = applyFormat(
		{ ok: true, url: "https://x", title: "x", content: "# body" },
		"json",
		"# body",
	);
	const parsed = JSON.parse(out.body);
	assert.equal(parsed.url, "https://x");
	assert.equal(parsed.content, "# body");
});

// ─── UX6: trim low-value frontmatter from the preview ────────────────

test("trimPreviewFrontmatter: drops low-value fields, keeps title + url + markers", () => {
	const md = wrap(
		"My Title",
		"https://x",
		"# H\n\nbody",
		'\nauthor: "Alice"\npublished: "2026"\nsite: "Example"\nlanguage: "en"\nword_count: 42',
	);
	const trimmed = trimPreviewFrontmatter(md);
	assert.ok(trimmed.includes('title: "My Title"'));
	assert.ok(trimmed.includes('url: "https://x"'));
	assert.ok(!trimmed.includes("author:"));
	assert.ok(!trimmed.includes("published:"));
	assert.ok(!trimmed.includes("site:"));
	assert.ok(!trimmed.includes("language:"));
	assert.ok(!trimmed.includes("word_count:"));
	// Body + safety markers are untouched.
	assert.ok(trimmed.includes("# H"));
	assert.ok(trimmed.includes("[UNTRUSTED WEB CONTENT START]"));
	assert.ok(trimmed.includes("[UNTRUSTED WEB CONTENT END]"));
});

test("trimPreviewFrontmatter: no-op when there is no leading frontmatter", () => {
	const md =
		"[UNTRUSTED WEB CONTENT START]\n# H\n\nbody\n[UNTRUSTED WEB CONTENT END]";
	assert.equal(trimPreviewFrontmatter(md), md);
	const prose = "Just a summary with no frontmatter.";
	assert.equal(trimPreviewFrontmatter(prose), prose);
});

// ─── Safety markers always present ───────────────────────────────────

test("safety markers: present in outline and frugal output", () => {
	const md = wrap("T", "https://x", "# A\n\n" + "w ".repeat(20).trim());
	for (const display of [buildOutlineDisplay(md), buildFrugalPreview(md)]) {
		assert.ok(display.includes("[UNTRUSTED WEB CONTENT START]"));
		assert.ok(display.includes("[UNTRUSTED WEB CONTENT END]"));
	}
});

// ─── TUI: compact outline rendering (UX1) ────────────────────────────

test("createResultComponent: outlineMode renders the heading outline, not the body", () => {
	const theme = makeTheme();
	const comp = createResultComponent(
		{
			title: "x",
			url: "https://x",
			outPath: "/tmp/x.md",
			outlineMode: true,
			wordCount: 42,
			outline: [
				{ level: 1, text: "Intro", words: 10 },
				{ level: 2, text: "DeepSection", words: 32 },
			],
			content: "body-that-should-not-render",
			format: "markdown",
		},
		false,
		theme,
	);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("Outline: 42 words, 2 sections"));
	assert.ok(text.includes("Intro"));
	assert.ok(text.includes("DeepSection"));
	assert.ok(!text.includes("body-that-should-not-render"));
});
