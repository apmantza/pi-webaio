import assert from "node:assert";
import test from "node:test";
import {
	scoreAndRankResults,
	applyDomainDiversityCap,
	DOMAIN_DIVERSITY_CAP,
	ENGINE_WEIGHTS,
} from "../src/search.ts";

// ─── helpers ───────────────────────────────────────────────────────

function engineSource(engine, result) {
	return { engine, weight: ENGINE_WEIGHTS[engine] || 1, result };
}

function res(url, domain, title = "Title", snippet = "") {
	return { title, url, snippet, domain };
}

// A nonsense query whose terms appear in no document, so BM25 relevance is
// 0 for every result and the diversity cap can be tested in isolation.
const NEUTRAL_QUERY = "zzz qqq xxx";

function domainsInTopSlice(scored, n) {
	return scored.slice(0, n).map((s) => s.result.domain);
}

function countDomain(scored, domain) {
	return scored.filter((s) => s.result.domain === domain).length;
}

// ─── the cap value ─────────────────────────────────────────────────

test("DOMAIN_DIVERSITY_CAP: defaults to 2 (Hound-style max-2-per-domain)", () => {
	assert.strictEqual(DOMAIN_DIVERSITY_CAP, 2);
});

// ─── core cap behavior via scoreAndRankResults ─────────────────────

test("diversity cap: >2 same-domain results are demoted out of the top slice", () => {
	const spam = "spam.example";
	const buckets = new Map();
	// Four high-consensus results all from the same domain — these would
	// naturally occupy the entire top-4 by score.
	for (let i = 1; i <= 4; i++) {
		const url = `https://${spam}/page-${i}`;
		buckets.set(url, [
			engineSource("google", res(url, spam, `Spam Page ${i}`)),
			engineSource("bing", res(url, spam, `Spam Page ${i}`)),
			engineSource("ddg", res(url, spam, `Spam Page ${i}`)),
		]);
	}
	// Three single-engine results from distinct domains, lower score.
	for (const d of ["good-a.com", "good-b.com", "good-c.com"]) {
		const url = `https://${d}/`;
		buckets.set(url, [engineSource("google", res(url, d, `Good ${d}`))]);
	}

	const scored = scoreAndRankResults(buckets, NEUTRAL_QUERY);

	// Recall preserved: nothing dropped.
	assert.strictEqual(scored.length, 7);

	// No domain occupies more than 2 of the top slice.
	const top = domainsInTopSlice(scored, 5);
	const spamInTop = top.filter((d) => d === spam).length;
	assert.ok(
		spamInTop <= 2,
		`expected <=2 ${spam} in top-5, got ${spamInTop}: ${top.join(",")}`,
	);

	// The first two slots are the top spam results; the excess two are
	// demoted to the very end (after all distinct-domain results).
	assert.strictEqual(scored[0].result.domain, spam);
	assert.strictEqual(scored[1].result.domain, spam);
	assert.strictEqual(scored[5].result.domain, spam);
	assert.strictEqual(scored[6].result.domain, spam);
	// The three distinct-domain results fill the middle slots.
	const middle = scored.slice(2, 5).map((s) => s.result.domain).sort();
	assert.deepStrictEqual(middle, ["good-a.com", "good-b.com", "good-c.com"]);
});

test("diversity cap: disabling it (domainCap: 0) lets one domain dominate", () => {
	const spam = "spam.example";
	const buckets = new Map();
	for (let i = 1; i <= 3; i++) {
		const url = `https://${spam}/page-${i}`;
		buckets.set(url, [
			engineSource("google", res(url, spam, `Spam ${i}`)),
			engineSource("bing", res(url, spam, `Spam ${i}`)),
		]);
	}
	const otherUrl = "https://other.com/";
	buckets.set(otherUrl, [engineSource("google", res(otherUrl, "other.com"))]);

	const capped = scoreAndRankResults(buckets, NEUTRAL_QUERY);
	const uncapped = scoreAndRankResults(buckets, NEUTRAL_QUERY, undefined, {
		domainCap: 0,
	});

	// Uncapped: all three spam results lead. Capped: only two do.
	assert.strictEqual(uncapped[0].result.domain, spam);
	assert.strictEqual(uncapped[1].result.domain, spam);
	assert.strictEqual(uncapped[2].result.domain, spam);
	assert.strictEqual(capped[2].result.domain, "other.com");
});

test("diversity cap: distinct-domain results are unaffected", () => {
	const domains = ["a.com", "b.com", "c.com", "d.com", "e.com"];
	const buckets = new Map();
	// Give each a distinct, strictly-decreasing consensus so the expected
	// order is fully determined by score; every domain appears exactly once.
	const engineSets = [
		["google", "bing", "ddg"],
		["google", "bing"],
		["google", "ddg"],
		["google"],
		["yahoo"],
	];
	domains.forEach((d, i) => {
		const url = `https://${d}/`;
		buckets.set(
			url,
			engineSets[i].map((e) => engineSource(e, res(url, d, `Doc ${d}`))),
		);
	});

	const scored = scoreAndRankResults(buckets, NEUTRAL_QUERY);
	assert.deepStrictEqual(
		scored.map((s) => s.result.domain),
		domains,
	);
});

// ─── composition with existing signals ─────────────────────────────

test("diversity cap: preserves sourceType ordering (official-docs still #1)", () => {
	const officialUrl = "https://docs.foo.com/start";
	const buckets = new Map([
		[
			officialUrl,
			[engineSource("google", res(officialUrl, "docs.foo.com", "Foo Docs"))],
		],
	]);
	// Three lower-weight generic-website results from one spammy domain
	// (ddg+brave+yahoo consensus = 13, just under the official-docs 15).
	for (let i = 1; i <= 3; i++) {
		const url = `https://spam.net/p${i}`;
		buckets.set(url, [
			engineSource("ddg", res(url, "spam.net", `Spam ${i}`)),
			engineSource("brave", res(url, "spam.net", `Spam ${i}`)),
			engineSource("yahoo", res(url, "spam.net", `Spam ${i}`)),
		]);
	}

	const scored = scoreAndRankResults(buckets, NEUTRAL_QUERY);
	assert.strictEqual(scored[0].result.url, officialUrl);
	assert.strictEqual(scored[0].result.sourceType, "official-docs");
	// spam.net is capped at 2 in the top slice; the third is demoted.
	assert.strictEqual(countDomain(scored.slice(0, 3), "spam.net"), 2);
});

test("diversity cap: preserves goggles boost across distinct domains", () => {
	const goggles = {
		name: "boost-test",
		rules: [{ domains: ["boost.me"], weight: 20 }],
	};
	const boostUrl = "https://boost.me/";
	const strongUrl = "https://strong.com/";
	const buckets = new Map([
		[boostUrl, [engineSource("google", res(boostUrl, "boost.me", "Boost"))]],
		[
			strongUrl,
			[
				engineSource("google", res(strongUrl, "strong.com", "Strong")),
				engineSource("bing", res(strongUrl, "strong.com", "Strong")),
				engineSource("ddg", res(strongUrl, "strong.com", "Strong")),
			],
		],
	]);

	const scored = scoreAndRankResults(buckets, NEUTRAL_QUERY, goggles);
	// Goggles bonus lifts the single-engine boosted domain above the
	// three-engine consensus; the cap does not interfere (distinct domains).
	assert.strictEqual(scored[0].result.url, boostUrl);
	assert.strictEqual(scored[0].result.goggles?.profile, "boost-test");
	assert.ok(scored[0].score > scored[1].score);
});

test("diversity cap: BM25 relevance breaks ties between equal-score results", () => {
	const relUrl = "https://kube.example.com/deploy";
	const otherUrl = "https://cooking.example.org/recipes";
	const buckets = new Map([
		[
			relUrl,
			[
				engineSource(
					"google",
					res(relUrl, "kube.example.com", "Kubernetes Deployment Guide"),
				),
			],
		],
		[
			otherUrl,
			[
				engineSource(
					"google",
					res(otherUrl, "cooking.example.org", "Cooking Recipes"),
				),
			],
		],
	]);

	// Both are single-engine "website" results (equal base score); the one
	// whose title matches the query must rank first via BM25 relevance.
	const scored = scoreAndRankResults(buckets, "kubernetes deployment");
	assert.strictEqual(scored[0].result.url, relUrl);
	assert.ok(scored[0].score > scored[1].score);
});

// ─── applyDomainDiversityCap unit tests ────────────────────────────

function entry(url, domain, score) {
	return { result: res(url, domain), score, sources: ["google"] };
}

test("applyDomainDiversityCap: demotes excess same-domain entries, keeps recall", () => {
	const input = [
		entry("https://x.com/1", "x.com", 100),
		entry("https://x.com/2", "x.com", 99),
		entry("https://x.com/3", "x.com", 98),
		entry("https://y.com/1", "y.com", 50),
		entry("https://x.com/4", "x.com", 49),
	];
	const out = applyDomainDiversityCap(input, 2);
	assert.strictEqual(out.length, input.length); // recall preserved
	assert.deepStrictEqual(
		out.map((e) => e.result.url),
		[
			"https://x.com/1",
			"https://x.com/2",
			"https://y.com/1",
			"https://x.com/3",
			"https://x.com/4",
		],
	);
});

test("applyDomainDiversityCap: www. and bare domain are the same domain", () => {
	const input = [
		entry("https://www.x.com/1", "www.x.com", 3),
		entry("https://x.com/2", "x.com", 2),
		entry("https://x.com/3", "x.com", 1),
	];
	const out = applyDomainDiversityCap(input, 2);
	// Third same-domain entry (after www-stripping) is deferred.
	assert.strictEqual(out[2].result.url, "https://x.com/3");
	assert.deepStrictEqual(
		out.slice(0, 2).map((e) => e.result.url),
		["https://www.x.com/1", "https://x.com/2"],
	);
});

test("applyDomainDiversityCap: cap <= 0 disables the cap", () => {
	const input = [
		entry("https://x.com/1", "x.com", 3),
		entry("https://x.com/2", "x.com", 2),
		entry("https://x.com/3", "x.com", 1),
	];
	assert.deepStrictEqual(applyDomainDiversityCap(input, 0), input);
	assert.deepStrictEqual(applyDomainDiversityCap(input, -1), input);
});

test("applyDomainDiversityCap: falls back to URL hostname when domain missing", () => {
	const input = [
		{ result: { title: "a", url: "https://x.com/1", snippet: "" }, score: 3, sources: [] },
		{ result: { title: "b", url: "https://x.com/2", snippet: "" }, score: 2, sources: [] },
		{ result: { title: "c", url: "https://x.com/3", snippet: "" }, score: 1, sources: [] },
	];
	const out = applyDomainDiversityCap(input, 2);
	// All three share hostname x.com → third deferred.
	assert.strictEqual(out[2].result.url, "https://x.com/3");
});
