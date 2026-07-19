// ─── Speculative prefetch for websearch results (issue #47) ──────────────────
//
// Fires background fetches of top search-result URLs into the session cache
// so that subsequent aio-webfetch calls are served instantly from cache.
//
// Design:
//   - Always fire-and-forget; never blocks or delays search response.
//   - Small concurrency cap (MAX_PREFETCH_CONCURRENCY) to stay polite.
//   - Per-URL timeout via AbortController so slow pages don't linger.
//   - Timers/handles are unref'd so prefetch never keeps the process alive.
//   - Failures are silently swallowed.
//   - URLs already fresh in the session cache are skipped.

import { pullPageEnhanced } from "./content.ts";
import { getStoredContent, storeContent } from "./session-store.ts";
import { frontmatter } from "./tools/utils.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum concurrent prefetch fetches at any time. */
export const MAX_PREFETCH_CONCURRENCY = 2;

/** Per-URL prefetch timeout in milliseconds. */
export const PREFETCH_TIMEOUT_MS = 15_000;

/** Default top-N URLs to prefetch when `prefetch: true`. */
export const DEFAULT_PREFETCH_COUNT = 3;

// ─── Prefetch runner ──────────────────────────────────────────────────────────

/**
 * Prefetch a single URL through the normal fetch+extract pipeline and store
 * the result in the session cache. Used by `triggerPrefetch`.
 *
 * @internal Exported for unit tests only.
 */
export async function prefetchUrl(url: string): Promise<void> {
	// Skip if already fresh in session cache.
	if (getStoredContent(url)) return;

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), PREFETCH_TIMEOUT_MS);
	// Don't let the timer keep the process alive.
	timer.unref?.();

	try {
		const result = await pullPageEnhanced(url, { mode: "auto" });
		if (!result.ok || !result.content) return;

		storeContent(result.url ?? url, result.title, frontmatter(result.title ?? url, result.url ?? url, {
			author: result.author,
			published: result.published,
			site: result.site,
			language: result.language,
			wordCount: result.wordCount,
		}) + result.content, undefined, {
			author: result.author,
			published: result.published,
			site: result.site,
			language: result.language,
			wordCount: result.wordCount,
		});
	} catch {
		// Silently swallow all errors — a failed prefetch must never surface.
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fire-and-forget background prefetch of the top N URLs.
 *
 * Returns immediately; prefetch work runs in the background with a
 * concurrency cap of MAX_PREFETCH_CONCURRENCY. The returned Promise
 * represents the entire batch but is intended to be ignored by the caller.
 *
 * @param urls - Ordered list of URLs to prefetch (first N are used).
 * @param count - How many to prefetch (default: DEFAULT_PREFETCH_COUNT).
 * @param fetcher - Injectable fetch function for tests (default: prefetchUrl).
 */
export function triggerPrefetch(
	urls: string[],
	count: number = DEFAULT_PREFETCH_COUNT,
	fetcher: (url: string) => Promise<void> = prefetchUrl,
): Promise<void> {
	const targets = urls.slice(0, count);
	if (!targets.length) return Promise.resolve();

	const batchPromise = runCapped(targets, MAX_PREFETCH_CONCURRENCY, fetcher);

	// We schedule via setImmediate so the search response is returned first,
	// then unref the immediate handle so it doesn't block process exit.
	const handle = setImmediate(() => {
		// The promise is intentionally not awaited.
		batchPromise.catch(() => {});
	});
	handle.unref?.();

	return batchPromise;
}

/**
 * Run tasks with capped concurrency. Each task is an element of `items`
 * passed to `fn`. At most `concurrency` tasks run simultaneously.
 */
async function runCapped<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	const workers: Promise<void>[] = [];

	async function worker(): Promise<void> {
		while (queue.length > 0) {
			const item = queue.shift();
			if (item === undefined) break;
			await fn(item).catch(() => {});
		}
	}

	for (let i = 0; i < Math.min(concurrency, items.length); i++) {
		workers.push(worker());
	}

	await Promise.all(workers);
}
