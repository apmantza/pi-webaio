// ─── Markdown chunking for RAG ────────────────────────────────────────
// Paragraph-bounded, token-budgeted segments with optional overlap.
// Uses our estimateTokens (handles CJK, URLs, code blocks correctly
// unlike the chars/4 heuristic used by simpler chunkers).
//
// References:
//   - pi-scraper/src/parse/chunker.ts (paragraph-split + overlap pattern)
//   - LangChain's RecursiveCharacterTextSplitter (oversized-paragraph split)

import { estimateTokens } from "./token-count.ts";

/** A single chunk of markdown, ready for RAG ingestion. */
export interface Chunk {
	/** Chunk text (markdown source). */
	text: string;
	/** Approximate token count for budget enforcement. */
	tokenCount: number;
	/** 0-based position in the chunk sequence. */
	index: number;
}

export interface ChunkOptions {
	/** Max tokens per chunk. Default 512. */
	maxTokens?: number;
	/** Tokens of tail-overlap from the previous chunk. Default 50. 0 disables. */
	overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_OVERLAP_TOKENS = 50;

/**
 * Split markdown into paragraph-bounded chunks with optional overlap.
 * Each chunk preserves its original paragraph breaks. Oversized
 * paragraphs (longer than `maxTokens`) are split at sentence, then
 * word, then hard-character boundaries.
 */
export function chunkMarkdown(
	markdown: string,
	options: ChunkOptions = {},
): Chunk[] {
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

	if (maxTokens < 1) {
		throw new Error(`chunkMarkdown: maxTokens must be >= 1, got ${maxTokens}`);
	}
	if (overlapTokens < 0) {
		throw new Error(
			`chunkMarkdown: overlapTokens must be >= 0, got ${overlapTokens}`,
		);
	}

	const normalized = markdown.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return [];

	const paragraphs = normalized
		.split(/\n\n+/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (paragraphs.length === 0) return [];

	const rawChunks = buildParagraphChunks(paragraphs, maxTokens);
	const withOverlap = applyOverlap(rawChunks, overlapTokens, maxTokens);

	return withOverlap.map((text, index) => ({
		text,
		tokenCount: estimateTokens(text),
		index,
	}));
}

/** Group paragraphs into chunks not exceeding `maxTokens`. */
/**
 * Shared token-budget accumulator: packs units into chunks not exceeding
 * `maxTokens` (counting a joiner's separator tokens), flushing on budget
 * overflow. Oversized units are split via `splitOversized` (dedup, jscpd —
 * shared by paragraph and sentence/word packing).
 */
function accumulateChunks(
	units: string[],
	maxTokens: number,
	joiner: string,
	splitOversized: (unit: string, maxTokens: number) => string[],
): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let currentTokens = 0;

	const flush = () => {
		if (current.length === 0) return;
		chunks.push(current.join(joiner));
		current = [];
		currentTokens = 0;
	};

	for (const unit of units) {
		const unitTokens = estimateTokens(unit);

		if (unitTokens > maxTokens) {
			flush();
			for (const piece of splitOversized(unit, maxTokens)) {
				chunks.push(piece);
			}
			continue;
		}

		const sepTokens = current.length > 0 ? estimateTokens(joiner) : 0;
		if (
			current.length > 0 &&
			currentTokens + sepTokens + unitTokens > maxTokens
		) {
			flush();
		}

		current.push(unit);
		currentTokens += sepTokens + unitTokens;
	}

	flush();
	return chunks;
}

function buildParagraphChunks(
	paragraphs: string[],
	maxTokens: number,
): string[] {
	return accumulateChunks(paragraphs, maxTokens, "\n\n", splitOversized);
}

/** Split an oversized paragraph at sentence, then word, then hard char limit. */
function splitOversized(paragraph: string, maxTokens: number): string[] {
	const maxChars = maxTokens * 4;
	if (paragraph.length <= maxChars) return [paragraph];

	const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
	if (sentences.length > 1) {
		return packUnits(sentences, maxTokens, " ");
	}

	const words = paragraph.split(/\s+/).filter(Boolean);
	if (words.length > 1) {
		return packUnits(words, maxTokens, " ");
	}

	const pieces: string[] = [];
	for (let i = 0; i < paragraph.length; i += maxChars) {
		pieces.push(paragraph.slice(i, i + maxChars));
	}
	return pieces;
}

/** Pack small units (sentences/words) into chunks bounded by `maxTokens`. */
function packUnits(
	units: string[],
	maxTokens: number,
	joiner: string,
): string[] {
	return accumulateChunks(units, maxTokens, joiner, (unit, budget) => {
		const maxChars = budget * 4;
		const pieces: string[] = [];
		for (let i = 0; i < unit.length; i += maxChars) {
			pieces.push(unit.slice(i, i + maxChars));
		}
		return pieces;
	});
}

/** Prepend the tail of each previous chunk to the next, for context overlap. */
function applyOverlap(
	chunks: string[],
	overlapTokens: number,
	maxTokens: number,
): string[] {
	if (overlapTokens <= 0 || chunks.length <= 1) return chunks;

	const out: string[] = [chunks[0]];
	for (let i = 1; i < chunks.length; i++) {
		const tail = takeTailForTokens(chunks[i - 1], overlapTokens, maxTokens);
		out.push(tail ? `${tail}\n\n${chunks[i]}` : chunks[i]);
	}
	return out;
}

/** Take a window-sized tail of `text` (≤ overlapTokens tokens) starting at a word boundary. */
function takeTailForTokens(
	text: string,
	tokenBudget: number,
	maxTokens: number,
): string {
	if (tokenBudget <= 0 || !text) return "";
	const maxChars = Math.min(text.length, tokenBudget * 4, maxTokens * 4);
	if (text.length <= maxChars) return text;
	const slice = text.slice(-maxChars);
	const boundary = slice.search(/\s/);
	return boundary > 0 ? slice.slice(boundary + 1) : slice;
}

/** Max token count across chunks. Loop-based to avoid spread RangeError on huge arrays. */
export function maxTokenCount(chunks: Chunk[] | undefined): number {
	if (!chunks || chunks.length === 0) return 0;
	let max = 0;
	for (const c of chunks) {
		if (c.tokenCount > max) max = c.tokenCount;
	}
	return max;
}

/** Format chunks for the user-facing text output. */
export function formatChunksText(
	chunks: Chunk[] | undefined,
	overlapTokens: number,
	indent: string = "",
): { header: string; body: string } {
	if (!chunks || chunks.length === 0) {
		return { header: "", body: "" };
	}
	const maxChunkTokens = maxTokenCount(chunks);
	const header = `${indent}Chunks: ${chunks.length} generated (max ${maxChunkTokens} tokens, overlap ${overlapTokens})`;
	const body = chunks
		.map(
			(c) =>
				`${indent}[CHUNK ${c.index} / ${chunks.length} / ${c.tokenCount} tokens]\n${indent}${c.text}\n${indent}[/CHUNK]`,
		)
		.join("\n\n");
	return { header, body };
}
