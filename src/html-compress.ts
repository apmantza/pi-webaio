// ─── HTML attribute stripping for cleaner extraction ─────────────────
// Inspired by Retio-pagemap's compress_html() — removes non-semantic
// attributes (class, id, data-*, style, event handlers, etc.) before
// feeding HTML to Readability / Defuddle.  This reduces token bloat
// from HTML cruft while preserving semantic attributes.

/** Attributes to KEEP during compression (semantic / machine-readable). */
const KEEP_ATTRS = new Set([
	"itemprop",
	"itemtype",
	"itemscope",
	"role",
	"aria-label",
	"aria-labelledby",
	"href",
	"src",
	"alt",
	"title",
	"datetime",
	"content",
	"property",
	"type",
	"name",
	"value",
]);

/**
 * Strip noise attributes from an HTML string using regex.
 * Removes: class, id, data-*, style, event handlers, and many ARIA
 * attributes while preserving semantic attributes like href, src, alt,
 * itemprop, role, etc.
 *
 * This is a lossy operation for visual rendering but lossless for
 * content extraction — the text and structure remain intact.
 */
function stripNoiseAttributes(html: string): string {
	// Remove attributes we don't want, keeping the ones in KEEP_ATTRS.
	// Pattern: attrName="value" or attrName='value' or attrName=value
	const removePattern = new RegExp(
		`\\s+(?!(?:${[...KEEP_ATTRS].join("|")})\\b)` +
			`[a-zA-Z][\\w-]*` +
			`\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
		"gi",
	);
	return html.replace(removePattern, "");
}

/**
 * Remove empty HTML elements — tags with no text content between them.
 * Runs multiple passes to catch nested empties (inner-first removal).
 */
function removeEmptyElements(html: string, passes = 3): string {
	const emptyTagRe =
		/<(div|span|p|section|article|aside|figure|figcaption|details|summary|b|i|em|strong|small|sup|sub|a|abbr|cite|code|mark|u|s)\b[^>]*>\s*<\/\1>/gi;

	let result = html;
	for (let i = 0; i < passes; i++) {
		const prev = result;
		result = result.replace(emptyTagRe, "");
		if (result === prev) break;
	}
	return result;
}

/**
 * Full HTML compression pass: strip noise attributes + remove empties.
 * Safe to call before Readability/Defuddle — only removes attributes,
 * never content.
 */
export function compressHtml(html: string): string {
	let result = stripNoiseAttributes(html);
	result = removeEmptyElements(result);
	return result;
}
