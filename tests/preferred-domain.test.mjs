import assert from "node:assert";
import test from "node:test";
import {
	inferPreferredDomains,
	scoreAndRankResults,
} from "../src/search.ts";

test("inferPreferredDomains: matches known keywords to canonical domains", () => {
	assert.deepStrictEqual(inferPreferredDomains("prisma migrate guide"), [
		"prisma.io",
	]);
	assert.deepStrictEqual(inferPreferredDomains("vite config"), [
		"vitejs.dev",
		"vite.dev",
	]);
	assert.deepStrictEqual(
		inferPreferredDomains("anthropic claude api docs"),
		["anthropic.com", "docs.anthropic.com"],
	);
});

test("inferPreferredDomains: matches bare 'go' via word boundary, not substrings", () => {
	const domains = inferPreferredDomains("go error handling");
	assert.deepStrictEqual(domains, ["go.dev", "golang.org", "pkg.go.dev"]);

	// "google" contains "go" but must not trigger the golang rule.
	const googleDomains = inferPreferredDomains("google search tips");
	assert.ok(!googleDomains.includes("go.dev"));
});

test("inferPreferredDomains: returns empty array when nothing matches", () => {
	assert.deepStrictEqual(inferPreferredDomains("how to bake bread"), []);
});

test("inferPreferredDomains: dedupes domains contributed by multiple rules", () => {
	const domains = inferPreferredDomains("postgres vs supabase");
	const seen = new Set(domains);
	assert.strictEqual(domains.length, seen.size);
	assert.ok(domains.includes("supabase.com"));
});

test("scoreAndRankResults: a matched official domain outranks an unmatched result with equal engine consensus", () => {
	const buckets = new Map([
		[
			"https://prisma.io/docs/guide",
			[
				{
					result: {
						title: "Prisma Guide",
						url: "https://prisma.io/docs/guide",
						snippet: "Official Prisma docs.",
					},
					engine: "ddg",
					weight: 2,
				},
			],
		],
		[
			"https://some-blog.example.com/prisma-tutorial",
			[
				{
					result: {
						title: "Prisma Tutorial",
						url: "https://some-blog.example.com/prisma-tutorial",
						snippet: "A blog post about Prisma.",
					},
					engine: "ddg",
					weight: 2,
				},
			],
		],
	]);

	const scored = scoreAndRankResults(buckets, "prisma migrate tutorial");

	assert.strictEqual(scored[0].result.url, "https://prisma.io/docs/guide");
	assert.ok(
		scored[0].score > scored[1].score,
		"official domain result should score higher than the unmatched result",
	);
});

test("scoreAndRankResults: no boost applied when query has no preferred domain", () => {
	const buckets = new Map([
		[
			"https://prisma.io/docs/guide",
			[
				{
					result: {
						title: "Prisma Guide",
						url: "https://prisma.io/docs/guide",
						snippet: "Official Prisma docs.",
					},
					engine: "ddg",
					weight: 2,
				},
			],
		],
		[
			"https://some-blog.example.com/random",
			[
				{
					result: {
						title: "Random Post",
						url: "https://some-blog.example.com/random",
						snippet: "Unrelated content.",
					},
					engine: "ddg",
					weight: 2,
				},
			],
		],
	]);

	const scored = scoreAndRankResults(buckets, "how to bake bread");
	assert.strictEqual(scored[0].score, scored[1].score);
});
