// ─── Markdown content pruning to token budget ───────────────────────
// Trims markdown content to a target token budget while preserving the
// most important sections: headings, first paragraphs, and key content.
// Inspired by Retio-pagemap's rule-based pruner but operating on
// markdown text instead of HTML chunks.
//
// When a `query` parameter is provided, sections are scored by BM25
// relevance to the query instead of generic importance heuristics.
// This produces query-aware "fit markdown" — only the most relevant
// sections survive the budget.

import { estimateTokens } from "./token-count.ts";
import { createBM25Scorer } from "./bm25.ts";

/** Default target token budget. */
const DEFAULT_PRUNE_TOKENS = 3000;

/** Minimum characters to keep for a section to be worth including. */
const MIN_SECTION_CHARS = 80;

/**
 * Split markdown into logical sections.
 * A section starts with a heading (# .. ## .. ###) or a horizontal rule (---).
 */
function splitSections(markdown: string): Array<{
	heading: string;
	level: number;
	content: string;
}> {
	const lines = markdown.split("\n");
	const sections: Array<{ heading: string; level: number; content: string }> =
		[];
	let currentHeading = "";
	let currentLevel = 0;
	let currentLines: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
		const isHr = /^[-*_]{3,}\s*$/.test(line.trim());

		if (headingMatch) {
			// Save previous section
			if (currentLines.length > 0) {
				sections.push({
					heading: currentHeading,
					level: currentLevel,
					content: currentLines.join("\n").trim(),
				});
			}
			currentHeading = headingMatch[2]!;
			currentLevel = headingMatch[1]!.length;
			currentLines = [];
		} else if (isHr && currentLines.length > 0) {
			sections.push({
				heading: currentHeading,
				level: currentLevel,
				content: currentLines.join("\n").trim(),
			});
			currentHeading = "";
			currentLevel = 0;
			currentLines = [];
		} else {
			currentLines.push(line);
		}
	}

	// Last section
	if (currentLines.length > 0) {
		sections.push({
			heading: currentHeading,
			level: currentLevel,
			content: currentLines.join("\n").trim(),
		});
	}

	return sections;
}

/**
 * Score a section for importance (heuristic, non-query path).
 * Higher score = more likely to be kept.
 *
 * Heuristics:
 * - H1/H2 headings score higher (they're main content)
 * - First section scores higher (lead paragraph)
 * - Longer sections score higher (more substantive)
 * - Sections with keywords like "price", "rating", "summary" score higher
 * - Sections with code blocks score lower (often examples, not content)
 */
function scoreSection(
	section: { heading: string; level: number; content: string },
	index: number,
	_total: number,
): number {
	let score = 0;

	// Heading level: H1=5, H2=4, H3=3, H4=2, H5/H6=1
	if (section.level > 0) {
		score += Math.max(1, 7 - section.level);
	}

	// First section bonus (lead paragraph)
	if (index === 0) score += 3;

	// Content length bonus (longer = more substantive, capped)
	const contentLen = section.content.length;
	if (contentLen > 500) score += 3;
	else if (contentLen > 200) score += 2;
	else if (contentLen > MIN_SECTION_CHARS) score += 1;

	// High-value keyword bonus
	const headingLower = section.heading.toLowerCase();
	const contentLower = section.content.toLowerCase();
	const highValueKeywords = [
		"abstract",
		"summary",
		"overview",
		"introduction",
		"price",
		"rating",
		"review",
		"description",
		"result",
		"conclusion",
		"finding",
		"specification",
		"feature",
	];
	for (const kw of highValueKeywords) {
		if (headingLower.includes(kw)) score += 2;
		if (contentLower.includes(kw)) score += 0.5;
	}

	// Penalty for code blocks (often examples, not core content)
	const codeBlockCount = (section.content.match(/```/g) || []).length;
	if (codeBlockCount > 0) {
		score -= Math.min(codeBlockCount / 2, 3);
	}

	// Penalty for tables (large token consumers)
	// But tables with pricing/numbers are valuable
	const tableLineCount = (section.content.match(/^\|.+\|/gm) || []).length;
	if (tableLineCount > 10) {
		score -= 2;
	} else if (tableLineCount > 3) {
		score -= 0.5;
	}

	return score;
}

/**
 * Options for pruneMarkdown.
 */
export interface PruneOptions {
	/** Target token budget (default 3000). */
	maxTokens?: number;
	/**
	 * Optional query for BM25 relevance scoring.
	 * When provided, sections are scored by relevance to this query
	 * instead of generic importance heuristics.
	 */
	query?: string;
	/**
	 * When true and a query is provided, combine BM25 relevance score
	 * with the heuristic importance score (weighted average).
	 * Default: false (BM25 replaces heuristic scoring entirely).
	 */
	combineScores?: boolean;
	/**
	 * Weight for BM25 score when combineScores is true (0-1).
	 * Default: 0.7 (70% BM25, 30% heuristic).
	 */
	bm25Weight?: number;
}

/**
 * Prune markdown content to fit within a token budget.
 *
 * When `query` is provided, sections are scored by BM25 relevance to
 * the query, producing query-aware "fit markdown" — only the most
 * relevant sections survive the budget.
 *
 * Algorithm:
 * 1. Split into sections by headings
 * 2. Score each section (heuristic or BM25-based)
 * 3. If query is provided, consider higher-relevance sections first;
 *    otherwise preserve top-to-bottom order
 * 4. Keep selected sections within budget
 * 5. Reconstruct selected sections in original document order
 *
 * Returns the pruned markdown string.
 */
export function pruneMarkdown(
	markdown: string,
	maxTokensOrOptions: number | PruneOptions = DEFAULT_PRUNE_TOKENS,
): {
	content: string;
	originalTokens: number;
	prunedTokens: number;
	truncated: boolean;
	/** Per-section relevance scores (only when query is provided). */
	scores?: Array<{ heading: string; score: number }>;
} {
	// Normalize arguments
	const options: PruneOptions =
		typeof maxTokensOrOptions === "number"
			? { maxTokens: maxTokensOrOptions }
			: maxTokensOrOptions;

	const maxTokens = options.maxTokens ?? DEFAULT_PRUNE_TOKENS;
	const query = options.query;
	const combineScores = options.combineScores ?? false;
	const bm25Weight = options.bm25Weight ?? 0.7;

	const originalTokens = estimateTokens(markdown);

	// If already under budget, return as-is
	if (originalTokens <= maxTokens) {
		return {
			content: markdown,
			originalTokens,
			prunedTokens: originalTokens,
			truncated: false,
		};
	}

	const sections = splitSections(markdown);

	// If no sections found, just truncate
	if (sections.length === 0) {
		const truncated = truncateToBudget(markdown, maxTokens);
		return {
			content: truncated,
			originalTokens,
			prunedTokens: estimateTokens(truncated),
			truncated: true,
		};
	}

	// Score all sections. For BM25, score the whole collection at once so
	// IDF reflects this page's section distribution instead of a single section.
	const bm25Scores = query
		? createBM25Scorer(query).scoreAll(
				sections.map((s) => `${s.heading}\n${s.content}`),
			)
		: [];

	const scored = sections.map((s, i) => {
		let score: number;

		if (query) {
			const bm25Score = bm25Scores[i] ?? 0;

			if (combineScores) {
				// Blend BM25 with heuristic importance
				const heuristicScore = scoreSection(s, i, sections.length);
				score = bm25Score * bm25Weight + heuristicScore * (1 - bm25Weight);
			} else {
				// BM25 replaces heuristic entirely
				score = bm25Score;
			}
		} else {
			// Heuristic importance path (original behavior)
			score = scoreSection(s, i, sections.length);
		}

		return {
			...s,
			score,
			index: i,
		};
	});

	// When a query is provided, sort by BM25 score descending so the most
	// relevant sections are considered first. Then re-sort by index for output
	// so the final markdown preserves document order.
	if (query) {
		scored.sort((a, b) => b.score - a.score);
	}

	const kept: typeof scored = [];
	let currentTokens = 0;
	// Reserve up to 80 tokens for the truncation notice, but do not consume
	// most of very small budgets used by tests or callers.
	const budgetForContent = Math.max(
		1,
		maxTokens - Math.min(80, Math.floor(maxTokens * 0.1)),
	);

	for (const section of scored) {
		const sectionTokens = estimateTokens(section.content);
		const headingTokens = section.heading
			? estimateTokens(section.heading) + 5
			: 0;

		if (currentTokens + headingTokens + sectionTokens <= budgetForContent) {
			// Full section fits
			kept.push(section);
			currentTokens += headingTokens + sectionTokens;
		} else if (currentTokens + headingTokens < budgetForContent) {
			// Partial fit — truncate the section content
			const remaining = budgetForContent - currentTokens - headingTokens;
			if (remaining > MIN_SECTION_CHARS) {
				const truncatedContent = truncateToBudget(section.content, remaining);
				kept.push({ ...section, content: truncatedContent });
				currentTokens = budgetForContent;
			}
			break;
		} else {
			break;
		}
	}

	// Re-sort kept sections by original document order for output
	if (query) {
		kept.sort((a, b) => a.index - b.index);
	}

	// Reconstruct markdown from kept sections
	const lines: string[] = [];
	for (const section of kept) {
		if (section.heading) {
			const prefix = "#".repeat(section.level);
			lines.push(`${prefix} ${section.heading}`);
		}
		if (section.content) {
			lines.push("");
			lines.push(section.content);
			lines.push("");
		}
	}

	let result = lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	// Add truncation notice if we dropped sections
	if (kept.length < sections.length) {
		result += `\n\n---\n*Truncated to ~${estimateTokens(result)} tokens. ${sections.length - kept.length} sections omitted.*`;
	}

	const prunedTokens = estimateTokens(result);

	// Build per-section scores for the return value (only when query is provided)
	const scores = query
		? [...scored]
				.sort((a, b) => a.index - b.index)
				.map((s) => ({
					heading: s.heading || "(no heading)",
					score: Math.round(s.score * 1000) / 1000,
				}))
		: undefined;

	return {
		content: result,
		originalTokens,
		prunedTokens,
		truncated: prunedTokens < originalTokens,
		scores,
	};
}

/**
 * Convenience wrapper: prune markdown by relevance to a query.
 * Equivalent to pruneMarkdown(md, { maxTokens, query }).
 */
export function pruneByRelevance(
	markdown: string,
	query: string,
	maxTokens: number = DEFAULT_PRUNE_TOKENS,
): {
	content: string;
	originalTokens: number;
	prunedTokens: number;
	truncated: boolean;
	scores: Array<{ heading: string; score: number }>;
} {
	return pruneMarkdown(markdown, { maxTokens, query }) as ReturnType<
		typeof pruneByRelevance
	>;
}

/**
 * Truncate text to fit within a token budget by cutting at sentence boundaries.
 */
function truncateToBudget(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;

	// Rough character budget
	const charBudget = maxTokens * 4;

	// Try to find a good sentence boundary
	const truncated = text.slice(0, charBudget);

	// Find the last sentence-ending punctuation
	const lastPeriod = Math.max(
		truncated.lastIndexOf(". "),
		truncated.lastIndexOf(".\n"),
		truncated.lastIndexOf("? "),
		truncated.lastIndexOf("!\n"),
		truncated.lastIndexOf(".\n\n"),
		truncated.lastIndexOf("。"),
	);

	// Find the last paragraph boundary
	const lastParagraph = truncated.lastIndexOf("\n\n");

	// Prefer sentence boundary, fall back to paragraph boundary
	const cutPoint =
		lastPeriod > charBudget * 0.5
			? lastPeriod + 1
			: lastParagraph > charBudget * 0.5
				? lastParagraph
				: charBudget;

	return text.slice(0, Math.max(cutPoint, 100)) + "\n\n[...content truncated]";
}
