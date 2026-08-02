#!/usr/bin/env node
// reddit-cdp-dom-fetch.mjs — minimal working prototype

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const ACTIVE_PORT = join(PROFILE_DIR, "DevToolsActivePort");
const LAUNCH_SCRIPT = join(process.cwd(), "bin", "launch.mjs");

const REDDIT_URL =
	"https://www.reddit.com/r/AI_Agents/comments/1ur3uft/nocode_ai_agent_builder_recommendations_one_year/";

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

	onEvent(method, handler) {
		if (!this.handlers.has(method)) this.handlers.set(method, []);
		this.handlers.get(method).push(handler);
		return () => {
			const arr = this.handlers.get(method);
			const idx = arr.indexOf(handler);
			if (idx >= 0) arr.splice(idx, 1);
		};
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

async function main() {
	await ensureChromeRunning();

	const wsUrl = getWsUrl();
	console.error(`[cdp] Connecting to ${wsUrl}`);
	const cdp = new CDP(wsUrl);
	await cdp.connect();

	const { targetId } = await cdp.send("Target.createTarget", {
		url: REDDIT_URL,
	});
	console.error(`[cdp] Created tab ${targetId.slice(0, 8)}`);

	const { sessionId } = await cdp.send("Target.attachToTarget", {
		targetId,
		flatten: true,
	});
	await cdp.send("Page.enable", {}, sessionId);

	// Wait for page load + extra settle time for Reddit JS hydration
	const loadEvent = cdp.waitForEvent("Page.loadEventFired", 30000);
	await loadEvent.promise;
	await sleep(4000);

	// --- Minimal inline extraction (proven to work) ---
	const extractJs = String.raw`
    (function() {
      var post = document.querySelector('shreddit-post');
      if (!post) return JSON.stringify({ error: 'no shreddit-post' });
      var title = post.getAttribute('post-title') || '';
      var author = post.getAttribute('author') || '';
      var subreddit = post.getAttribute('subreddit-name') || '';
      var score = post.getAttribute('score') || '0';
      var comments = post.getAttribute('comment-count') || '0';
      var selfEl = post.querySelector('[slot="text-body"]');
      var selftext = selfEl ? selfEl.textContent.trim() : '';
      var commentEls = Array.from(document.querySelectorAll('shreddit-comment')).slice(0, 5);
      var topComments = commentEls.map(function(el) {
        return {
          author: el.getAttribute('author') || '',
          score: el.getAttribute('score') || '0',
          body: (el.querySelector('[slot="comment"]') || {}).textContent || ''
        };
      });
      return JSON.stringify({
        title: title,
        author: author,
        subreddit: subreddit,
        score: score,
        num_comments: comments,
        selftext: selftext,
        topComments: topComments
      });
    })()
  `;

	const result = await cdp.send(
		"Runtime.evaluate",
		{ expression: extractJs, returnByValue: true },
		sessionId,
	);

	if (result.exceptionDetails) {
		console.error(
			`[error] Eval exception: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description}`,
		);
		process.exit(1);
	}

	let data;
	try {
		data = JSON.parse(result.result.value);
	} catch (e) {
		console.error(`[error] JSON parse failed: ${e.message}`);
		console.error(
			`[error] Raw value: ${result.result.value?.slice?.(0, 200) || result.result.value}`,
		);
		process.exit(1);
	}
	if (data.error) {
		console.error(`[error] ${data.error}`);
		process.exit(1);
	}

	const output = {
		ok: true,
		url: REDDIT_URL,
		title: data.title || null,
		author: data.author || null,
		subreddit: data.subreddit || null,
		score: parseInt(data.score, 10) || 0,
		num_comments: parseInt(data.num_comments, 10) || 0,
		selftext: data.selftext || "",
		topComments: data.topComments || [],
	};

	console.log(JSON.stringify(output, null, 2));

	// Save raw HTML for debugging
	const debugPath = join(tmpdir(), "reddit-cdp-debug.html");
	writeFileSync(
		debugPath,
		await cdp
			.send(
				"Runtime.evaluate",
				{
					expression: "document.documentElement.outerHTML",
					returnByValue: true,
				},
				sessionId,
			)
			.then((r) => r.result.value),
	);
	console.error(`[debug] Raw HTML saved to ${debugPath}`);

	await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
	cdp.close();
}

main().catch((err) => {
	console.error(`[error] ${err.message}`);
	process.exit(1);
});
