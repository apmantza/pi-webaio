// ─── aio-webquery corpus ranking (issue #165, F15) ───
//
// `queryIndex()` and the aio-webquery tool each ranked chunks with
// `.filter(r => r.score > 0).sort().slice(0, topK)` — no relevance floor and no
// per-file cap. BM25 returns a positive score for *any* shared word, so:
//
//   query "how to persist state to localStorage" over a 4-page zustand corpus
//     -> 3 hits, all from comparison.md, all score=0.108, none about persistence
//   query "valtio" / "count" -> 3/3 from comparison.md, because that file
//     contributed 6 of the 10 chunks and therefore monopolized topK
//
// Two independent guards, both scale-free (no magic absolute score):
//  1. a hit must contain at least one DISCRIMINATIVE query term — one whose
//     document frequency is counted over FILES and stays below two thirds of
//     them. Matching only words every file shares ("state" in a zustand corpus)
//     is incidental and must read as "no relevant chunks".
//  2. a per-file cap with backfill, so one document cannot own topK.
//
// Recurrence prevented: confident-looking garbage presented as retrieval results,
// and a corpus query whose answer set is decided by file chunk-count skew.
import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	buildIndex,
	queryIndex,
	rankChunkEntries,
	DEFAULT_PER_FILE_CAP,
} from "../src/webquery-index.ts";

// A chatty page that owns 6 of the 10 chunks — the skew that produced the live
// monopoly. "benchmark" is the term only this family of pages carries.
const comparison = (n) => ({
	file: "comparison.md",
	url: `https://docs.example.com/comparison#${n}`,
	heading: `Comparison ${n}`,
	text: `Benchmark this: the state here is a library state. Benchmark ${n} covers benchmark coverage of state options.`,
});

// The corpus as it behaves for the cap tests: includes a page that genuinely
// answers the persist/localStorage question.
function corpusWithPersist() {
	return [
		comparison(1),
		comparison(2),
		comparison(3),
		comparison(4),
		comparison(5),
		comparison(6),
		{
			file: "middleware.md",
			url: "https://docs.example.com/middleware",
			heading: "Persist",
			text: "The persist middleware writes your state to localStorage so it survives reloads. Benchmark notes apply too.",
		},
		{
			file: "immer.md",
			url: "https://docs.example.com/immer",
			heading: "Immer",
			text: "The immer middleware updates nested state immutably. Benchmark notes apply too.",
		},
		{
			file: "devtools.md",
			url: "https://docs.example.com/devtools",
			heading: "Devtools",
			text: "The devtools middleware logs every state transition in the Redux devtools panel.",
		},
		{
			file: "shallow.md",
			url: "https://docs.example.com/shallow",
			heading: "Shallow",
			text: "useShallow selects a slice of state and prevents rerenders on unrelated updates.",
		},
	];
}

// The live shape: a corpus with NO persistence page, where the persist query must
// report nothing instead of confident noise.
function corpusWithoutPersist() {
	return corpusWithPersist().filter((c) => c.file !== "middleware.md");
}

const rank = (query, chunks, topK = 8) => rankChunkEntries(query, chunks, topK);

const describeHits = (hits) =>
	hits.map((h) => `${h.chunk.file} (${h.chunk.heading}) ${h.score.toFixed(3)}`).join(", ");

// ─── Guard 1: discriminative-term floor ───

test("F15: a query matching only corpus-wide words reports no relevant chunks", () => {
	// "state" appears in all five files: matching it proves nothing.
	const hits = rank("state", corpusWithPersist(), 8);
	assert.equal(hits.length, 0, `expected zero-signal, got ${hits.length}: ${describeHits(hits)}`);
});

test("F15: the live case — persist query over a corpus with no persist page", () => {
	// Reproduced from the finding: 3 hits, all comparison.md, all score=0.108,
	// none about persistence.
	const hits = rank("how to persist state to localStorage", corpusWithoutPersist(), 3);
	assert.equal(hits.length, 0, `expected nothing, got ${hits.length}: ${describeHits(hits)}`);
});

test("F15: a genuinely relevant query still finds its chunk", () => {
	const hits = rank("persist localStorage", corpusWithPersist(), 8);
	assert.ok(hits.length >= 1, "a query with corpus-rare terms must return hits");
	assert.equal(hits[0].chunk.file, "middleware.md");
	assert.equal(hits[0].chunk.heading, "Persist");
});

test("F15: a single-file corpus is not silenced by the floor", () => {
	// Degenerate corpus: every term is in 100% of files, which must not make
	// every match non-discriminative.
	const chunks = [
		{ file: "only.md", url: "u", heading: "H", text: "quantum flux capacitor calibration" },
	];
	const hits = rank("flux capacitor", chunks, 5);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].chunk.file, "only.md");
});

test("F15: a term unique to the biggest file is not treated as ubiquitous", () => {
	// DF must count files, not chunks: comparison.md holds 6 of 10 chunks, so a
	// chunk-level DF would call "benchmark" ubiquitous and reject it.
	const hits = rank("benchmark", corpusWithPersist(), 8);
	assert.ok(hits.length > 0, "a file-specific term must remain searchable");
	assert.ok(hits.every((h) => /benchmark/i.test(h.chunk.text)));
});

// ─── Guard 2: per-file cap with backfill ───

test("F15: one file cannot monopolize topK", () => {
	const hits = rank("benchmark state", corpusWithPersist(), 4);
	const perFile = new Map();
	for (const h of hits) perFile.set(h.chunk.file, (perFile.get(h.chunk.file) ?? 0) + 1);
	const max = Math.max(...perFile.values());
	assert.ok(
		max <= 2,
		`a single file contributed ${max} of ${hits.length} hits: ${[...perFile]
			.map(([f, n]) => `${f}=${n}`)
			.join(", ")}`,
	);
	// The cap backfills from other qualifying files rather than truncating.
	assert.equal(hits.length, 4, "topK must still be filled from other files");
	assert.ok(
		!hits.every((h) => h.chunk.file === "comparison.md"),
		"result set must not be one document",
	);
});

test("F15: the monopoly reproduces with the cap disabled (guards the guard)", () => {
	// Documents what the fix changes. If this ever stops being true the fixture
	// drifted and the cap test above would be vacuous.
	const uncapped = rankChunkEntries("benchmark state", corpusWithPersist(), 4, {
		perFileCap: 0,
	});
	assert.equal(uncapped.length, 4);
	assert.ok(
		uncapped.every((h) => h.chunk.file === "comparison.md"),
		`expected the monopoly, got ${uncapped.map((h) => h.chunk.file).join(", ")}`,
	);
});

test("F15: fewer qualifying chunks than topK returns what exists", () => {
	const chunks = [
		{ file: "a.md", url: "u", heading: "H", text: "zephyr quux" },
		{ file: "a.md", url: "u", heading: "H", text: "zephyr quux again" },
		{ file: "a.md", url: "u", heading: "H", text: "zephyr quux thrice" },
	];
	const hits = rank("zephyr quux", chunks, 8);
	assert.equal(hits.length, 2, "the default cap of 2 applies even to a lone file");
});

// ─── One ranking seam ───

test("F15: the shared queryIndex path gets both guards", async () => {
	const dir = await mkdtemp(join(tmpdir(), "webaio-f15-"));
	const chunks = corpusWithPersist();
	for (let i = 0; i < chunks.length; i++) {
		const c = chunks[i];
		await writeFile(
			join(dir, `${String(i).padStart(2, "0")}-${c.file}`),
			`---\nurl: ${c.url}\ntitle: ${c.heading}\n---\n\n${c.text}\n`,
		);
	}
	// One page long enough that `buildIndex` splits it into many chunks, each of
	// which mentions `zephyr`, while none of the pages above do. Without this the
	// per-file cap cannot be exercised through the index at all: writing every
	// chunk to its own numbered file gives every file a count of exactly 1.
	await writeFile(
		join(dir, "zephyr-long.md"),
		`---\nurl: https://docs.example.com/zephyr\ntitle: Zephyr\n---\n\n` +
			Array.from(
				{ length: 40 },
				(_, i) =>
					`## Zephyr section ${i}\n\nThe zephyr configuration is documented here at some length so that the indexer splits this page into several chunks, each of which mentions zephyr. Section ${i} adds filler words to push the token count up.`,
			).join("\n\n") +
			"\n",
		"utf8",
	);
	await buildIndex(dir);

	const relevant = await queryIndex(dir, "persist localStorage", 8);
	assert.equal(relevant.ok, true);
	if (!relevant.ok) return;
	assert.ok(relevant.hits.length >= 1, "the real path must find the persist chunk");
	assert.equal(relevant.hits[0].file.replace(/^\d+-/, ""), "middleware.md");

	const noise = await queryIndex(dir, "state", 8);
	assert.equal(noise.ok, true);
	if (!noise.ok) return;
	assert.equal(noise.hits.length, 0, `the real path must report zero-signal, got ${noise.hits.length}`);

	// The per-file cap, asserted through the REAL index path. It used to be
	// vacuous two ways over: every chunk was written to its own numbered file, so
	// no file could ever contribute more than one chunk, and the chosen query
	// ("benchmark state") can return zero hits — `Math.max(...new Map())` is
	// -Infinity, which passes any `<= 2`.
	//
	// `zephyr-long.md` is one page long enough for `buildIndex` to split into many
	// chunks, each of which mentions the term, while the other six pages never do.
	// So the term is discriminative (1 of 7 files) and the single file genuinely
	// has more qualifying chunks than the cap allows.
	const wide = await queryIndex(dir, "zephyr", 8);
	assert.equal(wide.ok, true);
	if (!wide.ok) return;
	assert.ok(
		wide.hits.length > 0,
		"the cap assertion below would be vacuous on an empty result",
	);
	const perFile = new Map();
	for (const h of wide.hits) perFile.set(h.file, (perFile.get(h.file) ?? 0) + 1);
	assert.equal(
		perFile.get("zephyr-long.md"),
		DEFAULT_PER_FILE_CAP,
		`one page with many matching chunks must be capped at ${DEFAULT_PER_FILE_CAP}, got ${perFile.get("zephyr-long.md")}`,
	);
	// topK 8 returning exactly the cap proves the CAP is what bound the result,
	// not the page simply having few chunks.
	assert.ok(
		wide.hits.length < 8,
		`topK 8 returned a full 8 — cannot tell the cap from a short corpus`,
	);
});
