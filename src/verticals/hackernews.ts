// ─── Hacker News extractor ─────────────────────────────────────────
// Uses the official Firebase API: https://github.com/HackerNews/API

import type { VerticalResult } from "./types.js";

export function matchesHackerNews(url: string): boolean {
	return /^https?:\/\/news\.ycombinator\.com\/item\?id=\d+/i.test(url);
}

export async function extractHackerNews(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/id=(\d+)/i);
	if (!match) return null;
	const id = match[1]!;

	const item = await fetchJson(
		`https://hacker-news.firebaseio.com/v0/item/${id}.json`,
	);
	if (!item || typeof item !== "object") return null;

	const d = item as Record<string, unknown>;
	const title = String(d.title || "Hacker News Item");
	const by = String(d.by || "");
	const time = d.time ? new Date(Number(d.time) * 1000).toISOString() : "";
	const score = Number(d.score || 0);
	const descendants = Number(d.descendants || 0);
	const text = String(d.text || "");
	const itemUrl = String(d.url || "");
	const type = String(d.type || "");

	let md = `# ${title}\n\n`;
	if (itemUrl) md += `**Link:** ${itemUrl}\n\n`;
	md += `- **Author:** ${by || "unknown"}\n`;
	md += `- **Type:** ${type}\n`;
	md += `- **Score:** ${score} points\n`;
	md += `- **Comments:** ${descendants}\n`;
	if (time) md += `- **Posted:** ${time}\n`;

	if (text) {
		md += `\n## Text\n\n${text}\n`;
	}

	// Fetch top-level comments
	const kids = Array.isArray(d.kids) ? (d.kids as string[]).slice(0, 10) : [];
	if (kids.length) {
		md += `\n## Top Comments\n\n`;
		for (const kidId of kids) {
			const kid = await fetchJson(
				`https://hacker-news.firebaseio.com/v0/item/${kidId}.json`,
			);
			if (kid && typeof kid === "object") {
				const k = kid as Record<string, unknown>;
				const kby = String(k.by || "");
				const ktext = String(k.text || "").slice(0, 500);
				md += `> **${kby}:** ${ktext}\n\n`;
			}
		}
	}

	return {
		ok: true,
		url,
		title,
		content: md,
	};
}
