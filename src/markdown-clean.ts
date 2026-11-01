/**
 * Markdown-aware whitespace normalisation.
 *
 * `cleanText` (src/http-text.ts) trims every line and drops blank ones. That is
 * the right thing for prose and destructive for two markdown constructs:
 *
 *   - fenced code blocks, where leading whitespace IS the program. Python, YAML,
 *     TOML and makefiles change meaning when indentation is removed, and a blank
 *     line inside a YAML mapping changes its grouping.
 *   - nested list items, where the indent is the parent/child relationship. In
 *     CommonMark a single leading space before `- ` is a lazy continuation of the
 *     previous item, not a child, so even preserving "one space" is wrong.
 *
 * Both were happening in production: Defuddle's own output is correct (verified
 * directly against the library — it emits `\t- child` and keeps the fence body
 * verbatim) and our post-processing then destroyed it. Found while building the
 * #162 markdown-shape corpus, pinned by tests/markdown-shape.test.mjs.
 *
 * This is a leaf module on purpose: no imports, so `content.ts`, the static
 * fetch API and anything else can share one rule without a cycle.
 */

/** Opening/closing line of a fenced code block (``` or ~~~, any length). */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

/** A line that starts a list item, after its leading indent is removed. */
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/;

/**
 * Normalise whitespace in markdown WITHOUT flattening structure.
 *
 * Inside a fence the text is returned verbatim (apart from `\r` removal, which
 * the caller already did upstream and is repeated here so the function is safe
 * standalone): a code block's bytes are its content.
 *
 * Outside a fence: internal whitespace runs collapse to one space, trailing
 * whitespace is dropped, and blank lines are removed to keep output compact.
 * List items keep their indentation — with tabs expanded to two columns, because
 * Defuddle indents nested items with a tab and a single column is not nesting.
 */
export function cleanMarkdown(value: string): string {
	const withoutCR = value.replace(/\r/g, "");
	const out: string[] = [];
	let openFence: string | null = null;

	for (const line of withoutCR.split("\n")) {
		const fenceMatch = FENCE_LINE.exec(line);

		if (openFence) {
			// Inside a fence: verbatim. Close only on a line that starts with the
			// same marker character, so a ``` block containing ~~~ stays open.
			out.push(line);
			if (fenceMatch && fenceMatch[1][0] === openFence[0]) openFence = null;
			continue;
		}

		if (fenceMatch) {
			openFence = fenceMatch[1];
			out.push(line);
			continue;
		}

		const indentMatch = /^[ \t]*/.exec(line);
		const indent = indentMatch ? indentMatch[0] : "";
		const body = line.slice(indent.length).replace(/[^\S\n]+/g, " ").replace(/\s+$/, "");
		if (!body) continue; // blank line outside a fence
		out.push(LIST_ITEM.test(body) ? indent.replace(/\t/g, "  ") + body : body);
	}

	return out.join("\n");
}
