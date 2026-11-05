// ─── Markdown chunking for RAG ────────────────────────────────────────
// Paragraph-bounded, token-budgeted segments with optional overlap.
// Uses our estimateTokens (handles CJK, URLs, code blocks correctly
// unlike the chars/4 heuristic used by simpler chunkers).
//
// References:
//   - pi-scraper/src/parse/chunker.ts (paragraph-split + overlap pattern)
//   - LangChain's RecursiveCharacterTextSplitter (oversized-paragraph split)

import { estimateTokens } from "./token-count.ts";
import { stripWrapper } from "./markdown-frontmatter.ts";
// Reused rather than re-implemented: this is the third place in the chunker that needs fence
// state, and a fourth inline copy of the same machine is exactly the drift #212 was about.
// Acyclic -- prune-markdown imports only token-count, markdown-frontmatter and bm25.
import { findUnclosedFence, FENCE_OPEN, fenceClosePattern } from "./prune-markdown.ts";

/** A single chunk of markdown, ready for RAG ingestion. */
export interface Chunk {
	/** Chunk text (markdown source). */
	text: string;
	/** Approximate token count for budget enforcement. */
	tokenCount: number;
	/** 0-based position in the chunk sequence. */
	index: number;
	/**
	 * The exact span this chunk was PREPENDED by the overlap pass (the tail of the
	 * previous chunk). Overlap exists to help SCORING, so it must not leak into
	 * DISPLAY: when two adjacent chunks are both selected, the shared span would
	 * otherwise render twice (issue #131). Recording it lets a composer trim
	 * precisely what the chunker added, and nothing else.
	 */
	overlapPrefix?: string;
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

	// The stored body carries a YAML frontmatter block and the [UNTRUSTED WEB
	// CONTENT] safety markers. That is storage envelope, not page content: with a
	// small maxTokens, chunk 0 used to be *entirely* `---\ntitle…\n---`,
	// `[UNTRUSTED WEB CONTENT START]` and the `URL Source:`/`Warning:` lines, with
	// zero words of the actual page — and the overlap then repeated it into chunk 1
	// (issue #165 F19; the same leak reached research quotes as F17). Stripped here
	// so every caller of the chunker is fixed at once.
	const normalized = stripWrapper(markdown).replace(/\r\n?/g, "\n").trim();
	if (!normalized) return [];

	// Fenced code is a BLOCK, not a paragraph. Splitting blindly on /\n\n+/ made a code
	// body one oversized "paragraph", which `splitOversized` then word-packed with " " as
	// the joiner -- replacing every newline inside the fence, so the reader got one long
	// line whose ``` opener was buried mid-text (#216). Fence state is a chunker property:
	// the chunker defines the boundaries, so a boundary that may fall inside a fence forces
	// every consumer to re-derive it (answer mode, `chunks: true`, aio-webquery's corpus
	// index, research quotes).
	const paragraphs = splitTopLevelBlocks(normalized);
	if (paragraphs.length === 0) return [];

	const rawChunks = buildParagraphChunks(paragraphs, maxTokens);
	const withOverlap = applyOverlap(rawChunks, overlapTokens, maxTokens);

	return withOverlap.map((piece, index) => ({
		text: piece.text,
		tokenCount: estimateTokens(piece.text),
		index,
		...(piece.overlapPrefix ? { overlapPrefix: piece.overlapPrefix } : {}),
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
	// Cache token counts — estimateTokens is called up to 2× per unit
	// (unit + separator). For 500-unit docs this saves ~500 tokenizations.
	const tokenCache = new Map<string, number>();
	const cachedTokens = (s: string): number => {
		let v = tokenCache.get(s);
		if (v === undefined) {
			v = estimateTokens(s);
			tokenCache.set(s, v);
		}
		return v;
	};
	const joinerTokensCached = cachedTokens(joiner);

	const flush = () => {
		if (current.length === 0) return;
		chunks.push(current.join(joiner));
		current = [];
		currentTokens = 0;
	};

	for (const unit of units) {
		const unitTokens = cachedTokens(unit);

		if (unitTokens > maxTokens) {
			flush();
			for (const piece of splitOversized(unit, maxTokens)) {
				chunks.push(piece);
			}
			continue;
		}

		const sepTokens = current.length > 0 ? joinerTokensCached : 0;
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

/**
 * Split on blank lines, but never inside a fenced code block, and always break before a
 * fence opener so a block starts its own unit. Fence detection is the same shape the rest
 * of the codebase uses: up to 3 leading spaces, 3+ backticks or tildes, and a closer must
 * use the same character and be at least as long as the opener.
 */
function splitTopLevelBlocks(text: string): string[] {
	const blocks: string[] = [];
	let buf: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		const s = buf.join("\n").trim();
		if (s) blocks.push(s);
		buf = [];
	};
	for (const line of text.split("\n")) {
		// One grammar for the whole repository: FENCE_OPEN for an opener, fenceClosePattern for
		// a closer. A closer must be marker-ONLY -- a line like "```js is how you open" inside a
		// code body is literal text, and treating it as a closer desynchronised the block from
		// the predicate every consumer uses (Qodo finding on #218).
		if (fence) {
			buf.push(line);
			if (fenceClosePattern(fence).test(line)) fence = null;
		} else if (FENCE_OPEN.test(line)) {
			flush();
			fence = (line.match(FENCE_OPEN) as RegExpMatchArray)[1] as string;
			buf.push(line);
		} else if (!line.trim()) {
			flush();
		} else {
			buf.push(line);
		}
	}
	flush();
	return blocks;
}

/**
 * Split an oversized block that contains a fence at LINE boundaries, closing any fence the
 * split leaves open and re-opening it on the next piece. Closing-and-reopening rather than
 * dropping the remainder: dropping would silently delete code, which is the failure this
 * issue is about, and the reader of a truncated piece still needs to know they are inside
 * a code block.
 */
/**
 * Longest prefix of `text` that fits `maxTokens`, shrinking from the 4-chars-per-token guess
 * until the estimate actually fits. The char guess is only a starting point: a dense line
 * tokenises denser than 4 chars/token and would otherwise be emitted over budget.
 */
function sliceWithinTokens(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;
	let take = Math.max(1, Math.min(text.length, maxTokens * 4));
	while (take > 1 && estimateTokens(text.slice(0, take)) > maxTokens) {
		take = Math.max(1, Math.floor(take * 0.75));
	}
	// Guarantee forward progress even when a single character cannot fit.
	return text.slice(0, Math.max(1, take));
}

function splitFencedAtLines(block: string, maxTokens: number): string[] {
	const pieces: string[] = [];
	let cur: string[] = [];
	let curTokens = 0;
	let fence: string | null = null;
	// The reopened marker is pending rather than pushed: flushing right before the block's own
	// closing line used to emit a piece containing nothing but an opener and a closer, i.e. an
	// empty code block handed to the reader and counted as a ranking candidate (#218).
	let pendingReopen: string | null = null;
	// A piece made only of fence markers is an EMPTY code block: the reader sees a blank
	// ```pair and ranking counts it as a candidate. Tracked so emit() can refuse to make one.
	let hasContent = false;

	const closerCost = () => (fence ? estimateTokens(fence) + 1 : 0);
	const emit = () => {
		if (cur.length === 0 || !hasContent) return;
		let text = cur.join("\n");
		if (fence) text += "\n" + fence;
		pieces.push(text);
		pendingReopen = fence;
		cur = [];
		curTokens = 0;
		hasContent = false;
	};
	const begin = (line: string) => {
		if (pendingReopen) {
			// The piece just emitted was sealed with a synthetic closer. If this line IS that
			// closer, reopening and re-closing would produce a piece containing only a fence pair
			// -- an empty code block (#218). The delimiter is already on the previous piece.
			if (fence && fenceClosePattern(fence).test(line)) {
				pendingReopen = null;
				return;
			}
			cur.push(pendingReopen);
			curTokens += estimateTokens(pendingReopen) + 1;
			pendingReopen = null;
		}
		cur.push(line);
		curTokens += estimateTokens(line) + 1;
		// A blank line is not content: a piece holding only markers and a blank line is an empty
		// code block, which is what emit() refuses to produce.
		if (!FENCE_OPEN.test(line) && line.trim() !== "") hasContent = true;
	};

	for (const raw of block.split("\n")) {
		// A line that cannot fit an empty piece at all is split by characters, each fragment
		// sealed in its own fence: a minified code line used to be emitted whole, producing a
		// 382-token chunk under a 40-token budget that the caller then kept (#218).
		if (estimateTokens(raw) > maxTokens) {
			emit();
			let rest = raw;
			while (rest.length > 0) {
				// Both synthetic markers belong to this piece's budget, or the piece comes back
				// over the caller's number (46 tokens under a 40-token budget, measured).
				const overhead =
					curTokens +
					(pendingReopen ? estimateTokens(pendingReopen) + 1 : 0) +
					closerCost();
				const frag = sliceWithinTokens(rest, Math.max(1, maxTokens - overhead));
				begin(frag);
				emit();
				rest = rest.slice(frag.length);
			}
			continue;
		}
		// The synthetic closer is part of this piece's cost, so reserving it cannot be skipped.
		if (cur.length > 0 && curTokens + estimateTokens(raw) + 1 + closerCost() > maxTokens) {
			emit();
		}
		begin(raw);
		const m = raw.match(FENCE_OPEN);
		if (fence) {
			if (fenceClosePattern(fence).test(raw)) fence = null;
		} else if (m) {
			fence = m[1] as string;
		}
	}
	emit();
	return pieces;
}

/** Split an oversized paragraph at sentence, then word, then hard char limit. */
function splitOversized(paragraph: string, maxTokens: number): string[] {
	// Dispatched BEFORE the char heuristic below. Two reasons: a fenced block must never reach
	// the sentence/word packers (both join with " " and destroy the line structure the fence
	// exists to preserve, #216), and the char proxy mis-measures token-dense fences -- a block
	// of one-word lines passed `length <= maxTokens*4` while carrying 66 tokens under a 47-token
	// budget. That regression came from making the block atomic, and the sweep caught it.
	if (FENCE_OPEN.test(paragraph)) {
		return estimateTokens(paragraph) > maxTokens
			? splitFencedAtLines(paragraph, maxTokens)
			: [paragraph];
	}
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

/**
 * Prepend the tail of each previous chunk to the next, for context overlap.
 * Returns the prepended span alongside the text so a DISPLAY consumer can remove
 * exactly what this SCORING aid added (issue #131).
 */
function applyOverlap(
	chunks: string[],
	overlapTokens: number,
	maxTokens: number,
): Array<{ text: string; overlapPrefix?: string }> {
	if (overlapTokens <= 0 || chunks.length <= 1) {
		return chunks.map((text) => ({ text }));
	}

	const out: Array<{ text: string; overlapPrefix?: string }> = [
		{ text: chunks[0] },
	];
	for (let i = 1; i < chunks.length; i++) {
		const tail = takeTailForTokens(chunks[i - 1], overlapTokens, maxTokens);
		out.push(
			tail
				? { text: `${tail}\n\n${chunks[i]}`, overlapPrefix: tail }
				: { text: chunks[i] },
		);
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
	// One candidate, then ONE fence correction. The early return for a short chunk must not
	// bypass it: that path hands back the whole previous chunk, and if that chunk ends inside
	// a fence the next chunk inherits a dangling delimiter (found on the real corpus after the
	// first version of this fix, where the trimmed-tail path looked correct).
	let candidate = text;
	if (text.length > maxChars) {
		const slice = text.slice(-maxChars);
		const boundary = slice.search(/\s/);
		candidate = boundary > 0 ? slice.slice(boundary + 1) : slice;
	}
		// A word-boundary cut can start INSIDE a fenced block, in which case the tail carries
		// that block's closing delimiter without its opener and the chunk it is prepended to
		// ends inside a fence (#216). The overlap is a SCORING aid that display already strips
		// (issue #131), so dropping the partial-fence fragment costs the reader nothing.
		let tail = candidate;
		while (tail && findUnclosedFence(tail)) {
			const next = tail.indexOf("\n");
			tail = next === -1 ? "" : tail.slice(next + 1);
		}
		return tail;
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
