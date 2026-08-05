// extractors/common.mjs — shared utilities for CDP-based extractors
// Extracts common patterns: cdp wrapper, tab management, clipboard interception, source parsing

import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEALTH_SCRIPT } from "./stealth-script.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, "..", "bin", "cdp.mjs");

// ============================================================================
// CDP wrapper
// ============================================================================

/**
 * Execute a CDP command through the cdp.mjs CLI
 * @param {string[]} args - Command arguments
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export function cdp(args, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [CDP, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let out = "";
		let err = "";
		let settled = false;
		const timer = setTimeout(() => {
			try { proc.kill(); } catch {}
			if (!settled) {
				settled = true;
				reject(new Error(`cdp timeout: ${args[0]}`));
			}
		}, timeoutMs);
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		proc.on("error", (error) => finish(reject, error));
		proc.on("close", (code) => {
			if (code === 0) finish(resolve, out.trim());
			else finish(reject, new Error(err.trim() || `cdp exit ${code}`));
		});
	});
}

// ============================================================================
// Tab management
// ============================================================================

/**
 * Get an existing tab by prefix or open a new one
 * @param {string|null} tabPrefix - Existing tab prefix, or null to create new
 * @returns {Promise<string>} Tab identifier
 */
export async function getOrOpenTab(tabPrefix) {
	if (tabPrefix) return tabPrefix;
	// Always open a fresh tab for each request (caller is responsible for closing)
	const list = await cdp(["list"]);
	const anchor = list.split("\n")[0]?.slice(0, 8);
	if (!anchor)
		throw new Error(
			"No Chrome tabs found. Is Chrome running with --remote-debugging-port=9222?",
		);

	let targetId;
	try {
		const raw = await cdp([
			"evalraw",
			anchor,
			"Target.createTarget",
			'{"url":"about:blank"}',
		]);
		targetId = JSON.parse(raw).targetId;
		if (typeof targetId !== "string" || !targetId)
			throw new Error("Target.createTarget returned no target id");
		await cdp(["list"]); // refresh cache
		// Navigation must not begin before the new-document stealth hook exists.
		await injectHeadlessStealth(targetId.slice(0, 8));
		return targetId;
	} catch (error) {
		if (targetId) await closeTarget(targetId);
		throw error;
	}
}

/** Close a target created by an extractor, ignoring teardown races. */
export async function closeTarget(targetId) {
	if (typeof targetId !== "string" || !targetId) return;
	try {
		await cdp([
			"evalraw",
			targetId.slice(0, 8),
			"Target.closeTarget",
			JSON.stringify({ targetId }),
		]);
	} catch {
		// The target may already be destroyed or its daemon may be gone.
	}
}

// ============================================================================
// Clipboard interception (for extractors that use copy-to-clipboard)
// ============================================================================

/**
 * Inject clipboard interceptor to capture text when copy buttons are clicked.
 * Each engine uses a unique global variable to avoid conflicts.
 * @param {string} tab - Tab identifier
 * @param {string} globalVar - Global variable name (e.g., '__pplxClipboard', '__geminiClipboard')
 */
export async function injectClipboardInterceptor(tab, globalVar) {
	const code = `
    window.${globalVar} = null;
    const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      window.${globalVar} = text;
      return _origWriteText(text);
    };
    const _origWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async function(items) {
      try {
        for (const item of items) {
          if (item.types && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            window.${globalVar} = await blob.text();
            break;
          }
        }
      } catch(e) {}
      return _origWrite(items);
    };
  `;
	await cdp(["eval", tab, code]);
}

// ============================================================================
// Headless stealth injection
// ============================================================================

/**
 * Inject anti-detection patches into a page in headless mode.
 * Based on production patterns from screenshotrun.com.
 *
 * The patch script itself lives in ./stealth-script.mjs (single source of
 * truth shared with pi-webaio's Playwright fallback in src/fetch.ts).
 */
export async function injectHeadlessStealth(tab) {
	await cdp([
		"evalraw",
		tab,
		"Page.addScriptToEvaluateOnNewDocument",
		JSON.stringify({ source: STEALTH_SCRIPT }),
	]);
}

// ============================================================================
// Source extraction from markdown
// ============================================================================

/**
 * Parse Markdown links from text to extract sources
 * @param {string} text - Text containing Markdown links like [title](url)
 * @returns {Array<{title: string, url: string}>} Extracted sources
 */
export function parseSourcesFromMarkdown(text) {
	if (!text) return [];
	const results = [];
	let idx = 0;
	while (idx < text.length && results.length < 10) {
		const openBracket = text.indexOf("[", idx);
		if (openBracket === -1) break;
		const closeBracket = text.indexOf("](", openBracket);
		if (closeBracket === -1) break;
		const openParen = closeBracket + 2;
		// Validate URL prefix and find closing paren
		let closeParen = -1;
		for (let p = openParen; p < text.length; p++) {
			const ch = text[p];
			if (ch === ")") {
				closeParen = p;
				break;
			}
			if (/\s/.test(ch)) break; // whitespace in URL = invalid markdown link
		}
		if (closeParen !== -1) {
			const title = text.slice(openBracket + 1, closeBracket);
			const url = text.slice(openParen, closeParen);
			if (/^https?:\/\//i.test(url) && title) {
				// Deduplicate by URL
				if (!results.some((r) => r.url === url)) {
					results.push({ title, url });
				}
			}
			idx = closeParen + 1;
		} else {
			idx = openBracket + 1;
		}
	}
	return results;
}

// ============================================================================
// Timing constants
// ============================================================================

export const TIMING = {
	postNav: 800, // settle after navigation
	postNavSlow: 1200, // settle after slower navigations (Bing, Gemini)
	postClick: 300, // settle after a UI click
	postType: 300, // settle after typing
	inputPoll: 400, // polling interval when waiting for input to appear
	copyPoll: 600, // polling interval when waiting for copy button
	afterVerify: 1500, // settle after a verification challenge completes
};

// ============================================================================
// Copy button polling
// ============================================================================

/**
 * Wait for a copy button to appear in the DOM.
 * @param {string} tab - Tab identifier
 * @param {string} selector - CSS selector for the copy button
 * @param {object} [options]
 * @param {number} [options.timeout=60000] - Max wait in ms
 * @param {Function} [options.onPoll] - Optional async callback on each poll tick (e.g. scroll)
 * @returns {Promise<void>}
 */
export async function waitForCopyButton(tab, selector, options = {}) {
	const { timeout = 60000, onPoll } = options;
	const deadline = Date.now() + timeout;
	let tick = 0;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, jitter(TIMING.copyPoll)));
		if (onPoll) await onPoll(++tick).catch(() => null);
		const found = await cdp([
			"eval",
			tab,
			`!!document.querySelector('${selector}')`,
		]).catch(() => "false");
		if (found === "true") return;
	}
	throw new Error(
		`Copy button ('${selector}') did not appear within ${timeout}ms`,
	);
}

// ============================================================================
// Timing jitter
// ============================================================================

/**
 * Add ±20% random jitter to a timing value to avoid bot-like regularity.
 * Also floors at 50ms minimum to prevent micro-polling.
 * @param {number} ms - Base interval in milliseconds
 * @returns {number} Jittered interval
 */
export function jitter(ms) {
	const variance = ms * 0.4;
	const offset = randomInt(-Math.floor(variance), Math.floor(variance) + 1);
	return Math.max(50, Math.round(ms + offset));
}

// ============================================================================
// Stream completion detection
// ============================================================================

/**
 * Wait for generation/streaming to complete by monitoring text length stability.
 *
 * Uses a SINGLE Runtime.evaluate call with awaitPromise: true — the stability
 * polling runs entirely inside the browser context, emitting no CDP traffic
 * during the wait. This avoids the CDP Runtime serialization detection vector
 * that would otherwise fire on every poll tick (~50 evals → 1 eval).
 *
 * @param {string} tab - Tab identifier
 * @param {object} options - Options
 * @param {number} [options.timeout=30000] - Maximum wait time in ms
 * @param {number} [options.interval=600] - Polling interval in ms (jittered ±20%)
 * @param {number} [options.stableRounds=3] - Required stable rounds to consider complete
 * @param {string} [options.selector='document.body'] - Element to monitor (default: body)
 * @returns {Promise<number>} Final text length
 */
export async function waitForStreamComplete(tab, options = {}) {
	const {
		timeout = 20000,
		interval = 600,
		stableRounds = 3,
		selector = "document.body",
		minLength = 0,
	} = options;

	// Single self-contained eval — polling runs in the browser, no CDP chatter.
	// The promise resolves when stability is reached or timeout expires.
	const code = String.raw`
	new Promise((resolve, reject) => {
		const _deadline = Date.now() + ${timeout};
		const _baseInterval = ${interval};
		const _stableRounds = ${stableRounds};
		const _minLength = ${minLength};
		let _lastLen = -1;
		let _stableCount = 0;

		function _jitter(ms) {
			return Math.max(50, ms + (Math.random() * ms * 0.4 - ms * 0.2));
		}

		function _poll() {
			try {
				// Re-query DOM each tick — element may not exist at eval start
				const el = ${selector};
				const cur = el?.innerText?.length ?? 0;
				if (cur >= _minLength) {
					if (cur === _lastLen) {
						_stableCount++;
						if (_stableCount >= _stableRounds) { resolve(cur); return; }
					} else {
						_lastLen = cur;
						_stableCount = 0;
					}
				}
				if (Date.now() < _deadline) {
					setTimeout(_poll, _jitter(_baseInterval));
				} else {
					if (_lastLen >= _minLength) { resolve(_lastLen); }
					else { reject(new Error('Generation did not stabilise within ${timeout}ms')); }
				}
			} catch(e) { reject(e); }
		}

		_poll();
	})
	`;

	// Use eval (which has awaitPromise:true in cdp.mjs) with generous timeout.
	// This is ONE Runtime.evaluate call — the polling loop runs in the browser.
	const lenStr = await cdp(["eval", tab, code], timeout + 10000);
	const currentLen = parseInt(lenStr, 10) || 0;

	if (currentLen >= minLength) return currentLen;
	throw new Error(`Generation did not stabilise within ${timeout}ms`);
}

// ============================================================================
// DOM selector waiting (single eval, no polling)
// ============================================================================

/**
 * Wait for a CSS selector to appear in the DOM using a single self-contained
 * eval. The polling loop runs in the browser — zero CDP traffic until done.
 *
 * @param {string} tab - Tab identifier
 * @param {string} selector - CSS selector to wait for
 * @param {number} [timeoutMs=15000] - Maximum wait time in ms
 * @param {number} [interval=500] - Base polling interval in ms (jittered ±20%)
 * @returns {Promise<boolean>} true if selector was found, false on timeout
 */
export async function waitForSelector(
	tab,
	selector,
	timeoutMs = 15000,
	interval = 500,
) {
	const code = String.raw`
	new Promise((resolve) => {
		const _deadline = Date.now() + ${timeoutMs};
		const _baseInterval = ${interval};

		function _jitter(ms) {
			return Math.max(50, ms + (Math.random() * ms * 0.4 - ms * 0.2));
		}

		function _poll() {
			try {
				if (document.querySelector('${selector}')) { resolve(true); return; }
				if (Date.now() < _deadline) { setTimeout(_poll, _jitter(_baseInterval)); }
				else { resolve(false); }
			} catch(_) { resolve(false); }
		}

		_poll();
	})
	`;

	const result = await cdp(["eval", tab, code], timeoutMs + 5000);
	return result === "true";
}

// ============================================================================
// CLI argument parsing
// ============================================================================

/**
 * Prepare args — if --stdin is present, read the query/prompt from stdin
 * and replace the --stdin flag with the content. This avoids leaking queries
 * and prompts via command-line arguments visible in the process table.
 * Call this before parseArgs().
 * @param {string[]} args - process.argv.slice(2)
 * @returns {Promise<string[]>} modified args with query in place of --stdin
 */
export async function prepareArgs(args) {
	const stdinIdx = args.indexOf("--stdin");
	if (stdinIdx === -1) return args;

	const query = await new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data.trim()));
	});

	// Replace --stdin with the query text (parseArgs will extract it as query)
	const modified = [...args];
	modified[stdinIdx] = query;
	return modified;
}

/**
 * Parse standard extractor CLI arguments
 * @param {string[]} args - process.argv.slice(2)
 * @returns {{query: string, tabPrefix: string|null, short: boolean, locale: string|null}}
 */
export function parseArgs(args) {
	const short = args.includes("--short");
	let rest = args.filter((a) => a !== "--short");

	const tabFlagIdx = rest.indexOf("--tab");
	const tabPrefix = tabFlagIdx === -1 ? null : rest[tabFlagIdx + 1];
	if (tabFlagIdx !== -1) {
		rest = rest.filter((_, i) => i !== tabFlagIdx && i !== tabFlagIdx + 1);
	}

	const localeIdx = rest.indexOf("--locale");
	const locale = localeIdx === -1 ? null : rest[localeIdx + 1];
	if (localeIdx !== -1) {
		rest = rest.filter((_, i) => i !== localeIdx && i !== localeIdx + 1);
	}

	const query = rest.join(" ");
	return { query, tabPrefix, short, locale };
}

/**
 * Validate that a query was provided, show usage and exit if not
 * @param {string[]} args - process.argv.slice(2)
 * @param {string} usage - Usage string for error message
 */
export function validateQuery(args, usage) {
	if (!args.length || args[0] === "--help") {
		process.stderr.write(usage);
		process.exit(1);
	}
}

// ============================================================================
// Output formatting
// ============================================================================

/**
 * Truncate answer if short mode is enabled
 * @param {string} answer - Full answer text
 * @param {boolean} short - Whether to truncate
 * @param {number} [maxLen=300] - Maximum length in short mode
 * @returns {string} Formatted answer
 */
export function formatAnswer(answer, short, maxLen = 300) {
	if (!short || answer.length <= maxLen) return answer;
	const truncated = answer.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > 0 ? `${truncated.slice(0, lastSpace)}…` : `${truncated}…`;
}

/**
 * Output JSON result to stdout
 * @param {object} data - Data to output
 */
export function outputJson(data) {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Build a lightweight result envelope from data already collected during extraction.
 * Zero additional CDP calls — everything here is already known.
 * @param {object} fields
 * @returns {object}
 */
export function buildEnvelope({
	engine,
	mode = "headless",
	clipboardEmpty = null,
	fallbackUsed = null,
	blockedBy = null,
	verificationResult = null,
	inputReady = null,
	durationMs = null,
} = {}) {
	return {
		engine,
		mode,
		clipboardEmpty,
		fallbackUsed,
		blockedBy,
		verificationResult,
		inputReady,
		durationMs,
	};
}

/**
 * Handle and output error, then exit.
 * If an envelope is provided, writes it to stdout as JSON so the runner
 * can parse structured diagnostics even on failure.
 * @param {Error} error - Error to handle
 * @param {object} [envelope] - Optional envelope object
 */
export function handleError(error, envelope = null) {
	if (envelope) {
		const out = JSON.stringify({ _envelope: envelope, error: error.message });
		process.stdout.write(`${out}\n`);
	}
	process.stderr.write(`Error: ${error.message}\n`);
	process.exit(1);
}
