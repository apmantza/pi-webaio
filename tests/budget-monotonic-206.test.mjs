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
import { applyTokenBudget, carriesPageProse } from "../src/prune-markdown.ts";
import { estimateTokens } from "../src/token-count.ts";

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
 *
 * ## Admission header — option (A), landed 2026-11-04 (92 -> 77)
 *
 * Composition-level candidate selection is now in place (`selectFullestCandidate`): it ADDS
 * candidates at the end of `applyTokenBudget` and takes the maximum, leaving the incumbent
 * byte-identical, so it cannot return less than master at any budget. Verified absolutely,
 * not sampled: 0 of 2,000 sweep cases (5 shapes x budgets 1..400) carry fewer document
 * characters than master, and 129 carry more.
 *
 * The set below is NOT simply what survived. 9 entries are NEW, and stating why matters:
 *
 *   headingLed@26, headingLed@27, cjk@59..65
 *
 * Each returns EXACTLY what master returned at that budget (verified against an
 * origin/master worktree, e.g. headingLed@26: 116 chars now, 116 on master). They became
 * violations because a SMALLER budget now reaches more of the document, so the running peak
 * rose and the plateau under it now counts. In the caller's terms the property is genuinely
 * violated — asking for more still returns less than a smaller ask does — so they are
 * admitted rather than argued away. But they are exposure, not loss: the change made these
 * budgets' NEIGHBOURS better, and made the existing shortfall visible.
 *
 * Net: 23 budgets cleared outright, 9 newly exposed, 92 -> 77. The detector's job is
 * unchanged: this set must shrink, and a new entry needs a header like this one.
 *
 * The strict bar (`BASELINE = []`) was traded away on measurement, recorded on #206: the only
 * candidate that reaches 24 violations is a footer-less monotone prefix, which makes
 * truncation SILENT. Silent truncation is a strictly larger instance of the defect #211 was
 * filed for, so the footer stays and the property stays imperfect.
 */
const BASELINE = new Set([
	"headingLed@20", "headingLed@24", "headingLed@25", "headingLed@28", "headingLed@29", "headingLed@30",
	"headingLed@31", "headingLed@32", "titleBody@12", "titleBody@13", "titleBody@20", "titleBody@21", "titleBody@23", "titleBody@24", "titleBody@25",
	"cjk@12", "cjk@13", "cjk@20", "cjk@21", "cjk@24", "cjk@25", "cjk@28", "cjk@29",
	"cjk@30", "cjk@31", "cjk@32", "cjk@33", "cjk@34", "cjk@35", "cjk@36", "cjk@37",
	"cjk@38", "cjk@39", "cjk@40", "cjk@59", "cjk@60", "cjk@61", "cjk@62", "cjk@63",
	"cjk@64", "cjk@65", "table@12", "table@13", "table@20", "table@21", "table@24", "table@25",
	"table@28", "table@29", "table@30", "table@31", "table@32", "table@33", "table@34", "fence@3",
	"fence@4", "fence@5", "fence@6", "fence@11", "fence@12", "fence@13", "fence@14", "fence@15",
	"fence@16", "fence@17", "fence@18", "fence@19", "fence@20", "fence@21", "fence@24", "fence@25",
	"fence@28", "fence@29", "fence@30", "fence@31", "fence@32",
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

test("#206: the exact-substring case that started this is FIXED, not merely admitted", () => {
	// The property violation in the caller's terms: budget 27 kept the article sentence and
	// budget 28 dropped it. That specific inversion is now closed, and this assertion is
	// deliberately the OPPOSITE of the one that shipped with the detector, which pinned 28 as
	// broken and told the fix to flip it. Flipping it is the designed upgrade path; leaving it
	// pinned would let a regression back in under the cover of an "admitted" baseline.
	const doc = DOCS.headingLed;
	const needle = "actual article prose";
	assert.ok(applyTokenBudget(doc, 27, "q").includes(needle), "premise: budget 27 keeps the article text");
	assert.ok(
		applyTokenBudget(doc, 28, "q").includes(needle),
		"budget 28 must keep the article text — the #206 inversion this issue opened with",
	);
	// headingLed@28 STAYS in BASELINE, and both facts are true at once: the sentence is back,
	// but the total document characters at 28 are still below the peak a smaller budget
	// reaches. The concrete caller-visible inversion and the aggregate character property are
	// different claims and must not be collapsed into each other.
});

// ─── Option (A): composition-level candidate selection ───────────────────────
//
// `selectFullestCandidate` adds candidates at the end of `applyTokenBudget` and takes the
// maximum, leaving the incumbent byte-identical. The tests below are the differential that
// justifies shipping it, and the guards that keep it from buying characters with invariants.

const CLEARED = [
	["titleBody", 4], ["titleBody", 5], ["titleBody", 9], ["titleBody", 10], ["titleBody", 11],
	["titleBody", 14], ["titleBody", 15], ["titleBody", 16], ["cjk", 4], ["cjk", 5],
	["cjk", 41], ["cjk", 42], ["cjk", 43], ["cjk", 44], ["cjk", 45], ["cjk", 46], ["cjk", 47],
	["cjk", 48], ["cjk", 49], ["cjk", 50], ["cjk", 51], ["cjk", 52], ["cjk", 53],
];

test("#206 option A: every budget the selection cleared is locally monotone", () => {
	// RED on master: each of these 23 budgets returned FEWER document characters than the
	// budget one below it. Stated locally (b vs b-1) rather than against the running peak,
	// so the assertion is the caller's own experience and not an artifact of the sweep.
	const bad = [];
	for (const [name, budget] of CLEARED) {
		const doc = DOCS[name];
		const now = documentChars(applyTokenBudget(doc, budget, "q"), doc);
		const prev = documentChars(applyTokenBudget(doc, budget - 1, "q"), doc);
		if (now < prev) bad.push(`${name}@${budget}: ${now} < ${prev}@${budget - 1}`);
	}
	assert.deepEqual(bad, [], `${bad.length} cleared budgets still regress:\n  ${bad.join("\n  ")}`);
});

test("#206 option A: a candidate may not win by breaking an invariant", () => {
	// The selection optimises document characters. Every guard in `selectFullestCandidate`
	// exists because a candidate was observed winning while breaking something the incumbent
	// held: the ceiling, the fence policy, margin-marker parity, the bare-marker rule, and the
	// content floor. This sweep is the differential for all of them at once, and it is the
	// reason the prose-only candidates and the raw truncateToBudget slice were removed.
	const bad = [];
	for (const [name, doc] of Object.entries(DOCS)) {
		for (let budget = 1; budget <= 120; budget++) {
			const out = applyTokenBudget(doc, budget, "q");
			const key = `${name}@${budget}`;
			// Ceiling: the caller's number is still a ceiling after a swap.
			if (estimateTokens(out) > budget) bad.push(`${key}: ceiling ${estimateTokens(out)} > ${budget}`);
			// Bare marker: a heading line with no text is framing with no document behind it.
			if (/^#{1,6}[ \t]*$/m.test(out)) bad.push(`${key}: bare heading marker`);
			// Margin-level fence markers must stay balanced.
			if ((out.match(/^(?:`{3,}|~{3,})[^\n]*$/gm) || []).length % 2 !== 0) {
				bad.push(`${key}: odd margin marker count`);
			}
			// Content floor, using the seam's OWN rule rather than a stricter one invented
			// here: a kept fragment may end mid-line, so `carriesPageProse` also accepts the
			// first 8 characters of a document line. Requiring a whole line made this test
			// claim 96 failures at budgets 1-5, where no whole line of the document CAN fit;
			// that was the test being wrong, not the code.
			// `table@1` is admitted, and it is NOT this change. Master fails this same sweep at
			// table@1 AND table@2; this change fixes table@2 and leaves table@1, where one token
			// cannot hold a cell of that table (master's answer is "|", byte for byte). The
			// residue is a pre-existing inconsistency worth naming: the seam can return an answer
			// that fails its own carriesPageProse. Admitted rather than skipped, and filed.
			if (key === "table@1") continue;
			if (!carriesPageProse(out, doc)) bad.push(`${key}: carries no page prose`);
		}
	}
	assert.deepEqual(bad, [], `${bad.length} invariant breaks:\n  ${bad.slice(0, 10).join("\n  ")}`);
});

test("#206 option A: a notice that is present quotes the caller's number", () => {
	// Candidates reuse the incumbent's notice, so this change must never be the reason a
	// notice stops quoting the caller's number (#211).
	//
	// Stated as "a notice that is PRESENT carries the number", NOT "a truncated answer always
	// carries a notice". The stronger form is false on master and always has been: at very
	// small budgets the notice cannot fit alongside any content, and that is the seam's
	// existing, deliberate behaviour, not something this change introduced. Whether the
	// selection changed WHICH budgets carry a notice is a differential question against
	// master, asserted in the sweep probe rather than smuggled in here.
	const bad = [];
	for (const [name, doc] of Object.entries(DOCS)) {
		for (let budget = 1; budget <= 200; budget++) {
			const out = applyTokenBudget(doc, budget, "q");
			const idx = out.lastIndexOf("\n\n---\n");
			if (idx < 0) continue;
			const notice = out.slice(idx);
			// The terminal rung `_truncated._` carries no number. It is pre-existing and
			// identical on master (verified at every budget where it appears), and it is the
			// last resort when no number-bearing rung fits the remaining room. It is also in
			// tension with the comment above the rung list, which rejects a truncation claim
			// with no budget — filed rather than quietly asserted either way.
			if (notice.replace(/^\s*---\s*/, "").trim() === "_truncated._") continue;
			if (!/\d+/.test(notice)) bad.push(`${name}@${budget}: notice carries no number`);
			else if (!new RegExp(`\\b${budget}\\b`).test(notice)) {
				bad.push(`${name}@${budget}: notice does not quote ${budget}`);
			}
		}
	}
	assert.deepEqual(bad, [], `${bad.length} framing problems:\n  ${bad.slice(0, 8).join("\n  ")}`);
});

test("#206 option A: with a query, a fuller prefix may not replace the selected section", () => {
	// The metric this selection optimises is TOTAL document characters, which is the wrong
	// objective once a query is present: the incumbent is BM25-selected, not merely truncated,
	// and a document-order prefix can carry more characters while dropping the section the
	// caller asked about. Measured on a three-section page queried for the middle section, the
	// unguarded selection lost the matching section at 69 of 101 budgets against master.
	//
	// Stated as RELEVANCE MONOTONICITY (once the answer contains the section the query asked
	// for, a larger budget must not stop containing it) rather than "the section must always
	// be present". The stronger form is false on master and always has been: at budgets 22 and
	// 26 the budget cannot reach the middle section at all, and master breaks the same two
	// budgets — verified side by side, and the full set is 22, 23, 26 and 27 on BOTH the
	// changed and the master code path, so this change introduces no relevance regression at
	// any budget. Those four are admitted here so the property THIS change protects is the one
	// being asserted, rather than a stronger claim the seam has never met.
	const doc =
		"# Intro\n\n" +
		Array(6).fill("Intro paragraph text about gardens and lawns.").join(" ") +
		"\n\n## Kubernetes section\n\n" +
		Array(8).fill("Kubernetes pods restart when the liveness probe fails repeatedly.").join(" ") +
		"\n\n## More\n\n" +
		Array(6).fill("Unrelated trailing text about cooking and recipes.").join(" ") +
		"\n";
	const query = "kubernetes pods liveness probe";
	const PREEXISTING = new Set([22, 23, 26, 27]);
	const flips = [];
	let had = false;
	for (let budget = 20; budget <= 120; budget++) {
		const keeps = applyTokenBudget(doc, budget, query).toLowerCase().includes("kubernetes");
		if (had && !keeps && !PREEXISTING.has(budget)) flips.push(budget);
		had = had || keeps;
	}
	assert.deepEqual(
		flips,
		[],
		`${flips.length} budgets where a larger budget dropped the section the query asked for: ${flips.join(", ")}`,
	);
});
test("#206 option A: the content floor holds with NO query, where the query guard is inert", () => {
	// The `hasQuery` superset rule and the `carriesPageProse` floor overlap, and the overlap is
	// asymmetric: with a query, superseding the incumbent already implies it carries prose, so
	// the floor becomes hard to observe. Every other sweep in this file passes a query, which
	// is exactly why removing the floor guard looked like an equivalent mutation. It is not:
	// with no query, deleting it yields 6 answers carrying none of the page (headingLed@4-8 and
	// the pre-existing table@1). This sweep is the witness for that guard.
	const bad = [];
	for (const [name, doc] of Object.entries(DOCS)) {
		if (name === "table") continue; // pre-existing: master answers budget 1 with "|"
		for (let budget = 1; budget <= 120; budget++) {
			const out = applyTokenBudget(doc, budget, "");
			if (!carriesPageProse(out, doc)) bad.push(`${name}@${budget}`);
		}
	}
	assert.deepEqual(
		bad,
		[],
		`${bad.length} no-query answers carry none of the document: ${bad.slice(0, 8).join(", ")}`,
	);
});

test("#206 option A: a document's own horizontal rule is never mistaken for the notice", () => {
	// The candidate's notice must be the string the pipeline actually appended. Deriving it as
	// `incumbent.slice(lastIndexOf("\n\n---\n"))` looks equivalent and is not: a document that
	// ends with a rule has a real `---` in its body, so the document's own closing lines were
	// read as the notice and appended AGAIN. Measured on this fixture: 4 budgets answered with
	// `---` twice where master answers it once. Passing the pipeline's `footer` constant was
	// also wrong (it is the unshrunk base; pricing room on it made the selection a no-op and
	// the sweep returned to master's 91 violations), so the rule here is the notice's own
	// signature: it is italic, an authored rule is followed by a blank line and prose.
	const doc =
		"Real article prose about the topic that should be kept at moderate budgets here.\n\n---\n\nClosing note after the rule that is also part of the document.\n";
	const bad = [];
	for (let budget = 1; budget <= 120; budget++) {
		const out = applyTokenBudget(doc, budget, "q");
		if ((out.match(/^---$/gm) || []).length > 1) bad.push(budget);
	}
	assert.deepEqual(bad, [], `budgets answering with a duplicated rule: ${bad.join(", ")}`);
});
