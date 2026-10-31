/**
 * One parser for the two things every layer of this project prepends to a page
 * body: the leading YAML frontmatter block and the `[UNTRUSTED WEB CONTENT
 * START]/[END]` safety-marker wrapper.
 *
 * Before this module existed, four independent copies of the frontmatter regex
 * disagreed with each other (issue #165 F21):
 *   - `outline.ts`        — `/^---\r?\n[\s\S]*?\r?\n---\r?\n?/`   (CRLF-tolerant)
 *   - `tools/webfetch.ts` — `/^---\n[\s\S]*?\n---\n/`             (LF only)
 *   - `session-store.ts`  — `raw.startsWith("---\n")` + `\n---`   (LF only, quoted `url:` only)
 *   - `webquery-index.ts` — LF only, quotes optional
 * and two more consumers (`prune-markdown.ts`, `chunker.ts`) had no notion of
 * either prefix at all. The consequences were concrete, not hypothetical:
 *   - `prune`/`budgetTokens` emitted an *unterminated* `---` block, or moved the
 *     frontmatter to the end of the document (F8), and the same corruption
 *     surfaced through `aio-webcontent` (F10).
 *   - RAG chunks began with frontmatter plus the safety markers instead of page
 *     content (F19), and `aio-webresearch` quoted the markers in evidence (F17).
 *   - `session-store`'s URL reader — the one `RequestQueue.resume` uses to mark
 *     a URL completed — returned nothing for a CRLF file or an unquoted `url:`,
 *     producing the same perpetual re-fetch loop as the path-collision bug (F16)
 *     from a second direction.
 *
 * This module is deliberately dependency-free so any layer can use it without
 * an import cycle. CRLF tolerance and unquoted scalar values are the contract.
 */

/** Leading YAML frontmatter block, LF or CRLF, with or without a trailing newline. */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** A `[UNTRUSTED WEB CONTENT START]` / `[UNTRUSTED WEB CONTENT END]` line. */
export const MARKER_LINE_RE = /^\s*\[UNTRUSTED WEB CONTENT (?:START|END)\]\s*$/;

export interface MarkdownPrefix {
	/** The verbatim `---\n…\n---\n` block, or "" when the document has none. */
	frontmatter: string;
	/** The document with the frontmatter block removed (markers still present). */
	body: string;
}

/**
 * Split the leading frontmatter block from the document body. A `---` line with
 * no closing fence is NOT frontmatter (it is a thematic break) and is left in
 * the body, so a truncated block can never swallow the document.
 */
export function splitFrontmatter(markdown: string): MarkdownPrefix {
	if (!markdown.startsWith("---")) return { frontmatter: "", body: markdown };
	const match = markdown.match(FRONTMATTER_RE);
	if (!match) return { frontmatter: "", body: markdown };
	return { frontmatter: match[0], body: markdown.slice(match[0].length) };
}

/**
 * Re-attach a frontmatter block that `splitFrontmatter` removed.
 *
 * Plain concatenation, deliberately: `splitFrontmatter` returns the body
 * verbatim (it slices at the exact end of the match), so `frontmatter + body`
 * is byte-for-byte the original document. Normalising the separator here looked
 * tidy and was wrong — it dropped the blank line that separates the block from
 * the body, so a prune/budget round-trip rewrote the header it was supposed to
 * preserve.
 */
export function withFrontmatter(frontmatter: string, body: string): string {
	return frontmatter + body;
}

/** Drop the frontmatter block and every safety-marker line. */
export function stripWrapper(markdown: string): string {
	let s = splitFrontmatter(markdown).body;
	s = s
		.split("\n")
		.filter((line) => !MARKER_LINE_RE.test(line.trim()))
		.join("\n");
	return s;
}

/**
 * Read the `url:` scalar out of a frontmatter block: CRLF-tolerant, quoted or
 * unquoted, with inline comments and surrounding whitespace ignored. This is the
 * reader `RequestQueue.resume` relies on to decide that a pulled page is
 * already complete, so a spelling it misses is a page re-fetched forever.
 * Returns null when the document has no frontmatter or no `url:` key.
 */
export function extractFrontmatterUrl(markdown: string): string | null {
	const { frontmatter } = splitFrontmatter(markdown);
	if (!frontmatter) return null;
	for (const rawLine of frontmatter.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("url:")) continue;
		let value = line.slice("url:".length).trim();
		// Strip a trailing YAML comment only when it is not part of the value
		// (a URL never contains " #").
		const comment = value.search(/\s+#/);
		if (comment > 0) value = value.slice(0, comment).trim();
		// Unquote a scalar written as "value" or 'value'.
		value = value.replace(/^"([^"]*)"$/g, "$1").replace(/^'([^']*)'$/g, "$1");
		return value.length > 0 ? value : null;
	}
	return null;
}
