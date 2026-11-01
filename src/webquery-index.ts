// ─── BM25 index builder and loader for aio-webpull corpus ────────────
// Serializes per-chunk metadata into a compact JSON file alongside the
// pulled markdown files. Loaded at query time by aio-webquery.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { chunkMarkdown } from "./chunker.ts";
import { extractFrontmatterUrl } from "./markdown-frontmatter.ts";
import { createBM25Scorer, extractTerms } from "./bm25.ts";

/** Index format version — bump when the stored shape changes. */
export const INDEX_VERSION = 1;

/** Name of the index file written into the output directory. */
export const INDEX_FILENAME = ".webaio-index.json";

/** One indexed chunk stored in the JSON file. */
export interface IndexedChunk {
	/** Relative path from outDir to the source markdown file. */
	file: string;
	/** Original URL from YAML frontmatter. */
	url: string;
	/** Heading breadcrumb derived from the chunk (first # heading found). */
	heading: string;
	/** The chunk text itself. */
	text: string;
}

/** Full index file structure. */
interface WebpullIndex {
	version: number;
	/** ISO timestamp of the last build. */
	builtAt: string;
	/** Absolute path of the output directory at build time. */
	outDir: string;
	chunks: IndexedChunk[];
}

// ─── Index building ────────────────────────────────────────────────────

/**
 * Extract the first H1/H2 heading from a chunk of text as a breadcrumb.
 */
function extractHeading(text: string): string {
	const match = text.match(/^#{1,6}\s+(.+)$/m);
	return match ? match[1].trim() : "";
}

/**
 * Walk `outDir` recursively and collect all `.md` files.
 */
async function collectMarkdownFiles(outDir: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue; // skip hidden files/dirs
			const full = join(dir, entry);
			let info;
			try {
				info = await stat(full);
			} catch {
				continue;
			}
			if (info.isDirectory()) {
				await walk(full);
			} else if (entry.endsWith(".md")) {
				results.push(full);
			}
		}
	}
	await walk(outDir);
	return results;
}

/**
 * Build a BM25 index from all markdown files currently on disk in `outDir`.
 * Writes the result to `<outDir>/.webaio-index.json`.
 *
 * This does a full rebuild — safe to call after any pull (incremental or fresh).
 */
export async function buildIndex(outDir: string): Promise<void> {
	const allFiles = await collectMarkdownFiles(outDir);
	const chunks: IndexedChunk[] = [];

	for (const fullPath of allFiles) {
		let markdown: string;
		try {
			markdown = await readFile(fullPath, "utf8");
		} catch {
			continue;
		}

		const url = extractFrontmatterUrl(markdown) ?? "";
		const rel = relative(outDir, fullPath).replace(/\\/g, "/");

		const fileChunks = chunkMarkdown(markdown, {
			maxTokens: 512,
			overlapTokens: 50,
		});

		for (const chunk of fileChunks) {
			chunks.push({
				file: rel,
				url,
				heading: extractHeading(chunk.text),
				text: chunk.text,
			});
		}
	}

	const index: WebpullIndex = {
		version: INDEX_VERSION,
		builtAt: new Date().toISOString(),
		outDir,
		chunks,
	};

	await writeFile(join(outDir, INDEX_FILENAME), JSON.stringify(index), "utf8");
}

// ─── Index loading ─────────────────────────────────────────────────────

export type LoadIndexResult =
	| { ok: true; index: WebpullIndex }
	| {
			ok: false;
			reason: "missing" | "version_mismatch" | "corrupt";
			message: string;
	  };

/**
 * Load and validate the index from `outDir`.
 */
export async function loadIndex(outDir: string): Promise<LoadIndexResult> {
	const indexPath = join(outDir, INDEX_FILENAME);
	let raw: string;
	try {
		raw = await readFile(indexPath, "utf8");
	} catch {
		return {
			ok: false,
			reason: "missing",
			message: `No index found at ${indexPath}. Run aio-webpull on this directory first to build the index.`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			reason: "corrupt",
			message: `Index file at ${indexPath} is corrupt (invalid JSON). Re-run aio-webpull to rebuild it.`,
		};
	}

	if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
		return {
			ok: false,
			reason: "corrupt",
			message: `Index file at ${indexPath} is missing required fields. Re-run aio-webpull to rebuild it.`,
		};
	}

	const obj = parsed as Record<string, unknown>;
	if (obj["version"] !== INDEX_VERSION) {
		return {
			ok: false,
			reason: "version_mismatch",
			message: `Index version mismatch (found ${obj["version"]}, expected ${INDEX_VERSION}). Re-run aio-webpull to rebuild the index.`,
		};
	}

	return { ok: true, index: parsed as WebpullIndex };
}

// ─── Querying ─────────────────────────────────────────────────────────

/** One ranked hit returned by {@link queryIndex}. */
export interface CorpusHit {
	/** BM25 relevance score (higher = more relevant). */
	score: number;
	/** Relative path from outDir to the source markdown file. */
	file: string;
	/** Original URL from YAML frontmatter (may be empty). */
	url: string;
	/** Heading breadcrumb (may be empty). */
	heading: string;
}

export type QueryIndexResult =
	| { ok: true; hits: CorpusHit[]; chunkCount: number; builtAt: string }
	| {
			ok: false;
			reason: "missing" | "version_mismatch" | "corrupt";
			message: string;
	  };

/**
 * Rank corpus chunks against a query. THE single ranking seam for the corpus
 * path: `queryIndex()` and the aio-webquery tool both call it, so the two cannot
 * drift (issue #165 F15).
 *
 * Two guards the old `score > 0` filter lacked, because BM25 returns a positive
 * score for any shared word:
 *  1. a discriminative-term floor, so matching only ubiquitous corpus words
 *     reports "no relevant chunks" instead of confident-looking noise;
 *  2. a per-file cap with backfill, so a file that contributed most of the
 *     chunks cannot own the whole result set.
 */
/** Tuning for the corpus ranking seam. */
export interface RankOptions {
	/**
	 * Max chunks one file may contribute to the returned set, with the remaining
	 * slots backfilled from other files. 0 disables the cap. Default 2.
	 */
	perFileCap?: number;
	/**
	 * Require a hit to contain at least one DISCRIMINATIVE query term. Default
	 * true.
	 */
	requireDiscriminative?: boolean;
}

/** Default per-file ceiling in a corpus result set. */
export const DEFAULT_PER_FILE_CAP = 2;

/**
 * A query term is discriminative when it is present in the corpus but rare
 * enough that matching it means something: at least one file contains it, and at
 * most two thirds of the FILES do. A term in every file ("state" in a zustand
 * corpus) proves nothing, and a term in no file matches nothing — so a query
 * whose only corpus-wide words are ubiquitous yields no hits instead of confident
 * garbage.
 *
 * Document frequency is counted per FILE, not per chunk: a page split into six
 * chunks must not count six times, or a term unique to the biggest file would be
 * rejected as ubiquitous. The `max(1, …)` floor keeps a one-file corpus from
 * silencing itself.
 */
function discriminativeTerms(
	terms: string[],
	fileTermSets: Map<string, Set<string>>,
): Set<string> | null {
	if (terms.length === 0) return null;
	const dfMax = Math.max(1, Math.floor(fileTermSets.size * (2 / 3)));
	const out = new Set<string>();
	for (const t of terms) {
		let df = 0;
		for (const set of fileTermSets.values()) if (set.has(t)) df++;
		if (df > 0 && df <= dfMax) out.add(t);
	}
	return out;
}

/**
 * Rank corpus chunks against a query. THE single ranking seam for the corpus
 * path: `queryIndex()` and the aio-webquery tool both call it, so the two cannot
 * drift (issue #165 F15).
 */
/**
 * Rank corpus chunks and return the surviving chunks with their scores.
 * Use this when the caller needs the chunk body; `rankChunks()` is the same
 * ranking reduced to the public hit shape.
 */
export function rankChunkEntries(
	query: string,
	chunks: IndexedChunk[],
	topK = 8,
	opts: RankOptions = {},
): { score: number; chunk: IndexedChunk }[] {
	const k = Math.max(1, Math.floor(topK));
	const scorer = createBM25Scorer(query);
	const scores = scorer.scoreAll(chunks.map((c) => c.text));

	// One tokenization pass per chunk, reused by the floor. Same order of work
	// the scorer already does for scoring.
	const chunkTermSets = chunks.map((c) => new Set(extractTerms(c.text)));
	// Fold chunk term sets up to per-file sets so DF counts files, not chunks.
	const fileTermSets = new Map<string, Set<string>>();
	chunks.forEach((c, i) => {
		const acc = fileTermSets.get(c.file) ?? new Set<string>();
		for (const t of chunkTermSets[i]!) acc.add(t);
		fileTermSets.set(c.file, acc);
	});
	const discriminative =
		opts.requireDiscriminative === false
			? null
			: discriminativeTerms(scorer.queryTerms, fileTermSets);

	const ranked = scores
		.map((score, i) => ({ score, i }))
		.filter(({ score, i }) => {
			if (score <= 0) return false;
			if (!discriminative) return true;
			const set = chunkTermSets[i]!;
			for (const t of discriminative) if (set.has(t)) return true;
			return false;
		})
		.sort((a, b) => b.score - a.score);

	// Per-file cap: a hard ceiling on how many chunks one file may contribute.
	// Overflow is DROPPED, not deferred to the tail — re-appending it would make
	// the cap a no-op whenever topK exceeds the cap, which is exactly the monopoly
	// this guard exists to stop. Slots go to other files' chunks instead, so a
	// skewed corpus yields a shorter, more diverse set rather than the same skew.
	const cap = opts.perFileCap ?? DEFAULT_PER_FILE_CAP;
	const kept: typeof ranked = [];
	if (cap > 0) {
		const perFile = new Map<string, number>();
		for (const entry of ranked) {
			const file = chunks[entry.i]!.file;
			const seen = perFile.get(file) ?? 0;
			if (seen >= cap) continue;
			perFile.set(file, seen + 1);
			kept.push(entry);
			if (kept.length >= k) break;
		}
	} else {
		kept.push(...ranked.slice(0, k));
	}

	return kept.map(({ score, i }) => ({ score, chunk: chunks[i]! }));
}

/**
 * Rank corpus chunks against a query, reduced to the public hit shape.
 * THE single ranking seam for the corpus path (see `rankChunkEntries`).
 */
export function rankChunks(
	query: string,
	chunks: IndexedChunk[],
	topK = 8,
	opts: RankOptions = {},
): CorpusHit[] {
	return rankChunkEntries(query, chunks, topK, opts).map(({ score, chunk }) => ({
		score,
		file: chunk.file,
		url: chunk.url,
		heading: chunk.heading,
	}));
}

/**
 * Load the corpus index at `outDir` and return the top-`topK` BM25-ranked
 * chunks matching `query`. This is the shared query primitive reused by
 * aio-webquery and the aio-webfetch local-knowledge pre-check (F8) so the
 * scoring logic lives in exactly one place.
 *
 * Returns `ok: false` (with the loadIndex reason) when the index is missing
 * or invalid, and an empty `hits` array when the corpus exists but nothing
 * matches the query terms.
 */
export async function queryIndex(
	outDir: string,
	query: string,
	topK = 8,
): Promise<QueryIndexResult> {
	const loaded = await loadIndex(outDir);
	if (!loaded.ok) {
		return { ok: false, reason: loaded.reason, message: loaded.message };
	}

	const { index } = loaded;
	const { chunks } = index;
	if (chunks.length === 0) {
		return { ok: true, hits: [], chunkCount: 0, builtAt: index.builtAt };
	}

	const hits = rankChunks(query, chunks, topK);

	return { ok: true, hits, chunkCount: chunks.length, builtAt: index.builtAt };
}
