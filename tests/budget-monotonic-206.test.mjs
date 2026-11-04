// #206 — a BIGGER budget must not yield LESS of the document.
//
// The budget model states the ceiling ("never more than you asked for") and the content
// floor ("a non-empty body always yields page prose"). It has never stated the property
// this sweep checks, and nothing pinned it: for a FIXED document, if B2 > B1 then the
// answer at B2 must carry at least as much of the document as the answer at B1. Without
// it, a caller that asks for MORE gets a WORSE answer — observed at budget 28 on a
// heading-led document, which returns 75 document characters where budget 27 returned 116.
//
// The metric counts only lines that appear VERBATIM in the document. The truncation notice
// is not in the document, so a longer notice can never register as more content; an earlier
// draft of this probe counted letters and mistook notice wording for prose.
import assert from "node:assert";
import test from "node:test";
import { applyTokenBudget } from "../src/prune-markdown.ts";

const DOCS = {
	headingLed:
		"# Very Long Heading Line That Eats The Whole Budget\n\nThe actual article prose starts here and explains the topic in enough words to be worth keeping at moderate budgets.\n",
	titleBody:
		"# Title\n\nIntro paragraph with the substance of the page continuing long enough to require trimming at modest budgets for sure.\n",
	cjk: "机器学习的核心是数据。".repeat(6),
	table:
		"| name | value |\n| - | - |\n| alpha | 1 |\n| beta | 2 |\n\nProse after the table that is long enough to be trimmed at some budgets here.\n",
	fence:
		"```js\nconst a = 1;\n```\n\nProse after the fence block that is long enough to matter at several budgets and continues further.\n",
};

/** Characters of `answer` that are the document's own text, verbatim. */
function documentChars(answer, doc) {
	let n = 0;
	for (const line of answer.split("\n")) {
		const t = line.trim();
		if (t !== "" && doc.includes(t)) n += t.length;
	}
	return n;
}

function regressions() {
	const out = [];
	for (const [name, doc] of Object.entries(DOCS)) {
		let best = 0;
		for (let budget = 1; budget <= 80; budget++) {
			const got = documentChars(applyTokenBudget(doc, budget, "q"), doc);
			if (got < best) out.push(`${name}@${budget}`);
			else best = got;
		}
	}
	return out;
}

/**
 * The regressing budgets as they stand on `master` at the time of writing. This is an
 * ADMISSION, not a loosening: the test below fails on any budget NOT in this list, so the
 * property cannot regress further, and the list must be edited DOWNWARD as the seam is
 * fixed — a third test refuses stale entries so the baseline cannot silently go out of date.
 *
 * Root cause, RECORDED AS SUPERSEDED. This comment originally attributed the regression to
 * framing being installed when installing it forces the body to be cut. That is a symptom.
 * The measured cause is one level down: `trimToTokenBudget` returns the FIRST slice that fits
 * and its absolute `- 16` shrink step overshoots as the budget shrinks, so at room 9 it
 * answers 2 tokens while room 8 answers 7 — 25 of 400 sweep answers spend under half the room
 * they were given. Fixing the leaf (largest-fitting prefix, gated to fence-free text because
 * the #190 guards prove quality is non-monotone in length WITH fences) takes worst-gap 78 ->
 * 30 chars and under-fill 25 -> 0, yet still regresses 35 of 400 assembled answers per budget
 * against master, because the leaf's output feeds `contentWasCut`, footer sizing and the
 * skeleton branch. So no leaf-local patch can fix this; the fix is composition-level. Full
 * measurements, the counter-example, and the three refused designs: issue #206.
 *
 * Why a baseline rather than the fix in this commit: this seam has had five rounds in which
 * each patch deleted content in a new way (#182, #188, #190, and the designs refused on
 * evidence and recorded on #189 and #206). The invariant and its detector are the part that
 * stops the debt growing while the fix is designed.
 */
const BASELINE = new Set([
	"headingLed@20", "headingLed@21", "headingLed@24", "headingLed@25", "headingLed@28", "headingLed@29",
	"headingLed@30", "headingLed@31", "headingLed@32", "titleBody@4", "titleBody@5", "titleBody@9",
	"titleBody@10", "titleBody@11", "titleBody@12", "titleBody@13", "titleBody@14", "titleBody@15",
	"titleBody@16", "titleBody@20", "titleBody@21", "titleBody@24", "titleBody@25", "cjk@4",
	"cjk@5", "cjk@12", "cjk@13", "cjk@20", "cjk@21", "cjk@24",
	"cjk@25", "cjk@28", "cjk@29", "cjk@30", "cjk@31", "cjk@32",
	"cjk@33", "cjk@34", "cjk@35", "cjk@36", "cjk@37", "cjk@38",
	"cjk@39", "cjk@40", "cjk@41", "cjk@42", "cjk@43", "cjk@44",
	"cjk@45", "cjk@46", "cjk@47", "cjk@48", "cjk@49", "cjk@50",
	"cjk@51", "cjk@52", "cjk@53", "table@12", "table@13", "table@20",
	"table@21", "table@24", "table@25", "table@28", "table@29", "table@30",
	"table@31", "table@32", "table@33", "table@34", "fence@3", "fence@4",
	"fence@5", "fence@6", "fence@11", "fence@12", "fence@13", "fence@14",
	"fence@15", "fence@16", "fence@17", "fence@18", "fence@19", "fence@20",
	"fence@21", "fence@24", "fence@25", "fence@28", "fence@29", "fence@30",
	"fence@31", "fence@32",
]);

test("#206: a larger budget never yields less of the document than a smaller one", () => {
	const fresh = regressions().filter((k) => !BASELINE.has(k));
	assert.deepEqual(
		fresh,
		[],
		`${fresh.length} NEW budgets where asking for MORE returned LESS of the document:\n  ${fresh.slice(0, 12).join("\n  ")}`,
	);
});

test("#206: the admitted baseline matches reality and can only shrink", () => {
	const now = new Set(regressions());
	const stale = [...BASELINE].filter((k) => !now.has(k));
	assert.deepEqual(stale, [], `these budgets no longer regress — delete them from BASELINE: ${stale.join(", ")}`);
	const undeclared = [...now].filter((k) => !BASELINE.has(k));
	assert.deepEqual(undeclared, [], `these budgets regress but are not admitted: ${undeclared.join(", ")}`);
});

test("#206: the exact-substring case that started this is admitted, not silent", () => {
	// The property violation, stated in the caller's terms rather than as a character
	// count: budget 27 keeps the article sentence, budget 28 does not. Pinned so the fix
	// has to clear this concrete case and not just an aggregate number.
	const doc = DOCS.headingLed;
	const needle = "actual article prose";
	assert.ok(applyTokenBudget(doc, 27, "q").includes(needle), "premise: budget 27 keeps the article text");
	assert.ok(
		!applyTokenBudget(doc, 28, "q").includes(needle),
		"budget 28 appears FIXED; when it keeps the text, assert it does and remove headingLed@28 from BASELINE",
	);
});
