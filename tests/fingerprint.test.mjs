// ─── Fingerprint/profile regression tests ───────────────────────────
// Offline by default. Optional live TLS check is gated by
// PI_WEBAIO_LIVE_TLS_TEST=1 to avoid flaky network dependencies in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyStealth,
	buildHeaders,
	DEFAULT_BROWSER,
	DEFAULT_OS,
	getLatestChromeProfile,
	normalizeFetchedUrl,
	smartFetch,
} from "../src/fetch.ts";
import { STEALTH_SCRIPT } from "#stealth-script";

// ─────────────────────────────────────────────────────────────────────
// Offline profile/header regression tests
// ─────────────────────────────────────────────────────────────────────

test("DEFAULT_BROWSER and DEFAULT_OS are stable baseline profiles", () => {
	assert.match(DEFAULT_BROWSER, /^chrome_\d+$/);
	assert.equal(DEFAULT_OS, "windows");
});

test("getLatestChromeProfile returns a Chrome profile or baseline fallback", () => {
	const latest = getLatestChromeProfile();
	assert.match(latest, /^chrome_\d+$/);
	const latestVersion = Number.parseInt(latest.split("_").pop() ?? "0", 10);
	const baselineVersion = Number.parseInt(
		DEFAULT_BROWSER.split("_").pop() ?? "0",
		10,
	);
	assert.ok(
		latestVersion >= baselineVersion,
		`latest profile ${latest} should be >= baseline ${DEFAULT_BROWSER}`,
	);
});

test("buildHeaders: default Chrome/Windows headers include Sec-CH-UA", () => {
	const headers = buildHeaders();
	assert.equal(headers["Sec-Ch-Ua-Platform"], '"Windows"');
	assert.ok(headers["Sec-Ch-Ua"].includes("Google Chrome"));
	assert.ok(headers["Sec-Ch-Ua"].includes("Chromium"));
	assert.equal(headers["Sec-Ch-Ua-Mobile"], "?0");
	assert.equal(headers["Sec-Fetch-Mode"], "navigate");
});

test("buildHeaders: Chrome profile version is reflected in Sec-CH-UA", () => {
	const headers = buildHeaders("chrome_147", "windows");
	assert.ok(headers["Sec-Ch-Ua"].includes('"Google Chrome";v="147"'));
	assert.ok(headers["Sec-Ch-Ua"].includes('"Chromium";v="147"'));
});

test("buildHeaders: Edge profile uses Microsoft Edge brand", () => {
	const headers = buildHeaders("edge_145", "windows");
	assert.ok(headers["Sec-Ch-Ua"].includes('"Microsoft Edge";v="145"'));
	assert.ok(headers["Sec-Ch-Ua"].includes('"Chromium";v="145"'));
});

test("buildHeaders: Firefox profile omits Sec-CH-UA brand header", () => {
	const headers = buildHeaders("firefox_147", "linux");
	assert.equal(headers["Sec-Ch-Ua"], undefined);
	assert.equal(headers["Sec-Ch-Ua-Platform"], '"Linux"');
});

test("buildHeaders: Safari profile omits Sec-CH-UA brand header", () => {
	const headers = buildHeaders("safari_26", "macos");
	assert.equal(headers["Sec-Ch-Ua"], undefined);
	assert.equal(headers["Sec-Ch-Ua-Platform"], '"macOS"');
});

test("buildHeaders: unknown OS falls back to Windows platform token", () => {
	const headers = buildHeaders("chrome_145", "plan9");
	assert.equal(headers["Sec-Ch-Ua-Platform"], '"Windows"');
});

test("normalizeFetchedUrl upgrades http to https and leaves https intact", () => {
	assert.equal(
		normalizeFetchedUrl("http://example.com/path"),
		"https://example.com/path",
	);
	assert.equal(
		normalizeFetchedUrl("https://example.com/path"),
		"https://example.com/path",
	);
});

test("smartFetch returns null instead of throwing on invalid URL", async () => {
	const result = await smartFetch("not a url");
	assert.equal(result, null);
});

// ─────────────────────────────────────────────────────────────────────
// Optional live TLS diagnostic test
// ─────────────────────────────────────────────────────────────────────

test("live TLS fingerprint endpoint returns profile metadata (opt-in)", {
	skip: process.env.PI_WEBAIO_LIVE_TLS_TEST !== "1",
}, async () => {
	const profile = getLatestChromeProfile();
	const result = await smartFetch("https://tls.peet.ws/api/all", {
		browser: profile,
		os: DEFAULT_OS,
	});
	assert.ok(result, "expected live TLS endpoint response");
	assert.equal(result.status, 200);

	let payload;
	try {
		payload = JSON.parse(result.text);
	} catch (err) {
		assert.fail(`expected JSON payload from TLS endpoint: ${String(err)}`);
	}
	assert.equal(typeof payload.user_agent, "string");
	assert.ok(payload.tls, "expected tls object");
	assert.equal(typeof payload.tls.ja3, "string");
	assert.equal(typeof payload.tls.ja4, "string");
});

// ─────────────────────────────────────────────────────────────────────
// Shared stealth script regression tests
// ─────────────────────────────────────────────────────────────────────
// Guards the "#stealth-script" package subpath import used by fetch.ts (the
// Playwright fallback) and extractors/common.mjs (CDP search extractors). If
// the subpath ever fails to resolve, the import throws here rather than
// silently disabling stealth in production.

test("#stealth-script subpath resolves to a non-empty script with key patches", () => {
	assert.equal(typeof STEALTH_SCRIPT, "string");
	assert.ok(STEALTH_SCRIPT.length > 500, "stealth script should be substantial");
	// Spot-check the hardened patches that distinguish this from the old
	// inline version — a deleted webdriver property (not a getter tell) and
	// native-code masking.
	assert.match(STEALTH_SCRIPT, /delete navigator\.webdriver/);
	assert.match(STEALTH_SCRIPT, /toString/);
});

test("applyStealth injects the shared script via addInitScript", async () => {
	let injected = null;
	const fakePage = {
		addInitScript: async (script) => {
			injected = script;
		},
	};
	await applyStealth(fakePage);
	assert.equal(injected, STEALTH_SCRIPT);
});

test("applyStealth never throws when addInitScript fails", async () => {
	const fakePage = {
		addInitScript: async () => {
			throw new Error("page closed");
		},
	};
	await applyStealth(fakePage);
});
