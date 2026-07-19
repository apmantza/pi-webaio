// ─── Tests for HTTP revalidation (issue #46) ─────────────────────────
//
// Covers:
//   - extractValidators: pulls ETag / Last-Modified from headers
//   - attachValidators: persists validators on a session-store entry
//   - buildConditionalHeaders: returns If-None-Match / If-Modified-Since
//   - isExpiredEntry: detects expired vs fresh entries
//   - refreshEntryOnNotModified: refreshes timestamp (simulates 304 path)
//   - hasValidators: guard before conditional request
//   - captureResponseValidators / drainCapturedValidators: side channel

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	extractValidators,
	attachValidators,
	buildConditionalHeaders,
	isExpiredEntry,
	refreshEntryOnNotModified,
	hasValidators,
	captureResponseValidators,
	drainCapturedValidators,
} from "../src/http-validators.ts";

import {
	sessionStore,
	normalizeCacheKey,
	SESSION_CACHE_TTL_MS,
} from "../src/session-store.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeEntry(overrides = {}) {
	return {
		url: "https://example.com/page",
		content: "# Page\n\nHello world.",
		timestamp: Date.now(),
		...overrides,
	};
}

function seedStore(url, entry) {
	const key = normalizeCacheKey(url);
	sessionStore.set(key, entry);
	return key;
}

// ─── extractValidators ────────────────────────────────────────────────

test("extractValidators: returns etag and lastModified from headers", () => {
	const headers = {
		get(name) {
			if (name === "etag") return '"abc123"';
			if (name === "last-modified") return "Wed, 01 Jan 2025 00:00:00 GMT";
			return null;
		},
	};
	const v = extractValidators(headers);
	assert.equal(v.etag, '"abc123"');
	assert.equal(v.lastModified, "Wed, 01 Jan 2025 00:00:00 GMT");
});

test("extractValidators: returns empty object for null headers", () => {
	const v = extractValidators(null);
	assert.deepEqual(v, {});
});

test("extractValidators: returns partial when only etag present", () => {
	const headers = { get(name) { return name === "etag" ? '"xyz"' : null; } };
	const v = extractValidators(headers);
	assert.equal(v.etag, '"xyz"');
	assert.equal(v.lastModified, undefined);
});

// ─── attachValidators + hasValidators ─────────────────────────────────

test("attachValidators: attaches etag and lastModified to existing entry", () => {
	const url = "https://example.com/reval-attach";
	const entry = makeEntry({ url });
	seedStore(url, entry);

	attachValidators(url, { etag: '"v1"', lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" });

	const key = normalizeCacheKey(url);
	const stored = sessionStore.get(key);
	assert.equal(stored.etag, '"v1"');
	assert.equal(stored.lastModified, "Mon, 01 Jan 2024 00:00:00 GMT");
});

test("hasValidators: false when no validators present", () => {
	const entry = makeEntry();
	assert.equal(hasValidators(entry), false);
});

test("hasValidators: true when etag present", () => {
	const entry = makeEntry({ etag: '"abc"' });
	assert.equal(hasValidators(entry), true);
});

test("hasValidators: true when only lastModified present", () => {
	const entry = makeEntry({ lastModified: "Thu, 01 Jan 2026 00:00:00 GMT" });
	assert.equal(hasValidators(entry), true);
});

// ─── buildConditionalHeaders ──────────────────────────────────────────

test("buildConditionalHeaders: returns If-None-Match for etag", () => {
	const entry = makeEntry({ etag: '"token123"' });
	const h = buildConditionalHeaders(entry);
	assert.equal(h["If-None-Match"], '"token123"');
	assert.equal(h["If-Modified-Since"], undefined);
});

test("buildConditionalHeaders: returns both headers when both present", () => {
	const entry = makeEntry({ etag: '"abc"', lastModified: "Sat, 01 Jan 2000 00:00:00 GMT" });
	const h = buildConditionalHeaders(entry);
	assert.equal(h["If-None-Match"], '"abc"');
	assert.equal(h["If-Modified-Since"], "Sat, 01 Jan 2000 00:00:00 GMT");
});

test("buildConditionalHeaders: empty object when no validators", () => {
	const entry = makeEntry();
	const h = buildConditionalHeaders(entry);
	assert.deepEqual(h, {});
});

// ─── isExpiredEntry ───────────────────────────────────────────────────

test("isExpiredEntry: fresh entry is not expired", () => {
	const entry = makeEntry({ timestamp: Date.now() });
	assert.equal(isExpiredEntry(entry), false);
});

test("isExpiredEntry: old entry is expired", () => {
	const entry = makeEntry({ timestamp: Date.now() - SESSION_CACHE_TTL_MS - 1000 });
	assert.equal(isExpiredEntry(entry), true);
});

// ─── refreshEntryOnNotModified ────────────────────────────────────────

test("refreshEntryOnNotModified: updates timestamp to now", () => {
	const url = "https://example.com/reval-304";
	const oldTs = Date.now() - SESSION_CACHE_TTL_MS - 5000;
	const entry = makeEntry({ url, timestamp: oldTs });
	seedStore(url, entry);

	const before = Date.now();
	refreshEntryOnNotModified(url);
	const after = Date.now();

	const key = normalizeCacheKey(url);
	const refreshed = sessionStore.get(key);
	assert.ok(refreshed.timestamp >= before, "timestamp should be updated");
	assert.ok(refreshed.timestamp <= after, "timestamp should be recent");
});

test("refreshEntryOnNotModified: updates validators when provided", () => {
	const url = "https://example.com/reval-304-validators";
	const entry = makeEntry({ url, etag: '"old-etag"' });
	seedStore(url, entry);

	refreshEntryOnNotModified(url, { etag: '"new-etag"' });

	const key = normalizeCacheKey(url);
	const refreshed = sessionStore.get(key);
	assert.equal(refreshed.etag, '"new-etag"');
});

test("refreshEntryOnNotModified: no-op when entry absent", () => {
	// Should not throw
	refreshEntryOnNotModified("https://example.com/nonexistent-reval");
});

// ─── captureResponseValidators / drainCapturedValidators ──────────────

test("captureResponseValidators + drainCapturedValidators: round-trip", () => {
	const headers = {
		get(name) {
			if (name === "etag") return '"cap-test"';
			if (name === "last-modified") return "Fri, 01 Jan 2021 00:00:00 GMT";
			return null;
		},
	};
	captureResponseValidators("https://example.com/cap-test", headers);
	const drained = drainCapturedValidators("https://example.com/cap-test");
	assert.ok(drained !== null);
	assert.equal(drained.etag, '"cap-test"');
	assert.equal(drained.lastModified, "Fri, 01 Jan 2021 00:00:00 GMT");
});

test("drainCapturedValidators: returns null when nothing captured", () => {
	const result = drainCapturedValidators("https://example.com/no-capture");
	assert.equal(result, null);
});

test("captureResponseValidators: does not capture when no validators in headers", () => {
	const headers = { get(_name) { return null; } };
	captureResponseValidators("https://example.com/no-headers", headers);
	const drained = drainCapturedValidators("https://example.com/no-headers");
	assert.equal(drained, null);
});

test("drainCapturedValidators: draining removes the entry (idempotent)", () => {
	const headers = {
		get(name) { return name === "etag" ? '"drain-once"' : null; },
	};
	captureResponseValidators("https://example.com/drain-once", headers);
	const first = drainCapturedValidators("https://example.com/drain-once");
	const second = drainCapturedValidators("https://example.com/drain-once");
	assert.ok(first !== null);
	assert.equal(second, null);
});
