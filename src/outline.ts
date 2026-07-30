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

// ─── Conservative heading fallback (Fix 3) ──────────────────────────
// Some pages reach the agent with NO ATX headings even though they have
// clear sections. The reproduced case is expressjs.com's guide: the
// extraction pipeline prefers Readability, whose `article.textContent` is
// plain prose, so section titles ("Route methods", "Route paths", …)
// survive only as short plain-text lines and `extractOutline` reports
// "(no headings — flat document)". Defuddle itself emits proper ATX
// headings — it simply never runs when Readability wins.
//
// Rather than reorder the extraction pipeline (a risky change for every
// well-formed page), we add a CONSERVATIVE fallback here that activates
// ONLY when a document has zero ATX headings: detect short, unpunctuated,
// heading-like lines and treat them as level-2 headings. It must never
// fire on ordinary prose paragraphs and never when real `#` headings exist.

/** Max length for a line to be considered heading-like. */
const FALLBACK_HEADING_MAX_LEN = 60;

/**
 * Is `line` a plausible section heading in a heading-less document?
 * Conservative on purpose — every guard exists to keep ordinary prose
 * paragraphs (long, sentence-punctuated) from being misread as headings.
 */
function isFallbackHeadingLine(line: string, nextNonEmpty: string): boolean {
	// Indented (>= 4 spaces) lines are code, not headings.
	if (/^\s{4,}/.test(line)) return false;
	const t = line.trim();
	if (!t) return false;
	if (t.length > FALLBACK_HEADING_MAX_LEN) return false;
	// Must contain a real letter (rules out rules, symbols, pure numbers).
	if (!/[a-zA-Z]/.test(t)) return false;
	// Terminal punctuation → a sentence, not a heading.
	if (/[.!?…,;:]$/.test(t)) return false;
	// Commas/semicolons mid-line → a clause, not a heading.
	if (/[,;]/.test(t)) return false;
	// List items, blockquotes, table rows, fences, bare URLs are not headings.
	if (/^([-*+]|\d+\.)\s/.test(t)) return false;
	if (/^>/.test(t) || /^\|/.test(t)) return false;
	if (/^(```|~~~)/.test(t)) return false;
	if (/^https?:\/\//.test(t)) return false;
	// Headings read like titles: start with a capital letter, or carry a
	// code-identifier signal (`.`, `()`, `_`, backtick) for headings such as
	// "app.route()" / "express.Router". This is what keeps an all-lowercase
	// prose fragment ("just some plain prose") from matching.
	const looksLikeTitle =
		/^[A-Z]/.test(t) || /[`()._]/.test(t);
	if (!looksLikeTitle) return false;
	// Must be followed by real content: a prose line (long, or a terminated
	// sentence). A short line followed by nothing/another short line is not
	// enough evidence.
	const nt = nextNonEmpty.trim();
	if (!nt) return false;
	return nt.length > FALLBACK_HEADING_MAX_LEN || /[.!?]$/.test(nt);
}

/**
 * Detect heading-like lines in a document that has ZERO ATX headings and
 * synthesize level-2 outline entries for them (with per-section word
 * counts). Fence-aware: lines inside ``` / ~~~ blocks are never treated as
 * headings. Returns [] when nothing qualifies, so the caller's empty-outline
 * behavior is preserved for genuinely flat prose.
 */
function detectFallbackHeadings(clean: string): OutlineHeading[] {
	const lines = clean.split("\n");
	const headingIdx: number[] = [];
	let inFence = false;
	let fenceChar = "";

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
			continue;
		}
		if (inFence) continue;
		// Next non-empty line (a heading is always followed by its body).
		let next = "";
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j]!.trim()) {
				next = lines[j]!;
				break;
			}
		}
		if (isFallbackHeadingLine(line, next)) headingIdx.push(i);
	}
	if (headingIdx.length === 0) return [];

	const headings: OutlineHeading[] = [];
	for (let k = 0; k < headingIdx.length; k++) {
		const start = headingIdx[k]!;
		const end = k + 1 < headingIdx.length ? headingIdx[k + 1]! : lines.length;
		const body = lines.slice(start + 1, end).join("\n").trim();
		headings.push({
			level: 2,
			text: lines[start]!.trim(),
			words: countWords(body),
		});
	}
	return headings;
}

/**
 * Parse ATX headings into a document-ordered outline with per-section word
 * counts and a total word count. A document with no ATX headings falls back
 * to conservative heading detection (see {@link detectFallbackHeadings}); a
 * genuinely flat prose document still yields an empty `headings` array.
 * totalWords always reflects the body size.
 */
export function extractOutline(markdown: string): Outline {
	const clean = stripWrapper(markdown);
	const sections = splitSectionsClean(clean);
	const headings =
		sections.length > 0
			? sections.map((s) => ({
					level: s.level,
					text: s.text,
					words: s.words,
				}))
			: detectFallbackHeadings(clean);
	return {
		totalWords: countContentWords(clean),
		headings,
	};
}

// ─── Frugal-section selection (Fix 1) ───────────────────────────────
// The frugal preview showcases ONE section. Picking the raw largest by word
// count is naive: on Wikipedia's Express.js page that was "External links"
// (mostly unstripped CSS) over genuinely useful Summary/History prose. Skip
// low-value tail sections and non-prose (CSS/link-heavy) bodies, then pick
// the largest remaining content section (earlier position breaks ties).

/** Headings that mark low-value tail/boilerplate sections (case-insensitive). */
const LOW_VALUE_HEADINGS = new Set([
	"references",
	"external links",
	"see also",
	"categories",
	"notes",
	"bibliography",
	"further reading",
	"footer",
	"navigation",
	"menu",
]);

/** Normalize a heading for low-value comparison (trim, lower, strip trailing punct). */
function normalizeHeading(text: string): string {
	return text.trim().toLowerCase().replace(/[\s.:]+$/, "").replace(/\s+/g, " ");
}

/** Is this section's heading a known low-value tail/boilerplate section? */
export function isLowValueHeading(text: string): boolean {
	return LOW_VALUE_HEADINGS.has(normalizeHeading(text));
}

/**
 * Does a whitespace token look like leaked CSS or a bare URL rather than
 * prose? Used to detect sections that are mostly non-prose (e.g. Wikipedia's
 * CSS-filled "External links"). Individual matches are deliberately loose —
 * the >50% aggregate threshold in {@link isMostlyNonProse} is what keeps this
 * from false-positiving on an occasional "Note:" in real prose.
 */
function isCruftToken(token: string): boolean {
	if (/^https?:\/\//i.test(token) || /^www\./i.test(token)) return true; // bare URL
	if (/[{};]/.test(token)) return true; // CSS block / declaration separators
	if (/^[.#][a-zA-Z_]/.test(token)) return true; // .class / #id selector
	// A CSS declaration with a CSS-ish value (margin:0, color:#fff, width:50%).
	if (
		/^[a-z-]+:[a-z0-9#.!%]/i.test(token) &&
		/\d|%|px|em|rem|#[0-9a-f]/i.test(token)
	) {
		return true;
	}
	return false;
}

/**
 * Is this section body mostly non-prose (>~50% of tokens look like CSS
 * selectors/declarations or bare URLs)? Empty bodies are treated as prose
 * (not skipped) so an empty-but-legit section is never penalized here.
 */
export function isMostlyNonProse(body: string): boolean {
	const tokens = body.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return false;
	const cruft = tokens.reduce((n, t) => n + (isCruftToken(t) ? 1 : 0), 0);
	return cruft / tokens.length > 0.5;
}

/**
 * Pick the section to showcase in the frugal preview. Skips low-value
 * tail sections (References, External links, …) and mostly-non-prose
 * (CSS/link-heavy) bodies, then returns the largest remaining section by
 * word count, with EARLIER document position as the tiebreak. If EVERY
 * section is low-value, falls back to the first section. Returns null only
 * when there are no sections at all.
 */
export function selectFrugalSection(sections: Section[]): Section | null {
	if (sections.length === 0) return null;
	const candidates = sections.filter(
		(s) => !isLowValueHeading(s.text) && !isMostlyNonProse(s.body),
	);
	// All low-value → fall back to the first section (never null when non-empty).
	if (candidates.length === 0) return sections[0]!;
	// Largest by word count; strict `>` keeps the earliest on ties.
	let best = candidates[0]!;
	for (const s of candidates) {
		if ((s.words ?? 0) > (best.words ?? 0)) best = s;
	}
	return best;
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
