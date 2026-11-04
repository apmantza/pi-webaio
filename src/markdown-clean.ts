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
 * A line that is NOTHING BUT one JSX/MDX component tag — opening, closing, or
 * self-closing, with or without attributes.
 *
 * The property is what makes this safe without an allowlist. MDX component tags leak out
 * of `.mdx` sources as their own lines (`<Note>` … `</Note>`), carrying no prose at all;
 * a page that DOCUMENTS a component writes it inline in a sentence ("wrap the deferred
 * subtree in `<Suspense>`"), so that line has other text and can never match. The
 * attribute part excludes `<` and `>`, which is what keeps `<Note>child</Note>` — a tag
 * with content — from matching, and that is the difference between dropping scaffolding
 * and dropping a sentence.
 *
 * Uppercase-initial only, by JSX convention. Lowercase HTML (`<p>`, `<abbr>`) is the
 * HTML-to-markdown stage's business and is deliberately not claimed here.
 */
const LONE_COMPONENT_TAG = /^<\/?[A-Z][A-Za-z0-9_.]*(\s[^<>\n]*)?\s*\/?>$/;

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
			// Inside a fence: verbatim. A closing fence must use the same marker
			// character, be at least as long as the opener, and have nothing after
			// the marker — so a 4-backtick fence holding a 3-backtick sample stays
			// open, and a line like "```js" written as content is not a terminator.
			out.push(line);
			if (
				fenceMatch &&
				fenceMatch[1][0] === openFence[0] &&
				fenceMatch[1].length >= openFence.length &&
				/^[ \t]*$/.test(line.slice(fenceMatch[0].length))
			) {
				openFence = null;
			}
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
		// #212: MDX scaffolding. Reached only OUTSIDE a fence and only for a line that is
		// a single bare tag, so the JSX inside a code sample and the prose that names a
		// component are both untouched — the two failure directions measured on the real
		// react.dev page were 13 fenced JSX lines versus 9 prose leaks.
		if (LONE_COMPONENT_TAG.test(body)) continue;
		out.push(LIST_ITEM.test(body) ? indent.replace(/\t/g, "  ") + body : body);
	}

	return out.join("\n");
}
