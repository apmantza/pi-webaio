// ─── DEV.to extractor ──────────────────────────────────────────────
// Uses the DEV.to public REST API (dev.to/api).
// No API key required for read-only access. Returns article content,
// tags, reactions, and comments.

import type { VerticalResult } from "./types.js";

/**
 * Match DEV.to article URLs.
 * e.g. dev.to/{username}/{slug}
 *      dev.to/{username}/{slug}-{hash}
 */
export function matchesDevTo(url: string): boolean {
	return /^https?:\/\/dev\.to\/[^/]+\/[^/?#]+/i.test(url);
}

/**
 * Extract username and slug from a DEV.to article URL.
 */
function parseDevToUrl(url: string): { username: string; slug: string } | null {
	const m = url.match(/dev\.to\/([^/?#]+)\/([^/?#]+)/i);
	if (!m) return null;
	const username = m[1]!;
	// Remove trailing hash fragment from slug (e.g. "slug-3p1e" → "slug")
	let slug = m[2]!;
	// DEV.to appends a hash like -3p1e to the slug in the URL. Remove it.
	const hashMatch = slug.match(/^(.+)-([a-z0-9]{4,8})$/i);
	if (hashMatch) {
		slug = hashMatch[1]!;
	}
	return { username, slug };
}

export async function extractDevTo(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const parsed = parseDevToUrl(url);
	if (!parsed) return null;
	const { username, slug } = parsed;

	// DEV.to uses a different slug format internally (e.g. URL has "10-free-public-apis"
	// but API slug is "10-free-public-apis-2p3"). Try the URL slug first, then try fetching
	// the user's articles to find a match.

	const apiUrl = `https://dev.to/api/articles/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;
	let data = await fetchJson(apiUrl);

	// If 404, try the full slug (with the hash portion)
	if (!data && parsed) {
		const origSlug = url.match(/dev\.to\/[^/]+\/([^/?#]+)/i)?.[1];
		if (origSlug && origSlug !== slug) {
			const retryUrl = `https://dev.to/api/articles/${encodeURIComponent(username)}/${encodeURIComponent(origSlug)}`;
			data = await fetchJson(retryUrl);
		}
	}

	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const title = String(d.title || "");
	const bodyMarkdown = String(d.body_markdown || "");
	const description = String(d.description || "");
	const publishedAt = String(d.published_at || "");
	const readingTime = Number(d.reading_time_minutes || 0);
	const tags = Array.isArray(d.tags) ? (d.tags as string[]) : [];
	const url_ = String(d.url || "");
	const coverImage = String(d.cover_image || d.social_image || "");
	const positiveReactions = Number(d.positive_reactions_count || 0);
	const commentsCount = Number(d.comments_count || 0);
	const user =
		d.user && typeof d.user === "object"
			? (d.user as Record<string, unknown>)
			: null;
	const authorName = user ? String(user.name || user.username || "") : username;
	const authorImage = user ? String(user.profile_image_90 || "") : "";

	// ── Build markdown ───────────────────────────────────────────────
	let md = `# ${title}\n\n`;

	if (description) md += `> ${description}\n\n`;

	if (authorImage) md += `![${authorName}](${authorImage}) `;
	md += `- **Author:** ${authorName}\n`;
	if (publishedAt) md += `- **Published:** ${publishedAt}\n`;
	if (readingTime) md += `- **Reading time:** ${readingTime} min\n`;
	md += `- **Reactions:** ${positiveReactions}\n`;
	md += `- **Comments:** ${commentsCount}\n`;

	if (tags.length) {
		const tagNames = tags.map((t) => (typeof t === "string" ? t : ""));
		md += `- **Tags:** ${tagNames.filter(Boolean).join(", ")}\n`;
	}

	if (coverImage) {
		md += `\n![Cover](${coverImage})\n`;
	}

	if (bodyMarkdown) {
		md += `\n${bodyMarkdown}\n`;
	}

	if (url_) {
		md += `\n---\n_Originally published at [${url_}](${url_})_\n`;
	}

	return {
		ok: true,
		url: url_ || url,
		title,
		content: md,
	};
}
