// ─── Jina reader envelope must not become page content (issue #165, F7) ───
//
// `parseJinaBody()` consumed only the `Title:` line and returned everything else
// verbatim, so `aio-webfetch("https://example.com")` handed back:
//
//   URL Source: https://example.com/
//   Published Time: Thu, 29 Oct 2026 …
//   Warning: This page maybe not yet fully loaded, consider explicitly specify a timeout.
//   Warning: This is a cached snapshot of the original page, consider retry with caching opt-out.
//   Markdown Content:
//
// Two harms: the agent is served the proxy's own boilerplate as if it were the
// article, and `content.ts` decides "Jina recovered more than local extraction"
// by `wordCount(jina.content) > localWords` — a comparison inflated by the
// wrapper's own words, which on low-word pages means Jina wins on noise.
//
// Recurrence prevented: reader-proxy chrome presented as page content, and a
// fetch-ladder decision driven by the wrapper instead of the page.
import assert from "node:assert";
import test from "node:test";
import { parseJinaBody } from "../src/fetch-jina.ts";

// Captured shape of a real Jina reader response for a tiny page.
const JINA_BODY = `Title: Example Domain

URL Source: https://example.com/
Published Time: Thu, 29 Oct 2026 09:14:22 GMT
Warning: This page maybe not yet fully loaded, consider explicitly specify a timeout.
Warning: This is a cached snapshot of the original page, consider retry with caching opt-out.

Markdown Content:
This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.
`;

test("F7: the reader envelope is stripped from the returned content", () => {
	const r = parseJinaBody(JINA_BODY, "https://example.com");
	assert.ok(r, "a genuine reader response must still parse");
	assert.equal(r.title, "Example Domain");

	for (const needle of [
		"URL Source:",
		"Published Time:",
		"Warning:",
		"Markdown Content:",
	]) {
		assert.ok(
			!r.content.includes(needle),
			`${needle} leaked into page content:\n${r.content.slice(0, 240)}`,
		);
	}
	// The article itself survives.
	assert.match(r.content, /This domain is for use in illustrative examples/);
});

test("F7: the word-count comparison is no longer inflated by the wrapper", () => {
	const r = parseJinaBody(JINA_BODY, "https://example.com");
	assert.ok(r);
	const words = r.content.trim().split(/\s+/).length;
	// The article is ~30 words; the envelope adds ~35 more. The old body
	// measured 60+, which is what let a wrapper beat a real article.
	assert.ok(
		words < 40,
		`content still carries the wrapper (${words} words): ${r.content.slice(0, 160)}`,
	);
});

test("F7: an envelope-only body yields nothing so local extraction runs", () => {
	const envelopeOnly = `Title: Some Page

URL Source: https://slow.example/x
Warning: This page maybe not yet fully loaded, consider explicitly specify a timeout.

Markdown Content:
`;
	const r = parseJinaBody(envelopeOnly, "https://slow.example/x");
	assert.equal(
		r,
		null,
		"no article behind the envelope must fall through, not return empty content",
	);
});

test("F7: a body with no envelope keeps its content untouched", () => {
	const r = parseJinaBody(
		"Title: Plain\n\nJust the article body, nothing else.\n",
		"https://plain.example",
	);
	assert.ok(r);
	assert.equal(r.title, "Plain");
	assert.match(r.content, /^Just the article body, nothing else\.\s*$/);
});

test("F7: clean markdown without a Title line still passes through", () => {
	const r = parseJinaBody(
		"# Heading\n\nReal prose here.\n",
		"https://clean.example",
	);
	assert.ok(r);
	assert.equal(r.title, "clean.example");
	assert.match(r.content, /Real prose here/);
});

test("F7: a challenge body is still rejected (no regression)", () => {
	const challenge = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div class="cf-browser-verification">Verifying that you are not a robot</div></body></html>`;
	assert.equal(parseJinaBody(challenge, "https://blocked.example"), null);
});

test("F7: envelope variants (Retrieved, empty URL Source) are stripped", () => {
	const r = parseJinaBody(
		`Title: Variant

URL Source: https://v.example/
Retrieved: 2026-10-31T10:00:00Z
Markdown Content:
Body text after the headers.
`,
		"https://v.example/",
	);
	assert.ok(r);
	assert.ok(!r.content.includes("Retrieved:"), r.content);
	assert.ok(!r.content.includes("URL Source:"), r.content);
	assert.match(r.content, /Body text after the headers/);
});
