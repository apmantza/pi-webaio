// ─── Wikipedia / MediaWiki extractor ───────────────────────────────
// Uses the MediaWiki REST API (action=parse + action=query).
// No API key required. Works for all language editions.

import type { VerticalResult } from "./types.ts";

/**
 * Match any Wikipedia article URL across all language editions.
 */
export function matchesWikipedia(url: string): boolean {
	return /^https?:\/\/([a-z]+)\.wikipedia\.org\/wiki\/[^?#]+/i.test(url);
}

/**
 * Extract the language code and page title from a Wikipedia URL.
 */
function parseWikipediaUrl(
	url: string,
): { lang: string; title: string } | null {
	const m = url.match(/^https?:\/\/([a-z]+)\.wikipedia\.org\/wiki\/([^?#]+)/i);
	if (!m) return null;
	const title = decodeURIComponent(m[2]!);
	// Skip special pages
	if (
		title.startsWith("Special:") ||
		title.startsWith("File:") ||
		title.startsWith("Category:") ||
		title.startsWith("Help:") ||
		title.startsWith("Template:") ||
		title.startsWith("Talk:") ||
		title.startsWith("Portal:") ||
		title.startsWith("Wikipedia:")
	) {
		return null;
	}
	return { lang: m[1]!, title };
}

/**
 * Extract Wikipedia article content and metadata via the MediaWiki API.
 */
export async function extractWikipedia(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const parsed = parseWikipediaUrl(url);
	if (!parsed) return null;
	const { lang, title } = parsed;
	const apiBase = `https://${lang}.wikipedia.org/w/api.php`;

	// ── 1. Page info (extract + metadata) ────────────────────────────
	const infoUrl = `${apiBase}?action=query&prop=extracts|pageimages|info&exintro=0&explaintext=1&exsentences=5&pithumbsize=300&inprop=url|displaytitle&titles=${encodeURIComponent(title)}&format=json&origin=*`;
	const infoData = await fetchJson(infoUrl);

	let pageId = 0;
	let pageTitle = title;
	let displayTitle = title;
	let extract = "";
	let pageUrl = "";
	let lastRevId = 0;
	let thumbnail: string | undefined;
	let pageLang = lang;

	if (infoData && typeof infoData === "object") {
		const query = (infoData as Record<string, unknown>).query as
			| Record<string, unknown>
			| undefined;
		if (query?.pages && typeof query.pages === "object") {
			const pages = query.pages as Record<string, Record<string, unknown>>;
			for (const [, page] of Object.entries(pages)) {
				if (page.missing) continue;
				pageId = Number(page.pageid || 0);
				pageTitle = String(page.title || title);
				displayTitle = String(page.displaytitle || pageTitle);
				extract = String(page.extract || "");
				pageUrl = String(page.fullurl || "");
				pageLang = String(page.pagelanguage || lang);
				lastRevId = Number(page.lastrevid || 0);
				if (
					page.thumbnail &&
					typeof page.thumbnail === "object" &&
					(page.thumbnail as Record<string, unknown>).source
				) {
					thumbnail = String((page.thumbnail as Record<string, unknown>).source);
				}
				break;
			}
		}
	}

	if (!pageId) return null;

	// ── 2. Full page text (action=parse) ─────────────────────────────
	const parseUrl = `${apiBase}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text|sections|categories&format=json&origin=*`;
	const parseData = await fetchJson(parseUrl);

	let pageText = "";
	const sections: { line: string; index: string; number: string }[] = [];
	const categories: string[] = [];

	if (parseData && typeof parseData === "object") {
		const pd = parseData as Record<string, unknown>;

		if (pd.parse && typeof pd.parse === "object") {
			const parse = pd.parse as Record<string, unknown>;
			// MediaWiki's action=parse returns `text` as an object of the form
			// { "*": "<html>" } in JSON format, not a plain string. String()-ing
			// the object directly yields "[object Object]" — unwrap the "*" key.
			const textNode = parse.text;
			if (textNode && typeof textNode === "object") {
				pageText = String((textNode as Record<string, unknown>)["*"] || "");
			} else {
				pageText = String(textNode || "");
			}

			// Sections
			if (Array.isArray(parse.sections)) {
				for (const s of parse.sections as Record<string, unknown>[]) {
					sections.push({
						line: String(s.line || ""),
						index: String(s.index || ""),
						number: String(s.number || ""),
					});
				}
			}

			// Categories
			if (Array.isArray(parse.categories)) {
				for (const c of parse.categories as Record<string, unknown>[]) {
					const catName = String(c["*"] || "");
					if (catName) categories.push(catName);
				}
			}
		}
	}

	// ── 3. Build markdown ───────────────────────────────────────────
	let md = `# ${displayTitle}\n\n`;

	// Quick stats
	md += `- **Language:** ${pageLang}\n`;
	if (lastRevId) md += `- **Last Revision:** ${lastRevId}\n`;

	if (extract) {
		md += `\n## Summary\n\n${extract}\n`;
	}

	if (thumbnail) {
		md += `\n![Lead image](${thumbnail})\n`;
	}

	if (sections.length > 0) {
		md += `\n## Sections\n\n`;
		for (const s of sections) {
			const depth = s.number.split(".").length;
			const indent = "  ".repeat(Math.max(0, depth - 1));
			md += `${indent}- ${s.line}\n`;
		}
	}

	if (pageText) {
		// Strip HTML tags for a cleaner read, but keep structure
		const cleaned = cleanHtmlToMarkdown(pageText);
		md += `\n## Content\n\n${cleaned}\n`;
	}

	if (categories.length > 0) {
		md += `\n## Categories\n\n`;
		for (const cat of categories.slice(0, 20)) {
			md += `- ${cat}\n`;
		}
	}

	return {
		ok: true,
		url: pageUrl || url,
		title: displayTitle,
		content: md,
	};
}

/**
 * Basic HTML-to-Markdown conversion for Wikipedia parse output.
 * Handles the most common MediaWiki HTML structures.
 */
function cleanHtmlToMarkdown(html: string): string {
	let out = html;

	// Remove edit section links
	out = out.replace(/<span class="mw-editsection">[\s\S]*?<\/span>/g, "");

	// Headings
	out = out.replace(/<h2[^>]*>/gi, "\n\n## ");
	out = out.replace(/<h3[^>]*>/gi, "\n\n### ");
	out = out.replace(/<h4[^>]*>/gi, "\n\n#### ");
	out = out.replace(/<\/h[234]>/gi, "\n");

	// Paragraphs
	out = out.replace(/<p[^>]*>/gi, "\n\n");
	out = out.replace(/<\/p>/gi, "");

	// Bold
	out = out.replace(/<b[^>]*>/gi, "**");
	out = out.replace(/<\/b>/gi, "**");

	// Italic
	out = out.replace(/<i[^>]*>/gi, "_");
	out = out.replace(/<\/i>/gi, "_");

	// Links — extract text, drop hrefs
	out = out.replace(
		/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href, text) => {
			const url = String(href || "");
			const inner = stripTags(String(text || ""));
			// Internal Wikipedia link: keep just the text
			if (url.startsWith("/wiki/")) return inner;
			// External link
			return `[${inner}](${url})`;
		},
	);

	// Images
	out = out.replace(
		/<img[^>]*src="([^"]*)"[^>]*>/gi,
		(_m, src) => `\n![image](${src})\n`,
	);

	// Lists
	out = out.replace(/<li[^>]*>/gi, "\n- ");
	out = out.replace(/<\/li>/gi, "");
	out = out.replace(/<(?:ul|ol)[^>]*>/gi, "");
	out = out.replace(/<\/(?:ul|ol)>/gi, "");

	// Tables — simplified
	out = out.replace(/<table[^>]*>/gi, "\n");
	out = out.replace(/<\/table>/gi, "\n");
	out = out.replace(/<tr[^>]*>/gi, "| ");
	out = out.replace(/<\/tr>/gi, "|\n");
	out = out.replace(/<t[dh][^>]*>/gi, " ");
	out = out.replace(/<\/t[dh]>/gi, " |");
	out = out.replace(/<caption[^>]*>/gi, "**");
	out = out.replace(/<\/caption>/gi, "**\n");

	// Remove remaining tags
	out = stripTags(out);

	// Clean up whitespace
	out = out.replace(/\n{3,}/g, "\n\n");
	out = out.trim();

	// Truncate to reasonable length (100K chars is huge)
	if (out.length > 100000) {
		out = out.slice(0, 100000) + "\n\n_… content truncated …_";
	}

	return out;
}

function stripTags(s: string): string {
	// Loop until stable to prevent incomplete multi-character sanitization
	let prev: string;
	do {
		prev = s;
		s = s.replace(/<[^>]*>/g, "");
	} while (s !== prev);
	return s;
}
