// #190 — applyTokenBudget can return prose sitting inside an UNCLOSED fence.
//
// The defect is narrow and it is worth stating precisely, because the repro set in
// the issue mixes two different things. "``` caption: …" is an OPENING marker in
// Markdown (a closer may not carry an info string), so one of the reported documents
// is unbalanced on the way in and is returned verbatim whenever it fits the budget.
// This function budgets; it does not repair, and "closing" such a document would
// invent a line the author never wrote. So the property under test is:
//
//   a document that is CLOSED on input must still be CLOSED in the answer.
//
// Three properties constrain this seam and pull against each other, which is why four
// rounds on #188 each satisfied two by deleting content in a new way:
//   (1) a marker line that is the document's own content must survive;
//   (2) no answer may leave a stray marker that changes parsing context;
//   (3) the document's prose must survive at small budgets.
// The fix is not a fifth string rule: `findUnclosedFence` in this file already models
// fence state and is used by the closer. The candidate choice never asks it.
//
// The oracle is that same exported model, not a test-local re-spelling: a second
// definition of "ends inside a fence" would be a second model, and two models drift
// exactly like the six `stripWww` spellings in #167.
import assert from "node:assert";
import test from "node:test";

const { estimateTokens } = await import("../src/token-count.ts");
const { applyTokenBudget, findUnclosedFence, unwrapLeadingFences } = await import(
	"../src/prune-markdown.ts"
);

/** Documents that are well-balanced on input, so any openness is created by trimming. */
const CLOSED_INPUTS = [
	"```\n---\n```\nword more prose",
	"```\n---\n```\nword more prose here\n",
	"```js\nconst a = 1;\n```\nprose after the fence\n",
	"~~~\ntilde code\n~~~\ntilde prose tail\n",
	"````\nouter ``` inner ```` fence\n````\nafter\n",
	"# Heading\n\n```sh\nmake test\n```\n\nClosing prose paragraph.\n",
];

test("#190: a closed document never comes back with an open fence", () => {
	for (const src of CLOSED_INPUTS) {
		assert.equal(findUnclosedFence(src), null, `fixture itself is unbalanced: ${src}`);
		for (let b = 1; b <= 40; b++) {
			const answer = applyTokenBudget(src, b, "a");
			const open = findUnclosedFence(answer);
			assert.equal(
				open,
				null,
				`budget ${b} of ${JSON.stringify(src)} introduced an open fence ` +
					`(marker ${JSON.stringify(open?.marker)}): ${JSON.stringify(answer)}`,
			);
		}
	}
});

test("#190: the reported repro budgets are covered by that sweep", () => {
	// The issue's families, at the budgets it names — each one is a closed-input case
	// except the caption document, which is unbalanced on input (see header).
	for (const b of [7, 8, 9]) {
		const a = applyTokenBudget("```\n---\n```\nword more prose", b, "a");
		assert.equal(findUnclosedFence(a), null, `budget ${b}: ${JSON.stringify(a)}`);
	}
	for (const b of [4, 5, 6, 7, 8, 9, 10]) {
		const a = applyTokenBudget("```\n---\n```\nword more prose here\n", b, "a");
		assert.equal(findUnclosedFence(a), null, `budget ${b}: ${JSON.stringify(a)}`);
	}
});

// Every answer keeps the two properties that are NOT about fences, so a "fix" that
// buys fence balance with content loss is caught here rather than in six rounds.
test("#190: balance is never bought with an empty answer or a broken ceiling", () => {
	for (const src of [...CLOSED_INPUTS, "```\nintro\n``` caption: the fence example\ntail body text\n"]) {
		for (let b = 1; b <= 40; b++) {
			const answer = applyTokenBudget(src, b, "a");
			assert.ok(answer.length > 0, `budget ${b} returned nothing for ${JSON.stringify(src)}`);
			assert.ok(
				estimateTokens(answer) <= b,
				`budget ${b} exceeded by ${estimateTokens(answer)}: ${JSON.stringify(answer)}`,
			);
		}
	}
});

// Property (1), at a budget that can actually hold the document — at 10 tokens the
// content cannot survive and the assertion would be measuring something else.
test("#190: a fence documenting fences keeps its inner marker", () => {
	const src = "````\nthis page documents ``` fences in prose\n````\n";
	assert.ok(estimateTokens(src) <= 22, "fixture no longer fits the budget this test uses");
	const answer = applyTokenBudget(src, 22, "a");
	assert.ok(answer.includes("```"), `inner marker deleted: ${JSON.stringify(answer)}`);
	assert.equal(findUnclosedFence(answer), null);
});

// Property (3), likewise at a budget where prose and framing can coexist.
test("#190: closing a fence never costs the document its prose", () => {
	const src = "```\ncode line\n```\nthe important sentence stays\n";
	assert.ok(estimateTokens(src) <= 18, "fixture no longer fits the budget this test uses");
	const answer = applyTokenBudget(src, 18, "a");
	assert.match(answer, /important sentence/, `prose lost: ${JSON.stringify(answer)}`);
	assert.equal(findUnclosedFence(answer), null);
});

// The test above fits inside its budget, so it pins "fits is returned verbatim" and
// says nothing about how a trimmed answer is BUILT — a mutant that discarded every
// line after the closing fence survived it. Measured behaviour for this document:
// budgets 6..10 unwrap to the prose, 11..14 keep the fenced code, 15 is verbatim.
// These are the budgets where "the text after the run must survive" is decided.
test("#190: the prose AFTER a leading fence survives the trimming path", () => {
	const src = "```\ncode line\n```\nthe important sentence stays\n";
	for (const b of [6, 7, 8, 9, 10]) {
		const answer = applyTokenBudget(src, b, "a");
		assert.ok(
			/important|sentence/.test(answer),
			`budget ${b} lost the prose that follows the fence: ${JSON.stringify(answer)}`,
		);
		assert.equal(findUnclosedFence(answer), null, `budget ${b} left an open fence`);
		// No character bound here. `budget` counts TOKENS, and 28 characters is about 6
		// of them — a char <= budget+20 line was the wrong instrument and failed on a
		// document that was inside its budget. The ceiling is pinned by the sweep test
		// below, over many documents, where that formula is the one the module uses.
	}
});

// The policy that the sweep deliberately does NOT assert, pinned so nobody "fixes"
// it by silently repairing input: an unbalanced document that fits the budget is
// returned byte-for-byte. Making this function close it would add a line the author
// never wrote, which is a different feature with a different name.
test("#190: unbalanced input that fits is passed through, not repaired", () => {
	const src = "```\nintro\n``` caption: the fence example\ntail body text\n";
	assert.ok(findUnclosedFence(src), "fixture must be unbalanced for this test to mean anything");
	assert.ok(estimateTokens(src) <= 30, "fixture no longer fits the budget this test uses");
	assert.equal(applyTokenBudget(src, 30, "a"), src);
});

// The unwrap helper's own contract, pinned directly. These three shapes are what a
// dispatcher-level budget sweep cannot reach: no budget in the range above selects the
// unwrap candidate while also being long enough to carry the marker line, so a mutant
// that re-scanned a kept closer as a new opener — and so deleted a marker line that is
// the document's own content — survived the end-to-end tests.
test("#190: unwrap keeps a marker line that is data, drops only delimiters", () => {
	// Leading EMPTY fence, then a fence marker that is the document's content.
	assert.equal(
		unwrapLeadingFences("```\n\n```\ncritical\n```\nafter\n"),
		"critical\n```\nafter\n",
		"the marker line that is data was consumed as a delimiter",
	);
	// A stack of empty fences collapses entirely.
	assert.equal(unwrapLeadingFences("```\n```\n```\nplain text\n"), "plain text\n");
	// Scanning stops at the first plain line; later markers are content, not delimiters.
	assert.equal(unwrapLeadingFences("```\n\n```\n\n```\ntail\n"), "\n```\ntail\n");
});

test("#190: an unclosed leading fence loses only its opener", () => {
	// "``` caption" is an OPENER, not a closer, so the leading run never closes.
	// Consuming to end of input would delete the whole document.
	const out = unwrapLeadingFences("```\nintro\n``` caption: the fence example\ntail\n");
	assert.match(out, /intro/, `body lost: ${JSON.stringify(out)}`);
	assert.match(out, /caption/, `caption lost: ${JSON.stringify(out)}`);
	assert.match(out, /tail/, `tail lost: ${JSON.stringify(out)}`);
});

// The finding that the suite could not see. A randomised sweep over generated
// documents found 80 balanced inputs whose answer came back OPEN while the
// candidate-level fence preference was absent — and `test:all` was byte-for-byte
// green without it. The suite is an existence proof for the cases it contains, not
// for a universal claim, so the sweep itself is the test.
test("#190: a balanced document never comes back open (generated sweep)", () => {
	const MARKERS = ["```", "~~~", "````", "~~``", "    ```", "``` js", "``` cap: x"];
	const TEXT = ["alpha text", "beta", "gamma delta epsilon", "- list item", "# head", "| a | b |", "---", ""];
	// Deterministic LCG: the same corpus on every run, so a regression is reproducible.
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	let tested = 0;
	for (let t = 0; t < 4000; t++) {
		const lines = [];
		const n = 1 + Math.floor(rnd() * 7);
		for (let i = 0; i < n; i++) lines.push(rnd() < 0.45 ? pick(MARKERS) : pick(TEXT));
		const src = lines.join("\n") + "\n";
		// Only balanced documents: the tool does not repair input that was already
		// unbalanced, so those are not this property.
		if (findUnclosedFence(src)) continue;
		// A leading "---" is FRONTMATTER, which is kept whole by design; the fence it can
		// contain is the named residual pinned by the next test, not this property.
		if (lines[0] === "---") continue;
		tested++;
		for (let b = 1; b <= 20; b++) {
			const answer = applyTokenBudget(src, b, "a");
			assert.equal(
				findUnclosedFence(answer),
				null,
				`balanced source came back open at budget ${b}: ${JSON.stringify(src)} -> ${JSON.stringify(answer)}`,
			);
		}
	}
	assert.ok(tested > 500, `sweep degenerated to ${tested} balanced documents`);
});

// The one shape the sweep still finds, recorded rather than patched. A leading
// "---" is FRONTMATTER, and frontmatter is kept whole by design; when a fence is
// opened inside it and its closer sits in the body, truncating the body necessarily
// separates the pair. Repairing it would mean either dropping the metadata the
// caller asked to keep or appending a marker the author never wrote — the policy
// "unbalanced input is passed through, not repaired" already refuses the second.
// Pinning the behaviour so a future change to either side of this seam is visible.
test("#190: a fence opened inside kept frontmatter is a named residual, not a silent one", () => {
	const src = "---\n```\nalpha text\n---\n| a | b |\n````\n| a | b |\n";
	assert.equal(findUnclosedFence(src), null, "fixture must start balanced");
	const answer = applyTokenBudget(src, 13, "a");
	assert.match(answer, /^---\n```\nalpha text\n---/, "frontmatter was not kept whole");
	// The answer still carries document text and stays inside the ceiling; only the
	// fence pairing is inherited-broken.
	assert.ok(answer.trim().length > 0, "answer blank");
});

// CodeRabbit / Sourcery finding, confirmed by probe: a documented fence inside a
// LONGER fence is the document's content, and the earlier marker-counting content
// test swallowed it. At budget 8 the documented "```" used to vanish.
test("#190: a documented fence inside a longer fence survives", () => {
	const doc = "````\n```\n````\n" + "tail body text here\n".repeat(30);
	// Where the answer has room for the document, the documented fence must be there.
	for (const b of [16, 20, 24]) {
		const answer = applyTokenBudget(doc, b, "a");
		assert.ok(
			answer.includes("```"),
			`budget ${b} deleted the documented fence: ${JSON.stringify(answer)}`,
		);
	}
	// Where it does not, the content floor wins instead: the answer is the page's text,
	// never a marker. Measured: 8 and 12 yield the body prose. Asserting the fence here
	// too would demand the impossible — one token is either the delimiter or the text.
	for (const b of [8, 12]) {
		const answer = applyTokenBudget(doc, b, "a");
		assert.match(
			answer,
			/tail body/,
			`budget ${b} answered with framing instead of the document: ${JSON.stringify(answer)}`,
		);
	}
	// The literal-text branch of `bodyHoldsLiteralText` pinned by the two inputs a
	// generated differential found load-bearing (105 differing pairs). Without it the
	// scan treats a documented fence as an empty run, skips it, and the marker that
	// follows eats the whole room: the answer is a LONE BACKTICK where the document
	// had text. These are the content-floor cases, so the assertion is the floor, not
	// fence closure — both sources are unbalanced to begin with and keep that openness.
	for (const [src, expect] of [
		["````\n~~~\n``` js\n", /~~~/],
		["    ```\n````\n````\n``` cap: x\n", /cap: x/],
	]) {
		for (const b of [8, 12]) {
			const answer = applyTokenBudget(src, b, "a");
			assert.match(
				answer,
				expect,
				`budget ${b} answered with framing instead of the document: ${JSON.stringify(answer)}`,
			);
		}
	}
});

// CodeRabbit finding, confirmed by probe: String.trim() strips NBSP, so a body line
// of only U+00A0 counted as padding and was swallowed. Blankness for fence
// bookkeeping is ASCII space/tab/CR only — the same reason the CRLF fix in this file
// stopped using a trim-based blank test.
test("#190: a unicode-whitespace body line is content, not padding", () => {
	const doc = "```\n\u00a0\n```\n" + "tail body text here\n".repeat(30);
	for (const b of [8, 12]) {
		const answer = applyTokenBudget(doc, b, "a");
		// The NBSP-only line is the leading fence's whole body. Treating it as padding
		// unwraps the run and the line is gone; treating it as content stops the scan
		// there and the line is still in the answer. That is the whole difference this
		// assertion is drawn to distinguish — an `|| reached the prose` fallback here
		// made the test pass under either rule and was the reason a trim()-based blank
		// test survived mutation.
		assert.ok(
			/\u00a0/.test(answer),
			`budget ${b} swallowed the NBSP-only body line: ${JSON.stringify(answer)}`,
		);
	}
});
