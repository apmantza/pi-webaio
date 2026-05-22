// ─── arXiv extractor ───────────────────────────────────────────────
// Uses the Atom export feed API.

import type { VerticalResult } from "./types.js";

export function matchesArxiv(url: string): boolean {
	return (
		/^https?:\/\/arxiv\.org\/abs\/\d+\.\d+/i.test(url) ||
		/^https?:\/\/export\.arxiv\.org\/api\/query/i.test(url) ||
		/^https?:\/\/arxiv\.org\/pdf\/\d+\.\d+/i.test(url)
	);
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

	const title = extractTag(xml, "title");
	const summary = extractTag(xml, "summary");
	const published = extractTag(xml, "published");
	const updated = extractTag(xml, "updated");

	// Authors
	const authors: string[] = [];
	const authorRe = /<author[^>]*>\s*<name>([^<]*)<\/name>/gi;
	let m: RegExpExecArray | null;
	while ((m = authorRe.exec(xml)) !== null) {
		authors.push(m[1]!.trim());
	}

	// Categories
	const categories: string[] = [];
	const catRe = /<category[^>]*term="([^"]*)"/gi;
	while ((m = catRe.exec(xml)) !== null) {
		categories.push(m[1]!.trim());
	}

	// PDF link
	const pdfLink =
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
