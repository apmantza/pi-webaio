// ─── Jina AI reader ───────────────────────────────────────────────
// Extracted from index.ts. Uses Jina AI Reader (r.jina.ai) as a proxy
// to convert web pages to clean markdown.

import { smartFetch } from "./fetch.ts";
import type { PullResult } from "./types.ts";

export async function fetchJina(url: string): Promise<PullResult | null> {
	try {
		const res = await smartFetch(
			`https://r.jina.ai/${encodeURIComponent(url)}`,
		);
		if (!res || res.status >= 400) return null;
		const text = res.text.trim();
		if (!text) return null;
		// Parse Jina's "Title: ...\n\ncontent" format without regex backtracking
		const titleLine = text.startsWith("Title:")
			? text.slice(6).split("\n")[0]!.trim()
			: null;
		const contentStart = titleLine !== null ? text.indexOf("\n\n", 6) : -1;
		if (titleLine && contentStart !== -1) {
			return {
				ok: true,
				url,
				title: titleLine,
				content: text.slice(contentStart + 2),
			};
		}
		return { ok: true, url, title: new URL(url).hostname, content: text };
	} catch {
		return null;
	}
}
