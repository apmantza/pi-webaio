// ─── arXiv extractor ───────────────────────────────────────────────
// Uses the Atom export feed API.

import type { VerticalResult } from "./types.ts";

export function matchesArxiv(url: string): boolean {
	// /pdf/ is deliberately NOT matched: a PDF URL is an explicit request for the
	// binary, and claiming it here returned the abstract page instead of the PDF
	// text (issue #165 F9). The binary/PDF path in content.ts handles it.
	return (
		/^https?:\/\/arxiv\.org\/abs\/\d+\.\d+/i.test(url) ||
		/^https?:\/\/export\.arxiv\.org\/api\/query/i.test(url)
	);
}

/**
 * Atom responses are XML and arrive with entities (`&amp;`, `&#8212;`). Nothing
 * decoded them, so a title reached the agent as
 * `arXiv Query: search_query=&amp;id_list=…` (issue #165 F9).
 *
 * One pass over a single alternation: `&amp;amp;` therefore becomes the literal
 * text `&amp;` rather than `&`, which is what a decoder should do with
 * double-encoded input.
 *
 * Numeric refs that would inject a control character are left literal — a form
 * feed inside a markdown body is corruption, not a decoded character.
 */
const XML_ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g;

export function decodeXmlEntities(text: string): string {
	return text.replace(XML_ENTITY, (whole) => {
		const body = whole.slice(1, -1);
		switch (body) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
		}
		const hex = body.startsWith("#x") || body.startsWith("#X");
		const code = hex
			? parseInt(body.slice(2), 16)
			: parseInt(body.slice(1), 10);
		const valid =
			Number.isFinite(code) &&
			code >= 0x20 && // never inject a control character
			code <= 0x10ffff &&
			!(code >= 0xd800 && code <= 0xdfff); // lone surrogate
		if (!valid) return whole;
		try {
			return String.fromCodePoint(code);
		} catch {
			return whole;
		}
	});
}

export async function extractArxiv(
	url: string,
	fetchText: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	// Extract paper ID from abs URL, pdf URL, or api/query URL
	let id: string | undefined;
	const absMatch = url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/i);
	const pdfMatch = url.match(/arxiv\.org\/pdf\/(\d+\.\d+(?:v\d+)?)/i);
	const apiMatch = url.match(/[?&]id_list=([^&]+)/i);
	if (absMatch) id = absMatch[1];
	else if (pdfMatch) id = pdfMatch[1];
	else if (apiMatch) id = decodeURIComponent(apiMatch[1]!);
	if (!id) return null;

	// Use the Atom API
	const atomUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;

	// If the original URL is already the api/query endpoint, use its response directly
	let xml: string | null;
	if (apiMatch) {
		xml = await fetchText(url);
	} else {
		xml = await fetchText(atomUrl);
	}
	if (!xml) return null;

	// Quick XML extraction (no XML parser dependency, string-based)
	function extractTag(xmlStr: string, tag: string): string {
		const open = `<${tag}`;
		const close = `</${tag}>`;
		const startIdx = xmlStr.indexOf(open);
		if (startIdx === -1) return "";
		const contentStart = xmlStr.indexOf(">", startIdx);
		if (contentStart === -1) return "";
		const contentEnd = xmlStr.indexOf(close, contentStart);
		if (contentEnd === -1) return "";
		return xmlStr.slice(contentStart + 1, contentEnd).trim();
	}

	// Scope to the first <entry>: a bare `extractTag(xml, "title")` returns the
	// FEED title, which for an api/query response is the query echo
	// (`arXiv Query: search_query=&id_list=…`) rather than the paper title.
	// That echo is the string reported in issue #165 F9.
	const entryStart = xml.indexOf("<entry");
	const entryEnd = entryStart === -1 ? -1 : xml.indexOf("</entry>", entryStart);
	const entry =
		entryStart !== -1 && entryEnd !== -1
			? xml.slice(entryStart, entryEnd + "</entry>".length)
			: xml;

	const title = decodeXmlEntities(extractTag(entry, "title"));
	const summary = decodeXmlEntities(extractTag(entry, "summary"));
	const published = extractTag(entry, "published");
	const updated = extractTag(entry, "updated");

	// Authors
	const authors: string[] = [];
	const authorRe = /<author[^>]*>\s*<name>([^<]*)<\/name>/gi;
	let m: RegExpExecArray | null;
	while ((m = authorRe.exec(entry)) !== null) {
		authors.push(decodeXmlEntities(m[1]!.trim()));
	}

	// Categories
	const categories: string[] = [];
	const catRe = /<category[^>]*term="([^"]*)"/gi;
	while ((m = catRe.exec(entry)) !== null) {
		categories.push(m[1]!.trim());
	}

	// PDF link
	const pdfLink =
		entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/i)?.[1] ||
		xml.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/i)?.[1] ||
		`https://arxiv.org/pdf/${id}.pdf`;

	let md = `# ${title}\n\n`;
	if (published) md += `- **Published:** ${published}\n`;
	if (updated && updated !== published) md += `- **Updated:** ${updated}\n`;
	if (authors.length) md += `- **Authors:** ${authors.join(", ")}\n`;
	if (categories.length) md += `- **Categories:** ${categories.join(", ")}\n`;
	md += `- **PDF:** ${pdfLink}\n`;

	if (summary) {
		md += `\n## Abstract\n\n${summary}\n`;
	}

	return {
		ok: true,
		url,
		title,
		content: md,
	};
}
