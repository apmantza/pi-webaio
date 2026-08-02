// ─── Reddit search (CDP) ───────────────────────────────────────────
// Synthetic Reddit search via Chrome CDP — no external APIs, no PullPush.
// Uses the dedicated Chrome instance (greedysearch-chrome-profile).
// Activated by REDDIT_CDP_SEARCH=1 or when Chrome is available.

import {
	getCdpWsUrl,
	CDPClient,
	evalInMainContext,
	cdpIsAvailable,
} from "./_cdp-shared.ts";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir as osTmpdir } from "os";

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

	try {
		const wsUrl = getCdpWsUrl();
		const cdp = new CDPClient(wsUrl);
		await cdp.connect();

		// Create a fresh tab for each search
		const { targetId } = await cdp.send("Target.createTarget", {
			url: "about:blank",
		});
		const { sessionId } = await cdp.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		await cdp.send("Page.enable", {}, sessionId);

		try {
			// Navigate to Reddit search
			const searchUrl = `https://www.reddit.com/search?q=${encodeURIComponent(query)}&sort=relevance`;
			const loadEvent = cdp.waitForEvent(
				"Page.loadEventFired",
				CDP_NAV_TIMEOUT_MS,
			);
			const navResult = await cdp.send(
				"Page.navigate",
				{ url: searchUrl },
				sessionId,
			);
			if (navResult.errorText) {
				throw new Error(`Navigation failed: ${navResult.errorText}`);
			}
			await loadEvent.promise;

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

			// Check for block page
			const blocked = await cdp.send(
				"Runtime.evaluate",
				{ expression: buildBlockDetector(), returnByValue: true },
				sessionId,
			);
			if (blocked.result.value === "true") {
				return {
					ok: false,
					query,
					count: 0,
					results: [],
					elapsed: Date.now() - startTime,
					error: "Reddit returned a verification/block page",
				};
			}

			// Extract search results
			const extractor = buildSearchExtractor();
			const raw = await evalInMainContext(cdp, sessionId, extractor);

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

			// Deduplicate by URL
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
		} finally {
			await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
			cdp.close();
		}
	} catch (err) {
		return {
			ok: false,
			query,
			count: 0,
			results: [],
			elapsed: Date.now() - startTime,
			error: `Reddit search failed: ${(err as Error).message}`,
		};
	}
}
