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

// ─── Timeout ───────────────────────────────────────────────────────
// Jina is a *fallback* proxy that re-fetches a page we already have, so
// it should never inherit smartFetch's generous 30s whole-request
// timeout. Bound it to a few seconds: long enough for a genuine render
// on a JS-heavy page, short enough that a blocked/rate-limited Jina does
// not stall the pipeline (measured nulls took ~4–5.5s before falling
// through to local extraction anyway).
export const JINA_TIMEOUT_MS = 4000;

// ─── Per-domain negative cache ─────────────────────────────────────
// When Jina returns null for a domain (blocked/rate-limited/challenge),
// the very next page of the same pull almost certainly will too. Skip
// re-trying it. Bounded LRU so a long-running process does not grow this
// without limit.
const JINA_NEGATIVE_CACHE_MAX = 50;
const jinaNegativeCache = new Map<string, true>();

function rememberJinaFailure(host: string): void {
	if (!host) return;
	// Re-insert so the entry is the most-recently-used.
	jinaNegativeCache.delete(host);
	jinaNegativeCache.set(host, true);
	if (jinaNegativeCache.size > JINA_NEGATIVE_CACHE_MAX) {
		// Evict the least-recently-used (first) key.
		const oldest = jinaNegativeCache.keys().next().value;
		if (oldest !== undefined) jinaNegativeCache.delete(oldest);
	}
}

/** True when a domain recently failed Jina and should be skipped. */
export function isJinaNegativeCached(url: string): boolean {
	return jinaNegativeCache.has(hostnameOf(url));
}

/** Test helper — reset the per-domain negative cache. */
export function clearJinaNegativeCache(): void {
	jinaNegativeCache.clear();
}

// ─── Injectable transport (test seam) ──────────────────────────────
// The real transport does a network round-trip through smartFetch. Tests
// override this to assert call/skip behavior offline; the timeout and
// negative cache below still wrap whatever transport is installed.
type JinaTransport = (url: string) => Promise<PullResult | null>;

async function defaultJinaTransport(url: string): Promise<PullResult | null> {
	const res = await smartFetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
		timeoutMs: JINA_TIMEOUT_MS,
	});
	if (!res || res.status >= 400) return null;
	return parseJinaBody(res.text, url);
}

let jinaTransport: JinaTransport = defaultJinaTransport;

/** Test helper — override the Jina transport (pass null to restore). */
export function __setJinaTransportForTests(fn: JinaTransport | null): void {
	jinaTransport = fn ?? defaultJinaTransport;
}

/** Race a promise against the Jina timeout without dangling rejections. */
function withJinaTimeout(
	promise: Promise<PullResult | null>,
): Promise<PullResult | null> {
	return new Promise<PullResult | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), JINA_TIMEOUT_MS);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

export async function fetchJina(url: string): Promise<PullResult | null> {
	const host = hostnameOf(url);
	// A domain that just returned null is skipped on the next page of a
	// pull instead of paying the round-trip again.
	if (host && jinaNegativeCache.has(host)) return null;

	let result: PullResult | null = null;
	try {
		result = await withJinaTimeout(jinaTransport(url));
	} catch {
		result = null;
	}
	if (result === null && host) rememberJinaFailure(host);
	return result;
}
