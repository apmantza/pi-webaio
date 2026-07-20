// ─── Tests for src/source-classifier.ts and the ranking integration ───
// in src/search.ts (scoreAndRankResults). No live network fetches.

import assert from "node:assert/strict";
import test from "node:test";
import {
	classifySourceType,
	sourceTypePriority,
	matchesDomain,
	normalizeDomain,
	COMMUNITY_HOSTS,
	NEWS_HOSTS,
	SOCIAL_HOSTS,
} from "../src/source-classifier.ts";
import { scoreAndRankResults } from "../src/search.ts";

// ── classifySourceType ──────────────────────────────────────────────

test("classifySourceType: github.com and gitlab.com are repo", () => {
	assert.equal(classifySourceType("github.com", "", "https://github.com/foo/bar"), "repo");
	assert.equal(classifySourceType("gitlab.com", "", "https://gitlab.com/foo/bar"), "repo");
	// subdomains do not count as the repo host itself
	assert.notEqual(classifySourceType("gist.github.com", "", "https://gist.github.com/x"), "repo");
});

test("classifySourceType: academic hosts and path heuristics", () => {
	assert.equal(classifySourceType("arxiv.org", "", "https://arxiv.org/abs/1234"), "academic");
	assert.equal(classifySourceType("doi.org", "", "https://doi.org/10.1/x"), "academic");
	assert.equal(
		classifySourceType("semanticscholar.org", "", "https://semanticscholar.org/x"),
		"academic",
	);
	assert.equal(
		classifySourceType("api.semanticscholar.org", "", "https://api.semanticscholar.org/x"),
		"academic",
	);
	assert.equal(
		classifySourceType("example.com", "", "https://example.com/paper/123"),
		"academic",
	);
	assert.equal(
		classifySourceType("example.com", "", "https://example.com/pdf/123"),
		"academic",
	);
});

test("classifySourceType: social/community/news host lists", () => {
	assert.equal(classifySourceType("x.com", "Some post"), "social");
	assert.equal(classifySourceType("www.twitter.com", "Some post"), "social");
	assert.equal(classifySourceType("reddit.com", "AMA thread"), "community");
	assert.equal(classifySourceType("old.reddit.com", "AMA thread"), "community");
	assert.equal(classifySourceType("stackoverflow.com", "Q&A"), "community");
	assert.equal(classifySourceType("techcrunch.com", "Startup news"), "news");
	assert.equal(classifySourceType("www.wired.com", "Article"), "news");
});

test("classifySourceType: official-docs via domain prefix, title, or path", () => {
	assert.equal(classifySourceType("docs.example.com", "", "https://docs.example.com/x"), "official-docs");
	assert.equal(classifySourceType("developer.example.com", "", "https://developer.example.com/x"), "official-docs");
	assert.equal(classifySourceType("developers.example.com", "", "https://developers.example.com/x"), "official-docs");
	assert.equal(classifySourceType("api.example.com", "", "https://api.example.com/x"), "official-docs");
	assert.equal(
		classifySourceType("example.com", "Full Documentation", "https://example.com/guide"),
		"official-docs",
	);
	assert.equal(
		classifySourceType("example.com", "Getting started", "https://example.com/docs/intro"),
		"official-docs",
	);
	assert.equal(
		classifySourceType("example.com", "", "https://example.com/reference/api"),
		"official-docs",
	);
});

test("classifySourceType: maintainer-blog and website fallback", () => {
	assert.equal(classifySourceType("blog.example.com", "", "https://blog.example.com/post"), "maintainer-blog");
	assert.equal(classifySourceType("example.com", "", "https://example.com/blog/post"), "maintainer-blog");
	assert.equal(classifySourceType("example.com", "Random title", "https://example.com/about"), "website");
});

test("classifySourceType: precedence — repo/academic/social/community/news beat docs heuristics", () => {
	// github.com with a "docs" path is still "repo", not "official-docs"
	assert.equal(classifySourceType("github.com", "Documentation", "https://github.com/foo/docs"), "repo");
	// a community host with "/docs/" in the path is still "community"
	assert.equal(
		classifySourceType("stackoverflow.com", "docs question", "https://stackoverflow.com/questions/docs/1"),
		"community",
	);
});

test("classifySourceType: empty/missing title and url do not throw", () => {
	assert.equal(classifySourceType("example.com"), "website");
	assert.equal(classifySourceType(""), "website");
});

// ── sourceTypePriority ordering ─────────────────────────────────────

test("sourceTypePriority: matches documented ordering", () => {
	const order = [
		"official-docs",
		"repo",
		"maintainer-blog",
		"website",
		"community",
		"news",
		"social",
	];
	for (let i = 0; i < order.length - 1; i++) {
		assert.ok(
			sourceTypePriority(order[i]) >= sourceTypePriority(order[i + 1]),
			`${order[i]} should not rank below ${order[i + 1]}`,
		);
	}
	assert.equal(sourceTypePriority("repo"), sourceTypePriority("academic"));
	assert.ok(sourceTypePriority("social") < 0, "social must be a net negative");
	assert.equal(sourceTypePriority(undefined), 0);
});

// ── matchesDomain / normalizeDomain helpers ─────────────────────────

test("matchesDomain: exact and subdomain matches, no false positives", () => {
	assert.ok(matchesDomain("reddit.com", COMMUNITY_HOSTS));
	assert.ok(matchesDomain("old.reddit.com", COMMUNITY_HOSTS));
	assert.ok(!matchesDomain("notreddit.com", COMMUNITY_HOSTS));
	assert.ok(matchesDomain("x.com", SOCIAL_HOSTS));
	assert.ok(matchesDomain("techcrunch.com", NEWS_HOSTS));
});

test("normalizeDomain: lowercases and strips leading www.", () => {
	assert.equal(normalizeDomain("WWW.Example.COM"), "example.com");
	assert.equal(normalizeDomain("example.com"), "example.com");
});

// ── scoreAndRankResults integration (issue #61 ranking invariant) ───

function bucketFrom(entries) {
	// entries: [{ url, engine, weight, title, domain }]
	const buckets = new Map();
	for (const e of entries) {
		const list = buckets.get(e.url) || [];
		list.push({
			result: { title: e.title, url: e.url, snippet: "", domain: e.domain },
			engine: e.engine,
			weight: e.weight,
		});
		buckets.set(e.url, list);
	}
	return buckets;
}

test("scoreAndRankResults: single-engine official docs beats generic multi-engine consensus", () => {
	const buckets = bucketFrom([
		// generic website, 3-engine consensus
		{
			url: "https://example.com/some-article",
			engine: "ddg",
			weight: 2,
			title: "Some Article",
			domain: "example.com",
		},
		{
			url: "https://example.com/some-article",
			engine: "brave",
			weight: 2,
			title: "Some Article",
			domain: "example.com",
		},
		{
			url: "https://example.com/some-article",
			engine: "yahoo",
			weight: 1,
			title: "Some Article",
			domain: "example.com",
		},
		// official docs, single engine (google, highest weight)
		{
			url: "https://docs.example.com/guide",
			engine: "google",
			weight: 5,
			title: "Guide",
			domain: "docs.example.com",
		},
	]);

	const ranked = scoreAndRankResults(buckets);
	assert.equal(ranked[0].result.url, "https://docs.example.com/guide");
	assert.equal(ranked[0].result.sourceType, "official-docs");
	assert.equal(ranked[1].result.url, "https://example.com/some-article");
	assert.equal(ranked[1].result.sourceType, "website");
});

test("scoreAndRankResults: multi-engine consensus beats a single-engine community post", () => {
	const buckets = bucketFrom([
		// generic website, multi-engine consensus
		{
			url: "https://example.com/some-article",
			engine: "ddg",
			weight: 2,
			title: "Some Article",
			domain: "example.com",
		},
		{
			url: "https://example.com/some-article",
			engine: "brave",
			weight: 2,
			title: "Some Article",
			domain: "example.com",
		},
		// single-engine community post, even via the highest-weight engine
		{
			url: "https://reddit.com/r/foo/comments/1",
			engine: "google",
			weight: 5,
			title: "Reddit thread",
			domain: "reddit.com",
		},
	]);

	const ranked = scoreAndRankResults(buckets);
	assert.equal(ranked[0].result.url, "https://example.com/some-article");
	assert.equal(ranked[1].result.url, "https://reddit.com/r/foo/comments/1");
	assert.equal(ranked[1].result.sourceType, "community");
});

test("scoreAndRankResults: social results sink even with multi-engine consensus", () => {
	const buckets = bucketFrom([
		{
			url: "https://x.com/foo/status/1",
			engine: "ddg",
			weight: 2,
			title: "A tweet",
			domain: "x.com",
		},
		{
			url: "https://x.com/foo/status/1",
			engine: "brave",
			weight: 2,
			title: "A tweet",
			domain: "x.com",
		},
		{
			url: "https://x.com/foo/status/1",
			engine: "yahoo",
			weight: 1,
			title: "A tweet",
			domain: "x.com",
		},
		{
			url: "https://example.com/some-article",
			engine: "google",
			weight: 5,
			title: "Some Article",
			domain: "example.com",
		},
	]);

	const ranked = scoreAndRankResults(buckets);
	assert.equal(ranked[0].result.url, "https://example.com/some-article");
	assert.equal(ranked[1].result.sourceType, "social");
	assert.ok(ranked[0].score > ranked[1].score);
});

test("scoreAndRankResults: attaches sourceType to every result", () => {
	const buckets = bucketFrom([
		{
			url: "https://github.com/foo/bar",
			engine: "ddg",
			weight: 2,
			title: "foo/bar",
			domain: "github.com",
		},
	]);
	const ranked = scoreAndRankResults(buckets);
	assert.equal(ranked[0].result.sourceType, "repo");
});
