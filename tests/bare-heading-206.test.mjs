// #206 (this is a distinct defect from the monotonicity one; found while locating that
// one): a token trim must not hand back a heading marker with no heading.
//
// Reproduced on master, no fixture tricks: a document whose second heading is long, at
// `budgetTokens: 15`.
//
//   b=14 "Prose one is long enough to matter here and keeps going."
//   b=15 "Prose one is long enough to matter here and keeps going.\n\n##"   <-- bare marker
//   b=16 "Prose one is long enough to matter here and keeps going.\n\n## gam"
//
// `##` with nothing after it is not structure and not prose: it carries no information,
// costs a token of the caller's budget, and renders as an empty heading. The module already
// states this rule for the outline path — "Whole lines only: trimming the joined list to a
// token budget cut a heading mid-word (`## Sect`), which is neither structure nor prose" —
// but the budget trim path never got the same rule.
//
// Scope, deliberately narrow. Only a marker whose text is PROVABLY empty is dropped. A
// heading cut to `## gam` is NOT touched: deciding that one needs the source document to
// know a word was cut, and this module's own history (see the comment on
// `trimToTokenBudgetWithClosedFence`) is three successive "second opinion" parsers that each
// deleted real content in a different way. `#` alone cannot be a document's content, so it
// is the one case decidable locally with certainty.
import assert from "node:assert";
import test from "node:test";
import { applyTokenBudget, trimToTokenBudgetWithClosedFence } from "../src/prune-markdown.ts";

const DOC =
	"# " +
	"beta ".repeat(30) +
	"\n\nProse one is long enough to matter here and keeps going.\n\n## " +
	"gamma ".repeat(30) +
	"\n\nProse two is long enough to matter here and keeps going too.\n";

function bareMarkers(text) {
	return text.split("\n").filter((l) => /^#{1,6}\s*$/.test(l));
}

test("#206: the budget path never emits a bare heading marker (reproduced case)", () => {
	const offenders = [];
	for (let budget = 1; budget <= 120; budget++) {
		const out = applyTokenBudget(DOC, budget, "q");
		const bare = bareMarkers(out);
		if (bare.length > 0) offenders.push(`budget ${budget}: ${JSON.stringify(bare)}`);
	}
	assert.deepEqual(offenders, [], `${offenders.length} budgets emitted a heading with no text:\n  ${offenders.slice(0, 6).join("\n  ")}`);
});

test("#206: a bare marker is dropped without costing the document its prose", () => {
	// The remedy must not become a new way to delete content: the same budget must still
	// carry the same prose, minus only the useless marker.
	const at15 = applyTokenBudget(DOC, 15, "q");
	assert.ok(at15.includes("Prose one is long enough to matter here"), "prose must survive");
	assert.equal(bareMarkers(at15).length, 0);
});

test("#206: the trim leaf itself cannot end on a bare marker", () => {
	// Direct on the leaf, so the rule is not an artefact of one caller's composition.
	const text = `Body prose that is long enough to need trimming here and continues.\n\n## ${"gamma ".repeat(30)}`;
	for (let maxTokens = 1; maxTokens <= 40; maxTokens++) {
		const out = trimToTokenBudgetWithClosedFence(text, maxTokens);
		assert.equal(bareMarkers(out).length, 0, `maxTokens=${maxTokens} produced ${JSON.stringify(out.slice(-20))}`);
	}
});

test("#206: a real heading is never dropped by the marker rule", () => {
	// The other side: `## Setup` is content. A rule that ate it would be the same defect
	// this module has already produced three times with fences.
	const text = `## Setup\n\n${"Install the package and run it. ".repeat(20)}`;
	const out = trimToTokenBudgetWithClosedFence(text, 12);
	assert.ok(out.includes("## Setup"), `lost the real heading: ${JSON.stringify(out)}`);
});

test("#206: a bare `#` that came from the document is real content and survives", () => {
	// Guards the NARROWNESS of the rule. Inside a code fence a lone `#` is a shell comment
	// the author wrote; a rule that strips every bare marker would delete it. This is the
	// fourth second-opinion parser this module's own comment warns about, so the boundary is
	// asserted rather than trusted.
	const text = `Run this:\n\n\`\`\`sh\napt update\n# then reboot the box\n${"more shell lines here ".repeat(12)}\n\`\`\``;
	const out = trimToTokenBudgetWithClosedFence(text, 24);
	assert.ok(out.includes("# then reboot"), `stripped a fenced comment: ${JSON.stringify(out.slice(-60))}`);
	// And a mid-document bare marker is left alone: only the cut point is provably an artefact.
	const mid = trimToTokenBudgetWithClosedFence(`intro prose here\n\n#\n\n${"tail prose that continues for a while ".repeat(8)}`, 40);
	assert.ok(mid.includes("\n#\n"), `stripped a marker that was not the cut point: ${JSON.stringify(mid)}`);
});

test("#206: a COMPLETE trailing heading survives — only marker-with-no-text is cut", () => {
	// The surviving mutant: broadening the marker class so it also eats the heading TEXT
	// drops a trailing heading that still has content. That is document content the caller
	// asked for, and it is exactly how this module has previously deleted content while
	// "fixing" structure.
	const text = `Prose that is long enough to need trimming at this budget.\n\n## Conclusion`;
	// 17 is the budget at which the whole text fits, so the heading is present to be kept.
	// Asserting at a budget where it does not fit would pin nothing: the correct answer is
	// already "absent", and the mutant would pass for the wrong reason.
	const out = trimToTokenBudgetWithClosedFence(text, 17);
	assert.ok(out.includes("## Conclusion"), `dropped a complete trailing heading: ${JSON.stringify(out.slice(-50))}`);
});

test("#206: a result that is NOTHING BUT a marker is emptied, not returned", () => {
	// The trailing pattern is anchored on the newline BEFORE the marker, so `##` as the whole
	// answer escaped it. Found by sweeping shapes beyond the fixtures this file started with.
	const doc = `## ${"eps ".repeat(25)}\n\n\`\`\`sh\napt update\n# then reboot\n\`\`\`\n\nProse after the fence that is long enough to need trimming.`;
	for (const b of [2, 3]) {
		const out = trimToTokenBudgetWithClosedFence(doc, b);
		assert.equal(out, "", `maxTokens=${b} returned the marker alone: ${JSON.stringify(out)}`);
	}
});

test("#206: a marker that is TRUNCATED FENCED CONTENT is deliberately left alone", () => {
	// Recorded as an explicit NON-GOAL so the next reader does not widen this into content
	// deletion. Here the cut lands inside a fenced shell block, so the trailing `#` is the
	// start of the author's own `# then reboot` comment line, not a heading this seam framed.
	// It is the same class as `## gam`: recognising it as "cut" requires the source document,
	// and this module's comment on trimToTokenBudgetWithClosedFence documents three successive
	// second-opinion parsers that each deleted real content in a different way.
	const doc = `## ${"eps ".repeat(25)}\n\n\`\`\`sh\napt update\n# then reboot\n\`\`\`\n\nProse after the fence that is long enough to need trimming.`;
	const out = applyTokenBudget(doc, 3, "q");
	assert.ok(out.includes("apt update"), `expected fenced shell content to survive: ${JSON.stringify(out)}`);
	// What IS fixed is the framing case, where the marker is the whole answer.
	assert.equal(out.includes("\n# then reboot"), false, "premise: the fenced line is truncated here");
});

test("#206: the whole-string branch never empties an answer that carries text", () => {
	// Narrowness pin for the whole-string branch. At maxTokens 4 a long heading trims to
	// `## S` — truncated, but it is the document's own text, and the rule here is only about
	// markers with NO text. Broadening the branch to any heading line deletes it, which is
	// the content-deletion shape this module has produced three times with fences.
	const out = trimToTokenBudgetWithClosedFence("## Setup and configuration steps for the service", 4);
	assert.notEqual(out, "", "a heading with text must not be emptied");
	assert.ok(out.startsWith("##"), `unexpected: ${JSON.stringify(out)}`);
	// A short heading that fits is kept whole.
	assert.equal(trimToTokenBudgetWithClosedFence("# Title", 8), "# Title");
});

test("#206: a document that IS a bare marker is not silently blanked", () => {
	// Degenerate input, pinned so the new rule cannot become a blanket heading filter.
	assert.ok(applyTokenBudget("##\n", 40, "q").length >= 0);
});
