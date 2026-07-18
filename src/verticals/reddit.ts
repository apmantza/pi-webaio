// ─── Reddit extractor ──────────────────────────────────────────────
// Uses the public .json endpoint (e.g. reddit.com/r/.../.json)
// Returns structured errors for blocked/rate-limited posts instead of
// bypassing anti-bot controls.

import { readResponseTextWithProgress } from "../fetch.ts";
import type { VerticalResult } from "./types.ts";

/** Bound on each block-detection probe — connect/headers and body read. */
const PROBE_TIMEOUT_MS = 10_000;

export function matchesReddit(url: string): boolean {
	return /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/i.test(
		url,
	);
}

/**
 * Quick probe to figure out why a Reddit fetch failed. The .json endpoint
 * is the only AI-consumable path; when it returns 403/HTML we want to
 * give the user a clear explanation instead of a generic "blocked" error.
 *
 *   - "You've been blocked by network security" — Reddit's anti-bot wall
 *     is blocking our IP. No workaround; the only way to read the post
 *     is to open the URL in a browser.
 *   - 404 HTML — the post was deleted or the URL is wrong.
 *   - Other 4xx/5xx — generic fetch error.
 *
 * Returns null when we can't tell (no extra info beyond the generic
 * "Reddit returns structured errors" message).
 */
async function detectRedditBlock(url: string): Promise<string | null> {
	// Probe the .json endpoint (returns 403 on block) and the main
	// HTML page (returns 200 with a "Please wait" body on block).
	// Either signal confirms the block.
	const probeUrls = [
		url.replace(/\/?$/, ".json"), // .json (returns 403 on block)
		url, // main page (returns 200 with verify body)
		"https://www.reddit.com/.json", // reddit's home .json (control)
	];
	try {
		const probes = await Promise.all(
			probeUrls.map(async (u) => {
				try {
					const res = await fetch(u, {
						headers: {
							"User-Agent":
								"pi-webaio:0.5.0 (https://github.com/apmantza/pi-webaio)",
						},
						redirect: "follow",
						// Bound the connect/headers phase — a hung socket must
						// never hang the whole Promise.all (issue #41).
						signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
					});
					// Stream-read the body with a byte cap and a deadline —
					// Reddit's 403 block page puts the diagnostic message at
					// the END of a 190KB doc that's mostly CSS, so truncating
					// to 4KB misses the marker, but an unbounded res.text()
					// read can hang forever on a stalled connection.
					const { text } = await readResponseTextWithProgress(
						res,
						PROBE_TIMEOUT_MS,
					);
					return { url: u, status: res.status, text };
				} catch {
					return { url: u, status: 0, text: "" };
				}
			}),
		);

		const jsonProbe = probes[0];
		const main = probes[1];
		const home = probes[2];

		// 404 on the post — clearly a "not found" not a network block
		if (jsonProbe && jsonProbe.status === 404) {
			return `Reddit returned 404 for ${url} — the post may have been deleted or the URL is incorrect.`;
		}

		// The 403 block page marker — both statuses can indicate a block:
		//   - .json → 403 with "blocked by network security" in the body
		//   - main HTML page → 200 with "Please wait for verification"
		// Check the .json probe for the canonical block message.
		if (jsonProbe && jsonProbe.status === 403) {
			if (
				jsonProbe.text.includes("blocked by network security") ||
				jsonProbe.text.includes("You've been blocked")
			) {
				return (
					`Reddit returned 403 — its anti-bot wall is blocking requests from this network. ` +
					`The .json endpoint (the only AI-consumable Reddit API) is gated, so we can't extract the post or comments programmatically. ` +
					`Try opening the URL in a browser, or use a Reddit-aware proxy. ` +
					`Affected URL: ${url}`
				);
			}
			// 403 but not the block page — rate limit?
			return `Reddit returned 403 for ${url} — possibly rate-limited. Wait a few minutes and try again.`;
		}

		// Main page returned 200 — check for the "Please wait for verification" body
		if (main && main.status === 200) {
			if (
				main.text.includes("Please wait for verification") ||
				main.text.includes("Verifying your browser")
			) {
				return (
					`Reddit's anti-bot wall is blocking requests from this network. ` +
					`The .json endpoint (the only AI-consumable Reddit API) is gated, so we can't extract the post or comments programmatically. ` +
					`Try opening the URL in a browser, or use a Reddit-aware proxy. ` +
					`Affected URL: ${url}`
				);
			}
		}

		// Main page returns 5xx — but check whether Reddit as a whole
		// is down (main AND home both 5xx) vs just this endpoint
		if (main && main.status >= 500) {
			if (home && home.status >= 500) {
				return `Reddit returned ${main.status} for the post and ${home.status} for reddit.com. Reddit may be temporarily down from this network.`;
			}
			return `Reddit returned ${main.status} (server error). The post may be temporarily unavailable; try again later.`;
		}

		return null;
	} catch {
		return null;
	}
}

export async function extractReddit(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	// Normalize to .json endpoint
	const jsonUrl = url.replace(/\/?$/, ".json");

	// Try the .json endpoint first. Reddit's .json API is the only
	// AI-consumable way to get post + comment data — there is no
	// official public API. If we can't reach it, the post is unreachable.
	const data = await fetchJson(jsonUrl);
	if (!data || !Array.isArray(data)) {
		// The fetchJson wrapper returned null when status >= 400.
		// Try a plain text fetch so we can see WHY it failed — Reddit's
		// "blocked by network security" 403 page is a giant HTML doc, not
		// JSON, and we want to differentiate that from a 404.
		const blockedHint = await detectRedditBlock(url);
		return {
			ok: false,
			url,
			error:
				blockedHint ??
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
