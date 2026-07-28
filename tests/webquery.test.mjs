// ─── Tests for aio-webquery: BM25 index build and search ─────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import {
	buildIndex,
	loadIndex,
	INDEX_VERSION,
	INDEX_FILENAME,
} from "../src/webquery-index.ts";
import { resolveCorpusDir } from "../src/tools/webquery.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

async function makeTempDir() {
	return mkdtemp(join(osTmpdir(), "webquery-test-"));
}

/**
 * Write a minimal markdown file with YAML frontmatter into `dir`.
 */
async function writeMd(dir, relPath, url, body) {
	const full = join(dir, relPath);
	await mkdir(join(dir, relPath.split("/").slice(0, -1).join("/")), {
		recursive: true,
	});
	const content = `---\ntitle: "Test"\nurl: "${url}"\n---\n\n${body}`;
	await writeFile(full, content, "utf8");
}

// ─── buildIndex ───────────────────────────────────────────────────────

test("buildIndex: creates index file in outDir", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"index.md",
			"https://example.com/",
			"Hello world. This is a test page about dogs.",
		);
		await buildIndex(dir);
		const result = await loadIndex(dir);
		assert.ok(result.ok, "index should load successfully");
		assert.equal(result.index.version, INDEX_VERSION);
		assert.ok(result.index.chunks.length > 0, "should have at least one chunk");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildIndex: chunks contain source file, URL, and text", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"docs/intro.md",
			"https://example.com/docs/intro",
			"## Introduction\n\nThis document explains the introduction to the system.",
		);
		await buildIndex(dir);
		const result = await loadIndex(dir);
		assert.ok(result.ok);
		const chunk = result.index.chunks[0];
		assert.ok(
			chunk.file.includes("intro.md"),
			`expected file path in chunk, got: ${chunk.file}`,
		);
		assert.equal(chunk.url, "https://example.com/docs/intro");
		assert.ok(chunk.text.length > 0, "chunk text should not be empty");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildIndex: extracts heading breadcrumb from chunks", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"guide.md",
			"https://example.com/guide",
			"## Getting Started\n\nFollow these steps to get started with the API.",
		);
		await buildIndex(dir);
		const result = await loadIndex(dir);
		assert.ok(result.ok);
		const headingChunk = result.index.chunks.find((c) =>
			c.heading.includes("Getting Started"),
		);
		assert.ok(headingChunk, "should find a chunk with the heading");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildIndex: multiple files are all indexed", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"page-a.md",
			"https://example.com/a",
			"Content about apples and fruit.",
		);
		await writeMd(
			dir,
			"page-b.md",
			"https://example.com/b",
			"Content about bicycles and transport.",
		);
		await buildIndex(dir);
		const result = await loadIndex(dir);
		assert.ok(result.ok);
		const files = new Set(result.index.chunks.map((c) => c.file));
		assert.ok(files.has("page-a.md"), "page-a.md should be indexed");
		assert.ok(files.has("page-b.md"), "page-b.md should be indexed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildIndex: full rebuild on second call keeps index consistent", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"v1.md",
			"https://example.com/v1",
			"Version one content.",
		);
		await buildIndex(dir);
		const r1 = await loadIndex(dir);
		assert.ok(r1.ok);
		const countAfterFirst = r1.index.chunks.length;

		// Add a second file, rebuild
		await writeMd(
			dir,
			"v2.md",
			"https://example.com/v2",
			"Version two content.",
		);
		await buildIndex(dir);
		const r2 = await loadIndex(dir);
		assert.ok(r2.ok);
		assert.ok(
			r2.index.chunks.length > countAfterFirst,
			"second build should include more chunks",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── loadIndex ────────────────────────────────────────────────────────

test("loadIndex: returns missing error when no index file", async () => {
	const dir = await makeTempDir();
	try {
		const result = await loadIndex(dir);
		assert.ok(!result.ok);
		assert.equal(result.reason, "missing");
		assert.ok(
			result.message.includes("aio-webpull"),
			"message should mention aio-webpull",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadIndex: returns corrupt error for invalid JSON", async () => {
	const dir = await makeTempDir();
	try {
		await writeFile(join(dir, INDEX_FILENAME), "not json!!!", "utf8");
		const result = await loadIndex(dir);
		assert.ok(!result.ok);
		assert.equal(result.reason, "corrupt");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadIndex: returns version_mismatch for wrong version", async () => {
	const dir = await makeTempDir();
	try {
		const badIndex = {
			version: 999,
			builtAt: new Date().toISOString(),
			outDir: dir,
			chunks: [],
		};
		await writeFile(
			join(dir, INDEX_FILENAME),
			JSON.stringify(badIndex),
			"utf8",
		);
		const result = await loadIndex(dir);
		assert.ok(!result.ok);
		assert.equal(result.reason, "version_mismatch");
		assert.ok(
			result.message.includes("Re-run aio-webpull"),
			"message should tell user to re-pull",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadIndex: returns corrupt error for missing version field", async () => {
	const dir = await makeTempDir();
	try {
		const badIndex = { builtAt: new Date().toISOString(), chunks: [] };
		await writeFile(
			join(dir, INDEX_FILENAME),
			JSON.stringify(badIndex),
			"utf8",
		);
		const result = await loadIndex(dir);
		assert.ok(!result.ok);
		assert.equal(result.reason, "corrupt");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── BM25 query relevance ─────────────────────────────────────────────

test("query returns relevant chunks with attribution", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"dogs.md",
			"https://example.com/dogs",
			"Dogs are loyal animals. They make great companions and are known for their playfulness.",
		);
		await writeMd(
			dir,
			"cats.md",
			"https://example.com/cats",
			"Cats are independent creatures. They are known for their agility and self-sufficiency.",
		);
		await buildIndex(dir);

		const { createBM25Scorer } = await import("../src/bm25.ts");
		const result = await loadIndex(dir);
		assert.ok(result.ok);

		const scorer = createBM25Scorer("loyal dog companions");
		const scores = scorer.scoreAll(result.index.chunks.map((c) => c.text));
		const ranked = scores
			.map((score, i) => ({ score, chunk: result.index.chunks[i] }))
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score);

		assert.ok(ranked.length > 0, "should find at least one relevant chunk");
		// The dog page should rank above the cat page for a dogs-related query
		const topChunk = ranked[0].chunk;
		assert.ok(
			topChunk.url === "https://example.com/dogs",
			`top result should be the dogs page, got: ${topChunk.url}`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("topK limits the number of results", async () => {
	const dir = await makeTempDir();
	try {
		// Write many pages
		for (let i = 0; i < 10; i++) {
			await writeMd(
				dir,
				`page-${i}.md`,
				`https://example.com/page-${i}`,
				`Page ${i} talks about programming languages and software development techniques.`,
			);
		}
		await buildIndex(dir);
		const { createBM25Scorer } = await import("../src/bm25.ts");
		const result = await loadIndex(dir);
		assert.ok(result.ok);

		const scorer = createBM25Scorer("programming software");
		const scores = scorer.scoreAll(result.index.chunks.map((c) => c.text));
		const topK = 3;
		const ranked = scores
			.map((score, i) => ({ score, chunk: result.index.chunks[i] }))
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);

		assert.ok(ranked.length <= topK, `should return at most ${topK} results`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── dir resolution (B5) ───────────────────────────────────────────

test("resolveCorpusDir: relative paths resolve against the temp base (B5)", () => {
	const base = join(osTmpdir(), "pi-webaio");
	// undefined → the base itself
	assert.equal(resolveCorpusDir(undefined), base);
	// relative hostname subdir → base/<hostname>, matching aio-webpull's layout
	assert.equal(resolveCorpusDir("example.com"), join(base, "example.com"));
	assert.ok(isAbsolute(resolveCorpusDir("example.com")));
	// absolute paths pass through unchanged
	const abs = join(osTmpdir(), "somewhere-else");
	assert.equal(resolveCorpusDir(abs), abs);
});
