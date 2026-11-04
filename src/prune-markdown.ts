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
import { splitFrontmatter, withFrontmatter } from "./markdown-frontmatter.ts";
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
 * Build the "Omitted sections:" mini-TOC footer fragment shared by BOTH
 * truncation paths — the `prune` param (pruneMarkdown) and the `budgetTokens`
 * contract (applyTokenBudget). Keeping this in one place means the two
 * footers can no longer drift apart. (F7)
 *
 * Lists the dropped headings in the order supplied (callers pass them in
 * document order), indented by heading level, and capped so very large
 * documents don't bloat the footer.
 *
 * @param omitted Dropped sections (heading + level). Headingless entries are
 *                skipped — there is nothing useful to list for them.
 * @returns The TOC fragment (leading blank lines included), or "" when no
 *          omitted section has a heading.
 */
export function buildOmittedSectionsToc(
	omitted: Array<{ heading: string; level: number }>,
	/**
	 * Token ceiling for the whole TOC block. Without it the list is bounded only
	 * by entry COUNT, so a page of many long headings produced a 241-token footer
	 * on a 250-token budget: the guarantee then trimmed the body to nothing and
	 * STILL landed 2 tokens over (issue #165 F20). A heading list is a navigation
	 * convenience and must never evict the content it is pointing at.
	 */
	maxTokens?: number,
): string {
	const withHeadings = omitted.filter((s) => s.heading);
	if (withHeadings.length === 0) return "";
	const MAX_TOC = 20;
	// Reserve room for the trailing "… N more" line. Without the reservation the
	// last entry could consume the exact remaining budget, the suffix then failed
	// its own fit check and was skipped, and the dropped headings vanished with no
	// trace — the reader could not tell a complete list from a truncated one.
	const RESERVE_MORE_TOKENS = 12;
	const fillBudget = maxTokens === undefined ? undefined : maxTokens - RESERVE_MORE_TOKENS;
	let toc = `\n\n*Omitted sections:*\n`;
	let listed = 0;
	for (const s of withHeadings.slice(0, MAX_TOC)) {
		const indent = "  ".repeat(Math.max(0, s.level - 1));
		// The header already ends in a newline; entries after the first need their
		// own separator, or the whole list collapses onto one line.
		const candidate = `${toc}${listed > 0 ? "\n" : ""}${indent}- ${s.heading}`;
		if (fillBudget !== undefined && estimateTokens(candidate) > fillBudget) break;
		toc = candidate;
		listed++;
	}
	// No room for even one entry: emit nothing rather than a useless header.
	if (listed === 0) return "";
	const remaining = withHeadings.length - listed;
	if (remaining > 0) {
		// Always emitted: the count is the contract, and the reservation above
		// guarantees it fits whenever any entry did.
		toc += `\n- … ${remaining} more`;
	}
	return toc;
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

	// High-value keyword bonus — sample first 2k chars of content to avoid
	// toLowerCase on 10k+ sections (heading is short, so check fully).
	const headingLower = section.heading.toLowerCase();
	const contentSample =
		section.content.length > 2000
			? section.content.slice(0, 2000).toLowerCase()
			: section.content.toLowerCase();
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
		if (contentSample.includes(kw)) score += 0.5;
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
	scores?: Array<{ heading: string; score: number }>;
} {
	// The leading YAML frontmatter block is part of the document's contract, not
	// content to rank: it must survive pruning at the top, terminated. Section
	// scoring used to see it as ordinary text, which emitted an unterminated
	// `---` block at mid budgets and moved the whole block behind the body at
	// small ones (issue #165 F8, surfaced again through aio-webcontent in F10).
	// Its tokens are reserved out of the budget so the caller's limit still holds.
	const { frontmatter, body } = splitFrontmatter(markdown);
	const frontmatterTokens = frontmatter ? estimateTokens(frontmatter) : 0;
	const options: PruneOptions =
		typeof maxTokensOrOptions === "number"
			? { maxTokens: maxTokensOrOptions }
			: maxTokensOrOptions;
	const pruned = pruneBody(body, {
		...options,
		maxTokens: Math.max(1, (options.maxTokens ?? DEFAULT_PRUNE_TOKENS) - frontmatterTokens),
	});
	if (!frontmatter) return pruned;
	const content = withFrontmatter(frontmatter, pruned.content);
	// One base for both numbers. `pruneBody` only saw the body, so its
	// `originalTokens` excluded the frontmatter while `prunedTokens` (measured over
	// the reassembled document) included it — the pair then read as "pruned from
	// 180 to 197": growth, with nothing truncated (issue #165).
	return {
		...pruned,
		content,
		originalTokens: estimateTokens(markdown),
		prunedTokens: estimateTokens(content),
	};
}

function pruneBody(
	markdown: string,
	options: PruneOptions,
): {
	content: string;
	originalTokens: number;
	prunedTokens: number;
	truncated: boolean;
	scores?: Array<{ heading: string; score: number }>;
} {
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
		// Build a mini table-of-contents of the omitted sections so the agent
		// knows what was left out (not just how many). Headings are listed in
		// document order, indented by level, and capped to avoid bloating the
		// footer on very large documents. Shared with applyTokenBudget so the
		// two truncation footers stay identical. (F7)
		const keptIndices = new Set(kept.map((s) => s.index));
		const omitted = scored
			.filter((s) => !keptIndices.has(s.index))
			.sort((a, b) => a.index - b.index);
		const noticeBase = `\n\n---\n*Truncated to ~${estimateTokens(result)} tokens. ${sections.length - kept.length} sections omitted.*`;
		// The TOC is sized from the room the CONTENT actually left, not from the
		// reserve the packer carved out: `estimateTokens` is not additive across
		// concatenation (shared newlines and markdown's short lines make the parts
		// sum to more than the whole), so budgeting the footer by adding up its
		// pieces under-shoots and the heading list vanished from documents that had
		// room for it. Bounded at 80 for the same reason as the budget footer, then
		// the guarantee below re-measures the whole thing.
		const tocBudget = Math.min(80, Math.max(0, maxTokens - estimateTokens(result)));
		result += noticeBase + buildOmittedSectionsToc(omitted, tocBudget);
	}

	// Hard guarantee, the same shape `applyTokenBudget` uses: re-measure the whole
	// result and shrink instead of trusting the reserve. A heading list is a
	// navigation convenience, so it is dropped before any content is cut.
	if (estimateTokens(result) > maxTokens) {
		const MIN_BODY_TOKENS = Math.min(40, Math.max(1, Math.floor(maxTokens * 0.2)));
		const footerIdx = result.lastIndexOf("\n\n---\n");
		const contentBody = footerIdx > 0 ? result.slice(0, footerIdx) : result;
		let ft = footerIdx > 0 ? result.slice(footerIdx) : "";
		if (estimateTokens(ft) + MIN_BODY_TOKENS > maxTokens) {
			ft = ft.replace(/\n\n\*Omitted sections:\*[\s\S]*$/, "");
		}
		result =
			trimToTokenBudgetWithClosedFence(
				contentBody,
				Math.max(0, maxTokens - estimateTokens(ft)),
			) + ft;
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
 * ## The budget model
 *
 * Seven consumers share one number, in this order, plus two decision points that
 * spend nothing but belong in the contract:
 *
 * Spend order, each step spending only what the previous steps left:
 *
 * | # | Consumer        | Cap                                                        | Guarantees |
 * |---|-----------------|------------------------------------------------------------|------------|
 * | 0 | (no-op)         | content already fits                                    | nothing is spent; the input is returned verbatim |
 * | 1 | caller's budget | `effectiveBudget = max(1, floor(budget))`                  | the number handed in is the contract; no hidden 100-token floor |
 * | 2 | **content floor** | `MIN_CONTENT_SHARE × effectiveBudget`                    | I2 — reserves the space prose is cut from, and if the notice still displaces it completely the floor pass below takes the room back |
 * | 3 | frontmatter     | kept only if it fits in `effectiveBudget − content floor`  | metadata never crowds out content; dropped whole otherwise |
 * | 4 | truncation notice | `min(MAX_NOTICE_RESERVE, effectiveBudget − frontmatter − content floor)` | I1 — the notice may only spend what the floor does not need. This sizes `contentBudget` only; the footer actually emitted is rebuilt as `footerBase + omittedToc` and re-measured at step 8, so it is not the notice's final size |
 * | 5 | outline (skeleton) | `outlineShare(contentBudget)`, and `prependOutlineShare` on the assembled-result path | structure survives heavy pruning, but never at the prose's expense |
 * | 6 | prose           | `contentBudget − outline − selected heading`               | whatever is left, which is what the floor protected it for |
 * | 7 | omitted-sections TOC | `effectiveBudget − frontmatter − estimateTokens(footerBase) − content floor` | lowest priority; the first thing to go, and step 8 may still drop it |
 * | 8 | (backstop)      | re-measure the whole result; shrink the notice, then hard-trim the body | I1 — the ceiling is enforced here, not by the reservations above |
 * | 9 | (floor pass)    | if the portion carries none of the document's own words, drop the notice and refill with prose | I2 — runs whether or not the result overflows, because at tiny budgets nothing overflows |
 *
 * Three invariants, and the guard that enforces each:
 *
 * 1. **Ceiling** — the returned text measures ≤ `effectiveBudget` for every
 *    input shape. Enforced by the final re-measure: the notice is stepped down
 *    (`shrinkNoticeToRoom`) and the body hard-trimmed with a closed fence.
 *    Reserving in the order above is what makes the re-measure a backstop rather
 *    than the mechanism.
 * 2. **Content floor** — a non-empty body yields page prose **at every budget
 *    ≥ 1**. This was stated as a domain until issue #182 closed it. Writing the
 *    invariant down (#170) exposed that the step-8 backstop could reclaim the
 *    whole content allocation: budgets 1, 2, 3, 6–11, 18, 19, 22, 23, 26, 27
 *    returned framing with no page prose, non-monotonically, because which rung
 *    of the `shrinkNoticeToRoom` ladder fit depended on the notice's token
 *    count. Two decisions closed it rather than a threshold: **a `---` with
 *    nothing after it is not a separator**, so the rule belongs to the notice
 *    and steps down with it (it may never survive as the whole answer); and the
 *    **floor wins outright**, so a notice that cannot coexist with one token of
 *    prose costs zero and prose takes the room. `budgetTokens: 1` now returns
 *    one token of the document, which is what "the caller's number is the
 *    contract" always meant. The domain is then derived rather than measured:
 *    the notice's cost is 0 or ≥ 1 token, frontmatter already yields when it
 *    cannot coexist with content, so at least one token of prose survives at
 *    every budget — and dropping framing can only lower the total, so the
 *    ceiling is untouched by construction. "Prose" is decided by membership in
 *    the document (`carriesPageProse`), not by a blacklist of notice wording:
 *    a notice trimmed mid-word is not any known notice, yet it is still not the
 *    document. See `#182: the content floor holds at EVERY budget`.
 * 3. **Attribution** — prose is never preceded by a heading it did not come
 *    from. Enforced by putting heading-less prose FIRST, and by the rule that a
 *    heading the outline refused to carry is not re-emitted for the prose that
 *    sat behind it. This is the invariant that cost three rounds to chase
 *    because it had never been stated: misattribution produces a *wrong*
 *    citation, not an ugly one.
 *
 * The two outline shares have different denominators on purpose:
 * `outlineShare` budgets against `contentBudget` (what is left for the body),
 * `prependOutlineShare` against `effectiveBudget`, because that path runs on the
 * already-assembled result. They are the same rule — whole headings only, and a
 * heading larger than the outline's share is dropped rather than emitted
 * unbounded — not two different policies.
 */

/** Share of the budget the returned body must keep, whatever else fits. */
const MIN_CONTENT_SHARE = 0.5;
/** Upper bound on what the truncation notice may reserve when there is room. */
const MAX_NOTICE_RESERVE = 30;
/** Share of the content budget the heading outline may take. */
const OUTLINE_SHARE = 0.4;
/** Floor on the outline share so a tiny budget still carries some structure. */
const MIN_OUTLINE_TOKENS = 10;
/** Same rule as `OUTLINE_SHARE`, measured against the whole budget. */
const PREPEND_OUTLINE_SHARE = 0.25;

/** Whole-heading outline budget: `share × denominator`, never under the floor. */
function outlineBudget(denominator: number, share: number): number {
	return Math.max(MIN_OUTLINE_TOKENS, Math.floor(denominator * share));
}

/**
 * Apply a hard token-budget contract to already-processed content.
 *
 * Unlike `pruneMarkdown` (which operates on raw source), this function is
 * designed to be applied *after* answer-mode or other transformations have
 * already narrowed the content.  It:
 *
 * 1. Returns the content unchanged when it already fits.
 * 2. Extracts a heading skeleton (all heading lines) to always preserve structure.
 * 3. Drops lowest-value sections first:
 *    - With a `query`: lowest-BM25-scored sections go first.
 *    - Without a `query`: sections are dropped from the bottom up.
 * 4. Appends a standardised footer noting how many sections were omitted
 *    and that the full content is cached.
 * 5. Re-measures after pruning and hard-trims if still over budget (footer
 *    counts against the budget).
 *
 * @param content   Text to fit within the budget.
 * @param budget    Hard token limit (minimum 100).
 * @param query     Optional relevance query — drives BM25 section ordering.
 * @param url       URL used in the footer so the agent knows where to retrieve
 *                  the full content.
 * @returns Pruned string that measures ≤ budget tokens.
 */
/**
 * The document's own prose, with frontmatter-adjacent whitespace and any
 * leading heading run removed.
 *
 * Both prose fallbacks need this: the section-level one (when pruning kept
 * nothing) and the step-8 one (when the notice displaced the floor). Headings
 * come from the skeleton, so a prefix built from the raw body can return a
 * heading twice with no prose at all (issue #169); the leading blank strip is
 * not cosmetic, because after a frontmatter block the body starts with "\n" and
 * a `^`-anchored regex never matched, which returned the heading fragment
 * verbatim. One implementation so the two fallbacks cannot drift.
 *
 * The heading run must cross BLANK LINES. The first version repeated a single
 * heading line, and the `+` stopped at the blank line between `# A` and `## B`,
 * so for a document whose prose follows a blank-line-separated heading stack the
 * "prose" handed to the swap was still headings — trimmed to `""`, rejected for
 * lack of room, and the notice fragment came back as the answer. That is how the
 * #182 P1 shape survived in the one document shape the fix's own sweep never
 * built. Whitespace between headings is part of the heading run, not prose, so it
 * is consumed with it; a line whose first non-whitespace character is not a
 * heading still stops the match.
 */
function prosePrefixSource(body: string): string {
	const lines = body.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// A CRLF document reaches the budget path without LF normalisation, so a blank
		// line between two headings is "   \r". Without the \r this test answered "not
		// blank", the heading run stopped there, and the prose behind it was never
		// reached (CodeRabbit on this PR).
		if (/^[ \t\r]*$/.test(line)) {
			i++;
			continue;
		}
		// A heading starts within three spaces of the margin. Four spaces (or a tab)
		// after a blank line is an indented CODE block in Markdown, and its `#` is a
		// comment. The regex this replaces ate the blank line, then the indentation,
		// then matched the comment as one more heading and dropped a real line of
		// code from the answer. Line-by-line, so indentation is never consumed on its
		// way to a heading.
		if (/^ {0,3}#{1,6}[ \t]/.test(line)) {
			i++;
			continue;
		}
		break;
	}
	// The first line's leading whitespace still has to go, exactly as the regex
	// version did. Without it a document that OPENS with four-space-indented
	// fence-looking text keeps that indentation, the closure parser still reads that
	// line as an opener and appends a margin-level closer — and at the 0..3-space
	// boundary the indented line is CODE while the appended marker is an unclosed
	// OPENING fence (verify round 3 on 78b334a). Only the first line: the indentation
	// of everything after it is the document's own code structure.
	return lines.slice(i).join("\n").replace(/^[ \t]+/, "");
}

/**
 * Does this portion contain any of the DOCUMENT's own text?
 *
 * Framing is not content: skeleton headings are generated, horizontal rules are
 * separators, and the truncation notice is boilerplate. The test is SUBSTRING
 * membership in the document, which is both non-enumerative and script-agnostic.
 *
 * Two earlier versions failed in structurally different ways, and both are the
 * reason this formulation is here:
 *  - filtering known framing shapes (headings, rules, notice wording) passed a
 *    notice trimmed mid-word (`*Trunc`) as prose — a fragment is not any known
 *    notice, so the blacklist could not name it;
 *  - a `[a-z0-9]{4,}` word set was an implicit SCRIPT whitelist. CJK and
 *    Cyrillic documents produced an empty word set, the detector answered
 *    "nothing to carry", the floor pass never ran, and CJK budgets 1–45 still
 *    returned `"\n\n--"`. A word set also fails for scripts without spaces,
 *    where a one-character answer (`内`) is a PREFIX of the document's only
 *    token rather than equal to it.
 *
 * A notice fragment cannot be a substring of the document unless the document
 * genuinely contains that text — in which case counting it as content is
 * correct. Query-ranked answers from a later section pass on their own text
 * because the whole body is the haystack.
 */
/**
 * Fill the budget with WHOLE lines, longest prefix that fits.
 *
 * The slice-based trimmers cannot do this job: `truncateToBudget` cuts at a character
 * offset and then at a sentence boundary, so a document of short heading lines answers
 * with a single `#` marker at 6 tokens when `# A\n\n## B` measured exactly 6 and fitted.
 * Growing by whole lines is also the one direction in which quality is monotone here —
 * each step adds a line of the document and never removes one — which is what makes it
 * safe to offer as a candidate at all (#189).
 */
function wholeLinesWithinBudget(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return "";
	const lines = text.split("\n");
	let out = "";
	for (const line of lines) {
		const next = out === "" ? line : `${out}\n${line}`;
		if (estimateTokens(next) > maxTokens) break;
		out = next;
	}
	return out;
}

export function carriesPageProse(portion: string, body: string): boolean {
	if (prosePrefixSource(body).trim() === "") {
		// A body with no prose PARAGRAPH is not a body with no CONTENT. `# A\n\n## B\n\n### C`
		// and `---\n\n---` are documents whose entire content is headings or rules, and the
		// unconditional `return true` this replaces ("there is no prose, so the floor cannot
		// be violated") let them answer `"\n"` and `""`: the floor was satisfied VACUOUSLY
		// while every word the document had was discarded (#189 item 1). The question is the
		// same one, asked of the text that IS there - does the answer carry a line of the body.
		const head = portion.lastIndexOf("\n\n---\n");
		const noFooter = head >= 0 ? portion.slice(0, head) : portion;
		// Deliberately looser than the prose branch below on ONE axis, and tighter on another.
		// A document made only of rules has no letters to ask for, so its rules are its
		// content. A document that does have text must show some of it: a bare `#` marker is
		// literally a substring of the body and would otherwise pass as the document's
		// content, which is the `"#"`-answers-a-headings-page failure the first version of
		// this branch produced, and the trap the prose branch below already documents.
		const bodyHasText = /[\p{L}\p{N}]/u.test(body);
		for (const line of noFooter.split("\n")) {
			const t = line.trim();
			if (t === "") continue;
			if (bodyHasText && !/[\p{L}\p{N}]/u.test(t)) continue;
			if (body.includes(t)) return true;
		}
		return false;
	}
	const footerIdx = portion.lastIndexOf("\n\n---\n");
	const withoutFooter = footerIdx >= 0 ? portion.slice(0, footerIdx) : portion;
	for (const line of withoutFooter.split("\n")) {
		const t = line.trim();
		if (t === "") continue;
		if (/^#{1,6}\s/.test(line)) continue; // skeleton heading = framing
		if (/^[-=*_~]{2,}$/.test(t)) continue; // rule / fence leftover
		// A line with no letter or number in it is markdown punctuation, not text:
		// a heading truncated to a bare `#` was passing as prose because "#" is
		// literally a substring of the document. This is a property of the line, not
		// an enumeration of framing shapes, so it holds for every script.
		if (!/[\p{L}\p{N}]/u.test(t)) continue;
		if (body.includes(t)) return true;
		// A trimmed tail can end mid-token, so the head of the line is still the
		// document's text even when the whole line no longer matches.
		const head = t.slice(0, 8);
		if (head.length > 0 && body.includes(head)) return true;
	}
	return false;
}

/**
 * Largest prefix of `text` that still fits `cap` tokens.
 *
 * The existing trims are first-fit: they cut at the first boundary that clears the budget
 * and then shrink by a fixed margin, so they can return far less than the budget allows.
 * This is the search for the OTHER end of the range, and it exists only to be compared
 * against (see `selectFullestCandidate`). It never replaces what the pipeline produced.
 *
 * Bounded by construction rather than by an open-ended loop: a binary search needs
 * ceil(log2(n)) + 1 halvings, so the iteration cap is that number and the loop cannot spin.
 */
function largestFittingSlice(text: string, cap: number): string {
	if (estimateTokens(text) <= cap) return text;
	// Fenced input goes to the fence-aware trim: a char-level cut here can land inside a
	// code block and return an answer with an open fence, which the #190 guard then rejects
	// anyway. Letting the trim that knows about fences handle it is both cheaper and safer.
	if (/^[ \t]*(`{3,}|~{3,})/.test(text)) return trimToTokenBudgetWithClosedFence(text, cap);
	let lo = 0;
	let hi = text.length;
	const steps = Math.ceil(Math.log2(Math.max(2, text.length))) + 1;
	for (let i = 0; i < steps && lo < hi; i++) {
		const mid = Math.ceil((lo + hi) / 2);
		if (estimateTokens(truncateToBudget(text.slice(0, mid), cap)) <= cap) lo = mid;
		else hi = mid - 1;
	}
	// The located slice goes back through the safe trim rather than being returned raw.
	// Deleting this was tried and is WRONG, and the way it was caught matters: the mutation run
	// and a 240,000-case generated sweep both reported it as equivalent, because that corpus
	// never nests a three-backtick marker inside a four-backtick one. The suite found it —
	// "a shorter marker inside a longer fence is body, not a delimiter" — once the fence guard
	// below was also removed, which is how the two turned out to be joint coverage rather than
	// two independent guards. A probe corpus that disagrees with a shipped pin is the weaker
	// witness, and the pin wins.
	return trimToTokenBudgetWithClosedFence(text.slice(0, lo), cap);
}

/**
 * How much of the document an answer actually carries: the total length of its lines that
 * appear verbatim in the body.
 *
 * Framing is excluded by construction — a notice line or a generated skeleton heading is
 * not a line of the body, so it scores zero. That is what makes this comparable across
 * candidates with different framing, and it is the same measure
 * tests/budget-monotonic-206.test.mjs uses, so the objective being optimised and the
 * property being asserted are the one quantity rather than two that can drift.
 */
function documentCharacters(answer: string, body: string): number {
	let n = 0;
	for (const line of answer.split("\n")) {
		const t = line.trim();
		if (t !== "" && body.includes(t)) n += t.length;
	}
	return n;
}

/**
 * True when `candidate` keeps every document line the incumbent kept.
 *
 * Used only when a query is set, where the incumbent is BM25-selected rather than merely
 * truncated: adding to it is fine, replacing it is not. The incumbent's own notice is
 * excluded (it is framing, not a document line), and so are lines the body does not contain,
 * for the same reason `documentCharacters` ignores them.
 */
function supersedesIncumbent(candidate: string, incumbent: string, body: string): boolean {
	const footerIdx = incumbent.lastIndexOf("\n\n---\n");
	const noNotice = footerIdx >= 0 ? incumbent.slice(0, footerIdx) : incumbent;
	for (const line of noNotice.split("\n")) {
		const t = line.trim();
		if (t === "" || !body.includes(t)) continue;
		if (!candidate.includes(t)) return false;
	}
	return true;
}

/**
 * #206 — composition-level candidate selection.
 *
 * The defect: raising the caller's budget could return LESS of the document. Root cause is
 * that three separate decisions each re-derive their own room (how much body to keep, which
 * framing to install, how terse the notice is), and their costs are not monotone in the
 * caller's number, so a bigger budget can flip a choice and hand back a smaller answer.
 *
 * The fix is NOT to make those decisions monotone — three attempts at the leaf each fixed one
 * band and regressed another, because changing the leaf changes the incumbent being compared.
 * Instead this ADDS candidates at the end and takes the maximum, leaving the incumbent byte
 * identical. A max over a superset cannot return less than the incumbent at the same budget,
 * so "no budget ever gets worse" holds by construction and is verified against master at every
 * budget in 1..400, not merely sampled.
 *
 * A candidate must clear the invariants the incumbent is already held to — the fence policy,
 * margin-marker parity, and the `carriesPageProse` content floor — because winning on document
 * characters is not a licence to break them. All were added after a shipped pin went red, not
 * predicted. The ceiling guard was added and then DELETED: with it removed, the whole suite and
 * a 240,000-case generated sweep report zero ceiling violations, because candidates are built
 * from `room` — the budget minus frontmatter minus the notice they are concatenated with — so
 * exceeding it is not a state they can reach. The ceiling is asserted by the sweep instead of
 * restated as dead code.
 *
 * Two things this deliberately does NOT do, both measured rather than assumed:
 *
 * - It offers no footer-less candidate. Those win on document characters at small budgets by
 *   returning no truncation notice at all (verified: no footer at every budget tested), which
 *   makes truncation SILENT — a strictly larger instance of the defect #211 was filed for, and
 *   the reason the strict monotonicity bar was traded away rather than the footer.
 * - It does not outbid the incumbent's framing. Candidates reuse the incumbent's notice, so
 *   heading-skeleton and notice decisions stay with the existing pipeline and this only changes
 *   how much body rides under them.
 */
function selectFullestCandidate(
	incumbent: string,
	body: string,
	effectiveBudget: number,
	frontmatterTokens: number,
	assemble: (portion: string) => string,
	hasQuery: boolean,
): string {
	const footerIdx = incumbent.lastIndexOf("\n\n---\n");
	const notice = footerIdx >= 0 ? incumbent.slice(footerIdx) : "";
	const room = Math.max(1, effectiveBudget - frontmatterTokens - estimateTokens(notice));
	const candidates = [
		incumbent,
		// Whole-body variants only. A prose-only candidate (heading prefix stripped) was tried
		// and removed on evidence: it wins characters by dropping the heading skeleton the
		// contract promises at small budgets, and it detaches query-selected prose from the
		// heading it belongs to — two existing pins, not hypotheticals.
		//
		// The heading itself is still exercised as DOCUMENT text: `largestFittingSlice(body, …)`
		// keeps it when it fits, which is the point that mattered for headingLed (8 of the 91
		// admitted violations). What is not offered is a candidate that chooses prose INSTEAD
		// of the framing the pipeline decided to install.
		trimToTokenBudgetWithClosedFence(body, room) + notice,
		largestFittingSlice(body, room) + notice,
	];
	// Margin-level marker lines are a separate property from `findUnclosedFence`, which
	// deliberately does not see an indented opener (4 spaces is a code block, and an info
	// string is allowed). The failure this guards is the asymmetry between them: closing an
	// indented run appends a marker at column 0, so the answer carries one bare-margin marker
	// line where the incumbent carried none — odd, and the #182 pin counts parity, not parses.
	// Policy: never make it worse; repairing it is the trim's job, not this selection's.
	const marginMarkers = (t: string) => (t.match(/^(?:`{3,}|~{3,})[^\n]*$/gm) || []).length;
	const incumbentMarginOdd = marginMarkers(assemble(incumbent)) % 2 !== 0;
	const incumbentOpen = findUnclosedFence(assemble(incumbent)) !== null;
	let best = incumbent;
	let bestChars = documentCharacters(incumbent, body);
	for (const c of candidates) {
		// No ceiling guard here, deliberately. With it removed, 240,000 generated cases and the
		// whole suite report ZERO ceiling violations — the candidates are built from `room`,
		// which is the budget minus frontmatter minus the notice they are concatenated with, so
		// exceeding it is not a state they can reach. A branch nothing can drive is a vacuous
		// guard, so the ceiling is asserted by the sweep in tests/budget-monotonic-206.test.mjs
		// instead of restated as dead code here.
		//
		// Same finding, same treatment, for a fence guard here: with it removed the fence count
		// was identical (39 before, 39 after), because `largestFittingSlice` already routes any
		// fenced input to the fence-aware trim. It was deleted rather than kept as insurance.
		//
		// That conclusion was half wrong and the guard is back. It is NOT load-bearing on its own
		// (the 39-vs-39 count is real) but it IS load-bearing jointly with the safe trim above:
		// removing both lets a candidate consume a four-backtick opener, which the shipped #182
		// pin catches. A guard that is redundant with one neighbour is not redundant with the
		// pair, and "no single mutant goes red" is not the same claim as "no change goes red".
		if (!incumbentOpen && findUnclosedFence(assemble(c)) !== null) continue;
		if (!incumbentMarginOdd && marginMarkers(assemble(c)) % 2 !== 0) continue;
		// The pipeline's own content floor, applied to the candidate as well. Without it a
		// candidate can win on character count while carrying no line of the page at all —
		// the framing-only failure #182 exists to prevent, re-opened through the back door.
		if (!carriesPageProse(c, body)) continue;
		// With a query, the incumbent is not "some of the document" — it is the BM25-SELECTED
		// part of it, and document characters is the wrong objective: a document-order prefix
		// can carry MORE characters while dropping the section the query asked for. Measured on
		// a three-section page queried for the middle one: master kept the matching section at
		// 101 budgets, this selection kept it at 32. That is the tool's core purpose traded for
		// a metric it does not measure. So a candidate may only ADD to a query-ranked answer,
		// never replace it: every document line the incumbent carried must still be present.
		// Candidates are prefixes, so this admits strictly longer prefixes and nothing else.
		if (hasQuery && !supersedesIncumbent(c, incumbent, body)) continue;
		const chars = documentCharacters(c, body);
		if (chars > bestChars) {
			bestChars = chars;
			best = c;
		}
	}
	return best;
}

export function applyTokenBudget(
	content: string,
	budget: number,
	query?: string,
	url?: string,
	opts?: { displayBudgetTokens?: number },
): string {
	// The caller's number is the contract. This used to floor at 100, which
	// silently overrode any smaller budget: `budgetTokens: 50` was answered with
	// ~100 tokens of content, and it also masked the footer-vs-budget case that
	// `shrinkNoticeToRoom` now handles. A budget of 1 still yields a non-empty
	// budget rather than collapsing to "no budget".
	const effectiveBudget = Math.max(1, Math.floor(budget));
	// The number the CALLER recognises. `webfetch` and `webcontent` deliberately size the
	// body below the caller's ceiling, because the header (title, URL, save path, note)
	// spends part of the same budget — so `effectiveBudget` here is an internal share
	// (measured: `budgetTokens: 150` produced a footer reading "108-token budget", and
	// `300` produced "267"). The caller sees a number that appears nowhere in their request
	// and cannot be reconciled with anything they passed (#211).
	//
	// DISPLAY ONLY. Every budget computation below still uses `effectiveBudget`; a test
	// pins that a display of 5000 against a real 108 cannot unlock 5000 tokens. This reuses
	// the rule `src/multi-answer.ts` already applies (`displayBudgetTokens ?? budget`) so
	// the count of budget-rendering seams does not go up.
	// The truthiness test alone is the guard: `0` and `undefined` are both falsy, so an
	// explicit `> 0` was unreachable difference — mutation proved it (removing it left the
	// suite byte-for-byte green) and it is deleted rather than kept as decoration.
	const displayBudget = opts?.displayBudgetTokens
		? Math.floor(opts.displayBudgetTokens)
		: effectiveBudget;
	if (estimateTokens(content) <= effectiveBudget) return content;

	// The frontmatter block is re-emitted verbatim at the top of the result, so
	// its tokens are part of what this function returns and must be reserved out
	// of the budget. Everything below operates on the body only (issue #165 F8/F20).
	const { frontmatter: rawFrontmatter, body } = splitFrontmatter(content);
	// Content is what the caller asked for, so it is reserved FIRST, and the
	// metadata and the truncation notice are dropped when they cannot coexist with
	// it. Previously frontmatter was reserved first and the footer second, so the
	// two together could consume the whole budget and the answer came back
	// containing none of the document: a 92-token frontmatter at `budgetTokens: 100`
	// returned 100 tokens of pure YAML, and budgets 40–80 on a plain page returned
	// headings plus a notice with no prose at all. That is worse than going over
	// budget, because the output looks complete (issue #165, CodeRabbit threads
	// src/prune-markdown.ts:568 and src/tools/webcontent.ts:56).
	const MIN_CONTENT_TOKENS = Math.max(
		1,
		Math.floor(effectiveBudget * MIN_CONTENT_SHARE),
	);
	const rawFrontmatterTokens =
		rawFrontmatter === "" ? 0 : estimateTokens(rawFrontmatter);
	const keepFrontmatter =
		rawFrontmatter !== "" &&
		rawFrontmatterTokens <= effectiveBudget - MIN_CONTENT_TOKENS;
	const frontmatter = keepFrontmatter ? rawFrontmatter : "";
	const frontmatterTokens = keepFrontmatter ? rawFrontmatterTokens : 0;
	// Spend what is left on the notice, never at the cost of the content floor.
	const FOOTER_TOKEN_RESERVE = Math.min(
		MAX_NOTICE_RESERVE,
		Math.max(0, effectiveBudget - frontmatterTokens - MIN_CONTENT_TOKENS),
	);
	const contentBudget = Math.max(
		1,
		effectiveBudget - FOOTER_TOKEN_RESERVE - frontmatterTokens,
	);

	// Extract heading skeleton — always preserved in the output.
	const headingLines = body.split("\n").filter((l) => /^#{1,6}\s/.test(l));

	const pruned = pruneMarkdown(
		body,
		{
			maxTokens: contentBudget,
			query,
		// When a query is present, drop lowest-BM25 sections first (the
		// default pruneMarkdown behaviour). Without a query the heuristic
		// scorer drops lower-priority sections first, which effectively
		// preserves the top of the document.
	});

	// pruneMarkdown appends its own "Truncated to ~N tokens … Omitted sections"
	// footer. Strip it so the budget path emits a SINGLE unified footer (the
	// budget footer below, which carries the same shared TOC) instead of two
	// redundant footers back-to-back.
	let prunedContent = pruned.content.replace(
		/\n\n---\n\*Truncated to ~[\s\S]*$/,
		"",
	);

	// The content floor is a promise, not a preference. pruneMarkdown admits WHOLE
	// sections, so a body that is a SINGLE section larger than the content budget is
	// discarded entirely: at the legal minimum `budgetTokens: 100` the answer was 26
	// tokens of pure notice (36 with a heading present) containing none of the
	// document, while frontmatter and the footer both survived. Partial prose beats a
	// footer, so when pruning kept nothing of a non-empty body, take a measured
	// prefix of it instead. Every sweep written before this used many small sections,
	// where at least one always fit, which is why the shape was missed (independent
	// review dlg-cf70d5aa on merged master ed7ec3a).
	const partialFallback =
		prunedContent.trim() === "" && body.trim() !== "" && contentBudget > 0;
	if (partialFallback) {
		// Which slice to take is a ranking question, not a position question. With a
		// query, the document prefix is usually the WRONG section: querying a later
		// oversized section returned only unrelated opening prose while the section
		// actually asked for stayed in the cache (issue #169, CodeRabbit thread
		// src/prune-markdown.ts:618). Rank the same way pruneMarkdown does.
		const sections = splitSections(body);
		// Headings come from the skeleton, so the prefix is built from PROSE. Left as
		// the raw body, a first heading line longer than the prefix room produced an
		// answer containing the heading twice and no page prose at all (issue #169,
		// CodeRabbit thread src/prune-markdown.ts:666). The leading blank is not
		// cosmetic: after a frontmatter block the body starts with "\n", so a regex
		// anchored at ^ never matched and the heading fragment came straight back.
		let source = prosePrefixSource(body);
		let selectedHeading = "";
		// A preamble has no heading of its own; emitting it after the skeleton would
		// make Markdown attribute it to the first real section, inventing a claim about
		// where those words came from (issue #169, CodeRabbit thread
		// src/prune-markdown.ts:635).
		let prefixBeforeSkeleton = false;
		if (!query && sections.length > 0) {
			// Without a query the document-order answer is the FIRST section, and its
			// heading has to travel with it. Taking the whole body left the prose sitting
			// under the skeleton's LAST heading — the same misattribution the ranked branch
				// had already been fixed for.
			const first = sections[0];
			if (first.content.trim() !== "") {
				source = first.content;
				prefixBeforeSkeleton = !first.heading;
				if (first.heading) {
					selectedHeading = `${"#".repeat(first.level)} ${first.heading}`;
				}
			}
		}
		if (query && sections.length > 1) {
			// Same ranking as the default pruneMarkdown path: with a query, BM25
			// replaces the heuristic entirely (`combineScores` defaults false), so the
			// heuristic must NOT be added here or document position outranks relevance.
			const bm25 = createBM25Scorer(query).scoreAll(
				sections.map((s) => `${s.heading}\n${s.content}`),
			);
			let best = 0;
			let bestScore = 0;
			bm25.forEach((sc, i) => {
				if ((sc ?? 0) > bestScore) {
					bestScore = sc ?? 0;
					best = i;
				}
			});
			// No section matches the query (a stop word scores 0 everywhere): fall back
			// to the FIRST section rather than the whole body, so "document order" means
			// the same section here as it does for the pruner, and the emitted heading
			// still names the prose that follows it.
			const chosen = bestScore > 0 ? sections[best] : sections[0];
			if (chosen && chosen.content.trim() !== "") {
				// `chosen.content` is already heading-free, which is what the prefix wants.
				source = chosen.content;
				// A chosen section can have NO heading to emit: a leading preamble, a
				// section after a `---` rule, or sections[0] picked by a query that scores 0
				// everywhere. Emitting the outline first would credit that prose to the
				// outline's last heading (issue #169, CodeRabbit thread
				// src/prune-markdown.ts:710).
				prefixBeforeSkeleton = !chosen.heading;
				// The skeleton ends with some OTHER section's heading, so Markdown would
				// attach this prose to it and the answer would name the wrong section as
				// the source of its own text. Re-emit the selected heading at its own level
				// (issue #169, CodeRabbit thread src/prune-markdown.ts:667).
				if (chosen.heading) {
					selectedHeading = `${"#".repeat(chosen.level)} ${chosen.heading}`;
				}
			}
		}
		// The prefix carries at most its own heading, so the outline must be added
		// alongside it. Omitting this was a regression the fallback itself introduced:
		// an empty pruned body used to take the skeleton path and keep every heading,
		// but once the prefix supplied the first heading `resultHasHeadings` was true
		// and the skeleton was skipped, so later sections vanished from the outline.
		// The skeleton is capped so it cannot crowd the prose back out.
		const skelLines = selectSkeletonLines(
			headingLines,
			outlineBudget(contentBudget, OUTLINE_SHARE),
		);
		const skeleton = skelLines.join("\n");
		const skeletonTokens = skeleton ? estimateTokens(skeleton) : 0;
		// When the selected heading is already in the outline, the prose is inserted
		// directly after it rather than appended past the whole skeleton: that keeps
		// document order AND attribution without emitting the heading twice.
		const selIdx = selectedHeading ? skelLines.indexOf(selectedHeading) : -1;
		// The outline already dropped this heading for being larger than its whole share;
		// re-emitting it separately would hand it that room back and leave the prose with
		// nothing (the exact shape the skeleton rule exists to prevent). Same rule, same
		// cap: if it did not fit the outline, it does not get a second chance.
		const outlineCap = outlineBudget(contentBudget, OUTLINE_SHARE);
		if (selectedHeading && estimateTokens(selectedHeading) > outlineCap) {
			selectedHeading = "";
			// The prose came from behind a heading the outline refused to carry. Without
			// this it would fall through to the outline-first branch and be credited to
			// whichever heading the outline DID keep.
			prefixBeforeSkeleton = true;
		}
		const headingTokens =
			selectedHeading && selIdx < 0 ? estimateTokens(selectedHeading) + 1 : 0;
		const prefixRoom = Math.max(
			1,
			contentBudget - skeletonTokens - headingTokens,
		);
		const prefix = trimToTokenBudgetWithClosedFence(source, prefixRoom);
		const parts: string[] = [];
		if (prefixBeforeSkeleton) {
			parts.push(prefix, skeleton);
		} else if (selIdx >= 0) {
			parts.push(skelLines.slice(0, selIdx + 1).join("\n"));
			parts.push(prefix);
			const rest = skelLines.slice(selIdx + 1).join("\n");
			if (rest !== "") parts.push(rest);
		} else {
			parts.push(skeleton, selectedHeading, prefix);
		}
		prunedContent = parts.filter((part) => part !== "").join("\n\n");
	}

	// Count sections in the original vs kept, and identify WHICH headings were
	// dropped so the footer can list them (same mini-TOC as the prune path).
	const originalSections = splitSections(body);
	const prunedSections = splitSections(prunedContent);
	// A partial prefix is a cut even when it retains the only section's heading, so
	// `omitted` alone cannot be trusted to pick the footer wording here. `pruned.truncated`
	// is the pruner's own statement of what it did; the token comparison is kept only
	// as a backstop because estimating a truncation after the fact from a lossy
	// estimator is inference where authoritative state is available (issue #169,
	// CodeRabbit thread src/prune-markdown.ts:628 — no mislabelled footer was
	// reproducible in 183 sweeps, so this is hardening of the source of truth, not a
	// demonstrated defect).
	const contentWasCut =
		partialFallback ||
		pruned.truncated ||
		estimateTokens(prunedContent) < estimateTokens(body);
	const omitted = Math.max(0, originalSections.length - prunedSections.length);
	const keptHeadings = new Set(prunedSections.map((s) => s.heading));
	const omittedSections = originalSections.filter(
		(s) => !keptHeadings.has(s.heading),
	);
	const retrieveHint = url
		? `retrieve via aio-webcontent with URL: ${url}`
		: "retrieve via aio-webcontent by URL";

	// The budget footer keeps its "full content cached — retrieve via
	// aio-webcontent" hint AND appends the omitted-sections TOC, so the two
	// truncation paths emit the same heading list. (F7)
	//
	// The footer BASE is built first so the TOC can be sized against what is
	// actually left: frontmatter + footer + a minimum slice of content must all
	// fit. Previously the TOC was bounded only by entry COUNT, so 14 long headings
	// produced a 241-token footer on a 250-token budget — the guarantee then
	// trimmed the body to NOTHING and still landed 2 tokens over (issue #165 F20).
	let footerText = `\n\n---\n_content fits ${displayBudget}-token budget; full content cached — ${retrieveHint}._`;
	if (contentWasCut) {
		// A partial prefix is a cut too, so it must not be described as fitting.
		const cutNote =
			omitted > 0
				? `${omitted} section${omitted === 1 ? "" : "s"} omitted`
				: "part of the remaining section kept";
			footerText = `\n\n---\n_truncated to fit ${displayBudget}-token budget: ${cutNote}; full content cached — ${retrieveHint}._`;
	}
	const footerBase = footerText;
	// Keep the content floor accounted for when sizing the TOC: the omitted-heading
	// list is the lowest-priority thing in this output.
	const tocBudget = Math.max(
		0,
		effectiveBudget - frontmatterTokens - estimateTokens(footerBase) - MIN_CONTENT_TOKENS,
	);
	const omittedToc = buildOmittedSectionsToc(omittedSections, tocBudget);
	const footer = `${footerBase}${omittedToc}`;

	// Preserve heading skeleton even when most content was dropped.
	// Prepend skeleton if none of the headings survived pruning.
	let result = prunedContent;
	if (headingLines.length > 0) {
		const resultHasHeadings = /^#{1,6}\s/m.test(result);
		if (!resultHasHeadings) {
			// Same rule as the fallback outline: WHOLE headings, and an individual
			// heading larger than the outline's share is dropped rather than prepended
			// unbounded — a 120-token H1 prepended here left 90 tokens of heading and no
			// prose at all (issue #169, CodeRabbit thread src/prune-markdown.ts:666).
			const skeleton = selectSkeletonLines(
				headingLines,
				outlineBudget(effectiveBudget, PREPEND_OUTLINE_SHARE),
			).join("\n");
			if (skeleton !== "") {
				// Heading-less prose goes FIRST. Prepending the outline always attributed
				// that prose to the skeleton's LAST heading — this branch only runs when the
				// kept content has no heading of its own, so every page reaching here was
				// labelled with a heading it never had (issue #169, CodeRabbit thread
				// src/prune-markdown.ts:635). The outline still travels with the answer, it
				// just no longer speaks for text it did not introduce.
				result = result.trim() === "" ? skeleton : `${result}\n\n${skeleton}`;
			}
		}
	}

	result = result + footer;

	// Hard guarantee: re-measure and trim until the FULL returned text —
	// frontmatter, body and footer — actually fits. The previous version trusted
	// a `maxTokens * 4` character estimate once and never re-checked, so
	// `budgetTokens` came back over budget (measured live: 250 -> 273; issue #165
	// F20). Markdown's short lines make chars/token far lower than 4.
	const assemble = (portion: string): string => withFrontmatter(frontmatter, portion);
	if (estimateTokens(assemble(result)) > effectiveBudget) {
		// Trim content portion only, keep footer.
		const footerIdx = result.lastIndexOf("\n\n---\n");
		// `>= 0`, not `> 0`. A footer starting at index 0 means there is NO content
		// above it — which is exactly the starved case — and `> 0` classified that
		// footer as page content, trimmed it to `bodyBudget` and emitted it. That is
		// the reported `"\n\n--"` at budget 1: the notice's own separator, cut to one
		// token (#182). `0` is a found index.
		const hasFooter = footerIdx >= 0;
		const contentBody = hasFooter ? result.slice(0, footerIdx) : result;
		// The footer is information, not the contract. A budget smaller than the
		// footer itself could not be satisfied by trimming content: the body went to
		// zero and the notice alone still overran (measured: budgets 1–31 returned
		// 33–34 tokens). Step the notice down until it fits and let content take what
		// is left, so the ceiling holds at every budget rather than only above the
		// footer's size.
		let ft = shrinkNoticeToRoom(
			hasFooter ? result.slice(footerIdx) : "",
			// Not the whole budget: the notice may use whatever is left AFTER the
			// content floor, or it reclaims the space the floor exists to protect.
			// Measured at budget 40, a ~35-token notice "fit" the 40-token room it was
			// offered and left the content 5 tokens — a literal "#".
			Math.max(0, effectiveBudget - frontmatterTokens - MIN_CONTENT_TOKENS),
			displayBudget,
		);
		let footerTokens = estimateTokens(ft);
		let bodyBudget = Math.max(
			0,
			effectiveBudget - footerTokens - frontmatterTokens,
		);
		let bodyPart = trimToTokenBudgetWithClosedFence(contentBody, bodyBudget);
		// D2 (#182): the floor wins outright. The notice is the lowest-priority
		// framing in the spend order, so if it displaced the floor completely — the
		// content part came out empty while the document is non-empty — the notice
		// costs zero and prose takes the whole room. "The caller's number is the
		// contract" means a 1-token answer is one token of the document, not one
		// token of boilerplate. Dropping framing can only lower the total, so the
		// ceiling is unaffected by construction.
		if (footerTokens > 0 && bodyPart.trim() === "" && body.trim() !== "") {
			ft = "";
			footerTokens = 0;
			bodyBudget = Math.max(0, effectiveBudget - frontmatterTokens);
			// contentBody is "" when the footer was the whole result, so fall back to
			// the document's own prose rather than returning nothing.
			bodyPart = trimToTokenBudgetWithClosedFence(
				contentBody || prosePrefixSource(body),
				bodyBudget,
			);
		}
		result = bodyPart + ft;
		// No separate "suppress a lone `---`" guard here. One was written for D1 and
		// then deleted: mutation testing showed the floor pass below already covers
		// it, because a result consisting only of a rule carries none of the
		// document's words and is therefore replaced by prose. A guard that cannot
		// be made to red does not get to stay in the file.
	}

	// #182 D2: the floor pass, deliberately OUTSIDE the overflow backstop above.
	// That block only runs when the assembled text EXCEEDS the budget, and at tiny
	// budgets nothing overflows — the notice alone fit inside 2 tokens and the
	// document contributed nothing, so an overflow-only guard could never see it.
	// Here the notice is the lowest-priority framing in the spend order: if the
	// portion carries none of the document's own words while the document is
	// non-empty, the notice costs zero and prose takes the room.
	//
	// This is also the single enforcement point for D1 (a lone `---` is not a
	// separator): a rule-only result carries no document words, so it is replaced
	// here rather than by a second guard.
	if (body.trim() !== "" && !carriesPageProse(result, body)) {
		const room = Math.max(0, effectiveBudget - frontmatterTokens);
		const stripped = prosePrefixSource(body);
		// When stripping the leading heading run leaves NOTHING, the document IS its headings
		// (or its rules) and the strip has removed all of its content, so every candidate
		// built from `source` was the empty string and the floor had nothing to install.
		// There is no prose to protect in such a document, so the run being stripped is the
		// only content there is (#189 item 1). Where prose exists this is byte-for-byte
		// unchanged - the strip still runs first, which is what stops a heading fragment
		// standing in for the article.
		const source = stripped.trim() === "" ? body : stripped;
		// The candidate is held to the same test as the result it replaces. The
		// trimmers emit framing at tiny budgets — a balanced pair of empty fence
		// markers, a lone opener — and installing one would only swap a piece of
		// NOTICE framing for a piece of MARKUP framing. Deciding that here, at the one
		// site that needs a content-bearing answer, is what replaced three rounds of
		// fence rewriting in the shared trim helper.
		const candidates = [
			trimToTokenBudgetWithClosedFence(source, room),
			// At one or two tokens a fence-led document yields only its marker: the opener
			// alone consumes the whole room (at room 10 the trim returned "```\n" and
			// nothing else). So ask for the text inside the fence — but UNWRAP it, do not
			// merely lift the lid: removing only the opener left its paired closer behind,
			// and a lone marker line is an OPENER in Markdown, so the answer ended inside a
			// fence that never closed (#190). This replaces the leading-marker regex and the
			// orphan-closer strip that used to sit here; see `unwrapLeadingFences` for why a
			// marker line that is the document's own content stays body.
			trimToTokenBudget(unwrapLeadingFences(source), room),
			// The same unwrapped text, but trimmed with the SHARED closed-fence helper so
			// the candidate can be prose AND closed instead of one or the other. Without it
			// the two properties fight: the plain-unwrap candidate is often open (the trim
			// cuts after an opener that survives), the candidate preference then refuses it,
			// and the answer degrades to framing — a regression this PR introduced and a
			// generated sweep caught, where master answered "beta gamma" and this branch
			// answered "`" for the same document at the same budget. The closed-fence trim
			// costs a marker line of room, which is why it is offered alongside the plain
			// one rather than replacing it: replacing it lost the `#182` caption case.
			trimToTokenBudgetWithClosedFence(unwrapLeadingFences(source), room),
			// Last resort, and only reachable when NEITHER model-built candidate carries
			// the document's words: the aggressive strip that drops every leading marker
			// and blank line. It is deliberately kept separate from `unwrapLeadingFences`
			// rather than folded into it, because the two answer different questions and
			// the document cannot satisfy both at one token: `unwrapLeadingFences` is
			// literal-aware and preserves a documented fence ("```" inside a ```` fence is
			// the page's content), which at a tiny budget leaves that marker to eat the
			// whole room and answer with "`". This one reaches the text -- though it strips only
			// LEADING markers, so a marker further down can survive and its answer may end open. That
			// is acceptable under the ranking below, where prose outranks closure. Selection prefers
			// prose, so it wins only where the faithful candidate would have answered with
			// framing — and on a balanced document it can still never install an open
			// fence, because the candidate preference below refuses that.
			trimToTokenBudget(stripLeadingMarkers(source), room),
			// Whole lines, offered last so it only wins where every slice-based candidate
			// failed to carry the document's text. For a headings-only document this is the
			// difference between `#` and `# A\n\n## B`: the marker-eating trim cannot reach
			// the heading words at a small budget, and filling by lines can (#189 item 1).
			wholeLinesWithinBudget(source, room),
			// The same line fill over the marker-stripped text, so a one-token budget can
			// reach the heading's WORD (`A`) instead of its `#`. Same ranking position
			// logic: it only wins where nothing above it carried prose (#189 item 1).
			wholeLinesWithinBudget(stripLeadingMarkers(source), room),
		];
		// Two redesigns of the SHRINK LEAF were tried for item 3 (CJK under-fill) and both
		// are recorded here so the next attempt does not repeat them. (a) A token-measured
		// binary search over the slice length: it fixed CJK and the Latin ceiling, and
		// broke four #190/#182 guards, because a LONGER slice can be a WORSE candidate -
		// `"```\ncode \n```\n"` drops the prose a shorter slice kept. Quality is not
		// monotone in slice length, so "largest fitting slice" is the wrong objective.
		// (b) Replacing the absolute `- 16` margin with a proportional one: it also broke
		// four guards and made Latin output worse (`# A\n\n## B\n\n#` at budget 6).
		// The line fill above is the change the evidence supports; the leaf itself needs a
		// redesign whose objective is candidate QUALITY, not size, and that is left open on
		// #189 rather than shipped as a partial win over four pinned regressions.
		// Prefer a candidate that actually carries the document's words. Order alone was
		// not enough: on a fence-led document at budget 1 the closed-fence trim yields a
		// lone backtick, which was installed while the second candidate — the real code
		// text with its markers removed — sat unused. A letter-less fragment is still a
		// legitimate last resort ("-" taken from a list is the document's own text), so
		// it is accepted only when nothing that carries prose was available.
		//
		// An earlier version also rejected candidates that were "nothing but fence
		// delimiters". That guard was deleted: once the prose preference exists, it can
		// only fire when NO candidate carries prose, i.e. when the document itself has no
		// letter-or-number content, and then the delimiters are the document's own text.
		// A guard that no input can require does not stay in the file.
		// Never install a candidate that ENDS inside a fence when one that does not is
		// available. Guarded on the source being balanced: a document that is unbalanced
		// on input keeps its own openness rather than being repaired with a line the
		// author never wrote (the policy pinned by "unbalanced input that fits is passed
		// through"). The final fallback keeps the old behaviour when every candidate is
		// open — a framing answer beats a blank one.
		//
		// This guard was deleted once in this PR's development on the reasoning that it
		// could not be made red, because removing it left `test:all` byte-for-byte as
		// green. That was a mistake of method: the suite is an existence proof for the
		// cases it contains, not for a universal claim. A randomised sweep over balanced
		// generated documents found 80 inputs where the answer came back open with the
		// guard absent (e.g. "```\n``` js\n| a | b |\nalpha text\n- list item\n# head\n```\n"
		// at budget 12 answered "``` js"), and those inputs are now pinned in
		// tests/fence-state-190.test.mjs.
		// Asked of the ASSEMBLED text, not of the body alone, because assembled text is what
		// the caller receives: frontmatter is prepended by `assemble` after this choice is
		// made, so a fence straddling the frontmatter boundary is invisible to a body-only
		// check. On the residual input the assembled document is genuinely unbalanced, which
		// makes the preference inert for the right reason -- the whole document is open, not
		// just the part this block can rewrite -- rather than by accident of scope.
		const sourceBalanced = findUnclosedFence(assemble(source)) === null;
		const closesCleanly = (c: string) =>
			!sourceBalanced || findUnclosedFence(assemble(c)) === null;
		// Ranking: closed-and-prose > prose > closed > anything. Prose sits ABOVE closure
		// deliberately, and both orders were measured. With closure first, a document whose only
		// prose-bearing candidate ends inside a fence is answered with a bare marker -- the
		// framing-only defect #182 exists to prevent, and a worse caller outcome than a
		// truncated preview with an unbalanced fence. The sweep in
		// tests/fence-state-190.test.mjs states the property that survives the choice:
		// never both framing and open.
		const chosen =
			candidates.find((c) => closesCleanly(c) && carriesPageProse(c, body)) ??
			candidates.find((c) => carriesPageProse(c, body)) ??
			candidates.find((c) => closesCleanly(c) && c.trim() !== "") ??
			candidates.find((c) => c.trim() !== "");
		// Nothing in the document fits the room, or the document has no prose to fit.
		// Leave the framing rather than install a blank candidate.
		if (chosen !== undefined) result = chosen;
	}

	// #206: composition-level selection. Runs last, over the ASSEMBLED-text contract, so it
	// sees the same framing the caller will, and never lowers what a budget already achieved.
	result = selectFullestCandidate(
		result,
		body,
		effectiveBudget,
		frontmatterTokens,
		assemble,
		(query ?? "").trim() !== "",
	);

	return assemble(result);
}

/**
 * Shorten a truncation notice until it fits the room it was given, stepping
 * through progressively terser forms and finally dropping it entirely.
 *
 * Ordered by what is worth keeping as the budget shrinks: the omitted-sections
 * heading list first, then the "full content cached" wording, then the count and
 * retrieval hint, then the notice itself. The caller's budget always wins over
 * the explanation of why the content was cut.
 */
function shrinkNoticeToRoom(footer: string, room: number, displayBudget?: number): string {
	if (estimateTokens(footer) <= room) return footer;
	// 1. Drop the omitted-sections TOC, keep the count line.
	const noToc = footer.replace(/\n\n\*Omitted sections:\*[\s\S]*$/, "");
	if (estimateTokens(noToc) <= room) return noToc;
	// 2. Fixed notices, longest first. The number-bearing forms come BEFORE the
	// numberless ones whenever a caller gave us a number to show: the old list was
	// hardcoded without one, so a slightly tighter room turned the footer into
	// "truncated to fit the token budget" — a truncation claim with no budget the caller
	// can check, which is the #211 confusion wearing a different face rather than a fix
	// of it. Falling through to the numberless forms stays correct for the rooms where the
	// number genuinely cannot fit: no notice at all would drop the truncation claim, which
	// is worse than a claim without a number.
	const rungs: string[] = [];
	if (displayBudget !== undefined) {
		rungs.push(
			`_truncated to fit the ${displayBudget}-token budget; full content cached._`,
			`_truncated to fit the ${displayBudget}-token budget._`,
			// "truncated to N tokens" reads as a statement about where the text ENDS. It is
			// not: the answer is at most N, usually fewer (measured: the rung fired on answers
			// well under the number). That is the same misstatement #211 exists to remove, so the
			// wording states a limit, never an endpoint.
			`_truncated to fit ${displayBudget} tokens._`,
		);
	}
	rungs.push(
		"_truncated to fit the token budget; full content cached._",
		"_truncated; full content cached._",
		"_truncated._",
	);
	for (const notice of rungs) {
		const candidate = `\n\n---\n${notice}`;
		if (estimateTokens(candidate) <= room) return candidate;
	}
	return "";
}

/**
 * Cut `text` so that it measures at most `maxTokens`.
 *
 * Exported because `aio-webcontent` bounds its header block with the same rule
 * rather than carrying a second truncation loop.
 *
 * `truncateToBudget` alone is not enough: it cuts at a rough `maxTokens * 4`
 * character estimate, which under-counts markdown with short lines, headings and
 * CJK text. This measures the result and shrinks by the measured excess until it
 * fits, so callers can state a hard token contract.
 */
/**
 * The line that OPENS a fence: any run of leading spaces/tabs, then three or more
 * backticks or tildes. Deliberately LOOSER than CommonMark, which allows at most three
 * spaces: this model treats a four-space-indented marker as a fence too, because the
 * alternative is to let an indented marker open a run the model cannot see and then
 * hand back prose inside it. Pre-existing behaviour, stated here rather than implied. One spelling for the whole file — the state model and the
 * unwrapper below must not drift into disagreeing about what a fence IS, and the two
 * ad-hoc marker regexes this replaced each disagreed with the model in its own way.
 * Non-global, so `.match`/`.test` carry no lastIndex state.
 */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Blankness for fence bookkeeping: ASCII space, tab and carriage return only.
 * `String.trim()` also strips NBSP and other Unicode spaces, which would let a line
 * the author actually wrote be swallowed as padding — the same reason the CRLF fix in
 * this file stopped using a trim-based blank test.
 */
const BLANK_LINE = /^[ \t\r]*$/;

/**
 * Drop every leading marker and blank line, without asking what they mean.
 *
 * A faithful model cannot do this: a marker line may be content. That is why it lives
 * beside `unwrapLeadingFences` as a last-resort candidate rather than inside it — see
 * the candidate list in `applyTokenBudget` for when each is allowed to win.
 */
export function stripLeadingMarkers(text: string): string {
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length && (BLANK_LINE.test(lines[i]) || FENCE_OPEN.test(lines[i]))) i++;
	return lines.slice(i).join("\n");
}

/**
 * Does a fence run's body carry text, or is it just another fence waiting behind
 * this one?
 *
 * This one is provable rather than heuristic. `j` is the FIRST line that could close
 * the run, so no line strictly inside the body can be a delimiter of that run — not a
 * same-character shorter marker, and not a fence in the other character either (a
 * "~~~" pair cannot close a backtick fence, it is two lines of code). Every non-blank
 * body line is therefore the document's text.
 *
 * The temptation was to treat a body of "```\n\n```" as an empty nested run and skip
 * it. That is wrong twice over: it deletes literal code (a tilde pair inside a
 * backtick fence, which is what a code-heavy README actually contains), and it is
 * unnecessary, because the last-resort `stripLeadingMarkers` candidate exists exactly
 * to reach text behind a wall of markers. Semantics live in the faithful candidate;
 * reachability lives in the last resort, which buys the text with an orphan marker and
 * is allowed to be open precisely because prose outranks closure below.
 */
function bodyHoldsLiteralText(runBody: string[]): boolean {
	return runBody.some((l) => !BLANK_LINE.test(l));
}

/**
 * The line that closes a fence opened with `marker`: the same character, at least as
 * long, and nothing else on the line. An info string makes a line an OPENER, which is
 * why "``` caption: …" does not close anything.
 *
 * Single spelling of the closing rule for the whole file; the dynamic length is the
 * marker's own length, never a caller-supplied pattern.
 */
function fenceClosePattern(marker: string): RegExp {
	const ch = marker[0] === "~" ? "~" : "`";
	// The trailing class admits \r as well as space and tab. A CRLF document is split on
	// \n, so every closer line still carries its carriage return; without it a CRLF
	// document's closer is never recognised, the run reads as unclosed, and the closer is
	// left in the body — and the shared closer then appends a marker to a document that
	// was already balanced. Same reason BLANK_LINE admits \r.
	return new RegExp(
		`^[ \\t]*${ch === "`" ? "`" : "~"}{${marker.length},}[ \\t\\r]*$`,
	);
}

/**
 * Unwrap the fences a document opens with, so the text INSIDE them can reach a tiny
 * budget. The body stays; the marker lines go.
 *
 * Three failure modes this avoids, each of which is a test on this seam:
 *   - removing only the OPENER leaves the paired closer behind, and a lone marker line
 *     is an OPENING marker in Markdown, so the answer ends inside a fence that never
 *     closes (#190);
 *   - removing the whole RUN deletes the document whenever the run's body IS the
 *     document — a page of code trimmed to 1 token must still yield code text (#182);
 *   - removing EVERY marker line destroys a marker line that is the document's own
 *     content, a caption or a documented fence (#182).
 * An UNCLOSED leading run loses only its opener: its "closer" may be an opener too
 * ("``` caption"), and consuming to end of input would eat the whole document. The
 * openness that remains is the source's own, not openness this function created, and
 * the candidate preference below is what decides whether such an answer may be
 * installed.
 */
export function unwrapLeadingFences(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(FENCE_OPEN);
		if (!m) break; // not a fence: the rest of the document is plain text
		const close = fenceClosePattern(m[1]);
		let j = i + 1;
		while (j < lines.length && !close.test(lines[j])) j++;
		// One path covers closed and unclosed: when no closer exists, `j` is already
		// end-of-input, so the body is the rest of the document and nothing follows it.
		// An unclosed run therefore loses only its OPENER — its apparent closer may itself
		// be an opener ("``` caption"), and consuming to end of input would eat the page.
		const runBody = lines.slice(i + 1, j);
		if (bodyHoldsLiteralText(runBody)) {
			// The body is the document, and so is everything after the run. STOP rather
			// than loop: a marker inside kept body is content ("``` caption" inside a fence
			// is just a line of code), and re-scanning it as a delimiter is the content-loss
			// this seam produced three times.
			return out.concat(runBody, lines.slice(j + 1)).join("\n");
		}
		// Nothing but blank lines in the run: drop opener and closer, keep scanning.
		i = j + 1;
	}
	return out.concat(lines.slice(i)).join("\n");
}

/**
 * Find a fence run that is opened but never closed, returning its marker and the
 * character offset of its opening line.
 *
 * A fence run is three or more backticks or tildes at the start of a line; the
 * opening run may carry an info string (```js), a closing run may not, and it must
 * use the same character and be at least as long as the run it closes.
 *
 * Exported because it is the project's single definition of "this document ends
 * inside a fence" (#190). Candidate selection asks it the same question the closer
 * asks; a second spelling of the property in a test would be a second model.
 */
export function findUnclosedFence(
	text: string,
): { marker: string; startIndex: number } | null {
	const lines = text.split("\n");
	let open: { marker: string; startIndex: number } | null = null;
	let cursor = 0;
	for (const line of lines) {
		if (open) {
			if (fenceClosePattern(open.marker).test(line)) open = null;
		} else {
			const m = line.match(FENCE_OPEN);
			if (m) open = { marker: m[1], startIndex: cursor };
		}
		cursor += line.length + 1;
	}
	return open;
}

/**
 * Close a fenced block that the text leaves open, within a token budget.
 *
 * The closer uses the ORIGINAL fence character and length — a fixed triple-backtick
 * suffix is wrong for longer backtick fences and for tilde fences. When `reserve` is
 * set, the closer's cost is taken out of the budget first so a page that is entirely
 * one code block still yields prose instead of collapsing to nothing.
 */
function closeFencesWithin(
	text: string,
	maxTokens: number,
	reserve = true,
): string {
	let open = findUnclosedFence(text);
	if (!open) return text;
	let closer = `\n${open.marker}\n`;
	if (estimateTokens(text) + estimateTokens(closer) <= maxTokens) {
		return text + closer;
	}
	if (!reserve) {
		// Closing still beats leaving the block open; the caller's hard trim re-checks
		// the ceiling with the cost reserved.
		return text + closer;
	}
	// Re-trim with the closer reserved instead of dropping the fragment, so the
	// answer still contains the page.
	const trimmed = trimToTokenBudget(
		text,
		Math.max(1, maxTokens - estimateTokens(closer)),
	);
	open = findUnclosedFence(trimmed);
	if (!open) return trimmed;
	closer = `\n${open.marker}\n`;
	if (estimateTokens(trimmed) + estimateTokens(closer) <= maxTokens) {
		return trimmed + closer;
	}
	// Only reachable when the budget cannot hold a fence plus its closer; at the
	// tools' minimum of 100 tokens a closer costs 2-3.
	return trimmed.slice(0, open.startIndex).trimEnd();
}

/**
 * Trim to a token budget while guaranteeing the result does not leave a fenced code
 * block open.
 *
 * Cutting inside a fence used to append the truncation footer INSIDE the code block,
 * so the pointer to the cached page rendered as part of the snippet (issue #169,
 * CodeRabbit thread src/prune-markdown.ts:667).
 */
export function trimToTokenBudgetWithClosedFence(
	text: string,
	maxTokens: number,
): string {
	// Closing is all this helper does. It briefly also REMOVED fences it judged empty,
	// in three successive forms — a character-class test, a regex pairing, then a
	// boundary scanner — and each form deleted real code content in a different way:
	// a `---` body became horizontal rules, a shorter marker line inside a longer
	// block was eaten as a closer, a tilde info string containing tildes hid a whole
	// body, and JS `trim()` erased NBSP/EM/VTAB bodies that Markdown treats as
	// content. Three rounds finding three classes of the same deletion is the
	// signature of a wrong seam, not a wrong patch: deciding what a fence MEANS is
	// the job of the one closure parser in this module, not of a second opinion
	// bolted onto its output. The budget path that actually needed a content-bearing
	// answer now validates its own swap candidate with the detector it already had.
	const trimmed = closeFencesWithin(trimToTokenBudget(text, maxTokens), maxTokens, true);
	// A token cut can land immediately after a heading marker, leaving `##` with no heading.
	// Reproduced on master at `budgetTokens: 15` for a document whose second heading is long:
	// the answer ended `…keeps going.\n\n##`. That is neither structure nor prose — it carries
	// no information, costs the caller a token, and renders as an empty heading. This module
	// already states the rule for the outline path ("Whole lines only: … cut a heading
	// mid-word (`## Sect`), which is neither structure nor prose"); the budget trim path
	// simply never got it.
	//
	// TRAILING only, on purpose. A bare `#` anywhere else came from the document itself —
	// inside a code fence it is real content — and stripping that would make this the fourth
	// second-opinion parser the comment above documents. Only the cut point is provably an
	// artefact of this trim. A heading cut to `## gam` is likewise left alone: recognising
	// that needs the source document to know a word was lost, which is inference this seam
	// has repeatedly turned into content deletion.
	//
	// The whole-string case needs its own branch: the trailing pattern is anchored on the
	// newline BEFORE the marker, so a result that is nothing but `##` — which this leaf does
	// produce at maxTokens 2 and 3 on a heading-led document — never matches it. An answer
	// consisting solely of a marker carries no document content by construction, so emptying
	// it is the same judgement rather than a wider one.
	// The rule is about a CUT. If the input already fit, `trimToTokenBudget` returned it
	// unchanged and any trailing `##` is the AUTHOR'S LINE, not an artefact of this function.
	// Measured against a real `origin/master` worktree (an earlier comparison of mine was
	// invalid: the changes were already committed, so `git stash` stashed nothing and both
	// sides ran the fixed code):
	//   master "Some authored prose that fits comfortably.\n\n##"   <- preserved
	//   without this gate
	//        "Some authored prose that fits comfortably.\n"          <- authored content deleted
	// That is precisely the content-deletion shape this function's comment above documents
	// three times, reintroduced by a rule whose own justification was "only the cut point is
	// provably an artefact". The justification now has a guard instead of only a sentence.
	if (estimateTokens(text) <= maxTokens) return trimmed;
	if (/^[ \t]*#{1,6}[ \t]*$/.test(trimmed)) return "";
	return trimmed.replace(/(?:\n[ \t]*#{1,6}[ \t]*)+$/, "");
}

/**
 * Pick heading lines for the outline, budget permitting.
 *
 * Whole lines only: trimming the joined list to a token budget cut a heading mid-word
 * (`## Sect`), which is neither structure nor prose. A single heading larger than the
 * outline's share is skipped rather than kept, so the prose gets the room instead.
 */
function selectSkeletonLines(headingLines: string[], capTokens: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (const h of headingLines) {
		const t = estimateTokens(h);
		if (kept.length > 0 && used + t > capTokens) break;
		if (t > capTokens) continue;
		kept.push(h);
		used += t;
	}
	return kept;
}

export function trimToTokenBudget(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return "";
	if (estimateTokens(text) <= maxTokens) return text;
	let chars = Math.min(text.length, Math.max(1, maxTokens * 4));
	let loop: string | null = null;
	for (let attempt = 0; attempt < 12; attempt++) {
		const candidate = truncateToBudget(text.slice(0, chars), maxTokens);
		const used = estimateTokens(candidate);
		if (used <= maxTokens) {
			loop = candidate;
			break;
		}
		// Shrink proportionally to the measured overshoot, minus a small margin
		// so progress cannot stall when the boundary search rounds back up.
		chars = Math.max(1, Math.floor((chars * maxTokens) / used) - 16);
	}
	// Terminal fallback: a slice no longer than the token budget can never
	// exceed it, since every remaining character is at least a fraction of a token.
	const plain = text.slice(0, maxTokens).replace(/\s+$/, "");
	if (loop === null) return plain;
	// The fallback is also a CANDIDATE, and comparing the two by the document's own
	// measure is what fixes #189 item 3 without touching the shape that four #190/#182
	// guards pin. The seed above (`maxTokens * 4`) and the absolute `- 16` shrink margin
	// are both Latin-shaped: measured, Latin runs 4.75 char/token and CJK 1.00, so for a
	// CJK document the seed overshoots ~4x and the margin then computes `20 - 16 = 4` at
	// budget 20 — the loop's first fitting answer was ONE character (1 token) while 19
	// tokens of the budget sat unused, and the function returned it immediately.
	//
	// This is a quality comparison between two candidates that both fit, NOT a search for
	// the largest fitting slice. Two earlier designs were refused on evidence and are
	// recorded at the floor pass above: a binary search over slice length, and a
	// proportional shrink margin. Both broke four guards, because a longer slice can be a
	// WORSE answer — `"```\ncode \n```\n"` drops the prose a shorter slice keeps — so
	// length is not the objective and monotonicity in length cannot be assumed.
	//
	// What this does to Latin text was MEASURED, not assumed. A first draft of this comment
	// claimed Latin output was "unchanged by construction"; the differential against the
	// pre-change code said otherwise — 58 of 1680 cases (7 Latin/fence/table shapes x
	// budgets 1..120, both `applyTokenBudget` and `trimToTokenBudget`) do differ, because a
	// different leaf answer changes which candidate the floor pass selects downstream. So
	// the honest claim is the one that was checked: **0 ceiling violations, 0 newly unclosed
	// fences, and 0 cases that lost all document prose** — the 19 cases that carry fewer
	// tokens shed notice framing, not document words. That is the bar this comparison has
	// to clear, and it is a narrower claim than "unchanged", which is why it is the one
	// pinned by the sweep rather than the one asserted here.
	// Closure is required, not assumed: a raw character slice can stop inside a fence, and
	// an unclosed answer is the #190 defect, so a fallback that would open a fence is
	// refused even when it carries more text.
	if (findUnclosedFence(plain) === null && estimateTokens(plain) > estimateTokens(loop)) {
		return plain;
	}
	return loop;
}

/**
 * Truncate text to fit within a token budget by cutting at sentence boundaries.
 */
function truncateToBudget(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;

	// Rough character budget
	const charBudget = maxTokens * 4;

	// A leading heading block that ALONE exceeds the budget is structure, not
	// content: cutting it returned a heading fragment and no page prose at all, which
	// is the same failure the content floor exists to prevent. Start from the prose
	// instead (issue #169, CodeRabbit thread src/prune-markdown.ts:666).
	const firstBlockEnd = text.search(/\n[ \t]*\n/);
	if (
		firstBlockEnd > 0 &&
		/^[ \t]*#{1,6}[ \t]/.test(text) &&
		estimateTokens(text.slice(0, firstBlockEnd)) >= maxTokens
	) {
		const prose = text.slice(firstBlockEnd).replace(/^[\s\S]*?\n[ \t]*\n/, "");
		if (prose.trim() !== "") {
			return closeFencesWithin(
				`${prose.slice(0, Math.max(charBudget, 100))}\n\n[...content truncated]`,
				maxTokens,
				false,
			);
		}
	}

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

	// Prefer a sentence boundary, then a paragraph boundary, then the raw cut.
	let cutPoint = charBudget;
	if (lastPeriod > charBudget * 0.5) {
		cutPoint = lastPeriod + 1;
	} else if (lastParagraph > charBudget * 0.5) {
		cutPoint = lastParagraph;
	}

	return closeFencesWithin(
		`${text.slice(0, Math.max(cutPoint, 100))}\n\n[...content truncated]`,
		maxTokens,
		false,
	);
}
