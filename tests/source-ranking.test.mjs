import assert from "node:assert";
import test from "node:test";
import {
	classifySourceType,
	sourceTypePriority,
	inferPreferredDomains,
	scoreAndRankResults,
	ENGINE_WEIGHTS,
} from "../src/search.ts";

// ─── classifySourceType (issue #61) ────────────────────────────────

test("classifySourceType: github.com and gitlab.com are repo", () => {
	assert.strictEqual(
		classifySourceType("github.com", "some/repo", "https://github.com/a/b"),
		"repo",
	);
	assert.strictEqual(
		classifySourceType("gitlab.com", "some/repo", "https://gitlab.com/a/b"),
		"repo",
	);
});

test("classifySourceType: arxiv/doi/semanticscholar and paper/pdf paths are academic", () => {
	assert.strictEqual(classifySourceType("arxiv.org", "", ""), "academic");
	assert.strictEqual(classifySourceType("doi.org", "", ""), "academic");
	assert.strictEqual(
		classifySourceType("semanticscholar.org", "", ""),
		"academic",
	);
	assert.strictEqual(
		classifySourceType("api.semanticscholar.org", "", ""),
		"academic",
	);
	assert.strictEqual(
		classifySourceType(
			"example.com",
			"",
			"https://example.com/paper/12345",
		),
		"academic",
	);
	assert.strictEqual(
		classifySourceType("example.com", "", "https://example.com/pdf/foo.pdf"),
		"academic",
	);
});

test("classifySourceType: known social/community/news hosts", () => {
	assert.strictEqual(classifySourceType("twitter.com", "", ""), "social");
	assert.strictEqual(classifySourceType("x.com", "", ""), "social");
	assert.strictEqual(
		classifySourceType("www.linkedin.com", "", ""),
		"social",
	);
	assert.strictEqual(classifySourceType("dev.to", "", ""), "community");
	assert.strictEqual(
		classifySourceType("stackoverflow.com", "", ""),
		"community",
	);
	assert.strictEqual(classifySourceType("reddit.com", "", ""), "community");
	assert.strictEqual(classifySourceType("techcrunch.com", "", ""), "news");
	assert.strictEqual(classifySourceType("theverge.com", "", ""), "news");
});

test("classifySourceType: docs/developer/api prefixes and doc-ish paths/titles are official-docs", () => {
	assert.strictEqual(
		classifySourceType("docs.example.org", "", "https://docs.example.org/x"),
		"official-docs",
	);
	assert.strictEqual(
		classifySourceType(
			"developer.example.org",
			"",
			"https://developer.example.org/x",
		),
		"official-docs",
	);
	assert.strictEqual(
		classifySourceType(
			"developers.example.org",
			"",
			"https://developers.example.org/x",
		),
		"official-docs",
	);
	assert.strictEqual(
		classifySourceType("api.example.org", "", "https://api.example.org/x"),
		"official-docs",
	);
	assert.strictEqual(
		classifySourceType(
			"example.org",
			"",
			"https://example.org/docs/getting-started",
		),
		"official-docs",
	);
	assert.strictEqual(
		classifySourceType(
			"example.org",
			"",
			"https://example.org/reference/api",
		),
		"official-docs",
	);
	assert.strictEqual(
		classifySourceType("example.org", "Example — Documentation", ""),
		"official-docs",
	);
});

test("classifySourceType: blog. prefix or /blog/ path is maintainer-blog", () => {
	assert.strictEqual(
		classifySourceType("blog.example.org", "", "https://blog.example.org/x"),
		"maintainer-blog",
	);
	assert.strictEqual(
		classifySourceType(
			"example.org",
			"",
			"https://example.org/blog/some-post",
		),
		"maintainer-blog",
	);
});

test("classifySourceType: unmatched generic domain falls back to website", () => {
	assert.strictEqual(
		classifySourceType("example.org", "Some Page", "https://example.org/x"),
		"website",
	);
});

test("classifySourceType: strips www. before matching", () => {
	assert.strictEqual(classifySourceType("www.github.com", "", ""), "repo");
	assert.strictEqual(classifySourceType("www.reddit.com", "", ""), "community");
});

// ─── sourceTypePriority ordering ───────────────────────────────────

test("sourceTypePriority: official-docs ranks highest, social ranks lowest", () => {
	const order = [
		"official-docs",
		"repo",
		"academic",
		"maintainer-blog",
		"website",
		"community",
		"news",
		"social",
	];
	const priorities = order.map((t) => sourceTypePriority(t));
	for (let i = 1; i < priorities.length; i++) {
		assert.ok(
			priorities[i - 1] >= priorities[i],
			`${order[i - 1]} (${priorities[i - 1]}) should be >= ${order[i]} (${priorities[i]})`,
		);
	}
	assert.ok(sourceTypePriority("social") < 0, "social priority must be negative");
});

// ─── inferPreferredDomains (issue #63) ─────────────────────────────

// Assert an exact array-membership by element equality. Written as an explicit
// equality scan rather than `array.includes("host.com")` so CodeQL does not
// misread these domain-literal membership checks as incomplete URL-substring
// sanitization (js/incomplete-url-substring-sanitization false positive).
function hasExactDomain(domains, expected) {
	return domains.some((d) => d === expected);
}

test("inferPreferredDomains: matches known tool/framework keywords", () => {
	assert.deepStrictEqual(
		inferPreferredDomains("how to set up prisma migrations"),
		["prisma.io"],
	);
	assert.ok(hasExactDomain(inferPreferredDomains("vite config"), "vitejs.dev"));
	assert.ok(
		hasExactDomain(inferPreferredDomains("react hooks tutorial"), "react.dev"),
	);
	assert.ok(
		hasExactDomain(
			inferPreferredDomains("anthropic claude api"),
			"anthropic.com",
		),
	);
});

test("inferPreferredDomains: is case-insensitive", () => {
	assert.ok(hasExactDomain(inferPreferredDomains("PRISMA SCHEMA"), "prisma.io"));
});

test("inferPreferredDomains: returns empty array when nothing matches", () => {
	assert.deepStrictEqual(inferPreferredDomains("what is the weather today"), []);
});

test("inferPreferredDomains: dedupes when multiple keywords hit overlapping domains", () => {
	const domains = inferPreferredDomains("vercel next.js deployment");
	const nextjsCount = domains.filter((d) => d === "nextjs.org").length;
	assert.strictEqual(nextjsCount, 1);
});

// ─── scoreAndRankResults ordering invariants (issue #61 + #63) ─────

function engineSource(engine, result) {
	return { engine, weight: ENGINE_WEIGHTS[engine] || 1, result };
}

test("scoreAndRankResults: official #1-ranked single-engine result outranks generic multi-engine consensus", () => {
	const officialUrl = "https://docs.example.org/getting-started";
	const genericUrl = "https://www.contentfarm.net/example-tutorial";

	const buckets = new Map([
		[
			officialUrl,
			[
				engineSource("google", {
					title: "Example Docs — Getting Started",
					url: officialUrl,
					snippet: "",
					domain: "docs.example.org",
				}),
			],
		],
		[
			genericUrl,
			[
				engineSource("ddg", {
					title: "Example Tutorial",
					url: genericUrl,
					snippet: "",
					domain: "www.contentfarm.net",
				}),
				engineSource("brave", {
					title: "Example Tutorial",
					url: genericUrl,
					snippet: "",
					domain: "www.contentfarm.net",
				}),
				engineSource("yahoo", {
					title: "Example Tutorial",
					url: genericUrl,
					snippet: "",
					domain: "www.contentfarm.net",
				}),
			],
		],
	]);

	const scored = scoreAndRankResults(buckets, "example getting started guide");
	assert.strictEqual(scored[0].result.url, officialUrl);
	assert.strictEqual(scored[0].result.sourceType, "official-docs");
	assert.ok(scored[0].score > scored[1].score);
});

test("scoreAndRankResults: multi-engine consensus outranks a single-engine community post", () => {
	const genericUrl = "https://www.someinfo.net/example-guide";
	const communityUrl = "https://dev.to/example-guide";

	const buckets = new Map([
		[
			genericUrl,
			[
				engineSource("ddg", {
					title: "Example Guide",
					url: genericUrl,
					snippet: "",
					domain: "www.someinfo.net",
				}),
				engineSource("yahoo", {
					title: "Example Guide",
					url: genericUrl,
					snippet: "",
					domain: "www.someinfo.net",
				}),
			],
		],
		[
			communityUrl,
			[
				engineSource("ddg", {
					title: "Example Guide (community post)",
					url: communityUrl,
					snippet: "",
					domain: "dev.to",
				}),
			],
		],
	]);

	const scored = scoreAndRankResults(buckets, "example guide");
	assert.strictEqual(scored[0].result.url, genericUrl);
	assert.strictEqual(scored[1].result.sourceType, "community");
	assert.ok(scored[0].score > scored[1].score);
});

test("scoreAndRankResults: preferred-domain match outranks an unmatched result with equal engine consensus", () => {
	const matchedUrl = "https://www.prisma.io/docs-landing";
	const unmatchedUrl = "https://www.unrelated-tips.com/prisma-notes";

	const buckets = new Map([
		[
			matchedUrl,
			[
				engineSource("google", {
					title: "Prisma",
					url: matchedUrl,
					snippet: "",
					domain: "www.prisma.io",
				}),
			],
		],
		[
			unmatchedUrl,
			[
				engineSource("google", {
					title: "Prisma Notes",
					url: unmatchedUrl,
					snippet: "",
					domain: "www.unrelated-tips.com",
				}),
			],
		],
	]);

	// Both classify as "website" (no docs/blog markers), so this isolates the
	// preferred-domain bonus from the source-type bonus.
	assert.strictEqual(
		classifySourceType("www.prisma.io", "Prisma", ""),
		"website",
	);
	assert.strictEqual(
		classifySourceType("www.unrelated-tips.com", "Prisma Notes", ""),
		"website",
	);

	const scored = scoreAndRankResults(buckets, "prisma client setup");
	assert.strictEqual(scored[0].result.url, matchedUrl);
	assert.ok(scored[0].score > scored[1].score);
});

test("scoreAndRankResults: without a query, preferred-domain boost is a no-op", () => {
	const url = "https://www.prisma.io/docs-landing";
	const buckets = new Map([
		[
			url,
			[
				engineSource("google", {
					title: "Prisma",
					url,
					snippet: "",
					domain: "www.prisma.io",
				}),
			],
		],
	]);
	const scored = scoreAndRankResults(buckets);
	assert.strictEqual(scored[0].result.sourceType, "website");
});
