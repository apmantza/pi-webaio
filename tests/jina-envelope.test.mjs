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

// ─── An empty `Title:` value is not "no Title line" ──────────────────
//
// `titleLine` was a single string doing two jobs: `null` meant "no Title line"
// and `""` was unreachable in practice — except when Jina answers `Title: ` with
// no value, which it does. Then `""` is neither `null` (so the challenge check was
// skipped) nor truthy (so the Title branch that slices past the header was
// skipped), and the body fell to the hostname fallback whose `stripJinaEnvelope`
// could not strip anything: `JINA_HEADER_LINE` does not list `Title`, so the loop
// broke on the very first line. Measured before the fix:
//
//   "Title: \n\nURL Source: …\n\nMarkdown Content:\n\n"
//     -> ok, content "Title: \n\nURL Source: https://e.com/\n\nMarkdow…"
//   "Title: \n\n…\n\nMarkdown Content:\n\n# Real\n\ntext"
//     -> ok, content STILL carrying the whole envelope
//   "Title: \n\nJust a moment…\n\nRay ID: abc"
//     -> ok, a Cloudflare CHALLENGE PAGE returned as the article
//
// The third is the serious one: it is the F7 defect recurring through the
// empty-value door, plus a bot-block page accepted as content.
test("F7: an empty Title value still strips the reader envelope", () => {
	const r = parseJinaBody(
		"Title: \n\nURL Source: https://e.com/\n\nMarkdown Content:\n\n# Real\n\ntext",
		"https://e.com/",
	);
	assert.ok(r, "empty title made the response unparseable");
	assert.ok(
		!r.content.includes("Markdown Content:"),
		`envelope served as content: ${JSON.stringify(r.content.slice(0, 60))}`,
	);
	assert.ok(!r.content.includes("URL Source:"), "envelope header left in content");
	assert.equal(r.content.trim(), "# Real\n\ntext");
	// No title to report, so the hostname is used rather than "".
	assert.equal(r.title, "e.com");
});

test("F7: an empty Title with no payload falls through to the real pipeline", () => {
	for (const body of [
		"Title: \n\nURL Source: https://e.com/\n\nMarkdown Content:\n\n",
		"Title: \n",
	]) {
		assert.equal(
			parseJinaBody(body, "https://e.com/"),
			null,
			`${JSON.stringify(body)} returned an empty "successful" page`,
		);
	}
});

test("F7: a challenge page behind an empty Title is rejected, not served", () => {
	const r = parseJinaBody(
		"Title: \n\nJust a moment…\n\nRay ID: abc123\n\nPerformance & security by Cloudflare",
		"https://e.com/",
	);
	assert.equal(r, null, "a bot-challenge page was returned as page content");
});

// A real title must still win over the hostname fallback, and clean markdown
// with no Title line must keep working — the two paths this restructure touches.
test("F7: a real title is kept and title-less markdown still parses", () => {
	const titled = parseJinaBody(
		"Title: Example Domain\n\nMarkdown Content:\n\nThis domain is for use in examples.",
		"https://e.com/",
	);
	assert.ok(titled);
	assert.equal(titled.title, "Example Domain");
	assert.equal(titled.content, "This domain is for use in examples.");

	const bare = parseJinaBody("# Just markdown\n\nBody text.", "https://e.com/");
	assert.ok(bare);
	assert.equal(bare.title, "e.com");
	assert.equal(bare.content, "# Just markdown\n\nBody text.");
});

// ─── A keyword that names a bot-defence PRODUCT is not a challenge ───
// CodeRabbit's second pass on this branch (thread src/fetch-jina.ts:120). The
// challenge screen added here for the empty-title defect tests the whole payload
// for any of nine substrings, so a genuine article ABOUT Cloudflare Turnstile was
// classified as the interstitial it describes. Measured pre-fix:
//   "genuine article about Turnstile" -> NULL (rejected as a challenge)
// and `fetchJina` then skips the remaining pages on that domain, so one article
// about bot defence costs the fallback for the rest of the site.

test("an article that discusses Turnstile is not the Cloudflare interstitial", () => {
	const article = [
		"Title: Implementing Cloudflare Turnstile in a React app",
		"",
		"URL Source: https://blog.example.com/turnstile",
		"",
		"Markdown Content:",
		"# Implementing Cloudflare Turnstile",
		"",
		"Turnstile is a challenge widget. We add turnstile verification to the",
		"signup form and verify the token server-side.",
		"",
		"## Why turnstile",
		"",
		"It replaces CAPTCHA with less friction for real users.",
	].join("\n");
	const r = parseJinaBody(
		article,
		"https://blog.example.com/turnstile",
	);
	assert.ok(r, "a genuine article about bot defence was rejected as a challenge");
	assert.match(r.content, /replaces CAPTCHA/);
});

test("a real interstitial that names turnstile is still rejected", () => {
	// The other side of the same rule: the challenge pages that made the keyword
	// list necessary must stay blocked, because `detectBotBlock()` does not catch
	// plain-text interstitials (measured: "Just a moment… Ray ID" -> blocked:false).
	for (const challenge of [
		"Title: \n\nJust a moment…\nPerforming security verification\nRay ID: 8f3ab1c2d3e4\n",
		"Title: \n\ncf-chl-bypass turnstile widget solving the challenge\nRay ID: 1234abcd\n",
		"Title: \n\nVerify you are human\nChecking your browser before accessing example.com\n",
	]) {
		assert.equal(
			parseJinaBody(challenge, "https://example.com/"),
			null,
			`interstitial not rejected: ${challenge.slice(0, 50)}`,
		);
	}
});

test("a troubleshooting article that says 'access denied' is still kept", () => {
	// CodeRabbit's third pass on my round-2 fix (thread src/fetch-jina.ts:43). The
	// corroboration list I added to stop Turnstile articles being rejected contained
	// `access denied` — a phrase ordinary troubleshooting prose contains, so the
	// new guard reproduced the defect it was written to fix, and `fetchJina` then
	// caches the failure for the host and skips later pages.
	//
	// Recurrence prevented: a corroboration signal broad enough to appear in prose
	// about the product is not corroboration.
	const article = [
		"Title: Debugging Turnstile on our signup form",
		"",
		"URL Source: https://devblog.example.com/turnstile-access-denied",
		"",
		"Markdown Content:",
		"# Turnstile returns access denied",
		"",
		"When the sitekey is wrong, Turnstile returns access denied for every user.",
		"Check the domain allowlist; access denied also appears when the origin",
		"header is stripped by a proxy.",
	].join("\n");
	const r = parseJinaBody(
		article,
		"https://devblog.example.com/turnstile-access-denied",
	);
	assert.ok(
		r,
		"a troubleshooting article was rejected because it used the phrase 'access denied'",
	);
	assert.match(r.content, /domain allowlist/);
});

test("interstitial chrome is still rejected after tightening the context list", () => {
	// The tightening must not cost the real signal. These carry Cloudflare's own
	// interstitial wording. The title is part of the shape: a served
	// interstitial carries "Attention Required! | Cloudflare" or the
	// "Just a moment" heading, and that is what pairs with the body evidence.
	//
	// Recorded gap, deliberately not closed here: a body reading
	// "You are unable to access example.com / Ray ID: …" with an EMPTY title is
	// not rejected, because neither "you are unable to access" nor "ray id" is
	// sufficient on its own — troubleshooting articles routinely quote both. That
	// behaviour predates this branch and is a detection gap, not a regression;
	// widening it is a separate call with its own false-positive cost.
	for (const challenge of [
		"Title: \n\nA turnstile challenge was presented\nRay ID: 9922ab77\n",
		"Title: \n\nAttention Required! | Cloudflare\nperformance & security by cloudflare\n",
		"Title: \n\nAttention Required! | Cloudflare\nYou are unable to access example.com\nRay ID: 8f3ab1c2d3e4\n",
	]) {
		assert.equal(
			parseJinaBody(challenge, "https://example.com/"),
			null,
			`interstitial not rejected: ${challenge.slice(0, 55)}`,
		);
	}
});
