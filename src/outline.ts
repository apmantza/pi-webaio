/**
 * Heading-outline extraction for markdown content (UX1 / UX4).
 *
 * The consumer of aio-webfetch is a coding AGENT, so the goal is "see the
 * shape before committing tokens": parse a page's ATX headings into a
 * document-ordered heading list with per-section word counts, letting the
 * agent decide whether (and which section) a page is worth reading in full —
 * the web equivalent of pi's `module_report`.
 *
 * Everything here is pure and side-effect free so it can be unit-tested
 * offline (tests/ux-webfetch-output.test.mjs).
 */

/** One heading in the document-ordered outline. */
export interface OutlineHeading {
	/** ATX level, 1..6. */
	level: number;
	/** Heading text (inline markdown preserved, surrounding hashes trimmed). */
	text: string;
	/** Words in the body under this heading, up to the next heading. */
	words?: number;
}

/** The result of {@link extractOutline}. */
export interface Outline {
	/** Total words in the document (frontmatter + wrapper markers excluded). */
	totalWords: number;
	/** Headings in document order; levels encode the tree structure. */
	headings: OutlineHeading[];
}

/** A section: a heading plus the body that follows it (up to the next heading). */
export interface Section extends OutlineHeading {
	/** Raw body text under the heading (heading line excluded), trimmed. */
	body: string;
	/** 0-based line index of the heading within the cleaned document. */
	start: number;
	/** 0-based line index just past the section's last body line. */
	end: number;
}

// Leading YAML frontmatter block (`---\n…\n---\n`). The saved markdown puts
// this before the [UNTRUSTED WEB CONTENT] markers.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

// CommonMark ATX heading: up to 3 leading spaces, 1-6 hashes, required
// whitespace, then the text. `#heading` (no space) is intentionally NOT a
// heading; 4+ leading spaces are indented code, also not a heading.
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;

// A fenced-code delimiter (``` or ~~~), up to 3 leading spaces.
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

// The prompt-injection safety markers added by content.ts. They are NOT
// content, so they are excluded from word counts and heading detection here.
// (Callers that RETURN web-derived text re-wrap it in fresh markers.)
const MARKER_LINE_RE = /^\[UNTRUSTED WEB CONTENT (START|END)\]\s*$/;

/** Count whitespace-separated tokens. Empty/blank → 0. */
export function countWords(text: string): number {
	const t = text.trim();
	if (!t) return 0;
	return t.split(/\s+/).length;
}

/**
 * Count content words in a cleaned document, excluding ATX heading marker
 * hashes (so `## API` contributes one word — "API" — not two). Used for the
 * totalWords size signal; heading text and code still count.
 */
function countContentWords(clean: string): number {
	return countWords(clean.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ""));
}

/**
 * Strip the leading YAML frontmatter block and the [UNTRUSTED WEB CONTENT]
 * marker lines so they don't pollute heading detection or word counts.
 * Leaves all real content (including fenced code) intact.
 */
export function stripWrapper(markdown: string): string {
	let s = markdown.replace(FRONTMATTER_RE, "");
	s = s
		.split("\n")
		.filter((line) => !MARKER_LINE_RE.test(line.trim()))
		.join("\n");
	return s;
}

/** Trim an optional ATX closing hash sequence (`## Heading ##` → `Heading`). */
function cleanHeadingText(raw: string): string {
	return raw.replace(/[ \t]+#+[ \t]*$/, "").trim();
}

/**
 * Split cleaned markdown into sections. A section starts at a heading and
 * runs until the next heading (of ANY level) or end-of-document. Headings
 * inside fenced code blocks are ignored. Words before the first heading are
 * not attributed to any section (but still count toward totalWords).
 */
function splitSectionsClean(clean: string): Section[] {
	const lines = clean.split("\n");
	const sections: Section[] = [];
	const bodyLines: string[] = [];
	let current: Section | null = null;
	let inFence = false;
	let fenceChar = "";

	const flush = (): void => {
		if (current) {
			current.body = bodyLines.join("\n").trim();
			current.words = countWords(current.body);
			sections.push(current);
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = line.match(FENCE_RE);
		if (fence) {
			const ch = fence[1]![0];
			if (!inFence) {
				inFence = true;
				fenceChar = ch;
			} else if (ch === fenceChar) {
				inFence = false;
				fenceChar = "";
			}
			if (current) bodyLines.push(line);
			continue;
		}
		if (!inFence) {
			const hm = line.match(HEADING_RE);
			if (hm) {
				flush();
				bodyLines.length = 0;
				current = {
					level: hm[1]!.length,
					text: cleanHeadingText(hm[2] ?? ""),
					body: "",
					words: 0,
					start: i,
					end: i,
				};
				continue;
			}
		}
		if (current) bodyLines.push(line);
	}
	flush();

	// Fill in `end` offsets now that all start positions are known.
	for (let i = 0; i < sections.length; i++) {
		sections[i]!.end =
			i + 1 < sections.length ? sections[i + 1]!.start : lines.length;
	}
	return sections;
}

/**
 * Split markdown into sections (strips frontmatter + wrapper markers first).
 * Exposed for callers (e.g. the frugal preview) that need section bodies.
 */
export function splitSections(markdown: string): Section[] {
	return splitSectionsClean(stripWrapper(markdown));
}

/**
 * Parse ATX headings into a document-ordered outline with per-section word
 * counts and a total word count. A document with no headings yields an empty
 * `headings` array (totalWords still reflects the body size).
 */
export function extractOutline(markdown: string): Outline {
	const clean = stripWrapper(markdown);
	const sections = splitSectionsClean(clean);
	return {
		totalWords: countContentWords(clean),
		headings: sections.map((s) => ({
			level: s.level,
			text: s.text,
			words: s.words,
		})),
	};
}

/**
 * Render an outline as compact agent-facing text (~1 line per heading).
 * Level is conveyed by indentation; per-section word counts are parenthesized.
 *
 * Example:
 *   Outline: 1234 words, 3 sections
 *   - Introduction (120)
 *     - Background (45)
 *   - API (300)
 */
export function renderOutlineText(outline: Outline): string {
	const { totalWords, headings } = outline;
	const lines: string[] = [
		`Outline: ${totalWords} words${
			headings.length
				? `, ${headings.length} section${headings.length === 1 ? "" : "s"}`
				: ""
		}`,
	];
	if (headings.length === 0) {
		lines.push("- (no headings — flat document)");
	} else {
		for (const h of headings) {
			const indent = "  ".repeat(Math.max(0, h.level - 1));
			const wc = h.words !== undefined ? ` (${h.words})` : "";
			lines.push(`${indent}- ${h.text}${wc}`);
		}
	}
	return lines.join("\n");
}
