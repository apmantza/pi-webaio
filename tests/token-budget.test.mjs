// ─── Tests for hard token-budget contract (issue #44) ────────────────
//
// Covers applyTokenBudget():
//   - No-op when content already fits the budget
//   - Budget is respected (measured tokens ≤ budget)
//   - Heading skeleton is preserved even when most content is dropped
//   - Footer is present (format: "N-token budget", "sections omitted", aio-webcontent)
//   - Composes with applyQueryAnswerMode output
//   - Hard guarantee on pathological input (one giant section)

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTokenBudget } from "../src/prune-markdown.ts";
import { applyQueryAnswerMode } from "../src/tools/webfetch.ts";
import { estimateTokens } from "../src/token-count.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Make a multi-section markdown doc with known token sizes. */
function makeDoc(sections) {
	return sections
		.map(({ heading, body }) => `## ${heading}\n\n${body}`)
		.join("\n\n");
}

/** Repeat a word N times to produce a roughly-N-token body. */
function words(word, count) {
	return Array(count).fill(word).join(" ");
}

// ─── No-op when already within budget ────────────────────────────────

test("applyTokenBudget: no-op when content fits", () => {
	const content = "## Hello\n\nShort content.";
	const result = applyTokenBudget(content, 5000);
	assert.equal(result, content, "content should be unchanged when under budget");
});

// ─── Budget is respected ──────────────────────────────────────────────

test("applyTokenBudget: output fits within budget", () => {
	const doc = makeDoc([
		{ heading: "Intro", body: words("alpha", 200) },
		{ heading: "Details", body: words("beta", 200) },
		{ heading: "More", body: words("gamma", 200) },
		{ heading: "Extra", body: words("delta", 200) },
	]);

	const budget = 300;
	const result = applyTokenBudget(doc, budget);
	const resultTokens = estimateTokens(result);
	assert.ok(
		resultTokens <= budget,
		`output tokens ${resultTokens} should be ≤ budget ${budget}`,
	);
});

// ─── Heading skeleton preserved ───────────────────────────────────────

test("applyTokenBudget: heading skeleton preserved when content is heavily pruned", () => {
	// Very tight budget so all body content must be dropped
	const headings = ["Introduction", "Details", "Pricing", "FAQ"];
	const doc = makeDoc(
		headings.map((h) => ({ heading: h, body: words("word", 100) })),
	);

	const budget = 120; // Only enough for a few lines
	const result = applyTokenBudget(doc, budget);

	// At least one heading should survive (or skeleton prepended)
	const hasHeading = /^#{1,6}\s/m.test(result);
	assert.ok(hasHeading, "result should contain at least one heading");
});

// ─── Footer is present ───────────────────────────────────────────────

test("applyTokenBudget: footer present when content is trimmed", () => {
	const doc = makeDoc([
		{ heading: "A", body: words("alpha", 100) },
		{ heading: "B", body: words("beta", 100) },
		{ heading: "C", body: words("gamma", 100) },
	]);

	const budget = 150;
	const result = applyTokenBudget(doc, budget);

	// Footer should contain budget reference and aio-webcontent hint
	assert.ok(result.includes("token budget"), `footer should mention token budget; got: ${result.slice(-200)}`);
	assert.ok(result.includes("aio-webcontent"), `footer should mention aio-webcontent; got: ${result.slice(-200)}`);
});

test("applyTokenBudget: footer includes url when provided", () => {
	const doc = makeDoc([
		{ heading: "A", body: words("alpha", 100) },
		{ heading: "B", body: words("beta", 100) },
	]);
	const url = "https://example.com/article";
	const result = applyTokenBudget(doc, 100, undefined, url);
	assert.match(
		result,
		/retrieve via aio-webcontent with URL: https:\/\/example\.com\/article/,
		"footer should include the provided URL",
	);
});

test("applyTokenBudget: footer mentions sections omitted count", () => {
	const doc = makeDoc([
		{ heading: "A", body: words("alpha", 80) },
		{ heading: "B", body: words("beta", 80) },
		{ heading: "C", body: words("gamma", 80) },
	]);

	const budget = 100;
	const result = applyTokenBudget(doc, budget);
	assert.ok(
		/\d+ section/.test(result),
		"footer should mention how many sections were omitted",
	);
});

// ─── Composition with query answer mode ──────────────────────────────

test("applyTokenBudget: composes with applyQueryAnswerMode output", () => {
	const doc = makeDoc([
		{
			heading: "Pricing",
			body: "Our pricing plans include Free Pro and Enterprise tiers. Monthly billing available.",
		},
		{
			heading: "Installation",
			body: words("install setup download wizard", 60),
		},
		{
			heading: "Support",
			body: words("help contact email chat", 60),
		},
	]);

	// First apply answer mode
	const answerBody = applyQueryAnswerMode(doc, "pricing billing", 2, {
		maxTokens: 50,
	});
	assert.ok(answerBody !== undefined, "answer mode should produce output");

	// Then apply budget to the answer-mode output
	const budget = 100;
	const result = applyTokenBudget(answerBody, budget, "pricing billing");
	const resultTokens = estimateTokens(result);
	assert.ok(
		resultTokens <= budget,
		`budget should be respected after answer mode; got ${resultTokens} > ${budget}`,
	);
});

// ─── Hard guarantee: pathological input (one giant section) ──────────

test("applyTokenBudget: hard guarantee with one giant section (no headings)", () => {
	// A single huge paragraph with no markdown headings — the worst case
	// because there are no section boundaries to prune at.
	const giant = words("word", 2000);
	const budget = 200;
	const result = applyTokenBudget(giant, budget);
	const resultTokens = estimateTokens(result);
	assert.ok(
		resultTokens <= budget,
		`hard guarantee violated: ${resultTokens} tokens > budget ${budget}`,
	);
});

test("applyTokenBudget: hard guarantee with one giant section under a heading", () => {
	const giant = `## Giant Section\n\n${words("word", 2000)}`;
	const budget = 200;
	const result = applyTokenBudget(giant, budget);
	const resultTokens = estimateTokens(result);
	assert.ok(
		resultTokens <= budget,
		`hard guarantee violated: ${resultTokens} tokens > budget ${budget}`,
	);
});

// ─── Minimum budget floor ─────────────────────────────────────────────

test("applyTokenBudget: minimum budget floor is 100", () => {
	const doc = makeDoc([{ heading: "A", body: words("word", 50) }]);
	// Passing budget < 100 should be floored to 100
	const result = applyTokenBudget(doc, 10);
	// Should not throw, and should produce some output
	assert.ok(typeof result === "string" && result.length > 0);
});

// ─── No change when budgetTokens absent ──────────────────────────────

test("applyTokenBudget: content unchanged when content fits budget", () => {
	const small = "## Title\n\nA short paragraph.";
	const result = applyTokenBudget(small, 10000);
	assert.equal(result, small);
});

// ─── BM25 ordering when query provided ───────────────────────────────

test("applyTokenBudget: keeps most relevant section when query provided", () => {
	const doc = makeDoc([
		{ heading: "Pricing", body: "monthly billing subscription price cost plans tiers free pro enterprise" },
		{ heading: "Installation", body: words("install setup wizard download", 30) },
		{ heading: "Support", body: words("help contact email phone", 30) },
	]);

	// Very tight budget, only one section worth of content should survive
	const budget = 60;
	const result = applyTokenBudget(doc, budget, "pricing billing cost");
	// The pricing section should be preferred over others
	assert.ok(
		result.toLowerCase().includes("pricing") ||
		result.toLowerCase().includes("billing") ||
		result.toLowerCase().includes("price"),
		`expected pricing content to be kept; result: ${result}`,
	);
	const resultTokens = estimateTokens(result);
	assert.ok(resultTokens <= budget, `budget violated: ${resultTokens} > ${budget}`);
});
