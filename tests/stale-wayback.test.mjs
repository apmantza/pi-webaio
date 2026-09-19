// Stale-cache serving on hard network failure + Wayback snapshot metadata
// (adopted from the unsloth webtools assessment — local note:
// unsloth_webtools_inspiration.md).
//
// Recurrence these prevent:
// - Stale serving: a page the user fetched an hour ago becomes unfetchable
//   (network down, 5xx, origin gone) — the tool returned a bare error with a
//   cached copy sitting right there in the session store. Serving the last
//   good copy, clearly marked, turns a dead end into a degraded success.
//   The eligibility filter is the guard: never for validation/blocked errors
//   (SSRF, secrets, bot blocks) and never for a user abort — stale content
//   must never mask a real security block or a cancellation.
// - Wayback-on-404 metadata: a snapshot served after the original 404'd must
//   carry its snapshot date so the model can judge staleness.
import assert from "node:assert/strict";
import { test } from "node:test";

import { serveStaleIfAvailable, waybackSnapshotDate } from "../src/content.ts";
import { storeContent } from "../src/session-store.ts";
import { createFetchError } from "../src/tools/fetch-error.ts";

const UNIQUE = (tag) => `https://stale-test.example/${tag}`;

function err(code, statusCode) {
	return createFetchError(code, `probe ${code}`, {
		url: "https://stale-test.example/x",
		phase: statusCode ? "headers" : "connecting",
		...(statusCode ? { statusCode } : {}),
	});
}

test("serves the cached copy on a hard network failure, marked stale with date", () => {
	const url = UNIQUE("timeout");
	storeContent(url, "Cached Title", "CACHED-BODY-MARKER");
	const result = serveStaleIfAvailable(url, err("timeout"));
	assert.ok(result, "stale copy must be served for timeout");
	assert.equal(result.ok, true);
	assert.equal(result.stale, true);
	assert.ok(result.staleDate, "staleDate must be set");
	assert.match(result.content, /CACHED-BODY-MARKER/);
	assert.match(result.content, /STALE/i, "content must carry a visible stale notice");
});

test("eligibility filter: 5xx served, 404/auth/validation/blocks/abort never served", () => {
	const cached = UNIQUE("filter");
	storeContent(cached, "t", "body");
	const served = ["timeout", "dns_error", "connect_error", "tls_error", "download_error"];
	for (const code of served) {
		assert.ok(serveStaleIfAvailable(cached, err(code)), `${code} must serve stale`);
	}
	assert.ok(serveStaleIfAvailable(cached, err("http_error", 500)), "500 must serve stale");
	assert.ok(serveStaleIfAvailable(cached, err("rate_limited")), "429 must serve stale");
	// The guard: these must stay hard failures.
	const refused = [
		["blocked_ssrf", undefined],
		["blocked_secret", undefined],
		["private_ip", undefined],
		["invalid_url", undefined],
		["aborted", undefined],
		["http_error", 404],
		["http_error", 403],
		["not_found", undefined],
		["paywall", undefined],
		["bot_detected", undefined],
	];
	for (const [code, status] of refused) {
		assert.equal(
			serveStaleIfAvailable(cached, err(code, status)),
			null,
			`${code}${status ? ` (${status})` : ""} must NOT serve stale`,
		);
	}
});

test("no cached copy means no stale result, whatever the error", () => {
	assert.equal(serveStaleIfAvailable(UNIQUE("no-cache"), err("timeout")), null);
});

test("an empty cached body is not served as stale", () => {
	const url = UNIQUE("empty-body");
	storeContent(url, "t", "");
	assert.equal(serveStaleIfAvailable(url, err("timeout")), null);
});

test("waybackSnapshotDate extracts the snapshot date from a wayback URL", () => {
	assert.equal(
		waybackSnapshotDate("https://web.archive.org/web/20240115123456/https://example.com/a"),
		"2024-01-15",
	);
	assert.equal(waybackSnapshotDate("https://web.archive.org/web/2/https://example.com/a"), null);
	assert.equal(waybackSnapshotDate("https://example.com/a"), null);
	assert.equal(waybackSnapshotDate("not a url"), null);
});
