// ─── Multi-source focused answer mode (UX8) ──────────────────────────
//
// Cited RETRIEVAL across multiple fetched pages — NOT a generated answer.
//
// aio-webfetch's single-URL answer mode (applyQueryAnswerMode in
// src/tools/webfetch.ts) chunks ONE page, BM25-ranks the chunks against a
// query, and returns the top-k with heading breadcrumbs. This module extends
// that to MULTIPLE sources: chunk every page, pool all the chunks, BM25-rank
// the pool, and return the top-k chunks each tagged with its source URL +
// heading breadcrumb so the agent can verify every claim against the page it
// came from.
//
// Everything here is pure and side-effect free (unit-tested offline in
// tests/ux-multi-answer.test.mjs). It reuses the same primitives as the
// single-URL path — chunkMarkdown (src/chunker.ts) + createBM25Scorer
// (src/bm25.ts) — so ranking behaves identically; only the pooling +
// per-chunk source attribution is new.

import { createBM25Scorer } from "./bm25.ts";
import { chunkMarkdown, type Chunk, type ChunkOptions } from "./chunker.ts";

/** One fetched page fed into the multi-source pool. */
export interface MultiAnswerSource {
	/** Canonical source URL — carried onto every chunk drawn from this page. */
	url: string;
	/** Page title (optional; surfaced alongside the source URL). */
	title?: string;
	/**
	 * The page's extracted markdown. May still carry the leading YAML
	 * frontmatter + [UNTRUSTED WEB CONTENT] markers the fetch pipeline adds —
	 * both are stripped before chunking so the returned chunk text is clean
	 * supporting prose (the rendered answer is re-wrapped in fresh markers).
	 */
	content: string;
}

/** A ranked chunk drawn from the pooled sources. */
export interface RankedChunk {
	/** Source URL this chunk was drawn from (always present — the citation). */
	url: string;
	/** Source page title, when known. */
	title?: string;
	/** Heading breadcrumb (last ATX heading seen at/before this chunk). */
	heading?: string;
	/** The verbatim supporting text (frontmatter + markers stripped). */
	text: string;
	/** BM25 relevance score against the query (higher = more relevant). */
	score: number;
}

/** Options for {@link rankChunksAcrossSources}. */
export interface RankChunksOptions {
	/** Maximum number of top-scoring chunks to return. Default 5. Min 1. */
	topK?: number;
	/** Chunking knobs (maxTokens / overlapTokens) forwarded to chunkMarkdown. */
	chunkOptions?: ChunkOptions;
}

/** Options for {@link formatMultiSourceAnswer}. */
export interface FormatMultiSourceAnswerOptions {
	/**
	 * Number of sources the answer was drawn from (for the header line).
	 * Defaults to the count of distinct source URLs in `ranked`.
	 */
	sourcesCount?: number;
	/**
	 * Wrap the output in the [UNTRUSTED WEB CONTENT] safety markers. Default
	 * true (safe by default). Callers that apply a further transform (e.g. a
	 * hard token budget) and re-wrap themselves pass false to avoid nesting.
	 */
	wrap?: boolean;
}

/** Default number of cited chunks returned in multi-source answer mode. */
export const DEFAULT_MULTI_ANSWER_TOP_K = 5;

// Leading YAML frontmatter block (`---\n…\n---\n`) the fetch pipeline adds.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

// The prompt-injection safety markers. They wrap content, they ARE NOT
// content — strip them before chunking so they never leak into a chunk.
const MARKER_LINE_RE = /^\[UNTRUSTED WEB CONTENT (START|END)\]\s*$/;

// First ATX heading inside a chunk (mirrors applyQueryAnswerMode). Used to
// track the heading breadcrumb as we walk a source's chunks in order.
const HEADING_INLINE_RE = /^#{1,6}\s+(.+)/m;

/** Wrap web-derived display text in the prompt-injection safety markers. */
function wrapUntrusted(inner: string): string {
	return `[UNTRUSTED WEB CONTENT START]\n${inner}\n[UNTRUSTED WEB CONTENT END]`;
}

/**
 * Strip the fetch pipeline's leading frontmatter + safety markers so chunk
 * text is clean supporting prose. Pure.
 */
function stripWrapper(content: string): string {
	const withoutFm = content.replace(FRONTMATTER_RE, "");
	const lines = withoutFm
		.split("\n")
		.filter((line) => !MARKER_LINE_RE.test(line.trim()));
	return lines.join("\n").trim();
}

/**
 * Pool chunks from multiple sources and BM25-rank them against `query`.
 *
 * Returns the top-k highest-scoring chunks (score descending; pool order
 * breaks ties), each tagged with its source URL + heading breadcrumb so the
 * result is verifiable cited retrieval, not a black-box answer.
 *
 * Returns `[]` for an empty source list, an empty/whitespace query, or when
 * no source yields any chunks — so callers can fall back cleanly.
 */
export function rankChunksAcrossSources(
	sources: ReadonlyArray<MultiAnswerSource>,
	query: string,
	opts: RankChunksOptions = {},
): RankedChunk[] {
	if (!Array.isArray(sources) || sources.length === 0) return [];
	if (!query || !query.trim()) return [];

	const topK = Math.max(1, Math.floor(opts.topK ?? DEFAULT_MULTI_ANSWER_TOP_K));
	const chunkOptions = opts.chunkOptions ?? {};

	// Pool every chunk, tagging each with its source + heading context.
	const pool: Array<{
		source: MultiAnswerSource;
		chunk: Chunk;
		heading: string;
	}> = [];

	for (const source of sources) {
		if (!source || !source.content) continue;
		const clean = stripWrapper(source.content);
		if (!clean) continue;

		let chunks: Chunk[];
		try {
			chunks = chunkMarkdown(clean, chunkOptions);
		} catch {
			// A source that fails to chunk is skipped, not fatal — the other
			// sources still contribute to the pool.
			continue;
		}
		if (chunks.length === 0) continue;

		// Walk this source's chunks in document order, tracking the last
		// heading seen so each chunk carries its heading breadcrumb (handles
		// the chunker splitting a heading into its own chunk).
		let currentHeading = "";
		for (const chunk of chunks) {
			const hm = chunk.text.match(HEADING_INLINE_RE);
			if (hm) currentHeading = hm[1]!.trim();
			pool.push({ source, chunk, heading: currentHeading });
		}
	}

	if (pool.length === 0) return [];

	// Score the whole pool in one pass (better IDF than scoring per source).
	const scorer = createBM25Scorer(query);
	const scores = scorer.scoreAll(pool.map((p) => p.chunk.text));

	const scored = pool.map((p, i) => ({ ...p, score: scores[i] ?? 0 }));
	// Stable sort by score descending — pool (source/document) order is
	// preserved among equal scores.
	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, topK).map((s) => ({
		url: s.source.url,
		...(s.source.title ? { title: s.source.title } : {}),
		...(s.heading ? { heading: s.heading } : {}),
		text: s.chunk.text,
		score: Math.round(s.score * 1000) / 1000,
	}));
}

/**
 * Render ranked multi-source chunks into an agent-facing cited-answer block.
 *
 * Each chunk is numbered and labeled with its source URL (+ title + heading
 * breadcrumb + score) so the agent can verify it. The output is wrapped in
 * the [UNTRUSTED WEB CONTENT] markers by default (pass `wrap: false` to get
 * the bare inner text for a caller that re-wraps after a further transform).
 */
export function formatMultiSourceAnswer(
	ranked: ReadonlyArray<RankedChunk>,
	query: string,
	opts: FormatMultiSourceAnswerOptions = {},
): string {
	const wrap = opts.wrap ?? true;
	if (ranked.length === 0) {
		const empty = `Multi-source answer mode: no relevant chunks found across the fetched sources for "${query}". Full content for every page is cached — retrieve any page via aio-webcontent by URL.`;
		return wrap ? wrapUntrusted(empty) : empty;
	}

	const sourcesCount =
		opts.sourcesCount ?? new Set(ranked.map((r) => r.url)).size;

	const blocks = ranked.map((r, i) => {
		const heading = r.heading ? r.heading : "(no heading)";
		const titleLine = r.title ? `\nTitle: ${r.title}` : "";
		return (
			`**[${i + 1}] ${heading}** (score ${r.score})\n` +
			`Source: ${r.url}${titleLine}\n\n` +
			`${r.text}`
		);
	});

	const inner =
		`Cited answer: top ${ranked.length} chunk(s) across ${sourcesCount} ` +
		`source(s) for "${query}". Each block is verbatim supporting text labeled ` +
		`with its source URL — verify against that source.\n\n` +
		blocks.join("\n\n---\n\n") +
		`\n\n---\n_Full content for every source is cached — retrieve any page in full via aio-webcontent by URL._`;

	return wrap ? wrapUntrusted(inner) : inner;
}
