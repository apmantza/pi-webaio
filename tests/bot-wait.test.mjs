// ─── Tests for waitForBotProtectionToClear (issue #76) ──────────────
//
// Covers:
//   - Immediate return when the first page.content() is clean HTML
//   - Poll loop: challenge HTML for N reads, then clean HTML returned
//   - Timeout path: challenge never clears — returns last HTML, never throws

import { test } from "node:test";
import assert from "node:assert/strict";

import { waitForBotProtectionToClear } from "../src/fetch.ts";

// ─── Fake page helpers ───────────────────────────────────────────────

/** Challenge HTML that satisfies the cloudflare js_challenge signature. */
const CHALLENGE_HTML =
	"<html><body>cf-browser-verification checking your browser</body></html>";

/** Clean HTML with no bot-detection markers. */
const CLEAN_HTML = "<html><body><h1>Welcome</h1></body></html>";

/**
 * Build a fake Playwright page whose content() returns items from `sequence`
 * in order, repeating the last item if the sequence is exhausted.
 */
function fakePage(sequence) {
	let i = 0;
	return {
		async content() {
			const val = sequence[Math.min(i, sequence.length - 1)];
			i++;
			return val;
		},
	};
}

// ─── Immediate return on clean HTML ─────────────────────────────────

test("waitForBotProtectionToClear: returns immediately when first content is clean", async () => {
	const page = fakePage([CLEAN_HTML]);
	const start = Date.now();
	const result = await waitForBotProtectionToClear(page, {
		timeoutMs: 5000,
		pollMs: 500,
	});
	assert.equal(result, CLEAN_HTML);
	// Must not have waited for a poll interval
	assert.ok(Date.now() - start < 200, "should return immediately on clean HTML");
});

// ─── Clearance after polls ───────────────────────────────────────────

test("waitForBotProtectionToClear: returns cleared HTML after N challenge polls", async () => {
	// challenge x2, then clean
	const page = fakePage([CHALLENGE_HTML, CHALLENGE_HTML, CLEAN_HTML]);
	const result = await waitForBotProtectionToClear(page, {
		timeoutMs: 5000,
		pollMs: 10,
	});
	assert.equal(result, CLEAN_HTML, "should return the first clean HTML seen");
});

test("waitForBotProtectionToClear: returns on first poll if second content is clean", async () => {
	const page = fakePage([CHALLENGE_HTML, CLEAN_HTML]);
	const result = await waitForBotProtectionToClear(page, {
		timeoutMs: 5000,
		pollMs: 10,
	});
	assert.equal(result, CLEAN_HTML);
});

// ─── Timeout: returns last HTML without throwing ─────────────────────

test("waitForBotProtectionToClear: returns last challenge HTML on timeout, never throws", async () => {
	// Always challenge — never clears
	const page = fakePage([CHALLENGE_HTML]);
	let threw = false;
	let result;
	try {
		result = await waitForBotProtectionToClear(page, {
			timeoutMs: 50,
			pollMs: 10,
		});
	} catch {
		threw = true;
	}
	assert.equal(threw, false, "must not throw on timeout");
	assert.equal(result, CHALLENGE_HTML, "must return the last HTML seen on timeout");
});

// ─── Non-retryable block: no pointless polling ───────────────────────

test("waitForBotProtectionToClear: returns immediately on captcha (retryable: false)", async () => {
	// Cloudflare captcha signature — a real user prompt that polling can never clear
	const captchaHtml =
		"<html><body>Attention Required! cloudflare captcha</body></html>";
	const page = fakePage([captchaHtml, CLEAN_HTML]);
	const start = Date.now();
	const result = await waitForBotProtectionToClear(page, {
		timeoutMs: 5000,
		pollMs: 500,
	});
	assert.equal(result, captchaHtml, "must not poll past a captcha page");
	assert.ok(Date.now() - start < 200, "should return without polling");
});

// ─── Default options ─────────────────────────────────────────────────

test("waitForBotProtectionToClear: works with default opts (clean page)", async () => {
	const page = fakePage([CLEAN_HTML]);
	const result = await waitForBotProtectionToClear(page);
	assert.equal(result, CLEAN_HTML);
});
