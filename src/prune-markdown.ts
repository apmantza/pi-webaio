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
 */
function prosePrefixSource(body: string): string {
	return body
		.replace(/^\s+/, "")
		.replace(/^(?:[ \t]*#{1,6}[ \t].*(?:\n|$))+/, "");
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
function carriesPageProse(portion: string, body: string): boolean {
	if (prosePrefixSource(body).trim() === "") return true; // nothing to carry
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

export function applyTokenBudget(
	content: string,
	budget: number,
	query?: string,
	url?: string,
): string {
	// The caller's number is the contract. This used to floor at 100, which
	// silently overrode any smaller budget: `budgetTokens: 50` was answered with
	// ~100 tokens of content, and it also masked the footer-vs-budget case that
	// `shrinkNoticeToRoom` now handles. A budget of 1 still yields a non-empty
	// budget rather than collapsing to "no budget".
	const effectiveBudget = Math.max(1, Math.floor(budget));
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
	let footerText = `\n\n---\n_content fits ${effectiveBudget}-token budget; full content cached — ${retrieveHint}._`;
	if (contentWasCut) {
		// A partial prefix is a cut too, so it must not be described as fitting.
		const cutNote =
			omitted > 0
				? `${omitted} section${omitted === 1 ? "" : "s"} omitted`
				: "part of the remaining section kept";
			footerText = `\n\n---\n_truncated to fit ${effectiveBudget}-token budget: ${cutNote}; full content cached — ${retrieveHint}._`;
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
		const prose = trimToTokenBudgetWithClosedFence(
			prosePrefixSource(body),
			room,
		);
		// The swap candidate is produced FROM the document by the trimmer, so it
		// needs no detector — only that the ceiling actually left room.
		if (prose.trim() !== "") result = prose;
	}

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
function shrinkNoticeToRoom(footer: string, room: number): string {
	if (estimateTokens(footer) <= room) return footer;
	// 1. Drop the omitted-sections TOC, keep the count line.
	const noToc = footer.replace(/\n\n\*Omitted sections:\*[\s\S]*$/, "");
	if (estimateTokens(noToc) <= room) return noToc;
	// 2–4. Fixed notices, longest first.
	for (const notice of [
		"_truncated to fit the token budget; full content cached._",
		"_truncated; full content cached._",
		"_truncated._",
	]) {
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
 * Find a fence run that is opened but never closed, returning its marker and the
 * character offset of its opening line.
 *
 * A fence run is three or more backticks or tildes at the start of a line; the
 * opening run may carry an info string (```js), a closing run may not, and it must
 * use the same character and be at least as long as the run it closes.
 */
function findUnclosedFence(
	text: string,
): { marker: string; startIndex: number } | null {
	const lines = text.split("\n");
	let open: { marker: string; startIndex: number } | null = null;
	let cursor = 0;
	for (const line of lines) {
		if (open) {
			const ch = open.marker[0];
			const close = new RegExp(
				`^[ \\t]*${ch === "`" ? "`" : "~"}{${open.marker.length},}[ \\t]*$`,
			);
			if (close.test(line)) open = null;
		} else {
			const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
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
	return closeFencesWithin(trimToTokenBudget(text, maxTokens), maxTokens, true);
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
	for (let attempt = 0; attempt < 12; attempt++) {
		const candidate = truncateToBudget(text.slice(0, chars), maxTokens);
		const used = estimateTokens(candidate);
		if (used <= maxTokens) return candidate;
		// Shrink proportionally to the measured overshoot, minus a small margin
		// so progress cannot stall when the boundary search rounds back up.
		chars = Math.max(1, Math.floor((chars * maxTokens) / used) - 16);
	}
	// Terminal fallback: a slice no longer than the token budget can never
	// exceed it, since every remaining character is at least a fraction of a token.
	return text.slice(0, maxTokens).replace(/\s+$/, "");
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
