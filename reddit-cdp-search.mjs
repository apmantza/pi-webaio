#!/usr/bin/env node
// reddit-cdp-search.mjs — synthetic Reddit search via CDP (no external APIs)
//
// Uses the dedicated Chrome instance (greedysearch-chrome-profile) to navigate
// to Reddit's public search UI and extract result cards from the DOM.
// No PullPush, no .json endpoint, no user's main Chrome profile.
//
// Usage:
//   node reddit-cdp-search.mjs "site:reddit.com AI agents"
//   node reddit-cdp-search.mjs "langchain"
//   node reddit-cdp-search.mjs "rust programming"

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const ACTIVE_PORT = join(PROFILE_DIR, "DevToolsActivePort");
const LAUNCH_SCRIPT = join(process.cwd(), "bin", "launch.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getWsUrl() {
	if (!existsSync(ACTIVE_PORT)) {
		throw new Error(
			`DevToolsActivePort not found at ${ACTIVE_PORT}. Run: node bin/launch.mjs`,
		);
	}
	const lines = readFileSync(ACTIVE_PORT, "utf8").trim().split("\n");
	return `ws://localhost:${lines[0]}${lines[1]}`;
}

function httpGet(url, timeout = 2000) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { timeout }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve(Buffer.concat(chunks).toString()));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error(`HTTP timeout: ${url}`));
		});
	});
}

class CDP {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.ws = null;
		this.id = 0;
		this.pending = new Map();
		this.handlers = new Map();
		this.closeHandlers = [];
	}

	async connect() {
		const { WebSocket } = await import("ws");
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.wsUrl);
			this.ws.onopen = () => resolve();
			this.ws.onerror = (e) =>
				reject(new Error(`WebSocket error: ${e.message || e.type}`));
			this.ws.onclose = () => this.closeHandlers.forEach((h) => h());
			this.ws.onmessage = (ev) => {
				let msg;
				try {
					msg = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (msg.id && this.pending.has(msg.id)) {
					const { resolve, reject } = this.pending.get(msg.id);
					this.pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				} else if (msg.method && this.handlers.has(msg.method)) {
					for (const h of this.handlers.get(msg.method))
						h(msg.params || {}, msg);
				}
			};
		});
	}

	send(method, params = {}, sessionId) {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const msg = { id, method, params };
			if (sessionId) msg.sessionId = sessionId;
			this.ws.send(JSON.stringify(msg));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`Timeout: ${method}`));
				}
			}, 30000);
		});
	}

	waitForEvent(method, timeout = 30000) {
		let settled = false;
		let off;
		let timer;
		const promise = new Promise((resolve, reject) => {
			off = this.onEvent(method, (params) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				off();
				resolve(params);
			});
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				off();
				reject(new Error(`Timeout waiting for event: ${method}`));
			}, timeout);
		});
		return {
			promise,
			cancel() {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					off();
				}
			},
		};
	}

	onEvent(method, handler) {
		if (!this.handlers.has(method)) this.handlers.set(method, []);
		this.handlers.get(method).push(handler);
		return () => {
			const arr = this.handlers.get(method);
			const idx = arr.indexOf(handler);
			if (idx >= 0) arr.splice(idx, 1);
		};
	}

	onClose(handler) {
		this.closeHandlers.push(handler);
	}

	close() {
		if (this.ws) this.ws.close();
	}
}

async function ensureChromeRunning() {
	if (existsSync(ACTIVE_PORT)) {
		try {
			const port = parseInt(
				readFileSync(ACTIVE_PORT, "utf8").trim().split("\n")[0],
				10,
			);
			await httpGet(`http://localhost:${port}/json/version`, 2000);
			console.error(`[ok] Chrome already running on port ${port}`);
			return;
		} catch {
			// Port file exists but Chrome not responding — relaunch
		}
	}

	console.error("[launch] Starting dedicated Chrome instance...");
	spawn("node", [LAUNCH_SCRIPT], {
		stdio: "inherit",
		detached: false,
	});

	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		if (existsSync(ACTIVE_PORT)) {
			await sleep(1000);
			return;
		}
		await sleep(500);
	}

	throw new Error(
		"Chrome launch timed out — DevToolsActivePort never appeared",
	);
}

// --- Search-specific extractor ---
// Extracts search result cards from Reddit's search results page.
// Primary source: search-telemetry-tracker data-faceplate-tracking-context (structured JSON)
// Fallback: data-testid selectors

function buildSearchExtractor() {
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
            var search = ctx.search || {};
            
            var title = post.title || '';
            var url = '';
            var titleEl = unit.querySelector('[data-testid="post-title-text"]') || unit.querySelector('[data-testid="post-title"]');
            if (titleEl) url = titleEl.getAttribute('href') || '';
            if (url && !url.startsWith('http')) url = 'https://www.reddit.com' + url;
            
            var score = 0;
            var comments = 0;
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

// --- Block detection ---
// Returns true if the page looks like a verification/block page.

function buildBlockDetector() {
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

async function main() {
	const query = process.argv[2];
	if (!query) {
		console.error("Usage: node reddit-cdp-search.mjs <query>");
		process.exit(1);
	}

	const startTime = Date.now();
	await ensureChromeRunning();

	const wsUrl = getWsUrl();
	console.error(`[cdp] Connecting to ${wsUrl}`);
	const cdp = new CDP(wsUrl);
	await cdp.connect();

	// Create a new tab for this search
	const { targetId } = await cdp.send("Target.createTarget", {
		url: "about:blank",
	});
	console.error(`[cdp] Created tab ${targetId.slice(0, 8)}`);

	const { sessionId } = await cdp.send("Target.attachToTarget", {
		targetId,
		flatten: true,
	});
	await cdp.send("Page.enable", {}, sessionId);

	// Navigate to Reddit search
	const searchUrl = `https://www.reddit.com/search?q=${encodeURIComponent(query)}&sort=relevance`;
	console.error(`[nav] Navigating to: ${searchUrl}`);

	const loadEvent = cdp.waitForEvent("Page.loadEventFired", 30000);
	const navResult = await cdp.send("Page.navigate", { url: searchUrl }, sessionId);
	if (navResult.errorText) {
		throw new Error(`Navigation failed: ${navResult.errorText}`);
	}
	await loadEvent.promise;

	// Wait for Reddit JS to hydrate + render results
	console.error(`[wait] Waiting for search results to render...`);
	const POLL_INTERVAL = 1000;
	const POLL_TIMEOUT = 25000;
	let postCount = 0;
	const pollDeadline = Date.now() + POLL_TIMEOUT;
	while (Date.now() < pollDeadline) {
		const countRaw = await cdp.send(
			"Runtime.evaluate",
			{
				expression: `document.querySelectorAll('[data-testid="sdui-post-unit"], [data-testid="search-post-unit"]').length`,
				returnByValue: true,
			},
			sessionId,
		);
		postCount = parseInt(countRaw.result.value, 10) || 0;
		if (postCount > 0) break;
		await sleep(POLL_INTERVAL);
	}
	console.error(`[wait] Found ${postCount} search result units after polling`);

	// Check for block page
	const isBlocked = await cdp.send(
		"Runtime.evaluate",
		{ expression: buildBlockDetector(), returnByValue: true },
		sessionId,
	);
	if (isBlocked.result.value === "true") {
		const output = {
			ok: false,
			error: "Reddit returned a verification/block page",
			query,
			elapsed: Date.now() - startTime,
		};
		console.log(JSON.stringify(output, null, 2));
		await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
		cdp.close();
		process.exit(0);
	}

	// Extract search results
	const extractor = buildSearchExtractor();
	const result = await cdp.send(
		"Runtime.evaluate",
		{ expression: extractor, returnByValue: true },
		sessionId,
	);

	if (result.exceptionDetails) {
		throw new Error(
			`Eval exception: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description}`,
		);
	}

	let posts;
	try {
		posts = JSON.parse(result.result.value);
	} catch (e) {
		throw new Error(`JSON parse failed: ${e.message}`);
	}

	// Deduplicate by URL
	const seen = new Set();
	const unique = posts.filter((p) => {
		if (seen.has(p.url)) return false;
		seen.add(p.url);
		return true;
	});

	const output = {
		ok: true,
		query,
		count: unique.length,
		results: unique,
		elapsed: Date.now() - startTime,
	};

	console.log(JSON.stringify(output, null, 2));
	console.error(`[done] ${unique.length} results (${posts.length - unique.length} dupes removed) in ${output.elapsed}ms`);

	// Cleanup
	await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
	cdp.close();
}

main().catch((err) => {
	console.error(`[error] ${err.message}`);
	process.exit(1);
});
