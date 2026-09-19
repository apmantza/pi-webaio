// Agent-visible metadata prefix on fetched pages (adopted from the unsloth
// webtools assessment — local note: unsloth_webtools_inspiration.md).
//
// Recurrence this prevents: the extraction pipeline already produces
// author/published/site (PullResult fields, cached-file frontmatter), but the
// agent-visible text only rendered Title/URL/Format — so the model judging a
// page's recency/provenance had to trust the body prose alone.
import assert from "node:assert/strict";
import { test } from "node:test";

import { composeFetchText } from "../src/tools/webfetch.ts";
import { finalizePullResult } from "../src/content.ts";

const base = {
	formatLabel: "✓ Fetched and saved to /tmp/x.md",
	title: "Example Page",
	url: "https://example.com/page",
	format: "markdown",
	showResponseId: false,
	displayContent: "Body text.",
};

test("composeFetchText renders Author/Published/Site lines when present", () => {
	const text = composeFetchText({
		...base,
		author: "Jane Doe",
		published: "2024-01-02",
		site: "example.com",
	});
	assert.match(text, /^Author: Jane Doe$/m);
	assert.match(text, /^Published: 2024-01-02$/m);
	assert.match(text, /^Site: example\.com$/m);
	// Header block order stays stable: metadata lines after Format, before content.
	const titleIdx = text.indexOf("Title: Example Page");
	const authorIdx = text.indexOf("Author: Jane Doe");
	const bodyIdx = text.indexOf("Body text.");
	assert.ok(titleIdx < authorIdx && authorIdx < bodyIdx);
});

test("composeFetchText omits metadata lines entirely when absent (no empty labels)", () => {
	const text = composeFetchText(base);
	assert.doesNotMatch(text, /Author:/);
	assert.doesNotMatch(text, /Published:/);
	assert.doesNotMatch(text, /Site:/);
	assert.match(text, /^Title: Example Page$/m);
});

test("finalizePullResult falls back to the URL hostname for missing Site provenance", () => {
	const result = finalizePullResult({
		ok: true,
		url: "https://example.com/deep/page",
		content: "Body text.",
	});
	assert.equal(result.site, "example.com", "hostname fallback must fill Site");
});

test("finalizePullResult keeps an explicit publisher site over the hostname fallback", () => {
	const result = finalizePullResult({
		ok: true,
		url: "https://example.com/page",
		content: "Body text.",
		site: "Rust Blog",
	});
	assert.equal(result.site, "Rust Blog", "meta-tag publisher name must win");
});

test("finalizePullResult leaves invalid URLs without a Site rather than throwing", () => {
	const result = finalizePullResult({
		ok: true,
		url: "not a url at all",
		content: "Body text.",
	});
	assert.equal(result.site, undefined);
});
