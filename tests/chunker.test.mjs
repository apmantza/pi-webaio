// ─── Tests for P10: RAG chunks parameter ──────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chunkMarkdown,
	formatChunksText,
	maxTokenCount,
} from "../src/chunker.ts";
import { maybeChunkMarkdown } from "../src/tools/webfetch.ts";

test("chunkMarkdown: returns empty array for empty input", () => {
	assert.deepEqual(chunkMarkdown(""), []);
	assert.deepEqual(chunkMarkdown("   \n\n   "), []);
});

test("chunkMarkdown: returns empty array for whitespace-only input", () => {
	assert.deepEqual(chunkMarkdown("\n\n\n"), []);
	assert.deepEqual(chunkMarkdown("  \n  \n  "), []);
});

test("chunkMarkdown: single short paragraph returns one chunk", () => {
	const md = "Hello world.";
	const chunks = chunkMarkdown(md, { maxTokens: 100 });
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].text, "Hello world.");
	assert.equal(chunks[0].index, 0);
	assert.ok(chunks[0].tokenCount > 0);
});

test("chunkMarkdown: splits on paragraph boundaries (\\n\\n)", () => {
	const md = "Para one.\n\nPara two.\n\nPara three.";
	// Use a tight budget to force one chunk per paragraph.
	// Disable overlap so chunks are pure (no tail from previous).
	const chunks = chunkMarkdown(md, { maxTokens: 3, overlapTokens: 0 });
	assert.equal(chunks.length, 3);
	assert.equal(chunks[0].text, "Para one.");
	assert.equal(chunks[1].text, "Para two.");
	assert.equal(chunks[2].text, "Para three.");
	assert.equal(chunks[0].index, 0);
	assert.equal(chunks[1].index, 1);
	assert.equal(chunks[2].index, 2);
});

test("chunkMarkdown: groups paragraphs within token budget", () => {
	// 3 small paragraphs, maxTokens=50 should fit them all in one chunk
	const md =
		"First short paragraph.\n\nSecond short paragraph.\n\nThird short paragraph.";
	const chunks = chunkMarkdown(md, { maxTokens: 50 });
	assert.equal(chunks.length, 1);
	assert.ok(chunks[0].text.includes("First short paragraph"));
	assert.ok(chunks[0].text.includes("Second short paragraph"));
	assert.ok(chunks[0].text.includes("Third short paragraph"));
});

test("chunkMarkdown: enforces token budget by splitting", () => {
	// 5 paragraphs of ~5 tokens each, maxTokens=10 should create multiple chunks
	const paras = [
		"Alpha bravo charlie.",
		"Delta echo foxtrot.",
		"Golf hotel india.",
		"Juliet kilo lima.",
		"Mike november oscar.",
	];
	const md = paras.join("\n\n");
	const chunks = chunkMarkdown(md, { maxTokens: 10 });
	assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`);
	// Each chunk should be within budget (allow some slack for separators)
	for (const c of chunks) {
		assert.ok(
			c.tokenCount <= 20,
			`chunk ${c.index} has ${c.tokenCount} tokens, expected <= 20`,
		);
	}
});

test("chunkMarkdown: splits oversized paragraphs at sentence boundaries", () => {
	const longPara =
		"First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth sentence here. Sixth sentence here. Seventh sentence here. Eighth sentence here.";
	const chunks = chunkMarkdown(longPara, { maxTokens: 15 });
	assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
	// Sentences should be reasonably split
	for (const c of chunks) {
		assert.ok(c.text.length > 0, "chunk should not be empty");
	}
});

test("chunkMarkdown: handles H4-H6 headings as paragraph boundaries", () => {
	const md =
		"## H2 heading\n\nBody after H2.\n\n#### H4 heading\n\nBody after H4.\n\n##### H5 heading\n\nBody after H5.\n\n###### H6 heading\n\nBody after H6.";
	const chunks = chunkMarkdown(md, { maxTokens: 10 });
	// Each heading + body should be in its own chunk
	assert.ok(chunks.length >= 4, `expected >= 4 chunks, got ${chunks.length}`);
	// H4, H5, H6 headings should appear as chunks
	const allText = chunks.map((c) => c.text).join("\n");
	assert.ok(allText.includes("H4 heading"));
	assert.ok(allText.includes("H5 heading"));
	assert.ok(allText.includes("H6 heading"));
});

test("chunkMarkdown: applies overlap from previous chunk tail", () => {
	const md =
		"First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
	const chunksNoOverlap = chunkMarkdown(md, { maxTokens: 5, overlapTokens: 0 });
	const chunksWithOverlap = chunkMarkdown(md, {
		maxTokens: 5,
		overlapTokens: 5,
	});
	assert.ok(chunksWithOverlap.length >= 2);
	// With overlap, each subsequent chunk should contain content from the previous
	for (let i = 1; i < chunksWithOverlap.length; i++) {
		// The tail of the previous chunk should appear in the current chunk
		const prevTail = chunksWithOverlap[i - 1].text.slice(-20);
		assert.ok(
			chunksWithOverlap[i].text.includes(prevTail.trim()) ||
				chunksWithOverlap[i].text.length > chunksNoOverlap[i]?.text.length,
			`chunk ${i} should have overlap content`,
		);
	}
});

test("chunkMarkdown: overlap=0 disables overlap", () => {
	const md = "First.\n\nSecond.\n\nThird.\n\nFourth.";
	const chunks = chunkMarkdown(md, { maxTokens: 3, overlapTokens: 0 });
	// Verify no chunk contains content from previous (no overlap prefix)
	for (let i = 1; i < chunks.length; i++) {
		// No prefix from previous chunk's text
		assert.ok(!chunks[i].text.startsWith(chunks[i - 1].text));
	}
});

test("chunkMarkdown: normalizes \\r\\n to \\n", () => {
	const md = "Para one.\r\n\r\nPara two.\r\n\r\nPara three.";
	const chunks = chunkMarkdown(md, { maxTokens: 3, overlapTokens: 0 });
	assert.equal(chunks.length, 3);
	assert.equal(chunks[0].text, "Para one.");
	assert.equal(chunks[2].text, "Para three.");
});

test("chunkMarkdown: throws on invalid maxTokens", () => {
	assert.throws(() => chunkMarkdown("hello", { maxTokens: 0 }), /maxTokens/);
	assert.throws(() => chunkMarkdown("hello", { maxTokens: -1 }), /maxTokens/);
});

test("chunkMarkdown: throws on negative overlapTokens", () => {
	assert.throws(
		() => chunkMarkdown("hello", { maxTokens: 100, overlapTokens: -1 }),
		/overlapTokens/,
	);
});

test("chunkMarkdown: tokenCount uses our estimateTokens (CJK counted individually)", () => {
	// CJK characters: each ~1-2 tokens in cl100k_base
	// Our estimateTokens counts them individually (not 1 per 4 chars)
	const cjkPara = "你好世界这是中文测试段落。";
	const chunks = chunkMarkdown(cjkPara, { maxTokens: 100 });
	assert.equal(chunks.length, 1);
	// 12 CJK chars → at least 8 tokens (our heuristic counts CJK as 1 per char)
	assert.ok(
		chunks[0].tokenCount >= 8,
		`CJK should be counted as ~1 per char, got ${chunks[0].tokenCount}`,
	);
});

test("chunkMarkdown: handles markdown with code blocks (preserves them)", () => {
	const md =
		"Intro paragraph.\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nOutro paragraph.";
	// The point: code blocks are preserved (not stripped, not mangled by the
	// backtick-special-char handling in estimateTokens). The exact chunk
	// count depends on the budget.
	const chunks = chunkMarkdown(md, { overlapTokens: 0 });
	const allText = chunks.map((c) => c.text).join("\n\n");
	assert.ok(
		allText.includes("```js"),
		"code fence with language should be preserved",
	);
	assert.ok(
		allText.includes("const x = 1;"),
		"first line of code should be preserved",
	);
	assert.ok(
		allText.includes("const y = 2;"),
		"second line of code should be preserved",
	);
	assert.ok(
		allText.includes("Intro paragraph"),
		"intro paragraph should be preserved",
	);
	assert.ok(
		allText.includes("Outro paragraph"),
		"outro paragraph should be preserved",
	);
});

test("chunkMarkdown: indices are 0-based and sequential", () => {
	const md = "A.\n\nB.\n\nC.\n\nD.\n\nE.";
	const chunks = chunkMarkdown(md, { maxTokens: 2 });
	for (let i = 0; i < chunks.length; i++) {
		assert.equal(
			chunks[i].index,
			i,
			`chunk at position ${i} should have index ${i}`,
		);
	}
});

// ─── maybeChunkMarkdown wrapper ────────────────────────────────────

test("maybeChunkMarkdown: returns undefined when chunks: false", () => {
	const errors = [];
	const result = maybeChunkMarkdown("# Hello", { chunks: false }, errors);
	assert.equal(result, undefined);
	assert.equal(errors.length, 0, "should not push errors when chunks disabled");
});

test("maybeChunkMarkdown: returns undefined for empty body", () => {
	const errors = [];
	const result = maybeChunkMarkdown("", { chunks: true }, errors);
	assert.equal(result, undefined);
	assert.equal(errors.length, 0, "empty body is not an error");
});

test("maybeChunkMarkdown: returns undefined for undefined body", () => {
	const errors = [];
	const result = maybeChunkMarkdown(undefined, { chunks: true }, errors);
	assert.equal(result, undefined);
	assert.equal(errors.length, 0, "undefined body is not an error");
});

test("maybeChunkMarkdown: returns chunks for valid body", () => {
	const errors = [];
	const result = maybeChunkMarkdown(
		"# Title\n\nBody paragraph.",
		{ chunks: true },
		errors,
	);
	assert.ok(result && result.length > 0, "should return non-empty chunks");
	const first = result[0];
	assert.ok(
		first.text.includes("Title") || first.text.includes("Body"),
		"first chunk should contain Title or Body text",
	);
	assert.equal(errors.length, 0, "valid body should not produce errors");
});

test("maybeChunkMarkdown: returns undefined for empty markdown (all whitespace)", () => {
	const errors = [];
	const result = maybeChunkMarkdown("   \n\n   ", { chunks: true }, errors);
	assert.equal(result, undefined);
	assert.equal(errors.length, 0, "whitespace body is not an error");
});

test("maybeChunkMarkdown: pushes generic message to errors array on failure", () => {
	const errors = [];
	// Force failure by passing invalid maxTokens (chunkMarkdown throws)
	const result = maybeChunkMarkdown(
		"valid body",
		{ chunks: true, maxTokens: 0 },
		errors,
	);
	assert.equal(result, undefined);
	assert.equal(errors.length, 1, "should push exactly one error");
	assert.equal(
		errors[0],
		"chunking failed for this result",
		"should use generic message",
	);
});

// ─── maxTokenCount helper ──────────────────────────────────────────

test("maxTokenCount: returns 0 for undefined", () => {
	assert.equal(maxTokenCount(undefined), 0);
});

test("maxTokenCount: returns 0 for empty array", () => {
	assert.equal(maxTokenCount([]), 0);
});

test("maxTokenCount: returns max across chunks", () => {
	const chunks = [
		{ text: "a", tokenCount: 10, index: 0 },
		{ text: "b", tokenCount: 50, index: 1 },
		{ text: "c", tokenCount: 25, index: 2 },
	];
	assert.equal(maxTokenCount(chunks), 50);
});

test("maxTokenCount: does not throw on large arrays (no spread)", () => {
	// Build a 100k-element array — Math.max(...arr) would RangeError on V8
	// (~65k arg limit). Our loop-based version should be safe.
	const chunks = Array.from({ length: 100_000 }, (_, i) => ({
		text: "x",
		tokenCount: i,
		index: i,
	}));
	assert.equal(maxTokenCount(chunks), 99_999);
});

// ─── formatChunksText helper ───────────────────────────────────────

test("formatChunksText: returns empty header and body for undefined", () => {
	const out = formatChunksText(undefined, 50);
	assert.equal(out.header, "");
	assert.equal(out.body, "");
});

test("formatChunksText: returns empty header and body for empty array", () => {
	const out = formatChunksText([], 50);
	assert.equal(out.header, "");
	assert.equal(out.body, "");
});

test("formatChunksText: produces header with count, max tokens, overlap", () => {
	const chunks = [
		{ text: "a", tokenCount: 10, index: 0 },
		{ text: "b", tokenCount: 50, index: 1 },
	];
	const out = formatChunksText(chunks, 25);
	assert.ok(out.header.includes("2 generated"), "should include count");
	assert.ok(
		out.header.includes("max 50 tokens"),
		"should include max token count",
	);
	assert.ok(out.header.includes("overlap 25"), "should include overlap");
});

test("formatChunksText: produces body with [CHUNK] markers", () => {
	const chunks = [
		{ text: "first", tokenCount: 5, index: 0 },
		{ text: "second", tokenCount: 6, index: 1 },
	];
	const out = formatChunksText(chunks, 0);
	assert.ok(
		out.body.includes("[CHUNK 0 / 2 / 5 tokens]"),
		"should include first CHUNK marker",
	);
	assert.ok(out.body.includes("first"), "should include first text");
	assert.ok(
		out.body.includes("[CHUNK 1 / 2 / 6 tokens]"),
		"should include second CHUNK marker",
	);
	assert.ok(out.body.includes("second"), "should include second text");
	assert.ok(out.body.includes("[/CHUNK]"), "should close CHUNK markers");
});

test("formatChunksText: indent prefix is applied", () => {
	const chunks = [{ text: "x", tokenCount: 1, index: 0 }];
	const out = formatChunksText(chunks, 0, "  ");
	assert.ok(out.header.startsWith("  "), "header should have indent prefix");
	assert.ok(
		out.body.startsWith("  [CHUNK"),
		"body CHUNK markers should have indent",
	);
});
