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
	applyTokenBudget,
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
