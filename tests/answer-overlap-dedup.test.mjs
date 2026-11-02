// ─── Issue #131: answer mode must not display the chunker's overlap twice ───
//
// `chunkMarkdown` prepends the previous chunk's tail to each chunk (overlap is
// a RETRIEVAL feature — it gives a chunk the context it needs to score well).
// Answer mode then composes the top-k chunks for DISPLAY. When two adjacent
// chunks both make the top-k, the shared span is rendered twice: once as chunk
// N's tail and again as chunk N+1's overlap head.
//
// Observed on a 27,781-char article, 2026-09-19:
//   the table fragment ending "…update its pinned and patched revision /
//   Multiple GGUF models behind one endpoint" rendered twice;
//   a "Keep a model loaded. / Unload it immediately." code-block header the
//   same way.
//
// Retrieval quality and display correctness are different requirements, so the
// fix is not "turn overlap off": the chunker now records the exact span it
// prepended (`Chunk.overlapPrefix`) and the composer trims that span when the
// previously displayed chunk already ends with it. Only the span the chunker
// itself generated is ever touched, so legitimately repeated content (a table
// that repeats its header, a deliberate code-block repeat) is left alone.
//
// Recurrence prevented: answer-mode output carrying the same sentence twice
// because a retrieval-only artefact leaked into the composed answer.

import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkMarkdown } from "../src/chunker.ts";
import { applyQueryAnswerMode } from "../src/tools/webfetch.ts";

const SENTINEL = "ZZTAILSENTINEL unique tail phrase that must appear once";

/**
 * Two paragraphs that both match the query, separated by enough filler that the
 * chunker splits them into adjacent chunks whose overlap carries SENTINEL.
 */
function twoAdjacentMatchingChunks() {
	const filler = (n) =>
		Array.from({ length: n }, (_, i) => `filler ${i} ${"pad ".repeat(20)}`).join("\n\n");
	return [
		`## First section\n\nalpha ${SENTINEL}`,
		filler(30),
		`## Second section\n\nalpha beta gamma ${SENTINEL.replace("unique tail phrase", "unique tail phrase again")}`,
		filler(30),
	].join("\n\n");
}

test("#131: the chunker records the overlap span it prepends", () => {
	const chunks = chunkMarkdown(twoAdjacentMatchingChunks(), {
		maxTokens: 120,
		overlapTokens: 50,
	});
	assert.ok(chunks.length > 1, "expected multiple chunks");
	const withOverlap = chunks.filter((c) => c.overlapPrefix);
	assert.ok(
		withOverlap.length > 0,
		"the chunker must record which span it prepended as overlap",
	);
	for (const c of withOverlap) {
		assert.ok(
			c.text.startsWith(c.overlapPrefix),
			"the recorded prefix must be the literal head of the chunk text",
		);
	}
});

test("#131: overlap-free chunking records no prefix", () => {
	const chunks = chunkMarkdown(twoAdjacentMatchingChunks(), {
		maxTokens: 120,
		overlapTokens: 0,
	});
	assert.ok(chunks.every((c) => c.overlapPrefix === undefined));
});

test("#131: adjacent selected chunks do not render the overlap span twice", () => {
	// Reproduction shape: the marker sits at the END of the first paragraph, so it
	// is part of chunk 0's body AND part of chunk 1's overlap head. Both chunks
	// match the query, so both are selected and both are displayed.
	const MARK = "||MARKERTAIL||";
	const para = (t, n) => `${t} ${"word ".repeat(n)}`;
	const body = [
		`${para("alpha intro", 60)}${MARK}`,
		para("alpha next", 60),
		para("unrelated filler", 60),
		para("more filler", 60),
	].join("\n\n");

	const chunks = chunkMarkdown(body, { maxTokens: 120, overlapTokens: 50 });
	const carrying = chunks.filter((c) => c.text.includes(MARK)).map((c) => c.index);
	// The fixture is only valid if the marker is in ADJACENT chunks — otherwise the
	// second sighting is genuine content and this test proves nothing.
	assert.deepEqual(
		carrying,
		[0, 1],
		"fixture must place the marker in two adjacent chunks (one real, one overlap)",
	);

	const answer = applyQueryAnswerMode(body, "alpha", 2, {
		maxTokens: 120,
		overlapTokens: 50,
	});
	assert.ok(answer, "answer mode should have produced output");

	const occurrences = answer.split(MARK).length - 1;
	assert.equal(
		occurrences,
		1,
		`the marker rendered ${occurrences} times: it is real content in chunk 0 and only an overlap artefact in chunk 1, so the composed answer must show it once`,
	);
});

test("#131: legitimately repeated content is NOT deduped", () => {
	// A table that repeats its header on purpose is real content, not overlap.
	const repeated = "| Col A | Col B |\n| --- | --- |\n| 1 | 2 |";
	const body = [
		`## Table one\n\nalpha\n\n${repeated}`,
		"",
		`## Table two\n\nalpha\n\n${repeated}`,
	].join("\n\n");
	const answer = applyQueryAnswerMode(body, "alpha", 5, {
		maxTokens: 120,
		overlapTokens: 50,
	});
	assert.ok(answer);
	const occurrences = answer.split(repeated).length - 1;
	assert.equal(
		occurrences,
		2,
		"two intentional table repeats must both survive — only the chunker's own overlap span may be trimmed",
	);
});

// Mutation-found gap (M-G): the first "legitimate repeat" test did not pin the
// `endsWith` guard, because an intentional repeat sits in a chunk's BODY, not in
// its overlap head. The guard's real job is different: when the selected chunks
// are NOT adjacent, a chunk's overlap head is the tail of a chunk that was never
// displayed. Trimming it unconditionally deletes content the reader never saw.
//
// Recurrence prevented: answer mode dropping a chunk's opening lines because the
// chunk before it was filtered out by score.
test("#131: a non-adjacent selection keeps its overlap head (the previous chunk was never shown)", () => {
	const HIDDEN = "||HIDDENHEAD||";
	const para = (t, n) => `${t} ${"word ".repeat(n)}`;
	const body = [
		`${para("zeta first", 60)}${HIDDEN}`,
		para("gamma middle", 60),
		para("gamma last", 60),
	].join("\n\n");

	const chunks = chunkMarkdown(body, { maxTokens: 120, overlapTokens: 50 });
	// The MIDDLE chunk's overlap head is the first chunk's tail, which carries HIDDEN.
	const middle = chunks[1];
	assert.ok(
		middle?.overlapPrefix?.includes(HIDDEN),
		"fixture must make the middle chunk's overlap head carry the marker",
	);

	// Select the two "gamma" chunks: chunk 0, which SUPPLIED the middle chunk's
	// overlap head, is never displayed.
	const answer = applyQueryAnswerMode(body, "gamma", 2, {
		maxTokens: 120,
		overlapTokens: 50,
	});
	assert.ok(answer);
	assert.ok(
		answer.includes(HIDDEN),
		"the last chunk's opening span must survive — the chunk that supplied it was not selected, so this is the reader's only copy",
	);
});

// Note on CodeRabbit #172 thread 1 (adjacency check): a fixture with three
// identical paragraphs does make tail(N-1) === tail(N-2), but the proposed extra
// guard could not be made to fail on any input. If `endsWith` matches, the span is
// already displayed, so nothing is hidden. The guard was rejected and the test that
// would have pinned it was removed rather than left passing vacuously — the same
// trap this file already records twice.
