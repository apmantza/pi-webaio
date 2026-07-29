// Regression tests for the Jina challenge-body rejection (fix B) and the
// RSC title hardcode (fix C).
//
// Background: `aio-webfetch` used to save a Cloudflare managed-challenge
// page as "content" with the hostname as "title", because fetchJina()
// returned unconditionally and defaulted the title to the hostname when
// Jina's body lacked a literal "Title:" line. The RSC branch also
// hardcoded the hostname for Next.js SPAs.
//
// These tests exercise the pure decision logic offline (no network):
//   - parseJinaBody()  — the classifier fetchJina() wraps around the fetch
//   - resolveHtmlTitle() + extractRSC() — the RSC branch title resolution
import assert from "node:assert";
import test from "node:test";
import { extractRSC, resolveHtmlTitle } from "../src/content.ts";
import { parseJinaBody } from "../src/fetch-jina.ts";

const URL = "https://weaviate.io/blog/some-post";

// ─── B: fetchJina / parseJinaBody challenge rejection ───────────────

test("parseJinaBody rejects a Cloudflare challenge body (no Title: line)", () => {
	const challenge = [
		"<!DOCTYPE html>",
		"<html>",
		"<head><title>Just a moment...</title></head>",
		"<body>",
		'<div id="challenge-platform">Performing security verification</div>',
		"<script>var cf_chl = 'abc';</script>",
		"</body>",
		"</html>",
	].join("\n");

	// No "Title:" line + challenge markers → must fall through (null),
	// so readability/RSC/defuddle run instead of saving the challenge HTML.
	assert.strictEqual(parseJinaBody(challenge, URL), null);
});

test("parseJinaBody rejects a turnstile/verify-human challenge body", () => {
	const challenge =
		"<!DOCTYPE html><html><body>Verify you are human. <div class='turnstile'></div></body></html>";
	assert.strictEqual(parseJinaBody(challenge, URL), null);
});

test("parseJinaBody keeps a proper 'Title: X' body unchanged", () => {
	const body = "Title: My Article Title\n\nThis is the article body content.";
	const result = parseJinaBody(body, URL);
	assert.ok(result);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.title, "My Article Title");
	assert.strictEqual(result.content, "This is the article body content.");
});

test("parseJinaBody keeps clean markdown without Title: (hostname fallback)", () => {
	const body = "# Heading\n\nSome clean markdown content with several words here.";
	const result = parseJinaBody(body, URL);
	// Not rejected — genuine reader output that simply lacks a Title: line.
	assert.ok(result);
	assert.strictEqual(result.ok, true);
	// Hostname fallback is acceptable here (never used for challenge pages).
	assert.strictEqual(result.title, "weaviate.io");
	assert.strictEqual(result.content, body);
});

test("parseJinaBody returns null on empty body", () => {
	assert.strictEqual(parseJinaBody("   \n  ", URL), null);
});

// ─── C: RSC title resolution ────────────────────────────────────────

const RSC_HTML = [
	"<!DOCTYPE html>",
	"<html>",
	"<head>",
	'<meta property="og:title" content="Weaviate Vector Database Blog" />',
	"<title>Fallback Title Tag</title>",
	"</head>",
	"<body>",
	"<h1>First Heading</h1>",
	"<script>self.__next_f.push([1,\"This is a fairly long readable sentence about server components that should pass the filter because it has many letters and words in it.\"])</script>",
	"</body>",
	"</html>",
].join("\n");

test("RSC fixture extracts content and resolves the real og:title, not hostname", () => {
	// Content still extracts from the Next.js flight data...
	const content = extractRSC(RSC_HTML);
	assert.ok(content, "extractRSC should return content");
	assert.match(content, /fairly long readable sentence/);

	// ...and the title is the real og:title, not the hostname.
	const title = resolveHtmlTitle(RSC_HTML, "https://weaviate.io/blog/some-post");
	assert.strictEqual(title, "Weaviate Vector Database Blog");
	assert.notStrictEqual(title, "weaviate.io");
});

test("resolveHtmlTitle prefers <title> when no og:title is present", () => {
	const html = "<html><head><title>Docs Home</title></head><body><h1>Heading</h1></body></html>";
	assert.strictEqual(resolveHtmlTitle(html, "https://docs.python.org/3/"), "Docs Home");
});

test("resolveHtmlTitle falls back to <h1> when no og:title or <title>", () => {
	const html = "<html><head></head><body><h1>  Page Heading  </h1></body></html>";
	assert.strictEqual(resolveHtmlTitle(html, "https://example.com/x"), "Page Heading");
});

test("resolveHtmlTitle uses hostname only when all real signals are empty", () => {
	const html = "<html><head></head><body><p>just some text, no headings</p></body></html>";
	assert.strictEqual(resolveHtmlTitle(html, "https://example.com/docs"), "example.com");
});

test("resolveHtmlTitle guards against an invalid finalUrl", () => {
	const html = "<html><head></head><body><p>nothing</p></body></html>";
	// No title signals + unparseable URL → empty string, not a throw.
	assert.strictEqual(resolveHtmlTitle(html, "not a url"), "");
});
