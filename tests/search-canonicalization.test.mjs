// URL canonicalization before search dedup (adopted from the unsloth
// webtools assessment — local note: unsloth_webtools_inspiration.md).
//
// Recurrence this prevents: cross-engine corroboration scoring diluted by
// tracking-param variants. buildResultBuckets keyed on the raw URL string,
// so `https://example.com/a?utm_source=x` and `https://example.com/a`
// landed in different buckets and the same page from DDG and Brave counted
// as two results instead of one corroborated one.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResultBuckets, canonicalizeUrl, dropGoogleRedirectDuplicates, isGoogleRedirectUrl } from "../src/search.ts";

test("canonicalizeUrl strips tracking params, fragments, host case, default port, trailing slash", () => {
	const variants = [
		"https://Example.com:443/a/?utm_source=rss&utm_medium=feed&id=2#section",
		"https://example.com/a?fbclid=abc123&id=2",
		"https://example.com/a?id=2",
	];
	const keys = new Set(variants.map((u) => canonicalizeUrl(u)));
	assert.equal(keys.size, 1, `variants must collapse to one key, got: ${[...keys].join(" | ")}`);
	assert.match(canonicalizeUrl(variants[0]), /id=2/);
	assert.doesNotMatch(canonicalizeUrl(variants[0]), /utm_|fbclid|#|:443|Example\.com/);
});

test("canonicalizeUrl sorts query params so order is irrelevant to the key", () => {
	assert.equal(
		canonicalizeUrl("https://example.com/p?b=2&a=1"),
		canonicalizeUrl("https://example.com/p?a=1&b=2"),
	);
});

test("canonicalizeUrl collapses root trailing slash but keeps distinct paths distinct", () => {
	assert.equal(canonicalizeUrl("https://example.com/"), canonicalizeUrl("https://example.com"));
	assert.notEqual(canonicalizeUrl("https://example.com/a"), canonicalizeUrl("https://example.com/b"));
});

test("canonicalizeUrl leaves non-http(s) and unparseable input unchanged (fail open)", () => {
	assert.equal(canonicalizeUrl("ftp://example.com/file"), "ftp://example.com/file");
	assert.equal(canonicalizeUrl("not a url"), "not a url");
	assert.equal(canonicalizeUrl(""), "");
});

test("isGoogleRedirectUrl recognises only Google /goto and /url wrappers", () => {
	assert.equal(isGoogleRedirectUrl("https://www.google.com/goto?url=CAESabc"), true);
	assert.equal(isGoogleRedirectUrl("https://google.com/url?q=https%3A%2F%2Fx.test"), true);
	assert.equal(isGoogleRedirectUrl("https://docs.python.org/3/library/pathlib.html"), false);
	assert.equal(isGoogleRedirectUrl("https://www.google.com/search?q=x"), false);
	assert.equal(isGoogleRedirectUrl("not a url"), false);
});

// Recurrence this prevents: a live aio-websearch for "Python pathlib Path
// read_text official documentation" returned the SAME page twice — the
// opaque Google /goto?url=CAES… result (title
// "pathlib — Object-oriented filesystem paths", cite docs.python.org) AND the
// direct docs.python.org result whose title carried a trailing suffix. The
// goto target cannot be decoded locally, so dedup has to key on the
// cite-derived domain plus a whole-word title prefix.
test("dropGoogleRedirectDuplicates drops a goto result when a direct result has the same domain and a title prefix", () => {
	const results = [
		{
			title: "pathlib — Object-oriented filesystem paths",
			url: "https://www.google.com/goto?url=CAESaQHrOzAVyKkbmkoKwBNCHSnMetXzPUEAT5bb",
			snippet: "s",
			domain: "docs.python.org",
		},
		{
			title: "pathlib — Object-oriented filesystem paths — Python 3.15.1 documentation",
			url: "https://docs.python.org/3/library/pathlib.html",
			snippet: "s",
			domain: "docs.python.org",
		},
	];
	const out = dropGoogleRedirectDuplicates(results);
	assert.equal(out.length, 1, "the goto duplicate must be dropped");
	assert.equal(out[0].url, "https://docs.python.org/3/library/pathlib.html");
});

test("dropGoogleRedirectDuplicates keeps a goto result that has no direct counterpart", () => {
	const results = [
		{
			title: "Some page",
			url: "https://www.google.com/goto?url=CAESabc",
			snippet: "s",
			domain: "uniquedomain.test",
		},
		{
			title: "A different page",
			url: "https://other.test/page",
			snippet: "s",
			domain: "other.test",
		},
	];
	assert.equal(dropGoogleRedirectDuplicates(results).length, 2);
});

test("dropGoogleRedirectDuplicates never drops a distinct page on the same domain with an unrelated title", () => {
	const results = [
		{
			title: "Installation guide",
			url: "https://www.google.com/goto?url=CAESabc",
			snippet: "s",
			domain: "example.com",
		},
		{
			title: "API reference",
			url: "https://example.com/api",
			snippet: "s",
			domain: "example.com",
		},
	];
	assert.equal(dropGoogleRedirectDuplicates(results).length, 2);
});

test("dropGoogleRedirectDuplicates is a no-op when no goto URLs are present", () => {
	const results = [
		{ title: "a", url: "https://example.com/a", snippet: "s", domain: "example.com" },
		{ title: "b", url: "https://example.com/b", snippet: "s", domain: "example.com" },
	];
	const out = dropGoogleRedirectDuplicates(results);
	assert.deepEqual(out, results);
	assert.equal(out, results, "must return the same reference when nothing to do");
});

test("buildResultBuckets merges tracking-param variants into one bucket, keeping originals", () => {
	const results = [
		{ title: "a", url: "https://example.com/guide?utm_source=x", snippet: "s", domain: "example.com" },
		{ title: "b", url: "https://example.com/guide", snippet: "s", domain: "example.com" },
		{ title: "c", url: "https://example.com/other", snippet: "s", domain: "example.com" },
	];
	const buckets = buildResultBuckets(results, "ddg");
	assert.equal(buckets.size, 2, `expected 2 buckets (guide, other), got ${buckets.size}`);
	const guideBucket = results.length && [...buckets.entries()].find(([, list]) =>
		list.some((e) => e.result.url.includes("/guide?utm_source=x")),
	)?.[1];
	assert.ok(guideBucket, "utm variant must land in the guide bucket");
	assert.equal(guideBucket.length, 2, "guide bucket holds both variants");
	// Original URLs are preserved for display/fetch; only the key canonicalizes.
	assert.deepEqual(
		guideBucket.map((e) => e.result.url).sort(),
		["https://example.com/guide", "https://example.com/guide?utm_source=x"],
	);
});
