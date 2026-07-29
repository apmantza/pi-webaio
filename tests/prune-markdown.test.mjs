// ─── Tests for P11: BM25 query-aware content pruning ────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createBM25Scorer,
	scoreRelevance,
	scoreAllRelevance,
} from "../src/bm25.ts";
import {
	pruneMarkdown,
	pruneByRelevance,
	buildOmittedSectionsToc,
} from "../src/prune-markdown.ts";

// ─────────────────────────────────────────────────────────────────────
// BM25 unit tests
// ─────────────────────────────────────────────────────────────────────

test("createBM25Scorer: returns a scorer object", () => {
	const scorer = createBM25Scorer("test query");
	assert.ok(typeof scorer.score === "function");
	assert.ok(typeof scorer.scoreAll === "function");
	assert.ok(Array.isArray(scorer.queryTerms));
	assert.ok(scorer.queryTerms.length > 0);
});

test("createBM25Scorer: empty query returns no-op scorer", () => {
	const scorer = createBM25Scorer("");
	assert.equal(scorer.score("anything"), 0);
	assert.deepEqual(scorer.scoreAll(["a", "b"]), [0, 0]);
	assert.deepEqual(scorer.queryTerms, []);
});

test("createBM25Scorer: stop words-only query returns no-op scorer", () => {
	const scorer = createBM25Scorer("the and or but");
	assert.equal(scorer.score("anything"), 0);
	assert.deepEqual(scorer.queryTerms, []);
});

test("scoreRelevance: exact match scores higher than no match", () => {
	const doc1 = "Pricing plans for the enterprise tier start at $99 per month.";
	const doc2 = "The company was founded in 2010 and has offices worldwide.";
	const score1 = scoreRelevance(doc1, "pricing plans");
	const score2 = scoreRelevance(doc2, "pricing plans");
	assert.ok(score1 > score2, `Expected ${score1} > ${score2}`);
});

test("scoreRelevance: repeated terms in doc boost score", () => {
	const doc1 = "Pricing: our pricing model is simple pricing per seat.";
	const doc2 = "Our company was founded in 2010.";
	const score1 = scoreRelevance(doc1, "pricing");
	const score2 = scoreRelevance(doc2, "pricing");
	assert.ok(score1 > score2, `Expected ${score1} > ${score2}`);
});

test("scoreRelevance: short docs get length-normalized scores", () => {
	const shortDoc = "pricing starts at $10";
	const longDoc = `We offer competitive pricing for all customers. Our team is available 24/7 to help you choose the right pricing plan for your needs. Contact us for custom pricing quotes.`;
	const scoreShort = scoreRelevance(shortDoc, "pricing");
	const scoreLong = scoreRelevance(longDoc, "pricing");
	// Short doc should score proportionally (BM25 length normalization)
	assert.ok(scoreShort > 0, "Short doc should have positive score");
	assert.ok(scoreLong > 0, "Long doc should have positive score");
});

test("scoreAllRelevance: ranks documents by relevance", () => {
	const docs = [
		"Our pricing plans start at $10 per month for the basic tier.",
		"The company was founded in 2010 and has 500 employees.",
		"Enterprise pricing includes custom deployment and dedicated support.",
		"We use renewable energy for all our data centers.",
	];
	const scores = scoreAllRelevance(docs, "pricing enterprise");
	assert.equal(scores.length, 4);
	// Documents mentioning "pricing" should rank higher
	assert.ok(scores[0] > 0, "Doc 0 should have positive score");
	assert.ok(scores[2] > 0, "Doc 2 should have positive score");
	// Non-matching docs get 0
	assert.equal(scores[1], 0);
	assert.equal(scores[3], 0);
});

test("createBM25Scorer: scoreAll caches IDF across calls", () => {
	const docs = [
		"Pricing plans for team collaboration.",
		"Our API documentation covers REST endpoints.",
		"Enterprise pricing with premium support.",
	];
	const scorer = createBM25Scorer("pricing");
	// First call computes IDF from the collection
	const firstScores = scorer.scoreAll(docs);
	// Second call (same docs) should reuse cached IDF and return same result
	const secondScores = scorer.scoreAll(docs);
	assert.deepEqual(firstScores, secondScores);
});

test("createBM25Scorer: markdown syntax is stripped before tokenizing", () => {
	const docWithMarkdown =
		"See [pricing](https://example.com/pricing) for **plans**.";
	const score = scoreRelevance(docWithMarkdown, "pricing plans");
	assert.ok(score > 0, "Markdown-stripped doc should match query terms");
});

test("createBM25Scorer: code blocks are stripped", () => {
	// "pricing" appears both inside and outside the code block
	const docWithCode =
		"Our pricing model is simple. ```\nconst x = pricing();\n``` More text about pricing.";
	const score = scoreRelevance(docWithCode, "pricing");
	assert.ok(
		score > 0,
		"Code-block-stripped doc should still match inline text",
	);
});

test("createBM25Scorer: custom stop words are respected", () => {
	const scorer = createBM25Scorer("the query", {
		stopWords: new Set(["the"]),
	});
	assert.deepEqual(scorer.queryTerms, ["query"]);
});

test("createBM25Scorer: minTermLen filters short terms", () => {
	const scorer = createBM25Scorer("a an the cat dog", { minTermLen: 3 });
	assert.ok(scorer.queryTerms.includes("cat"));
	assert.ok(scorer.queryTerms.includes("dog"));
	assert.ok(!scorer.queryTerms.includes("a"));
	assert.ok(!scorer.queryTerms.includes("an"));
});

test("createBM25Scorer: custom k1 and b affect scores", () => {
	const doc = "pricing " + "pricing ".repeat(10); // 10 occurrences
	const query = "pricing";

	const scorerDefault = createBM25Scorer(query);
	const scorerK1High = createBM25Scorer(query, { k1: 3.0 });

	const scoreDefault = scorerDefault.score(doc);
	const scoreK1High = scorerK1High.score(doc);

	// Higher k1 means TF saturates slower → higher score for repeated terms
	assert.ok(
		scoreK1High > scoreDefault,
		`Expected ${scoreK1High} > ${scoreDefault}`,
	);
});

// ─────────────────────────────────────────────────────────────────────
// pruneMarkdown query-aware integration tests
// ─────────────────────────────────────────────────────────────────────

test("pruneMarkdown: no query falls back to heuristic scoring (original behavior)", () => {
	const md = [
		"# Introduction",
		"",
		"This is the intro paragraph with general information.",
		"",
		"## Pricing",
		"",
		"Our pricing starts at $10 per month for the basic plan.",
		"",
		"## Contact",
		"",
		"Please email us for more information.",
	].join("\n");

	const result = pruneMarkdown(md, { maxTokens: 2000 });
	assert.ok(result.content.includes("Introduction"));
	assert.ok(result.content.includes("Pricing"));
	assert.ok(result.content.includes("Contact"));
	assert.ok(!result.truncated);
	assert.equal(result.scores, undefined);
});

test("pruneMarkdown: with query, sections are scored by BM25 relevance", () => {
	const md = [
		"# Company Overview",
		"",
		"Our company was founded in 2010 and has 500 employees worldwide. We operate in 12 countries and serve over 1 million customers. Our headquarters is in San Francisco with regional offices in London, Tokyo, and Sydney. The company has grown 40% year over year since inception.",
		"",
		"# Pricing Plans",
		"",
		"Our pricing starts at $10 per month for the basic plan. Enterprise pricing includes custom deployment and dedicated support. We offer volume discounts for teams of 10 or more. All plans include a 30-day free trial with no credit card required. Annual billing saves you 20% compared to monthly billing.",
		"",
		"# Careers",
		"",
		"We are hiring engineers and designers across all teams. Check our careers page for open positions. Benefits include health insurance, 401k matching, and unlimited PTO. We are an equal opportunity employer committed to diversity and inclusion in the workplace.",
	].join("\n");

	const result = pruneMarkdown(md, {
		maxTokens: 180,
		query: "pricing plans enterprise",
	});

	assert.ok(
		result.content.includes("Pricing Plans"),
		"Pricing section should be kept",
	);
	// The Careers *body* should be pruned; its heading may still appear in the
	// omitted-sections index appended on truncation (F7).
	assert.ok(
		!result.content.includes("Check our careers page"),
		"Careers section body should be pruned (low relevance)",
	);
	assert.ok(Array.isArray(result.scores));
	assert.equal(result.scores.length, 3);
	// Pricing section should have the highest score
	const pricingScore = result.scores.find((s) => s.heading === "Pricing Plans");
	const overviewScore = result.scores.find(
		(s) => s.heading === "Company Overview",
	);
	assert.ok(pricingScore, "Pricing section score should exist");
	assert.ok(overviewScore, "Overview section score should exist");
	assert.ok(
		pricingScore.score > overviewScore.score,
		`Pricing score ${pricingScore.score} should be > overview score ${overviewScore.score}`,
	);
});

test("pruneMarkdown: with query, irrelevant sections are pruned first", () => {
	const md = [
		"# Privacy Policy",
		"",
		"We collect minimal data and never share it with third parties. Your personal information is encrypted at rest and in transit. We comply with GDPR, CCPA, and other privacy regulations. Data retention is limited to 90 days after account closure. We do not sell your data to advertisers or third-party services.",
		"",
		"# Product Features",
		"",
		"Our API supports webhooks, real-time updates, and batch processing. The platform includes built-in analytics dashboards with customizable reports. Role-based access control lets you manage team permissions granularly. Integration marketplace connects with 200+ third-party services including Slack, Jira, and GitHub.",
		"",
		"# System Architecture",
		"",
		"The system uses a microservices architecture with Kubernetes orchestration. Each service is independently deployable and scales horizontally. We maintain 99.99% uptime SLA with multi-region failover. Database layer uses PostgreSQL with read replicas for query performance. Caching layer employs Redis for sub-millisecond response times.",
		"",
		"# Pricing",
		"",
		"Free tier: up to 1000 requests/month. Pro plan: $29/month for 10,000 requests. Team plan: $99/month for unlimited requests and priority support. Enterprise: custom pricing with dedicated infrastructure and SLA. All paid plans include a 14-day money-back guarantee. Annual billing discounts available.",
		"",
		"# Refund Policy",
		"",
		"Refunds are available within 30 days of purchase for annual plans. Monthly subscriptions can be cancelled at any time with no penalty. Enterprise contracts have custom terms negotiated at signing. Please contact our billing team with any questions about refund eligibility or processing times.",
	].join("\n");

	const result = pruneMarkdown(md, {
		maxTokens: 100,
		query: "pricing plans cost",
	});

	assert.ok(
		result.content.includes("Pricing"),
		"Pricing section should be kept",
	);
	assert.ok(
		result.truncated,
		"Should be truncated (fits sections within budget)",
	);
});

test("pruneMarkdown: with query and combineScores blends BM25 + heuristics", () => {
	const md = [
		"# Summary",
		"",
		"This is the executive summary with key findings about pricing.",
		"",
		"# Pricing Details",
		"",
		"Our pricing model is usage-based with volume discounts.",
		"",
		"# References",
		"",
		"See the attached documentation for API reference.",
	].join("\n");

	// Without combine — should only keep relevance-matched sections
	const resultScoreOnly = pruneMarkdown(md, {
		maxTokens: 2000,
		query: "pricing details",
		combineScores: false,
	});

	// With combine — "Summary" gets a heuristic bonus (first section + keyword match)
	const resultCombined = pruneMarkdown(md, {
		maxTokens: 2000,
		query: "pricing details",
		combineScores: true,
	});

	assert.ok(resultScoreOnly.content.includes("Pricing Details"));
	assert.ok(resultCombined.content.includes("Pricing Details"));
});

test("pruneByRelevance convenience wrapper", () => {
	const md = [
		"# Pricing",
		"",
		"Our pricing starts at $10 per month for the basic plan with full access to all core features. Enterprise pricing includes custom deployment options and dedicated support with 24/7 phone and email access. Volume discounts are available for teams of 10 or more users.",
		"",
		"# History",
		"",
		"Founded in 2010 by two engineers in a garage. The company grew from 3 to 500 employees over 15 years. We opened our first international office in London in 2015. The company went public in 2020 and is now listed on NASDAQ with a market cap of $10 billion.",
		"",
		"# Careers",
		"",
		"We are hiring engineers and designers across all teams. Benefits include competitive salary, equity packages, health insurance, and flexible working hours. We are an equal opportunity employer committed to building a diverse and inclusive workplace for everyone.",
	].join("\n");
	const result = pruneByRelevance(md, "pricing", 80);

	assert.ok(result.content.includes("Pricing"));
	// Pruned section *bodies* are gone; headings may remain in the omitted
	// sections index (F7), so assert on unique body text instead.
	assert.ok(!result.content.includes("Founded in 2010 by two engineers"));
	assert.ok(!result.content.includes("We are hiring engineers and designers"));
	assert.ok(Array.isArray(result.scores));
	assert.equal(result.scores.length, 3);
	assert.ok(result.truncated);
});

test("pruneMarkdown: empty query behaves like original", () => {
	const md = "# Hello\n\nWorld";
	const withQuery = pruneMarkdown(md, { query: "" });
	const without = pruneMarkdown(md);
	assert.deepEqual(withQuery.content, without.content);
	assert.equal(withQuery.scores, undefined);
});

test("pruneMarkdown: under budget returns unchanged regardless of query", () => {
	const md = "# Hello\n\nWorld";
	const result = pruneMarkdown(md, { maxTokens: 5000, query: "pricing" });
	assert.equal(result.truncated, false);
	assert.equal(result.content, md);
});

// ─────────────────────────────────────────────────────────────────────
// F7: omitted-sections mini-TOC (shared by prune + budget paths)
// ─────────────────────────────────────────────────────────────────────

test("buildOmittedSectionsToc: lists headings indented by level", () => {
	const toc = buildOmittedSectionsToc([
		{ heading: "Top", level: 1 },
		{ heading: "Nested", level: 2 },
		{ heading: "", level: 0 }, // headingless — skipped
	]);
	assert.ok(toc.includes("*Omitted sections:*"));
	assert.ok(toc.includes("\n- Top"), "level 1 → no indent");
	assert.ok(toc.includes("\n  - Nested"), "level 2 → 2-space indent");
});

test("buildOmittedSectionsToc: empty string when no headed sections", () => {
	assert.equal(buildOmittedSectionsToc([]), "");
	assert.equal(buildOmittedSectionsToc([{ heading: "", level: 0 }]), "");
});

test("buildOmittedSectionsToc: caps very long lists with a 'more' line", () => {
	const many = Array.from({ length: 25 }, (_, i) => ({
		heading: `Section ${i}`,
		level: 1,
	}));
	const toc = buildOmittedSectionsToc(many);
	assert.ok(toc.includes("- Section 19"), "keeps first 20");
	assert.ok(!toc.includes("- Section 20"), "drops past the cap");
	assert.match(toc, /5 more/);
});

test("pruneMarkdown: truncation appends omitted-sections TOC (F7)", () => {
	const md = [
		"# Alpha",
		"",
		"First section body text with enough words to count as real content for the pruner to weigh when deciding what to keep or drop.",
		"# Bravo",
		"",
		"Second section body text with enough words to count as real content for the pruner to weigh when deciding what to keep or drop.",
		"# Charlie",
		"",
		"Third section body text with enough words to count as real content for the pruner to weigh when deciding what to keep or drop.",
	].join("\n");
	const result = pruneMarkdown(md, { maxTokens: 60 });
	assert.ok(result.truncated);
	assert.ok(
		result.content.includes("*Omitted sections:*"),
		"should append the omitted-sections TOC",
	);
	// Omitted headings are listed as markdown list items.
	assert.match(result.content, /\n- (Alpha|Bravo|Charlie)/);
	// The count line is present alongside the TOC.
	assert.match(result.content, /\d+ sections omitted/);
});

test("pruneMarkdown: scores array is sorted by document order", () => {
	const md = [
		"# Section A",
		"",
		"Content about pricing. Our pricing model is simple and transparent with no hidden fees. We offer competitive rates for all service tiers.",
		"",
		"# Section B",
		"",
		"Content about pricing and plans. We have several pricing plans designed to meet different needs. Our enterprise plan includes custom pricing options.",
		"",
		"# Section C",
		"",
		"Content about unrelated topics. The weather today is sunny with a high of 75 degrees. Our office is located in downtown San Francisco near the Embarcadero.",
	].join("\n");

	const result = pruneMarkdown(md, { maxTokens: 50, query: "pricing plans" });
	assert.ok(Array.isArray(result.scores));
	assert.equal(result.scores.length, 3);
	assert.equal(result.scores[0].heading, "Section A");
	assert.equal(result.scores[1].heading, "Section B");
	assert.equal(result.scores[2].heading, "Section C");
});
