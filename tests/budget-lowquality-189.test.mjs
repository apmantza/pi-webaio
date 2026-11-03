// #189 — two low-budget quality residuals from #182, identical on origin/master, each
// needing a different change than the content-floor fix that landed.
//
// Item 2 (table-shaped documents answering with column labels + notice) is a judgement
// call about whether tabular headers count as document prose. It is NOT asserted here as
// a defect; the decision is recorded on the issue instead. Item 3 was described in the
// issue as "estimator behaviour, not the budget allocator" — measured below, that framing
// is wrong: the estimator is consistent (CJK 1 char/token, Latin 4.75), and what is wrong
// is the ALLOCATOR's `maxTokens * 4` seed plus an absolute `- 16` shrink margin.
import assert from "node:assert";
import test from "node:test";
import { applyTokenBudget } from "../src/prune-markdown.ts";
import { estimateTokens } from "../src/token-count.ts";

const HEADINGS = "# A\n\n## B\n\n### C\n\n";
const CJK = "机器学习的核心是数据。".repeat(6); // 66 chars, 66 tokens

// ── Item 1: a headings-only document answers blank ─────────────────────────────
// The floor's contract is that a non-empty body yields the document's own content.
// `prosePrefixSource` strips the heading run to find prose; when the document IS only
// headings, that leaves nothing, the floor pass has no candidate, and the caller gets a
// newline. The document's entire content was available and was thrown away.
// Budgets start at 2, and the reason is the estimator's arithmetic rather than a bar
// lowered to fit the code: `estimateTokens("# A") === 2`, so ONE token cannot hold a
// heading line at all. At budget 1 the answer is the single character `#`, which is the
// document's own first character and the best a one-token room admits.
for (const budget of [2, 3, 6, 12]) {
	test(`#189 item 1: a headings-only document answers with its headings at budget ${budget}`, () => {
		const out = applyTokenBudget(HEADINGS, budget, "a");
		assert.ok(
			/[A-C]/.test(out),
			`budget ${budget} returned ${JSON.stringify(out)} — the document's only content is headings and all of it was dropped`,
		);
		assert.ok(estimateTokens(out) <= budget, `ceiling broken at budget ${budget}`);
	});
}

test("#189 item 1: a rules-only document answers with its rules once one fits", () => {
	// `estimateTokens("---") === 1`, so at budget 1 the rule DOES fit — and the answer is
	// still "". The reason is recorded as a residual rather than fixed: the truncation
	// notice's own separator is `--`, and `--` is a substring of a document made only of
	// dashes, so `carriesPageProse` cannot distinguish "the document's content" from
	// "framing punctuation" for such a document. Distinguishing them needs the notice to be
	// excluded structurally rather than by substring, which is a different seam. A
	// punctuation-only document has no words to lose at budget 1, so the residual is
	// recorded on #189 instead of buying a mechanism for it.
	assert.ok(estimateTokens("---") === 1, "the fixture's premise: one rule is one token");
	const out = applyTokenBudget("---\n\n---", 3, "a");
	assert.ok(out.includes("---"), `budget 3 returned ${JSON.stringify(out)}`);
	assert.ok(estimateTokens(out) <= 3);
});

// ── Item 3: single-character under-fill in non-Latin scripts ───────────────────
// Measured, not assumed:
//   estimateTokens("机器学习的核心是数据。".repeat(6)) === 66 for 66 chars  → 1.00 char/token
//   estimateTokens(latin 228 chars)                       === 48            → 4.75 char/token
// The allocator seeds `chars = maxTokens * 4` (a Latin-only ratio) and then shrinks with
// `chars = floor(chars * maxTokens / used) - 16`. At budget 20 the first shrink computes
// 20 - 16 = 4, so the absolute margin removes four fifths of the room before the loop can
// refine, and the FIRST candidate that fits is returned rather than the largest.
// ── named residual: item 3, pinned AS WRONG ───────────────────────────────────
// Deliberately asserting the defect, in the pattern #197 used for #200: fixing it must
// invert an assertion that says "this is currently wrong" rather than a green suite
// quietly agreeing with a regression. The under-fill is real and measured.
//
// Two redesigns of the shrink leaf were tried for this and both are refused on evidence:
//   (a) token-measured binary search over slice length — fixed CJK and the Latin
//       ceiling, broke four #190/#182 guards, because a LONGER slice can be a WORSE
//       candidate: "```\ncode \n```\n" drops the prose a shorter slice kept. Quality is
//       not monotone in slice length, so "largest fitting slice" is the wrong objective.
//   (b) a proportional shrink margin instead of the absolute `- 16` — also broke four
//       guards and made LATIN worse (`# A\n\n## B\n\n#` at budget 6).
// The redesign must optimise candidate QUALITY, not size. Flip the comparison below when
// it lands; that flip is the decision.
test("RESIDUAL #189 item 3: a CJK document is answered with one character", () => {
	const MIN_CONTENT_SHARE = 0.5; // the project's own policy constant
	const budget = 10;
	const out = applyTokenBudget(CJK, budget, "a");
	const kept = out.replace(/[\s>*_\u2014-]*truncated[\s\S]*$/, "").trim();
	assert.ok(estimateTokens(out) <= budget, "the ceiling still holds — this is under-fill, not over-fill");
	assert.ok(
		estimateTokens(kept) < Math.floor(budget * MIN_CONTENT_SHARE),
		`item 3 appears FIXED (${JSON.stringify(kept)} kept of ${budget}); invert this assertion to assert parity`,
	);
	assert.equal(kept, "机", `expected the documented one-character answer, got ${JSON.stringify(kept)}`);
});

test("#189 item 3: the fix must not overfill for Latin text (ceiling both ways)", () => {
	const latin = "The core of machine learning is data, and data is messy. ".repeat(20);
	for (const budget of [10, 20, 40, 80]) {
		const out = applyTokenBudget(latin, budget, "a");
		assert.ok(estimateTokens(out) <= budget, `ceiling broken at budget ${budget}`);
	}
});

// ── the ceiling, swept ─────────────────────────────────────────────────────────
// The item-1 change adds a candidate that fills the budget by whole lines, and a
// candidate that overfills would be a worse bug than the one it fixes. A handful of
// budgets is an existence proof for the cases it contains, not for a universal claim —
// the lesson from #190, where a guard deleted as "impossible to make red" turned out to
// matter on 80 generated inputs. So the claim is swept over shapes x budgets instead.
test("#189: the ceiling holds across shapes and 120 budgets", () => {
	const docs = {
		headings: HEADINGS,
		rules: "---\n\n---",
		cjk: CJK,
		latin: "The core of machine learning is data, and data is messy. ".repeat(20),
		fence: "```js\nconst a = 1;\n```\n\nProse after the fence block here.\n",
		mixed: "# Title\n\nintro text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
		mixedCjk: "# 标题\n\n本文介绍机器学习的核心概念与数据准备流程。\n",
	};
	let checked = 0;
	for (const [name, doc] of Object.entries(docs)) {
		for (let budget = 1; budget <= 120; budget++) {
			const out = applyTokenBudget(doc, budget, "q");
			checked++;
			assert.ok(
				estimateTokens(out) <= budget,
				`ceiling broken: ${name} at budget ${budget} -> ${estimateTokens(out)} tokens ${JSON.stringify(out.slice(0, 60))}`,
			);
		}
	}
	assert.ok(checked >= 800, `sweep did not run (${checked} cases)`);
});

// A document that HAS text must answer with some of it at every budget where a word can
// fit. The rules-only document is excluded on purpose: it contains no letters at all, so
// "no text" is the correct answer for it and asserting otherwise would be a tautology
// about the fixture.
test("#189: a document with text answers with text at every budget >= 2", () => {
	const docs = {
		headings: HEADINGS,
		cjk: CJK,
		latin: "The core of machine learning is data. ".repeat(20),
		mixed: "# Title\n\nintro text\n\n| a | b |\n",
		mixedCjk: "# 标题\n\n本文介绍机器学习的核心概念。\n",
	};
	for (const [name, doc] of Object.entries(docs)) {
		for (let budget = 2; budget <= 60; budget++) {
			const out = applyTokenBudget(doc, budget, "q");
			assert.ok(
				/[\p{L}\p{N}]/u.test(out),
				`${name} at budget ${budget} answered with no document text at all: ${JSON.stringify(out)}`,
			);
		}
	}
});
