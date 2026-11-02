// ─── Tests for P11: BM25 query-aware content pruning ────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { blankCommentsOnly } from "./helpers.mjs";
import {
	createBM25Scorer,
	scoreRelevance,
	scoreAllRelevance,
} from "../src/bm25.ts";
import {
	pruneMarkdown,
	pruneByRelevance,
	buildOmittedSectionsToc,
	applyTokenBudget,
	trimToTokenBudgetWithClosedFence,
} from "../src/prune-markdown.ts";
import { estimateTokens } from "../src/token-count.ts";

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


// ─────────────────────────────────────────────────────────────────────
// applyTokenBudget: the number the caller passed is the contract
// (#165 — found sweeping the framing-outside-the-budget pattern CodeRabbit
// reported at multi-answer.ts:324)
// ─────────────────────────────────────────────────────────────────────

const BUDGET_DOC = Array.from(
	{ length: 80 },
	(_, i) =>
		`## Section ${i} with a longish heading\n\n${"word ".repeat(40)}`,
).join("\n");

const BUDGET_FM =
	"---\ntitle: A fairly long document title that costs tokens\n---\n\n";

test("applyTokenBudget honours a budget below the old 100-token floor", () => {
	// `effectiveBudget` used to be `Math.max(100, budget)`, so any smaller number
	// was silently raised. That was reachable: the tool schemas set
	// `minimum: 100`, so `budgetTokens: 100` — the smallest legal call — combined
	// with a 25-token header produced 122 tokens from aio-webcontent.
	for (const budget of [40, 60, 80, 99, 100]) {
		const out = applyTokenBudget(
			BUDGET_DOC,
			budget,
			undefined,
			"https://example.com/page",
		);
		assert.ok(
			estimateTokens(out) <= budget,
			`budget ${budget}: got ${estimateTokens(out)} tokens`,
		);
	}
});

test("applyTokenBudget holds the ceiling across every tool-reachable budget", () => {
	// The floor masked a second, real case: when the truncation notice alone was
	// larger than the budget, trimming content to zero still overran. Sweep the
	// legal range rather than pinning one value, in both frontmatter shapes and
	// with and without a query (the two prune scorers differ).
	for (const fm of ["", BUDGET_FM]) {
		for (const query of [undefined, "word"]) {
			for (let budget = 100; budget <= 300; budget += 10) {
				const out = applyTokenBudget(
					fm + BUDGET_DOC,
					budget,
					query,
					"https://example.com/page",
				);
				const used = estimateTokens(out);
				assert.ok(
					used <= budget,
					`fm=${fm ? "yes" : "no"} query=${query ? "yes" : "no"} budget=${budget}: got ${used} (+${used - budget})`,
				);
			}
		}
	}
});

test("a small budget still says the content was truncated", () => {
	// The notice steps down (TOC -> count line -> short forms) instead of being
	// dropped wholesale, so a caller reading the output can still tell it is a
	// partial view.
	for (const budget of [40, 60, 100, 150]) {
		const out = applyTokenBudget(
			BUDGET_DOC,
			budget,
			undefined,
			"https://example.com/page",
		);
		assert.match(
			out,
			/truncated/,
			`budget ${budget}: output gives no sign it was truncated`,
		);
	}
});

test("the frontmatter block is re-emitted verbatim when it fits", () => {
	// The residual this sweep deliberately does not close: a budget smaller than
	// the frontmatter itself cannot be honoured without destroying metadata
	// (measured: budget <= 11 against a 12-token block). It is unreachable through
	// the tools, whose schemas set `minimum: 100`, and through no other caller —
	// `pi-webaio/webfetch` does not reach `applyTokenBudget`. Asserting the
	// reachable behaviour instead of adding machinery for an unreachable input.
	const out = applyTokenBudget(
		BUDGET_FM + BUDGET_DOC,
		100,
		undefined,
		"https://example.com/page",
	);
	assert.ok(
		out.startsWith(BUDGET_FM.trimEnd()),
		"frontmatter was not re-emitted at the top of the result",
	);
	assert.ok(estimateTokens(out) <= 100);
});

test("a budget smaller than the truncation notice itself is still honoured", () => {
	// Reachable, not theoretical: aio-webcontent now charges its header against
	// the budget, and a long URL plus a long title makes that header 83 tokens, so
	// the smallest legal `budgetTokens: 100` asks for a 17-token body. The notice
	// used to be ~30 tokens and was never trimmed, so the body went to zero and
	// the notice alone came back: budget 17 -> 32, and end-to-end 153 against a
	// budget of 100. Recurrence prevented: a hard ceiling that quietly stops being
	// hard once the explanation of the cut outgrows the cut.
	for (const budget of [17, 20, 30, 35]) {
		const out = applyTokenBudget(
			BUDGET_DOC,
			budget,
			undefined,
			"https://example.com/page",
		);
		const used = estimateTokens(out);
		assert.ok(
			used <= budget,
			`budget ${budget}: got ${used} tokens (+${used - budget})`,
		);
	}
});

test("frontmatter larger than the budget does not break the ceiling", () => {
	// CodeRabbit's third pass (thread src/prune-markdown.ts:655). The metadata
	// block is re-emitted verbatim, so a block bigger than the budget could not be
	// honoured by trimming content or shrinking the notice — measured: a 402-token
	// frontmatter against `budgetTokens: 100` came back as 402 tokens, four times
	// the requested ceiling, with the body gone entirely.
	//
	// Policy, now stated: the budget wins over the metadata too. A page whose
	// opening block is bigger than the caller's ceiling gets that block omitted
	// rather than the ceiling ignored; the full document stays cached and is
	// retrievable by URL, which is what the footer points at.
	const bigFrontmatter =
		"---\n" +
		Array.from(
			{ length: 40 },
			(_, i) => `key${i}: value ${i} with some descriptive words here`,
		).join("\n") +
		"\n---\n\n";
	const out = applyTokenBudget(
		bigFrontmatter + BUDGET_DOC,
		100,
		undefined,
		"https://example.com/page",
	);
	const used = estimateTokens(out);
	assert.ok(
		used <= 100,
		`frontmatter larger than the budget returned ${used} tokens (4x the ceiling)`,
	);
});

test("the budget buys page content, not just metadata and a notice", () => {
	// CodeRabbit's fourth pass (threads src/prune-markdown.ts:568 and
	// src/tools/webcontent.ts:56), one root cause: the reserves (frontmatter, the
	// 30-token footer, the pruning threshold) could together consume the entire
	// budget, and whatever got squeezed out was the ONLY thing the caller asked
	// for — the page content. Measured pre-fix:
	//
	//   92-token frontmatter at budget 100 -> 100 tokens of pure YAML, no prose
	//   budget 40..80 on a plain page       -> headings + notice, no prose
	//
	// That is worse than going over budget: the answer looks complete and contains
	// none of the document. Policy: content is the point, so it is reserved first
	// and metadata or the notice is dropped when they cannot coexist with it.
	const bigFm =
		"---\n" +
		Array.from(
			{ length: 10 },
			(_, i) => `key${i}: a descriptive value number ${i} here`,
		).join("\n") +
		"\n---\n\n";
	const out = applyTokenBudget(
		bigFm + BUDGET_DOC,
		100,
		undefined,
		"https://example.com/page",
	);
	assert.match(
		out,
		/word word word/,
		"a 92-token frontmatter left no room for any page content",
	);
});

test("small budgets return the heading skeleton, not a truncated stub", () => {
	// What this actually guarantees, corrected after measuring. The documented
	// contract is "heading structure is preserved, lowest-value sections drop
	// first, and a footer notes omitted sections" — so a 2,400-token document asked
	// for in 60 tokens is answered with headings plus a pointer to the cached whole
	// page, and that is the contract, not a failure. Demanding prose at every budget
	// would assert more than the pruner can deliver: it admits WHOLE sections, and a
	// 48-token section does not fit a 42-token content budget.
	//
	// What WAS broken, and is what this pins: the notice and the frontmatter could
	// consume the whole budget, leaving a literal "#" plus a footer. Measured
	// pre-fix at budget 40: "#\n\n---\n_truncated to fit 40-token budget…" — 35
	// tokens of which 30 were the notice.
	for (const budget of [40, 50, 60, 80, 100, 120, 200]) {
		const out = applyTokenBudget(
			BUDGET_DOC,
			budget,
			undefined,
			"https://example.com/page",
		);
		assert.ok(
			estimateTokens(out) <= budget,
			`budget ${budget}: ${estimateTokens(out)} tokens`,
		);
		assert.match(
			out,
			/Section 0/,
			`budget ${budget}: lost the heading skeleton the contract promises`,
		);
		// The stub case: a single stray "#" is not an answer.
		assert.ok(
			!/\n#\n/.test(`\n${out}\n`) && !out.startsWith("#\n"),
			`budget ${budget}: degenerated to a truncated heading marker`,
		);
	}
});

test("budgets at or above the schema floor return prose too", () => {
	// 100 is the tools' `minimum`, so this is the smallest call a caller can make.
	for (const budget of [100, 120, 200, 400]) {
		const out = applyTokenBudget(
			BUDGET_DOC,
			budget,
			undefined,
			"https://example.com/page",
		);
		assert.match(
			out,
			/word word word/,
			`budget ${budget} (a legal call) returned no page prose`,
		);
		assert.ok(estimateTokens(out) <= budget);
	}
});

// Independent review of the merged budget work (dlg-cf70d5aa) found a shape every
// sweep in this session missed: all fixtures used MANY small sections, so at least
// one always fit the content budget. A body that is ONE section larger than the
// budget is discarded whole, and the answer was 26 tokens of footer out of a
// 100-token budget containing none of the document.
const PLAIN_1200 = "word ".repeat(1200);

test("a single oversized section still yields prose at the schema floor", () => {
	// Pre-fix (measured on merged master ed7ec3a): budget 100 returned 26 tokens and
	// the output was only the truncation notice — with a heading present it was 36
	// tokens and still no prose. The content floor must be satisfied by SOME of the
	// body even when no whole section fits; partial prose beats a footer.
	for (const body of [PLAIN_1200, `## Only Section\n\n${PLAIN_1200}`]) {
		for (const budget of [100, 150, 200]) {
			const out = applyTokenBudget(
				body,
				budget,
				undefined,
				"https://example.com/plain",
			);
			assert.match(
				out,
				/word word word/,
				`budget ${budget} on a single-section body returned no page prose`,
			);
			assert.ok(
				estimateTokens(out) <= budget,
				`budget ${budget}: ${estimateTokens(out)} tokens`,
			);
		}
	}
});

test("frontmatter never survives at the cost of all content", () => {
	// The stated policy: content is reserved first, and metadata is dropped when it
	// cannot coexist with the content floor. Pre-fix, a 6-token frontmatter plus a
	// single oversized section produced frontmatter + notice and zero prose, which
	// contradicts the policy at the legal minimum budget.
	const fm = "---\nk0: value words here\n---\n\n";
	const out = applyTokenBudget(
		fm + PLAIN_1200,
		100,
		undefined,
		"https://example.com/plain",
	);
	assert.match(
		out,
		/word word word/,
		"frontmatter was kept while every page word was dropped",
	);
	assert.ok(estimateTokens(out) <= 100);
});

test("a partial-section fallback is labelled truncated, never as fitting", () => {
	// The footer says "content fits N-token budget" when zero sections were omitted.
	// A partial fallback IS a cut, so emitting that sentence would misreport it.
	const out = applyTokenBudget(
		PLAIN_1200,
		100,
		undefined,
		"https://example.com/plain",
	);
	assert.doesNotMatch(
		out,
		/content fits .*token budget/,
		"a truncated single-section body was labelled as fitting the budget",
	);
	assert.match(out, /truncated to fit/);
});

// CodeRabbit on #169 (threads src/prune-markdown.ts:618 x2). Both are defects in
// the partial fallback itself — the third-round pattern repeating: the fix for
// "answer contains none of the page" was picking the wrong slice of the page.
const EARLY_900 = "## Intro\n\n" + "alpha ".repeat(900);
const LATE_900 = "## Target\n\n" + "zebra ".repeat(900);

test("a query targeting an oversized later section returns THAT section", () => {
	// Pre-fix: query "zebra" returned only "alpha" — the fallback took the document
	// prefix and ignored ranking, so the answer was unrelated prose while the asked
	// for section sat in the cache. The fallback must rank like pruneMarkdown does.
	const doc = `${EARLY_900}\n\n${LATE_900}`;
	const out = applyTokenBudget(doc, 100, "zebra", "https://example.com/two");
	assert.match(
		out,
		/zebra/,
		"the query-targeted section was dropped in favour of the document prefix",
	);
});

test("the fallback keeps later headings, not only the one in the prefix", () => {
	// Pre-fix this was a REGRESSION the fallback introduced: with an empty pruned
	// body the heading-skeleton path ran and every heading survived; once the prefix
	// supplied the first heading, `resultHasHeadings` was true and the skeleton was
	// skipped, so sections 2 and 3 vanished from the outline.
	const doc = `${EARLY_900}\n\n## Second\n\nsmall body words\n\n## Third\n\nmore words here`;
	const out = applyTokenBudget(doc, 100, undefined, "https://example.com/skel");
	for (const h of ["Intro", "Second", "Third"]) {
		assert.ok(
			out.includes(h),
			`heading "${h}" disappeared from the outline because the prefix already had one`,
		);
	}
	assert.ok(estimateTokens(out) <= 100);
});

// CodeRabbit round 6 on #169 (threads src/prune-markdown.ts:666, :667). Both are in
// the fallback's own prefix logic — the same shape repeating for a sixth round.
test("an oversized first heading cannot eat the whole prefix budget", () => {
	// Pre-fix: the output was the heading text twice (skeleton + prefix) and no prose
	// at all, i.e. the fallback still produced an answer with none of the document.
	const longHeading = `# ${"verylongheadingword ".repeat(120)}`;
	// The frontmatter variant is not decoration: after a frontmatter block the body
	// begins with "\n", which defeated a heading-strip anchored at ^ and let the
	// heading fragment back in. Both shapes are asserted.
	const fm = "---\ntitle: A fairly long document title that costs tokens\n---\n\n";
	for (const doc of [
		`${longHeading}\n\n${"prose ".repeat(600)}`,
		`${fm}${longHeading}\n\n${"prose ".repeat(600)}`,
	]) {
		const out = applyTokenBudget(
			doc,
			100,
			undefined,
			"https://example.com/heading",
		);
		assert.match(
			out,
			/prose prose/,
			`an oversized first heading consumed the prefix and no prose survived (${out.includes("---") ? "with" : "without"} frontmatter) — ${JSON.stringify(out.slice(0, 70))}`,
		);
		assert.ok(estimateTokens(out) <= 100);
	}
});

test("a cut inside a fenced block leaves no block open over the footer", () => {
	// Pre-fix the fence count was odd, so the truncation footer was rendered INSIDE
	// the code block and the pointer to the cached page became part of the snippet.
	for (const fence of ["```js", "````", "~~~"]) {
		const close = fence.replace(/[^\s~`]/g, "").length >= 0 ? fence[0].repeat(fence.length) : "`";
		const body = `${fence}\n${"word ".repeat(900)}\n${close}\n`;
		const out = applyTokenBudget(body, 200, undefined, "https://example.com/fence");
		const openRuns = (out.match(/(^|\n)[ \t]*(`{3,}|~{3,})/g) || []).length;
		assert.equal(
			openRuns % 2,
			0,
			`${fence}: unclosed fence left the footer inside the code block — ${JSON.stringify(out.slice(-90))}`,
		);
		assert.ok(estimateTokens(out) <= 200);
	}
});

test("a query-selected section's prose is attributed to its own heading", () => {
	// CodeRabbit round 7 on #169 (src/prune-markdown.ts:667). The fallback emitted the
	// whole heading skeleton and then the selected section's prose with no heading of
	// its own, so Markdown attached that prose to the LAST heading in the skeleton —
	// the answer named the wrong section as the source of its own text.
	const doc =
		"## One\n\n" +
		"a ".repeat(500) +
		"\n\n## Two\n\n" +
		"targetword ".repeat(500) +
		"\n\n## Three\n\n" +
		"c ".repeat(500);
	const out = applyTokenBudget(doc, 120, "targetword", "https://example.com/sel");
	assert.match(out, /targetword/, "the selected section's prose is missing");
	// The prose must directly follow its own heading, not the skeleton's last one.
	const idx = out.indexOf("targetword");
	const preceding = out.slice(0, idx);
	const lastHeading = (preceding.match(/^#{1,6} (.+)$/gm) || []).pop() || "";
	assert.ok(
		/Two/.test(lastHeading),
		`prose is attached to "${lastHeading.trim()}" instead of the section it came from — ${JSON.stringify(out.slice(0, 120))}`,
	);
	assert.ok(estimateTokens(out) <= 120);

	// A stop word scores 0 against every section, so nothing is "selected". That is
	// still not a licence to attach section one's prose to the skeleton's last
	// heading: document order means the FIRST section here, named as such.
	const stopWord = applyTokenBudget(
		doc,
		120,
		"a",
		"https://example.com/sel",
	);
	const sIdx = stopWord.indexOf("a a");
	const sLast =
		(stopWord.slice(0, sIdx).match(/^#{1,6} (.+)$/gm) || []).pop() || "";
	assert.ok(
		/One/.test(sLast),
		`an unranked (stop-word) query attached prose to "${sLast.trim()}" instead of the first section`,
	);
});

// CodeRabbit round 8 on #169 (src/prune-markdown.ts:635). Round 7 fixed attribution for
// the RANKED branch only; the plain no-query fallback still took the whole body while the
// skeleton ended on the last heading, so the same misattribution survived there.
const THREE_SEC =
	"## One\n\n" + "a-word ".repeat(500) +
	"\n\n## Two\n\n" + "b-word ".repeat(500) +
	"\n\n## Three\n\n" + "c-word ".repeat(500);

test("the no-query fallback attributes prose to the first section", () => {
	const out = applyTokenBudget(THREE_SEC, 120, undefined, "https://example.com/nq");
	const idx = out.indexOf("a-word");
	assert.ok(idx >= 0, "no page prose returned");
	const last = (out.slice(0, idx).match(/^#{1,6} (.+)$/gm) || []).pop() || "(none)";
	assert.ok(
		/One/.test(last),
		`no-query fallback attached section one's prose to "${last.trim()}" — ${JSON.stringify(out.slice(0, 100))}`,
	);
	assert.ok(estimateTokens(out) <= 120);
});

test("an unheaded preamble is not labelled with a later heading", () => {
	// A preamble has no heading of its own. Emitting it AFTER the skeleton makes
	// Markdown attribute it to the first real section, inventing a claim about where
	// those words came from.
	const doc =
		"intro preamble words ".repeat(60) +
		"\n\n## One\n\n" +
		"a-word ".repeat(500);
	const out = applyTokenBudget(doc, 120, undefined, "https://example.com/pre");
	const trimmed = out.trimStart();
	assert.ok(
		trimmed.startsWith("intro preamble words"),
		`preamble was emitted after the skeleton and so inherits a heading it does not have — ${JSON.stringify(out.slice(0, 90))}`,
	);
	assert.ok(estimateTokens(out) <= 120);
});

// CodeRabbit round 9 on #169 (src/prune-markdown.ts:710). Round 8 set
// prefixBeforeSkeleton on the NO-query branch only; two paths still select a section
// whose heading never gets emitted, and the prose then lands after the whole outline.
const BIG_PREAMBLE_DOC =
	"intro preamble words ".repeat(400) +
	"\n\n## One\n\n" +
	"a-word ".repeat(500);

test("a headingless section selected BY QUERY is not labelled by the outline", () => {
	// A stop word scores 0 against every section, so sections[0] — the unheaded
	// preamble — is chosen with no heading to emit. Measured pre-fix the answer was
	// `## One` followed by the preamble, i.e. the preamble was credited to section One.
	const out = applyTokenBudget(
		BIG_PREAMBLE_DOC,
		100,
		"a",
		"https://example.com/hq",
	);
	assert.ok(
		out.trimStart().startsWith("intro preamble words"),
		`a query-selected unheaded section was credited to the outline — ${JSON.stringify(out.slice(0, 90))}`,
	);
	assert.ok(estimateTokens(out) <= 100);
});

test("prose from a section whose heading was dropped for size is not relabelled", () => {
	// The outline drops a heading larger than its whole share. The prose that came
	// from behind it must not then be attributed to whichever heading the outline kept.
	const doc =
		"# " + "verylongheadingword ".repeat(120) + "\n\n" +
		"bigprose ".repeat(400) +
		"\n\n## Small\n\n" +
		"s-word ".repeat(400);
	const out = applyTokenBudget(doc, 150, "bigprose", "https://example.com/oh");
	const idx = out.indexOf("bigprose");
	assert.ok(idx >= 0, "no prose from the selected section");
	assert.ok(
		!/#{1,6}\s/.test(out.slice(0, idx)),
		`prose from the oversized-heading section was credited to a kept heading — ${JSON.stringify(out.slice(0, 90))}`,
	);
	assert.ok(estimateTokens(out) <= 150);
});

// ─── Issue #170: the budget model is written, and the code uses it ───
//
// `applyTokenBudget` was patched five consecutive rounds, each round fixing a
// defect the previous round wrote, because nothing stated who spends the budget
// in what order or what each reserve guarantees. The fix is the model itself:
// the caps are named constants and the prose above the function is the authority
// they are derived from. These guards keep the two from drifting apart again —
// a model nobody can check against the code is a comment, not a model.
//
// Recurrence prevented: a sixth round introducing a cap that appears in no model.

test("#170: the budget model names the three invariants it enforces", async () => {
	const src = await readFile(
		new URL("../src/prune-markdown.ts", import.meta.url),
		"utf8",
	);
	const model = src.slice(0, src.indexOf("export function applyTokenBudget("));
	for (const invariant of ["Ceiling", "Content floor", "Attribution"]) {
		assert.ok(
			model.includes(`**${invariant}**`),
			`the model block must state the ${invariant} invariant`,
		);
	}
});

test("#170: every budget cap inside applyTokenBudget is a named constant", async () => {
	// Comments are REMOVED (not just strings blanked): the file's prose mentions
	// "0.4 × contentBudget" throughout, so a comment must not be able to satisfy
	// this scan. Comment-only blanking is also the safe choice — blanking string
	// literals after comments are gone lets a leftover quote pair with a later one
	// and swallow the function body, which is what this test originally did to
	// itself. It failed loudly, which is the good direction.
	//
	// Fail-closed on the SHAPE of a cap, not on a list of bad spellings. An
	// earlier version of this guard looked for the exact strings "* 0.4" and
	// "Math.max(10,", which passes "*0.4", "* 0.40" and "0.400" — an enumeration
	// of known-bad spellings, the exact anti-pattern this repo calls out. Instead:
	// nothing may be multiplied by a numeric literal, and no Math.max/min may take
	// a numeric bound other than 0 or 1 (the two structural floors: "no budget",
	// "no room"). Any new cap therefore has to be a named constant in the model.
	const src = await blankCommentsOnly(
		new URL("../src/prune-markdown.ts", import.meta.url),
	);
	const start = src.indexOf("export function applyTokenBudget(");
	const end = src.indexOf("function shrinkNoticeToRoom", start);
	assert.ok(start > 0 && end > start, "could not isolate the function body");
	const body = src.slice(start, end);

	const mult = body.match(/\*\s*[\d.]/g) ?? [];
	assert.deepEqual(mult, [], `numeric multiplier reintroduced: ${mult.join(", ")}`);

	const bounds = body.match(/Math\.(?:max|min)\(\s*(?!0\b|1\b)[\d.]+/g) ?? [];
	assert.deepEqual(bounds, [], `numeric budget bound reintroduced: ${bounds.join(", ")}`);

	// A cap can also be smuggled in as an ARGUMENT to the helper rather than a
	// literal in an expression — `outlineBudget(contentBudget, 0.4)` keeps both
	// call sites and the multiplier check never sees it. Every argument to a budget
	// helper must be a name, so the number always lives in the model.
	const helperArgs = body.match(/outlineBudget\([^)]*[\d.]/g) ?? [];
	assert.deepEqual(
		helperArgs,
		[],
		`numeric argument passed to a budget helper: ${helperArgs.join(", ")}`,
	);

	const uses = (body.match(/outlineBudget\(/g) ?? []).length;
	// The outline share was spelled twice as two independent literals; one rule
	// now has one expression, called from both places.
	assert.ok(
		uses >= 2,
		`both outline sites must share one budget expression, got ${uses}`,
	);
});

test("#170: the spend-order table does not over-claim the content floor", async () => {
	// The table row and invariant 2 are two sentences about the same guarantee, and
	// the first draft of this PR had them disagreeing: the row said the floor means
	// "some of the document always survives" while the invariant and a test had just
	// established budgets 1..27 yield framing only. A model that contradicts itself
	// in two places is worse than no model, because a reader cannot tell which half
	// the code honours.
	const src = await readFile(
		new URL("../src/prune-markdown.ts", import.meta.url),
		"utf8",
	);
	const row = src
		.split("\n")
		.find((l) => l.includes("**content floor**") && l.trim().includes("|"));
	assert.ok(row, "the spend-order table must carry a content-floor row");
	assert.ok(
		!/always survives/i.test(row),
		`the floor row claims an unconditional guarantee: ${row}`,
	);
	assert.ok(
		/I2|invariant 2/i.test(row),
		"the floor row must point at the invariant it enforces",
	);
	// #182 made the floor unconditional, so the row must also name what ENFORCES
	// it rather than describing a reservation that prose may not survive. A row
	// that says only "reserves" while invariant 2 says "every budget >= 1" is the
	// same two-sentences-disagreeing defect this guard was written for.
	assert.match(
		row,
		/floor pass|takes the room back/i,
		"the floor row must name the floor pass, now that the floor is enforced rather than reserved",
	);
});

test("#182: the content floor holds at EVERY budget, not above a measured boundary", () => {
	// #170 stated invariant 2 as a DOMAIN because it was false below ~28 and the
	// seam was frozen for that round. #182 is the named remainder, and the two
	// decisions it asked for are taken here: a `---` with nothing after it is not
	// a separator (so the rule belongs to the notice and steps down with it), and
	// the floor wins outright (a notice that cannot coexist with one token of
	// prose costs zero). With those, the domain is all budgets >= 1 and the
	// measured 27 is gone — so this test asserts the unconditional form. It also
	// asserts the ceiling, because dropping framing can only lower the total.
	const body = `# Big Heading\n${"word ".repeat(600)}`;
	const PROSE = /word/;
	for (let budget = 1; budget <= 60; budget++) {
		const out = applyTokenBudget(body, budget, "a");
		assert.ok(
			PROSE.test(out),
			`budget ${budget} yielded no page prose: ${JSON.stringify(out.slice(0, 40))}`,
		);
		assert.ok(
			estimateTokens(out) <= budget,
			`ceiling violated at ${budget}: ${estimateTokens(out)} tokens`,
		);
	}
});

test("#182: a lone horizontal rule is never the answer", () => {
	// D1: the rule is part of the notice, not content. Pre-fix, budget 1 returned
	// "\n\n--" — the notice's own separator trimmed to one token — because the
	// backstop tested `footerIdx > 0` and a footer at index 0 was classified as
	// content. A rule with nothing after it conveys nothing.
	const body = `# Big Heading\n${"word ".repeat(600)}`;
	for (let budget = 1; budget <= 60; budget++) {
		const out = applyTokenBudget(body, budget, "a").trim();
		assert.ok(
			!/^-{3,}$/.test(out) && out !== "--" && out !== "---",
			`budget ${budget} returned a bare rule: ${JSON.stringify(out)}`,
		);
		assert.ok(out.length > 0, `budget ${budget} returned empty output`);
	}
});

test("#182: the notice is still emitted when it CAN coexist with prose", () => {
	// D2 must not become "never show the notice" — that would silently delete a
	// feature the budget can afford. The mirror of the floor test.
	const body = `# Heading\n${"alpha ".repeat(400)}`;
	const out = applyTokenBudget(body, 200, "alpha");
	assert.match(out, /truncat/i, "an ample budget must still say the content was cut");
	assert.match(out, /alpha/, "and still carry page prose");
	assert.ok(estimateTokens(out) <= 200);
});

test("#182: a document with frontmatter still yields prose at tiny budgets", () => {
	// S4: frontmatter already yields when it cannot coexist with content; the new
	// notice rule must not make the frontmatter the whole answer instead.
	const body = `---\ntitle: A very long frontmatter title that costs several tokens\n---\n\n${"body ".repeat(300)}`;
	for (const budget of [1, 4, 12, 30]) {
		const out = applyTokenBudget(body, budget, "body");
		assert.ok(
			/body/.test(out),
			`budget ${budget} yielded no page prose: ${JSON.stringify(out.slice(0, 40))}`,
		);
		assert.ok(estimateTokens(out) <= budget, `ceiling violated at ${budget}`);
	}
});

test("#170: the ceiling is unconditional across shapes", () => {
	// Invariant 1 is the one guarantee that was never in doubt, and #182 must not
	// cost it: the floor pass drops FRAMING, which can only lower the total. Swept
	// across the shapes that historically broke the ceiling (oversized single
	// section, frontmatter, heading-less prose, many small sections).
	const shapes = [
		["one oversized section", `# Big Heading\n${"word ".repeat(600)}`],
		[
			"frontmatter + body",
			`---\ntitle: A long enough frontmatter title to cost tokens\n---\n\n${"body ".repeat(300)}`,
		],
		["heading-less prose", "plain prose ".repeat(400)],
		[
			"many small sections",
			Array.from({ length: 60 }, (_, i) => `## S${i}\nsmall body ${i}`).join("\n\n"),
		],
	];
	for (const [name, body] of shapes) {
		for (let budget = 1; budget <= 60; budget++) {
			const out = applyTokenBudget(body, budget, "a");
			assert.ok(
				estimateTokens(out) <= budget,
				`ceiling violated (${name}) at ${budget}: ${estimateTokens(out)} tokens`,
			);
		}
	}
});

// #182, the part the author's own fix got wrong twice. The first detector used
// `[a-z0-9]{4,}`, an implicit SCRIPT whitelist: a CJK document produced an empty
// word set, the detector answered "nothing to carry", the floor pass never ran,
// and CJK budgets 1-45 still returned "\n\n--" while every Latin test stayed
// green. A claim about "every budget" must be swept across scripts, or it is a
// claim about the Latin test corpus.
test("#182: the content floor holds for non-Latin documents too", () => {
	const docs = [
		["CJK", "# 標題\n" + "内容テキストです。".repeat(200), "内"],
		["Cyrillic", "# Заголовок\n" + "содержимое документа. ".repeat(200), "с"],
		["Greek", "# Τίτλος\n" + "κείμενο εγγράφου ".repeat(200), "κ"],
		["Accented Latin", "# Título\n" + "contenido del documento ".repeat(200), "c"],
		["Arabic", "# عنوان\n" + "محتوى المستند ".repeat(200), "م"],
	];
	for (const [name, body, probe] of docs) {
		for (let budget = 1; budget <= 60; budget++) {
			const out = applyTokenBudget(body, budget, "x");
			assert.ok(
				out.includes(probe),
				`${name} at budget ${budget} yielded no document text: ${JSON.stringify(out.slice(0, 40))}`,
			);
			assert.ok(
				estimateTokens(out) <= budget,
				`${name} ceiling violated at ${budget}: ${estimateTokens(out)} tokens`,
			);
		}
	}
});

test("#182: a heading truncated to a bare marker is not counted as prose", () => {
	// Substring membership alone was not enough: "#" is literally inside the
	// document, so a heading cut to "#" passed as content and the floor pass
	// never fired (budget 4 returned exactly "#"). The line must carry a letter
	// or a number - a property, not a list of framing shapes.
	const body = "# Заголовок\n" + "содержимое документа. ".repeat(200);
	for (let budget = 1; budget <= 60; budget++) {
		const out = applyTokenBudget(body, budget, "x").trim();
		assert.ok(
			!/^[#\s>*~-]+$/.test(out),
			`budget ${budget} returned markdown punctuation only: ${JSON.stringify(out)}`,
		);
	}
});

// #182 residual, surfaced by re-running the PR #181 reviewer's P1 probe against
// the merged fix. The floor pass was correct; its INPUT was not.
// `prosePrefixSource` stripped leading headings with
// `/^(?:[ \t]*#{1,6}[ \t].*(?:\n|$))+/`, and the repetition stops at the blank
// line between `# A` and `## B`. So for a document whose prose follows a
// blank-line-separated heading stack, the "prose" handed to the swap was still
// headings, `trimToTokenBudget` cut it to `""`, the swap was rejected for lack of
// room, and the budget-1 answer was the notice fragment "\n\n--" — the exact
// shape #182 was filed for, surviving in the one document shape the fix's own
// sweep never built.
test("#182: a blank-line-separated heading stack does not block the content floor", () => {
	const skeleton = "# A\n\n## B\n\n### C\n\n" + "leaftext more ".repeat(60);
	for (let budget = 1; budget <= 60; budget++) {
		const out = applyTokenBudget(skeleton, budget, "a");
		assert.ok(
			/leaftext|leaftex|leaft|leaf|lea|le/.test(out),
			`budget ${budget} returned framing with no document text: ${JSON.stringify(out.slice(0, 40))}`,
		);
		assert.ok(
			estimateTokens(out) <= budget,
			`ceiling violated at ${budget}: ${estimateTokens(out)} tokens`,
		);
	}
});

// Second residual from the same re-run. `trimToTokenBudgetWithClosedFence` keeps
// the fence balanced, which is right — but when the room is too small for any of
// the code inside, it balanced an OPENING fence against a CLOSING one with
// nothing between them, and the answer to a document that clearly has content was
// "```\n```\n". Balanced framing around an empty body is still framing.
test("#182: a closed fence that holds no content is not an answer", () => {
	// The payload is deliberately rare. With "codefence body" as the content, the
	// notice wording "*Truncated" shares the 2-gram "nc" with "codefence" and the
	// assertion passed on a framing-only answer — a 2-gram criterion is only as
	// strict as the rarity of the document's tokens.
	const payload = "jxqv kzpw ";
	const body = "# T\n" + "```\n" + payload.repeat(60) + "```";
	const docGrams = body.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "");
	const carriesDoc = (out) => {
		for (let i = 0; i + 1 < out.length; i++) {
			const g = out.slice(i, i + 2);
			if (/[\p{L}\p{N}]/u.test(g) && docGrams.includes(g)) return true;
		}
		return false;
	};
	for (let budget = 1; budget <= 40; budget++) {
		const out = applyTokenBudget(body, budget, "a");
		const bare = out.replace(/[\s`~]/g, "");
		// One character is the documented UNDER-FILL residual, but it must be the
		// DOCUMENT's character: accepting any single character (or empty output) made
		// the assertion pass on a lone fence marker, which is exactly the framing this
		// test exists to reject.
		assert.ok(
			(bare.length === 1 && body.includes(bare)) || carriesDoc(out),
			`budget ${budget} returned framing with no document text: ${JSON.stringify(out)}`,
		);
		assert.ok(
			!/`{3,}[^`\n]*\n\s*`{3,}/.test(out),
			`budget ${budget} closed a fence around nothing: ${JSON.stringify(out)}`,
		);
		assert.ok(
			estimateTokens(out) <= budget,
			`ceiling violated at ${budget}: ${estimateTokens(out)} tokens`,
		);
	}
});

// --- Regressions introduced by the two fixes above, found by adversarial review
// of the PR that shipped them. Each is reproduced through the exported budget API.

// "No letter or number anywhere in the string" is not "the fence is empty".
// Before the fix: applyTokenBudget('# A\n```\n' + '+++\n'.repeat(100) + '```', 20, 'a')
// returned "```" fenced "+++"; after it returned the bare "+++", and a body of
// "---" came back as a run of horizontal rules. Fence delimiters carry meaning:
// they are what makes symbol content code instead of markdown.
test("#182 regression: a non-empty symbol-only fence keeps its delimiters", () => {
	for (const body of ["+++", "...", "| | |", "---"]) {
		const doc = "# A\n```\n" + body + "\n".repeat(1) + body.repeat(1) + "\n".repeat(1) + "```";
		const out = applyTokenBudget(doc, 60, "a");
		assert.ok(
			/```/.test(out),
			`fence around ${JSON.stringify(body)} was removed: ${JSON.stringify(out)}`,
		);
	}
	const rules = applyTokenBudget("# A\n```\n" + "---\n".repeat(100) + "```", 20, "a");
	assert.ok(/```/.test(rules), `--- fence body lost its delimiters: ${JSON.stringify(rules)}`);
});

// The plain-trimmer fallback could return a bare opening delimiter: budget 10 on
// a fence document returned "```" — three tokens, one unclosed opener, no page
// text. A complete opener changes the markdown parsing context for everything the
// caller renders after it, which is worse than the single character it replaced.
test("#182 regression: no budget yields an unclosed fence", () => {
	const doc = "# T\n```\n" + "codefence body ".repeat(60);
	for (let budget = 1; budget <= 60; budget++) {
		const out = applyTokenBudget(doc, budget, "a");
		const ticks = (out.match(/`{3,}/g) || []).length;
		assert.equal(
			ticks % 2,
			0,
			`budget ${budget} returned an unclosed backtick fence: ${JSON.stringify(out)}`,
		);
		const tildes = (out.match(/~{3,}/g) || []).length;
		assert.equal(
			tildes % 2,
			0,
			`budget ${budget} returned an unclosed tilde fence: ${JSON.stringify(out)}`,
		);
	}
});

// The blank-line-crossing strip ate the indentation of the NEXT line and then
// matched a four-space-indented `# critical code comment` as a heading. In
// Markdown, four spaces after a blank line is an indented code block and the `#`
// is a comment, not a heading — the line vanished from the answer.
test("#182 regression: four-space-indented code is not a heading run", () => {
	const doc =
		"# A\n\n    # critical code comment\n    return original_value;\n" +
		"    more code here;\n".repeat(60);
	for (const budget of [10, 20, 40]) {
		const out = applyTokenBudget(doc, budget, "a");
		assert.ok(
			out.includes("critical"),
			`budget ${budget} dropped the indented code comment: ${JSON.stringify(out.slice(0, 60))}`,
		);
	}
});

// --- Found by the verify round on the previous commit. The empty-fence rule was a
// regex, and the opener capture backtracks from four backticks to three while
// `[^\n]*` eats the remaining one. A literal three-backtick BODY line inside a
// four-backtick block therefore satisfied the backreference, both lines were
// deleted, and the surviving four-backtick closer became a new unclosed opener.
//
// Markers are built with escapes rather than written inline: a literal ``` inside
// a template literal terminates it, and the first version of this block failed to
// parse for exactly that reason.
const BT = "`";
const F3 = BT.repeat(3);
const F4 = BT.repeat(4);

test("#182 regression: a shorter marker inside a longer fence is body, not a delimiter", () => {
	// Valid CommonMark: a triple-backtick example inside a quadruple-backtick block.
	const doc = "# T\n" + F4 + "\n" + F3 + "\n" + "jxqv kzpw ".repeat(100) + "\n" + F3 + "\n" + F4;
	const out = applyTokenBudget(doc, 20, "a");
	const fours = (out.match(/`{4}/g) || []).length;
	assert.ok(
		fours > 0 && fours % 2 === 0,
		"the outer four-backtick opener was consumed: " + JSON.stringify(out),
	);
	// The helper isolated: an outer block whose only body line is a shorter marker.
	const kept = trimToTokenBudgetWithClosedFence(F4 + "\n" + F3 + "\n" + F4, 20);
	assert.ok(kept.includes(F3), "the literal three-backtick body line was deleted: " + JSON.stringify(kept));
	// A shorter marker line on its own is body text, not an empty fence.
	const alone = trimToTokenBudgetWithClosedFence(F4 + "\n" + F3, 20);
	assert.ok(alone.includes(F3), "a shorter marker line was eaten as a closer: " + JSON.stringify(alone));
});

// The shared trim helper no longer decides what a fence MEANS. It closes fences and
// nothing else. Deleting "empty" ones was tried three ways and each way deleted real
// code content in a new way, so the rule moved to the one caller that needed a
// content-bearing answer, which validates its own swap candidate. What is asserted
// here is therefore PRESERVATION: a fence that fits is returned untouched.
test("#182: the trim helper preserves fences verbatim instead of judging them", () => {
	const docs = [
		F3 + "\n\t\n \n" + F3, // whitespace-only body
		F3 + "\n" + F4, // opener closed by a longer run
		F3 + " " + F4.repeat(0) + "\n\n" + F3, // marker-bearing info string
		"~~~ ~\n" + F3 + "\n\n" + F3 + "\n~~~", // tilde fence with tilde info
		F3 + "\n\u00a0\n" + F3, // Unicode whitespace body
		F4 + "\n" + F3 + "\n" + F4, // shorter marker as body
	];
	for (const doc of docs) {
		const out = trimToTokenBudgetWithClosedFence(doc, 200);
		assert.equal(out, doc, `the helper rewrote a fence that fits: ${JSON.stringify(out)}`);
	}
});

// The public budget API still must not answer with framing. That guarantee now lives
// in the floor pass's candidate check, not in the trim helper, so it is asserted
// through the public API where it is actually owed.
test("#182: the public budget path never answers with framing-only output", () => {
	const docs = [
		"# T\n" + F3 + "\n\t\n \n" + F3 + "\n" + "jxqv kzpw ".repeat(100),
		"# T\n" + F3 + "\n\n" + F4 + "\n" + "jxqv kzpw ".repeat(100),
		"# T\n~~~ ~\n" + F3 + "\n\n" + F3 + "\n~~~\n" + "jxqv kzpw ".repeat(100),
		"# T\n" + F3 + "\n\u00a0\n" + F3 + "\n" + "jxqv kzpw ".repeat(100),
	];
	for (const doc of docs) {
		for (const budget of [10, 14, 20, 30, 60]) {
			const out = applyTokenBudget(doc, budget, "a");
			// 2-gram membership in the rare payload, the same criterion used everywhere
			// else in this lane. Requiring the whole payload string was too strict: a
			// truncated "jxqv " is document text, and at budget 30 the fence plus two
			// payload characters is a legitimate answer, not framing.
			const grams = "jxqv kzpw";
			let shares = false;
			for (let i = 0; i + 1 < out.length; i++) {
				const g = out.slice(i, i + 2);
				if (/[\p{L}\p{N}]/u.test(g) && grams.includes(g)) shares = true;
			}
			const bare = out.replace(/[\s`~]/g, "");
			assert.ok(
				shares || (bare.length === 1 && doc.includes(bare)),
				`budget ${budget} answered with framing: ${JSON.stringify(out)}`,
			);
			assert.ok(
				estimateTokens(out) <= budget,
				`ceiling violated at ${budget}: ${estimateTokens(out)} tokens`,
			);
		}
	}
});

// The verify round found that removing the fallback's post-trim marker strip was
// GREEN: no test exercised a SHORT fenced document. It is load-bearing. The
// fallback strips the leading opener from the SOURCE before trimming, so on a short
// block the trimmed result keeps the TRAILING closer and the opener is gone — the
// answer ends with a lone ``` that opens a block nothing closes.
test("#182 regression: a short fenced block never leaves a lone closer", () => {
	const docs = [
		"# T\n" + F3 + "\nab cd ef gh ij kl mn op qr\n" + F3,
		"# T\n" + F3 + "\nab cd\n" + F3,
		F3 + "\nab cd\n" + F3,
		"# T\n~~~\nab cd ef gh ij\n~~~",
	];
	for (const doc of docs) {
		for (let budget = 1; budget <= 40; budget++) {
			const out = applyTokenBudget(doc, budget, "a");
			for (const marker of [BT.repeat(3), "~~~"]) {
				const runs = (out.match(new RegExp(marker, "g")) || []).length;
				assert.equal(
					runs % 2,
					0,
					`budget ${budget} on ${JSON.stringify(doc.slice(0, 24))} left an unbalanced ${marker}: ${JSON.stringify(out)}`,
				);
			}
		}
	}
});

// Four branches of the old scanner survived mutation; the scanner is now gone, and
// what replaces the coverage is the invariant it was trying to express: fences are
// never rewritten, and the budget path only installs a candidate that carries
// document words.
test("#182: fence-boundary shapes survive the budget path unchanged or with prose", () => {
	// (a) A LONGER marker run closes a shorter opener. The helper no longer judges
	// whether the body is empty, so the block is returned untouched.
	assert.equal(
		trimToTokenBudgetWithClosedFence(F3 + "\n \n" + F4, 200),
		F3 + "\n \n" + F4,
		"the helper rewrote a fence closed by a longer run",
	);
	// (b) A blank FIRST body line does not make the block empty: content can follow.
	const later = trimToTokenBudgetWithClosedFence(F3 + "\n\nkeepme\n" + F3, 20);
	assert.ok(later.includes("keepme"), "content after a blank line was dropped");
	assert.ok(later.includes(F3), "the fence around real content lost its delimiters");
	// (c) An info string containing the marker character cannot open that fence
	// style, so the line is ordinary content. The body must be BLANK for this to
	// decide anything: with content in the block both paths keep it, and the first
	// version of this case passed whether the guard was present or not.
	const info = trimToTokenBudgetWithClosedFence(F3 + " " + F4 + "\n\n" + F3, 200);
	assert.equal(info, F3 + " " + F4 + "\n\n" + F3, "a marker-bearing info string was rewritten");
	// (d) Two sequential fences: the scan must resume OUTSIDE the first block. If it
	// does not, the second block is re-scanned from inside and lines duplicate.
	const two = trimToTokenBudgetWithClosedFence(
		F3 + "\nalpha\n" + F3 + "\nmiddle\n" + F3 + "\nbeta\n" + F3,
		60,
	);
	assert.equal(
		(two.match(new RegExp(F3, "g")) || []).length,
		4,
		`sequential fences were mis-paired: ${JSON.stringify(two)}`,
	);
	for (const w of ["alpha", "middle", "beta"]) {
		assert.equal(two.split(w).length - 1, 1, `${w} duplicated or lost: ${JSON.stringify(two)}`);
	}
});

// Verify round 2 on d42f04d. Both of these delete real code content through the
// exported helper AND the production budget API, and both are regressions against
// origin/master. They are the reason the fence-rewriting rule is being removed from
// the shared helper rather than patched a third time: character-class stripping,
// regex pairing and a boundary scanner have each exposed another class of the same
// literal-body deletion, which is the signature of a wrong seam, not a wrong patch.
test("#182 regression: a tilde fence whose info string contains tildes is valid", () => {
	// CommonMark restricts marker characters in the info string for BACKTICK fences
	// only. `~~~ ~` opens a block whose body is literal, so the ``` lines are content.
	const doc = "~~~ ~\n```\n\n```\n~~~";
	const out = trimToTokenBudgetWithClosedFence(doc, 100);
	assert.ok(out.includes("```\n\n```"), `literal body deleted: ${JSON.stringify(out)}`);
	const pub = applyTokenBudget("# T\n" + doc + "\n" + "jxqv kzpw ".repeat(100), 20, "a");
	assert.ok(pub.includes("```"), `public path deleted the body: ${JSON.stringify(pub)}`);
});

// Markdown blankness is ASCII spaces and tabs. JavaScript trim() also eats NBSP,
// EM SPACE and VTAB, and fenced code is literal, so a body holding one of those is
// real content.
test("#182 regression: Unicode whitespace inside a fence is content, not a blank line", () => {
	for (const [name, ch] of [["NBSP", "\u00a0"], ["EM SPACE", "\u2003"], ["VTAB", "\u000b"]]) {
		const doc = F3 + "\n" + ch + "\n" + F3;
		const out = trimToTokenBudgetWithClosedFence(doc, 100);
		assert.ok(out.includes(ch), `${name} body erased: ${JSON.stringify(out)}`);
		const pub = applyTokenBudget("# T\n" + doc + "\n" + "jxqv kzpw ".repeat(100), 20, "a");
		assert.ok(pub.includes(ch), `${name} erased on the public path: ${JSON.stringify(pub)}`);
	}
});

// Verify round 3 on 78b334a. Real regression versus origin/master, introduced by
// THIS PR: the line-based prosePrefixSource dropped master's leading-whitespace
// strip, so a document opening with four-space-indented fence-looking text keeps
// its indentation, the closure parser still treats that line as an opener and
// appends a margin-level closer — and at the Markdown 0..3-space boundary the
// indented line is CODE while the appended marker is an unclosed OPENING fence.
//
//   master: "```literal code\njxqv kzp\n```\n"          balanced
//   78b334a:"    ```literal code\njxqv\n```\n"          newly unclosed
test("#182 regression: an indented fence-like opening line is not left unclosed", () => {
	const doc = "    ```literal code\n" + "jxqv kzpw ".repeat(100);
	for (let budget = 1; budget <= 120; budget++) {
		const out = applyTokenBudget(doc, budget, "a");
		const margin = (out.match(/^(?:`{3,}|~{3,})[^\n]*$/gm) || []).length;
		assert.equal(
			margin % 2,
			0,
			`budget ${budget} left a margin-level marker unclosed: ${JSON.stringify(out.slice(0, 60))}`,
		);
	}
});
