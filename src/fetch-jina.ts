// ─── Jina AI reader ───────────────────────────────────────────────
// Extracted from index.ts. Uses Jina AI Reader (r.jina.ai) as a proxy
// to convert web pages to clean markdown.

import { smartFetch } from "./fetch.ts";
import { detectBotBlock } from "./bot-detection.ts";
import type { PullResult } from "./types.ts";

// Challenge / garbage markers that indicate Jina proxied back a bot
// challenge page (e.g. a Cloudflare managed challenge) instead of real
// reader output. These are specific enough that clean markdown rarely
// contains them.
const JINA_CHALLENGE_MARKERS = [
	"just a moment",
	"performing security verification",
	"challenge-platform",
	"cf_chl",
	"cf-chl",
	"turnstile",
	"attention required",
	"verify you are human",
	"checking your browser",
];

/**
 * Detect whether a Jina body that lacks a "Title:" line is actually a
 * bot-challenge / garbage page rather than genuine reader markdown.
 *
 * Reuses the shared structured detector first, then applies a focused
 * marker check for Jina-proxied challenge pages that the generic
 * heuristic (which requires ≥2 markers) may miss.
 */
function isJinaChallengeBody(body: string): boolean {
	if (detectBotBlock(body).blocked) return true;
	const sample = body.slice(0, 8000).toLowerCase();
	return JINA_CHALLENGE_MARKERS.some((m) => sample.includes(m));
}

/** Hostname title fallback, guarded against invalid URLs. */
function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/**
 * Classify a raw Jina reader body into a PullResult.
 *
 * Returns null when the body is empty or is a bot-challenge / garbage
 * page, so the caller skips Jina and falls through to the real
 * extraction pipeline (readability → RSC → defuddle), which produces
 * correct titles AND content.
 *
 * Exported for offline testing — fetchJina() wraps this with the
 * network fetch.
 */
export function parseJinaBody(text: string, url: string): PullResult | null {
	const body = text.trim();
	if (!body) return null;

	// Parse Jina's "Title: ...\n\ncontent" format without regex backtracking
	const titleLine = body.startsWith("Title:")
		? body.slice(6).split("\n")[0]!.trim()
		: null;

	// A genuine Jina reader response begins with a "Title:" line. When it
	// does not, the body is either clean markdown (acceptable) or a
	// bot-challenge / HTML garbage page. Reject the latter so the real
	// pipeline runs — never let a challenge page through with a hostname
	// title.
	if (titleLine === null && isJinaChallengeBody(body)) {
		return null;
	}

	if (titleLine) {
		const contentStart = body.indexOf("\n\n", 6);
		if (contentStart !== -1) {
			return {
				ok: true,
				url,
				title: titleLine,
				content: body.slice(contentStart + 2),
			};
		}
	}

	// Hostname title fallback is ONLY for genuine reader output that
	// simply lacks a "Title:" line — never for a challenge page (rejected
	// above).
	return { ok: true, url, title: hostnameOf(url), content: body };
}

export async function fetchJina(url: string): Promise<PullResult | null> {
	try {
		const res = await smartFetch(
			`https://r.jina.ai/${encodeURIComponent(url)}`,
		);
		if (!res || res.status >= 400) return null;
		return parseJinaBody(res.text, url);
	} catch {
		return null;
	}
}
