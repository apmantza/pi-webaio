// ─── Reddit extractor ──────────────────────────────────────────────
// Uses the public .json endpoint (e.g. reddit.com/r/.../.json)
// Returns structured errors for blocked/rate-limited posts instead of
// bypassing anti-bot controls.

import type { VerticalResult } from "./types.ts";

export function matchesReddit(url: string): boolean {
	return /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/i.test(
		url,
	);
}

export async function extractReddit(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	// Normalize to .json endpoint
	const jsonUrl = url.replace(/\/?$/, ".json");

	const data = await fetchJson(jsonUrl);
	if (!data || !Array.isArray(data)) {
		// Check if we got an error page / rate limit
		return {
			ok: false,
			url,
			error:
				"Reddit post unavailable: may be blocked, rate-limited, or requires authentication. Reddit returns structured errors rather than bypassing bot controls.",
			content: "",
		};
	}

	// Reddit returns [postListing, commentListing]
	function hasChildren(obj: unknown): obj is { children: unknown[] } {
		return (
			obj !== null &&
			typeof obj === "object" &&
			"children" in obj &&
			Array.isArray((obj as Record<string, unknown>).children)
		);
	}
	function getData(obj: unknown): Record<string, unknown> | undefined {
		if (obj !== null && typeof obj === "object" && "data" in obj) {
			return (obj as Record<string, unknown>).data as Record<string, unknown>;
		}
		return undefined;
	}

	const postListing = data[0] as Record<string, unknown> | undefined;
	const commentListing = data[1] as Record<string, unknown> | undefined;

	const plData = getData(postListing);
	const postChildren = plData && hasChildren(plData) ? plData.children : [];
	const firstPost = postChildren[0];
	const postData = firstPost ? getData(firstPost) : undefined;
	if (!postData) {
		return {
			ok: false,
			url,
			error: "Reddit post data not found in API response",
			content: "",
		};
	}

	const title = String(postData.title || "");
	const author = String(postData.author || "");
	const subreddit = String(postData.subreddit || "");
	const score = Number(postData.score || 0);
	const numComments = Number(postData.num_comments || 0);
	const selftext = String(postData.selftext || "");
	const permalink = String(postData.permalink || "");
	const created = postData.created_utc
		? new Date(Number(postData.created_utc) * 1000).toISOString()
		: "";

	let md = `# ${title}\n\n`;
	md += `- **Author:** u/${author}\n`;
	md += `- **Subreddit:** r/${subreddit}\n`;
	md += `- **Score:** ${score} points\n`;
	md += `- **Comments:** ${numComments}\n`;
	if (created) md += `- **Posted:** ${created}\n`;
	if (permalink) md += `- **Permalink:** https://reddit.com${permalink}\n`;

	if (selftext) {
		md += `\n## Selftext\n\n${selftext}\n`;
	}

	// Extract top comments
	const clData = getData(commentListing);
	const commentChildren = clData && hasChildren(clData) ? clData.children : [];
	if (commentChildren.length > 0) {
		md += `\n## Top Comments\n\n`;
		for (const child of commentChildren.slice(0, 10)) {
			if (typeof child !== "object" || child === null) continue;
			const childRec = child as Record<string, unknown>;
			if (childRec.kind !== "t1") continue;
			const c = getData(child);
			if (!c) continue;
			const cAuthor = String(c.author || "");
			const cBody = String(c.body || "").slice(0, 600);
			const cScore = Number(c.score || 0);
			if (cBody) {
				md += `**u/${cAuthor}** (${cScore} pts):\n> ${cBody.replace(/\n/g, "\n> ")}\n\n`;
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
