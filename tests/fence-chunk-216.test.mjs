// #216 — answer mode hands its consumers a document whose fence state is wrong.
//
// The filed symptom was odd fence-marker parity in the composed answer. Measuring the
// production path showed the cause is upstream of the composition and worse than parity:
// `chunkMarkdown` splits on /\n\n+/, so a fenced block is ONE paragraph (code bodies have
// no blank lines), and when that paragraph exceeds the budget `splitOversized` falls
// through to word-packing joined with " " — which replaces every newline inside the fence.
// A code block therefore arrives at the next consumer as a single line whose opener is
// buried mid-text: parity is broken, and so is the thing a fence exists to preserve.
//
// Decided boundary (acceptance criterion 4): fence-awareness is a CHUNKER property, not a
// composition responsibility. The chunker defines the boundaries; if a boundary may fall
// inside a fence then every consumer must re-derive fence state, and `chunks: true`,
// aio-webquery's corpus index and research quotes are all broken the same way. Closing the
// gap only at composition would paper over the one surface that happened to be observed.
import assert from "node:assert";
import test from "node:test";
import { chunkMarkdown } from "../src/chunker.ts";
import { findUnclosedFence } from "../src/prune-markdown.ts";
import { applyQueryAnswerMode } from "../src/tools/webfetch.ts";

/**
 * Real fence balance, not a marker count. Counting ``` lines and taking %2 is a proxy that
 * lies: a 4-backtick fence containing a 3-backtick fence (or a ~~~ inside a ```) changes the
 * count without changing the state. That proxy is what the original issue evidence rested on,
 * and it reported the extracted body as broken when it is in fact balanced -- so the tests
 * here use the state machine the rest of the codebase uses.
 */
/**
 * Fence balance is judged with the codebase's OWN predicate, not a local copy. Measured: a
 * spaces-only helper disagreed with `findUnclosedFence` on 3 of 366 real chunks and called
 * them broken when every shipped consumer (cleanMarkdown, prune-markdown, outline) agrees they
 * are fine. Writing a third private state machine is the drift #212 is about; if this import
 * ever changes, the tests move with the model rather than inventing a rival one.
 */
const balanced = (s) => findUnclosedFence(s) === null;
const code = (n) => Array.from({ length: n }, (_, i) => `const value${i} = compute(${i});`).join("\n");

test("#216: an oversized fenced block keeps its line structure", () => {
	const doc = `# Title\n\nIntro paragraph long enough to be its own unit for the chunker here.\n\n\`\`\`js\n${code(40)}\n\`\`\`\n\n## After\n\nTrailing prose after the code block.\n`;
	const chunks = chunkMarkdown(doc, { maxTokens: 60, overlapTokens: 0 });
	const all = chunks.map((c) => c.text).join("\n");
	// The defect: word-packing collapsed the block onto one line.
	const lines = all.split("\n").filter((l) => /const value\d+ = compute/.test(l));
	assert.ok(
		lines.length >= 40,
		`code lines were flattened: ${lines.length} lines carry code where 40 exist; sample: ${JSON.stringify(all.slice(0, 120))}`,
	);
});

test("#216: no chunk ends inside a fence (oversized block)", () => {
	const doc = `# T\n\n\`\`\`js\n${code(40)}\n\`\`\`\n\nTail prose.\n`;
	for (const c of chunkMarkdown(doc, { maxTokens: 60, overlapTokens: 0 })) {
		assert.ok(balanced(c.text), `chunk ${c.index} ends inside a fence: ${JSON.stringify(c.text.slice(0, 80))}`);
	}
});

test("#216: the marker-count proxy alone would have missed this", () => {
	// Guards the correction: 4-backtick fence wrapping a 3-backtick fence has an EVEN marker
	// count and is still balanced; a lone closer has an odd count and is unbalanced. If these
	// two ever disagree with `balanced`, the state machine -- not the tests -- is what changed.
	assert.ok(balanced("````\n```\n````\n"));
	assert.ok(!balanced("```\n"));
	assert.ok(!balanced("text\n```\n"));
	// And the shipped model is the yardstick: a tab-indented fence counts to it and to no local
	// spaces-only copy, which is exactly where the two disagreed on the real corpus.
	assert.ok(!balanced("\t```\n"), "shipped model treats a tab-indented opener as a fence");
});

test("#216: a fence containing blank lines is not split in half", () => {
	// A code body with blank paragraphs inside it is where the naive /\n\n+/ split does its
	// damage WITHOUT any oversized handling being involved: the opener and the closer land in
	// different units, so parity breaks at budgets where nothing needs hard-splitting.
	const body = "first section\n\nsecond section\n\nthird section\n\nfourth section\n\nfifth section";
	const doc = `# T\n\n\`\`\`\n${body}\n\`\`\`\n\nTail prose.\n`;
	for (const maxTokens of [6, 10, 20, 40]) {
		for (const c of chunkMarkdown(doc, { maxTokens, overlapTokens: 0 })) {
			assert.ok(balanced(c.text), `maxTokens=${maxTokens} chunk ${c.index} ends inside a fence: ${JSON.stringify(c.text.slice(0, 60))}`);
		}
	}
});

test("#216: prose directly above a fence does not merge into the block", () => {
	// No blank line between them, which is common in real docs. Merging them makes one unit
	// whose first lines are prose, and the block boundary then sits mid-fence.
	const doc = `Prose line that runs straight into the block.\n\`\`\`js\n${code(30)}\n\`\`\`\n`;
	for (const c of chunkMarkdown(doc, { maxTokens: 40, overlapTokens: 0 })) {
		assert.ok(balanced(c.text), `chunk ${c.index} ends inside a fence: ${JSON.stringify(c.text.slice(0, 60))}`);
	}
	const all = chunkMarkdown(doc, { maxTokens: 40, overlapTokens: 0 }).map((c) => c.text).join("\n");
	assert.ok(all.includes("Prose line that runs straight into the block."), "prose must not be dropped");
	// The named recurrence for the opener-break guard: without it the prose is glued into a
	// unit dominated by code, so a BM25 query for the PROSE scores a chunk of 30 code lines.
	// Verified observable -- deleting the flush() changes chunk count 8 -> 7 and puts both in
	// chunk 0.
	const proseChunk = chunkMarkdown(doc, { maxTokens: 40, overlapTokens: 0 }).find((c) => c.text.includes("Prose line that runs straight into the block."));
	assert.ok(proseChunk, "premise: the prose is present");
	assert.ok(!/^\s{0,3}(`{3,}|~{3,})/m.test(proseChunk.text), `prose was glued into a code block: ${JSON.stringify(proseChunk.text.slice(0, 80))}`);
});

test("#216: the composed answer never has dangling fence parity", () => {
	const doc = `# Intro\n\n${"Intro prose about gardens and lawns. ".repeat(30)}\n\n## Code\n\n\`\`\`js\n${code(40)}\n\`\`\`\n\n## More\n\n${"Trailing unrelated prose. ".repeat(30)}\n`;
	const out = applyQueryAnswerMode(doc, "compute value", 2);
	assert.ok(out, "premise: answer mode produced output");
	assert.ok(balanced(out), `composed answer ends inside a fence:\n${out.slice(-200)}`);
});

test("#216: the overlap window never carries a partial fence", () => {
	// THE mechanism every other test here missed, because they all passed overlapTokens: 0 and
	// the DEFAULT is 50. `takeTailForTokens` cut at a word boundary, so the tail could start
	// inside a fenced block and prepend a closing delimiter with no opener. Measured on the
	// real saved corpus: 181 unbalanced chunks from balanced sources, all via this path.
	const doc = `# T\n\n${"Prose about the topic that fills the first chunk nicely. ".repeat(12)}\n\n\`\`\`js\n${code(40)}\n\`\`\`\n\nClosing prose after the block.\n`;
	for (const overlapTokens of [0, 20, 50, 120]) {
		for (const c of chunkMarkdown(doc, { maxTokens: 60, overlapTokens })) {
			assert.ok(balanced(c.text), `overlap=${overlapTokens} chunk ${c.index} ends inside a fence: ${JSON.stringify(c.text.slice(0, 70))}`);
		}
	}
});

test("#216: default-options chunking stays balanced on prose+code documents", () => {
	// No explicit options at all: this is what aio-webfetch answer mode actually calls.
	const doc = `# Guide\n\n${"Intro prose that is long enough to matter here. ".repeat(40)}\n\n## Example\n\n\`\`\`sh\n${Array.from({ length: 80 }, (_, i) => `step-${i} --flag=${i}`).join("\n")}\n\`\`\`\n\n## End\n\n${"Closing prose. ".repeat(40)}\n`;
	for (const c of chunkMarkdown(doc)) {
		assert.ok(balanced(c.text), `chunk ${c.index} ends inside a fence: ${JSON.stringify(c.text.slice(0, 70))}`);
	}
});

test("#216: chunking still preserves fence CONTENT", () => {
	const doc = `# T\n\n\`\`\`js\n${code(60)}\n\`\`\`\n`;
	const all = chunkMarkdown(doc, { maxTokens: 60, overlapTokens: 0 }).map((c) => c.text).join("\n");
	for (const probe of ["const value0 = compute(0);", "const value30 = compute(30);", "const value59 = compute(59);"]) {
		assert.ok(all.includes(probe), `code line lost: ${probe}`);
	}
});

// ─── #218: the four findings from the Qodo review of PR #218 ───────────────────
// All four reproduced against the first version of the #216 fix, on real code paths, before
// any of them were addressed. They survived my own suite because it asserted balance and
// content but never (a) the shared predicate's closer rule, (b) budget adherence, (c) indent
// agreement with the shipped opener, or (d) that a piece is not a degenerate empty block.

test("#218 F1: a marker line with trailing text is literal code, not a closer", () => {
	// findUnclosedFence requires a closer to contain only the marker. The chunker's first version
	// accepted "```js is how you open" as a closer, which desynchronised it from every consumer.
	const body = "```js\nconst x = 1;\n```js is how you open\nconst y = 2;\n```\n";
	const chunks = chunkMarkdown(`# T\n\n${body}\n\nTail.\n`, { maxTokens: 12, overlapTokens: 0 });
	for (const c of chunks) {
		assert.ok(balanced(c.text), `unbalanced chunk: ${JSON.stringify(c.text.slice(0, 70))}`);
	}
	assert.ok(chunks.some((c) => c.text.includes("```js is how you open")), "the literal line must survive");
});

test("#218 F2: no chunk exceeds the caller's token budget", () => {
	// A fenced minified line was emitted whole: 382 tokens under a 40-token budget, and the
	// caller kept it because it was the first result.
	const long = `const payload = [${Array.from({ length: 400 }, (_, i) => i).join(",")}];`;
	for (let b = 12; b <= 80; b += 4) {
		for (const c of chunkMarkdown(`\`\`\`js\n${long}\n\`\`\`\n`, { maxTokens: b, overlapTokens: 0 })) {
			assert.ok(c.tokenCount <= b, `budget ${b} produced a ${c.tokenCount}-token chunk`);
		}
	}
});

test("#218 F2b: a token-dense fence is not waved through by the char heuristic", () => {
	// One word per line with blank lines: short in characters, dense in tokens. Making the
	// block atomic (this very fix) let a 66-token block pass `length <= maxTokens*4` under a
	// 47-token budget -- a regression the sweep caught, so it is pinned here.
	const dense = "```\n" + "x\n\n".repeat(60) + "```\n";
	for (let b = 12; b <= 80; b += 4) {
		for (const c of chunkMarkdown(dense, { maxTokens: b, overlapTokens: 0 })) {
			assert.ok(c.tokenCount <= b, `budget ${b} produced a ${c.tokenCount}-token chunk`);
		}
	}
});

test("#218 F3: the chunker and the shared predicate agree on indented openers", () => {
	// FENCE_OPEN allows any leading whitespace; the chunker's first version allowed three spaces
	// and so disagreed about where the block started.
	const src = "Some prose.\n\n    ~~~\n``` inside the fence\nstill fence\n    ~~~\n\nTail.\n";
	for (const c of chunkMarkdown(src, { maxTokens: 12, overlapTokens: 0 })) {
		assert.ok(balanced(c.text), `unbalanced chunk: ${JSON.stringify(c.text.slice(0, 70))}`);
	}
});

test("#218 F4: a piece is never an empty code block", () => {
	// Flush right before the block's own closer used to emit "```js\n```" -- a blank fenced
	// block handed to the reader and counted as a ranking candidate.
	const code = Array.from({ length: 12 }, (_, i) => `line${i} = ${i};`).join("\n");
	for (let b = 6; b <= 40; b++) {
		for (const c of chunkMarkdown(`\`\`\`js\n${code}\n\`\`\`\n`, { maxTokens: b, overlapTokens: 0 })) {
			const t = c.text.trim();
			const inner = t.replace(/^(`{3,}|~{3,})[^\n]*\n?/, "").replace(/\n?\s*(`{3,}|~{3,})\s*$/, "").trim();
			assert.ok(!/^(`{3,}|~{3,})/.test(t) || inner.length > 0, `budget ${b} produced an empty fenced block: ${JSON.stringify(c.text)}`);
		}
	}
});
