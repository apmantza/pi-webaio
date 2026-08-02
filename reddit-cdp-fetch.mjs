#!/usr/bin/env node
// reddit-cdp-fetch.mjs — Prototype: CDP-based Reddit .json fetch
// Uses the dedicated GreedySearch Chrome instance (bin/launch.mjs) to bypass
// Reddit's anti-bot wall. The .json endpoint returns structured data when
// requested by a real browser.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROFILE_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const NAV_TIMEOUT = 15000;
const CDP_TIMEOUT = 30000;
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Chrome lifecycle (mirrors src/google-ai.ts ensureChrome)
// ---------------------------------------------------------------------------

async function ensureChrome() {
	const launchBin = join(process.cwd(), "bin", "launch.mjs");
	if (!existsSync(launchBin)) {
		throw new Error(
			"Chrome launcher not found at bin/launch.mjs. " +
				"Run this script from the pi-webaio project root.",
		);
	}

	const env = {
		...process.env,
		CDP_PROFILE_DIR: PROFILE_DIR,
		GREEDY_SEARCH_HEADLESS: "1",
	};
	Object.keys(env).forEach((k) => {
		if (env[k] === undefined) delete env[k];
	});

	const child = spawn(process.execPath, [launchBin], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let settled = false;

	const result = await new Promise((resolve) => {
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout, stderr });
		});
		setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			resolve({ code: -1, stdout, stderr: stderr + "\n[timeout after 30s]" });
		}, 30000);
	});

	if (result.code === 0)
		return {
			ok: true,
			alreadyRunning: result.stdout.includes("already running"),
		};
	if (
		result.stdout.includes("already running") ||
		result.stderr.includes("already running")
	) {
		return { ok: true, alreadyRunning: true };
	}
	throw new Error(
		`Chrome launch failed (exit ${result.code}): ${result.stderr || result.stdout}`,
	);
}

function getWsUrl() {
	const portFile = join(PROFILE_DIR, "DevToolsActivePort");
	if (!existsSync(portFile)) {
		throw new Error(
			`Chrome DevToolsActivePort not found at ${portFile}. ` +
				"Is the dedicated Chrome instance running?",
		);
	}
	const lines = readFileSync(portFile, "utf8").trim().split("\n");
	if (!lines[0]) throw new Error("DevToolsActivePort file is empty");
	return `ws://localhost:${lines[0]}${lines[1] || ""}`;
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------

class CDP {
	#ws;
	#id = 0;
	#pending = new Map();
	#eventHandlers = new Map();
	#closeHandlers = [];

	async connect(wsUrl) {
		return new Promise((resolve, reject) => {
			this.#ws = new WebSocket(wsUrl);
			this.#ws.onopen = () => resolve();
			this.#ws.onerror = (e) =>
				reject(new Error(`WebSocket error: ${e.message || e.type}`));
			this.#ws.onclose = () => {
				for (const h of this.#closeHandlers) h();
			};
			this.#ws.onmessage = (ev) => {
				let msg;
				try {
					msg = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (msg.id && this.#pending.has(msg.id)) {
					const { resolve, reject } = this.#pending.get(msg.id);
					this.#pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				} else if (msg.method && this.#eventHandlers.has(msg.method)) {
					for (const handler of this.#eventHandlers.get(msg.method)) {
						handler(msg.params || {}, msg);
					}
				}
			};
		});
	}

	send(method, params = {}, sessionId) {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			const msg = { id, method, params };
			if (sessionId) msg.sessionId = sessionId;
			this.#ws.send(JSON.stringify(msg));
			setTimeout(() => {
				if (this.#pending.has(id)) {
					this.#pending.delete(id);
					reject(new Error(`Timeout: ${method}`));
				}
			}, CDP_TIMEOUT);
		});
	}

	onEvent(method, handler) {
		if (!this.#eventHandlers.has(method))
			this.#eventHandlers.set(method, new Set());
		const handlers = this.#eventHandlers.get(method);
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#eventHandlers.delete(method);
		};
	}

	waitForEvent(method, timeout = CDP_TIMEOUT) {
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
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				off?.();
			},
		};
	}

	onClose(handler) {
		this.#closeHandlers.push(handler);
	}
	close() {
		this.#ws.close();
	}
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

async function waitForDocumentReady(cdp, sid, timeoutMs = NAV_TIMEOUT) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const state = await cdp.send(
				"Runtime.evaluate",
				{
					expression: "document.readyState",
					returnByValue: true,
				},
				sid,
			);
			const val = state.result.value;
			if (val === "complete") return;
		} catch {}
		await SLEEP(200);
	}
	throw new Error("Timed out waiting for navigation to finish");
}

async function evalStr(cdp, sid, expression) {
	const result = await cdp.send(
		"Runtime.evaluate",
		{
			expression,
			returnByValue: true,
			awaitPromise: true,
		},
		sid,
	);
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.text ||
				result.exceptionDetails.exception?.description,
		);
	}
	const val = result.result.value;
	return typeof val === "object"
		? JSON.stringify(val, null, 2)
		: String(val ?? "");
}

async function navAndWait(cdp, sid, url) {
	const loadEvent = cdp.waitForEvent("Page.loadEventFired", NAV_TIMEOUT);
	const result = await cdp.send("Page.navigate", { url }, sid);
	if (result.errorText) {
		loadEvent.cancel();
		throw new Error(result.errorText);
	}
	// Page.loadEventFired may not fire for simple JSON responses — fall back to a fixed delay
	try {
		await loadEvent.promise;
	} catch {
		process.stderr.write(
			"Page.loadEventFired did not fire, using fallback delay\n",
		);
		await SLEEP(3000);
	}
	await waitForDocumentReady(cdp, sid, 5000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const TARGET_URL =
	process.argv[2] ||
	"https://www.reddit.com/r/AI_Agents/comments/1ur3uft/nocode_ai_agent_builder_recommendations_one_year/.json";

async function main() {
	const startTime = Date.now();
	let cdp = null;
	let sid = null;
	let targetId = null;

	try {
		// 1. Ensure dedicated Chrome is running
		const launchResult = await ensureChrome();
		if (launchResult.alreadyRunning) {
			process.stderr.write("Chrome already running\n");
		} else {
			process.stderr.write("Chrome launched\n");
		}

		// 2. Connect via WebSocket to the dedicated Chrome
		const wsUrl = getWsUrl();
		process.stderr.write(`Connecting to ${wsUrl}...\n`);
		cdp = new CDP();
		await cdp.connect(wsUrl);
		process.stderr.write("Connected to CDP\n");

		// 3. Create a new tab
		const { targetId: tid } = await cdp.send("Target.createTarget", {
			url: "about:blank",
		});
		targetId = tid;
		const attachRes = await cdp.send("Target.attachToTarget", {
			targetId: tid,
			flatten: true,
		});
		sid = attachRes.sessionId;

		// 4. Navigate to the .json URL
		process.stderr.write(`Navigating to ${TARGET_URL}\n`);
		await navAndWait(cdp, sid, TARGET_URL);
		process.stderr.write("Navigation complete\n");

		// 5. Extract raw JSON from the rendered page
		const rawJson = await evalStr(cdp, sid, "document.body.innerText");

		// 6. Detect common block pages before parsing
		if (
			rawJson.includes("blocked by network security") ||
			rawJson.includes("Verifying your browser") ||
			rawJson.includes("Please wait for verification")
		) {
			console.error(
				JSON.stringify({
					ok: false,
					error: "Reddit anti-bot wall detected in page content",
					blocked: true,
					url: TARGET_URL,
					proof: rawJson.substring(0, 300),
				}),
			);
			process.exit(1);
		}

		// 7. Parse the Reddit JSON
		let data;
		try {
			data = JSON.parse(rawJson);
		} catch (e) {
			console.error(
				JSON.stringify({
					ok: false,
					error: `JSON parse failed: ${e.message}`,
					rawPreview: rawJson.substring(0, 500),
					url: TARGET_URL,
				}),
			);
			process.exit(1);
		}

		if (!Array.isArray(data) || data.length < 1) {
			console.error(
				JSON.stringify({
					ok: false,
					error:
						"Unexpected response shape — expected [postListing, commentListing]",
					shape: typeof data,
					url: TARGET_URL,
				}),
			);
			process.exit(1);
		}

		// 8. Extract post + comments
		const postListing = data[0];
		const commentListing = data[1] || {};

		function getData(obj) {
			return obj && typeof obj === "object" && "data" in obj
				? obj.data
				: undefined;
		}
		function hasChildren(obj) {
			return (
				obj &&
				typeof obj === "object" &&
				"children" in obj &&
				Array.isArray(obj.children)
			);
		}

		const plData = getData(postListing);
		const postChildren = plData && hasChildren(plData) ? plData.children : [];
		const firstPost = postChildren[0];
		const postData = firstPost ? getData(firstPost) : undefined;

		if (!postData) {
			console.error(
				JSON.stringify({
					ok: false,
					error: "Reddit post data not found in API response",
					url: TARGET_URL,
				}),
			);
			process.exit(1);
		}

		const title = String(postData.title || "");
		const author = String(postData.author || "[deleted]");
		const subreddit = String(postData.subreddit || "");
		const score = Number(postData.score || 0);
		const numComments = Number(postData.num_comments || 0);
		const selftext = String(postData.selftext || "");
		const permalink = String(postData.permalink || "");
		const created = postData.created_utc
			? new Date(Number(postData.created_utc) * 1000).toISOString()
			: "";
		const url = `https://www.reddit.com${permalink}`;

		// Extract top comments
		const comments = [];
		const clData = getData(commentListing);
		if (clData && hasChildren(clData)) {
			for (const child of clData.children) {
				const cData = getData(child);
				if (!cData || cData.kind === "more") continue;
				const body = String(cData.body || cData.selftext || "");
				if (!body.trim()) continue;
				comments.push({
					author: String(cData.author || "[deleted]"),
					body: body.trim(),
					score: Number(cData.score || 0),
					created: cData.created_utc
						? new Date(Number(cData.created_utc) * 1000).toISOString()
						: "",
				});
				if (comments.length >= 10) break;
			}
		}

		// 9. Output structured JSON
		const result = {
			ok: true,
			url: TARGET_URL,
			fetched_via: "cdp",
			post: {
				title,
				author,
				subreddit,
				score,
				num_comments: numComments,
				selftext: selftext.trim(),
				url,
				created,
			},
			top_comments: comments,
			meta: {
				elapsed_ms: Date.now() - startTime,
				total_comments_available: numComments,
				comments_returned: comments.length,
			},
		};

		console.log(JSON.stringify(result, null, 2));
	} catch (e) {
		console.error(
			JSON.stringify({
				ok: false,
				error: e.message,
				url: TARGET_URL,
				elapsed_ms: Date.now() - startTime,
			}),
		);
		process.exit(1);
	} finally {
		// Cleanup: close tab
		if (cdp && targetId) {
			try {
				await cdp.send("Target.closeTarget", { targetId }, sid).catch(() => {});
			} catch {}
		}
		if (cdp) cdp.close();
	}
}

main();
