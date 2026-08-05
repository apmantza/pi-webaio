// ─── Reddit search (CDP) ───────────────────────────────────────────
// Synthetic Reddit search via Chrome CDP — no external APIs, no PullPush.
// Uses the dedicated Chrome instance (greedysearch-chrome-profile).
// Activated automatically when the shared Chrome CDP instance is available.

import {
	getCdpWsUrl,
	CDPClient,
	evalInMainContext,
	clearMainContext,
	cdpIsAvailable,
} from "./_cdp-shared.ts";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir as osTmpdir } from "os";
import { randomInt } from "crypto";

/** Page navigation timeout */
const CDP_NAV_TIMEOUT_MS = 30_000;
/** Max wait for Reddit JS to hydrate */
const CDP_HYDRATE_TIMEOUT_MS = 25_000;

export interface RedditSearchResult {
	title: string;
	url: string;
	subreddit: string;
	score: number;
	comments: number;
	author: string;
}

export interface RedditSearchOutput {
	ok: boolean;
	query: string;
	count: number;
	results: RedditSearchResult[];
	elapsed: number;
	error?: string;
}

function buildSearchExtractor(): string {
	return String.raw`
    (function() {
      var results = [];
      var units = document.querySelectorAll('[data-testid="sdui-post-unit"], [data-testid="search-post-unit"]');
      
      for (var i = 0; i < units.length; i++) {
        var unit = units[i];
        var tracker = unit.querySelector('search-telemetry-tracker[data-faceplate-tracking-context]');
        
        // Primary: structured JSON from telemetry tracker
        if (tracker) {
          try {
            var ctx = JSON.parse(tracker.getAttribute('data-faceplate-tracking-context'));
            var post = ctx.post || {};
            var subreddit = ctx.subreddit || {};
            var profile = ctx.profile || {};
            
            var title = post.title || '';
            var url = '';
            var titleEl = unit.querySelector('[data-testid="post-title-text"]') || unit.querySelector('[data-testid="post-title"]');
            if (titleEl) url = titleEl.getAttribute('href') || '';
            if (url && !url.startsWith('http')) url = 'https://www.reddit.com' + url;
            
            var score = 0, comments = 0;
            var counter = unit.querySelector('[data-testid="search-counter-row"]');
            if (counter) {
              var nums = counter.querySelectorAll('faceplate-number');
              if (nums.length >= 1) score = parseInt((nums[0].textContent || '').trim()) || 0;
              if (nums.length >= 2) comments = parseInt((nums[1].textContent || '').trim()) || 0;
            }
            
            if (title && url) {
              results.push({
                title: title,
                url: url,
                subreddit: (subreddit.name || '').replace(/^r\//, ''),
                score: score,
                comments: comments,
                author: (profile.name || '').replace(/^u\//, '')
              });
              continue;
            }
          } catch(e) {}
        }
        
        // Fallback: DOM selectors
        var titleEl = unit.querySelector('[data-testid="post-title-text"]') || unit.querySelector('[data-testid="post-title"]');
        var title = titleEl ? (titleEl.getAttribute('aria-label') || titleEl.textContent.trim()) : '';
        var url = titleEl ? (titleEl.getAttribute('href') || '') : '';
        if (url && !url.startsWith('http')) url = 'https://www.reddit.com' + url;
        
        var subredditEl = unit.querySelector('[data-testid="search-subreddit-desc-text"]');
        var subreddit = subredditEl ? subredditEl.textContent.trim().split('\n')[0].trim() : '';
        
        var counter = unit.querySelector('[data-testid="search-counter-row"]');
        var score = 0, comments = 0;
        if (counter) {
          var nums = counter.querySelectorAll('faceplate-number');
          if (nums.length >= 1) score = parseInt((nums[0].textContent || '').trim()) || 0;
          if (nums.length >= 2) comments = parseInt((nums[1].textContent || '').trim()) || 0;
        }
        
        if (title && url) {
          results.push({
            title: title,
            url: url,
            subreddit: subreddit,
            score: score,
            comments: comments,
            author: ''
          });
        }
      }
      
      return JSON.stringify(results);
    })()
  `;
}

export function isRedditBlocked(value: unknown): boolean {
	// Runtime.evaluate with returnByValue returns the primitive boolean. Do not
	// compare against the CLI client's string serialization.
	return value === true;
}

function buildBlockDetector(): string {
	return String.raw`
    (function() {
      var body = document.body ? document.body.innerText.toLowerCase() : '';
      var blockIndicators = [
        'blocked by network security',
        'please wait while we verify',
        'captcha',
        'cloudflare',
        'access denied',
        'forbidden',
        'rate limit',
        'too many requests'
      ];
      for (var i = 0; i < blockIndicators.length; i++) {
        if (body.indexOf(blockIndicators[i]) !== -1) return true;
      }
      return false;
    })()
  `;
}

/**
 * Best-effort recovery for targets whose Target.createTarget response was
 * lost (Chrome created the target but the CDP reply never arrived, so the
 * caller never learned its targetId): close any page target carrying our
 * unique marker URL that was not present in the pre-create snapshot.
 *
 * The marker URL makes recovery race-safe under concurrency: a bare
 * about:blank match could close a live target created by a concurrent search
 * or another CDP consumer during the (up to 5s) recovery window, so each
 * search creates its target with a per-call marker fragment and recovery
 * matches only that exact URL. Skipped when the snapshot itself failed —
 * without a baseline we cannot tell new targets from pre-existing ones, and
 * closing the wrong target would be worse than the leak. Never throws.
 */
async function recoverLeakedTargets(
	cdp: CDPClient,
	snapshotIds: Set<string> | undefined,
	markerUrl: string,
): Promise<void> {
	if (!snapshotIds) return;
	try {
		const targets = await cdp.send("Target.getTargets");
		for (const info of targets?.targetInfos ?? []) {
			const id = info?.targetId;
			if (typeof id !== "string" || snapshotIds.has(id)) continue;
			if (info?.type !== "page" || info?.url !== markerUrl) continue;
			await cdp.send("Target.closeTarget", { targetId: id }).catch(() => {});
		}
	} catch {
		// Recovery is best-effort; a dead connection must not mask the
		// original setup error.
	}
}

/**
 * Search Reddit via CDP. Returns null if Chrome/CDP is unavailable.
 */
export async function searchReddit(
	query: string,
): Promise<RedditSearchOutput | null> {
	// Quick liveness probe — confirm Chrome is actually responding
	const portPath = join(
		process.env.CDP_PROFILE_DIR ||
			join(osTmpdir(), "greedysearch-chrome-profile"),
		"DevToolsActivePort",
	);
	if (!existsSync(portPath)) return null;
	try {
		const alive = await cdpIsAvailable(portPath);
		if (!alive) return null;
	} catch {
		return null;
	}

	const startTime = Date.now();
	let cdp: CDPClient | undefined;
	let targetId: string | undefined;
	let sessionId: string | undefined;

	try {
		const wsUrl = getCdpWsUrl();
		cdp = new CDPClient(wsUrl);
		await cdp.connect();

		// Leak-recovery snapshot: record which targets exist BEFORE we create
		// ours, so that if the Target.createTarget response is lost (Chrome
		// created the target but we never learn its targetId and `finally`
		// cannot close it), we can find and close the orphan afterwards.
		// Trade-off: one extra cheap getTargets round-trip (~few ms) on every
		// search, including the happy path, in exchange for guaranteed
		// no-leaked-targets. Correctness first; snapshot failure itself must
		// never abort the search.
		let snapshotIds: Set<string> | undefined;
		try {
			const targets = await cdp.send("Target.getTargets");
			snapshotIds = new Set(
				(targets?.targetInfos ?? [])
					.map((t: any) => t?.targetId)
					.filter((id: unknown): id is string => typeof id === "string"),
			);
		} catch {
			snapshotIds = undefined;
		}

		// Keep setup inside the cleanup scope so failed attach/Page.enable
		// cannot leak a freshly created target or its socket.
		// Unique marker URL so leak recovery can identify exactly our orphan
		// target without ever touching targets created by concurrent searches
		// or other CDP consumers. A data: URL round-trips reliably through
		// Target.createTarget/getTargets (an about:blank fragment might not),
		// and the pid+random suffix makes cross-search collisions impossible.
		const markerUrl = `data:text/plain,pi-webaio-${process.pid}-${randomInt(0, 2 ** 31)}`;
		let created: { targetId?: string } | undefined;
		try {
			created = await cdp.send("Target.createTarget", {
				url: markerUrl,
			});
		} catch {
			// Response lost or timed out — the target may still exist in
			// Chrome even though we have no targetId for it.
			created = undefined;
		}
		targetId = created?.targetId;
		if (!targetId) {
			await recoverLeakedTargets(cdp, snapshotIds, markerUrl);
			throw new Error("CDP target setup returned no target id");
		}

		const attached = await cdp.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		sessionId = attached?.sessionId;
		if (!sessionId) throw new Error("CDP target setup returned no session id");
		await cdp.send("Page.enable", {}, sessionId);

		// Navigate to Reddit search. Cancel the competing event wait on every
		// navigation exit, including a failed Page.navigate command.
		const searchUrl = `https://www.reddit.com/search?q=${encodeURIComponent(query)}&sort=relevance`;
		const loadEvent = cdp.waitForEvent(
			"Page.loadEventFired",
			CDP_NAV_TIMEOUT_MS,
		);
		try {
			const navResult = await cdp.send(
				"Page.navigate",
				{ url: searchUrl },
				sessionId,
			);
			if (navResult.errorText)
				throw new Error(`Navigation failed: ${navResult.errorText}`);
			await loadEvent.promise;
		} finally {
			loadEvent.cancel();
		}

		// Wait for Reddit JS to hydrate + render results
		const POLL_INTERVAL = 1_000;
		const pollDeadline = Date.now() + CDP_HYDRATE_TIMEOUT_MS;
		while (Date.now() < pollDeadline) {
			const countRaw = await cdp.send(
				"Runtime.evaluate",
				{
					expression: `document.querySelectorAll('[data-testid="sdui-post-unit"], [data-testid="search-post-unit"]').length`,
					returnByValue: true,
				},
				sessionId,
			);
			const postCount = parseInt(countRaw.result.value, 10) || 0;
			if (postCount > 0) break;
			await new Promise((r) => setTimeout(r, POLL_INTERVAL));
		}

		const blocked = await cdp.send(
			"Runtime.evaluate",
			{ expression: buildBlockDetector(), returnByValue: true },
			sessionId,
		);
		if (isRedditBlocked(blocked.result.value)) {
			return {
				ok: false,
				query,
				count: 0,
				results: [],
				elapsed: Date.now() - startTime,
				error: "Reddit returned a verification/block page",
			};
		}

		const raw = await evalInMainContext(cdp, sessionId, buildSearchExtractor());
		let posts: RedditSearchResult[];
		try {
			posts = JSON.parse(raw);
		} catch {
			return {
				ok: false,
				query,
				count: 0,
				results: [],
				elapsed: Date.now() - startTime,
				error: "Failed to parse search results",
			};
		}

		const seen = new Set<string>();
		const unique = posts.filter((p) => {
			if (seen.has(p.url)) return false;
			seen.add(p.url);
			return true;
		});
		return {
			ok: true,
			query,
			count: unique.length,
			results: unique,
			elapsed: Date.now() - startTime,
		};
	} catch (err) {
		return {
			ok: false,
			query,
			count: 0,
			results: [],
			elapsed: Date.now() - startTime,
			error: `Reddit search failed: ${(err as Error).message}`,
		};
	} finally {
		// Cleanup covers create, attach, Page.enable, navigation, evaluation,
		// parsing, timeout, and cancellation failures. Teardown is strictly
		// best-effort: never throw out of finally and never leave an unhandled
		// rejection. If closeTarget fails or times out, retry exactly once
		// while the connection may still be open; when the socket is already
		// dead the retry rejects immediately, so it costs nothing. Always drop
		// the socket afterwards.
		if (cdp && targetId) {
			try {
				await cdp.send("Target.closeTarget", { targetId });
			} catch {
				await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
			}
		}
		if (sessionId) clearMainContext(sessionId);
		cdp?.close();
	}
}
