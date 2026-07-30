// ─── Tests for F6: content-hash dedup + aio-webcontent diff-mode ────
//
// Covers:
//   - src/content-hash.ts: SHA-256 hashing, short form, unchanged +
//     truncated-hash comparison helpers.
//   - src/session-store.ts storeContent(): hash stamping, unchanged
//     detection, and previous-version retention for diffing.
//   - src/tools/webcontent.ts: default retrieval (now hash-aware) and the
//     opt-in diff-mode, exercised against a seeded session cache.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	hashContent,
	shortHash,
	contentHashShort,
	contentUnchanged,
	hashesEqual,
	SHORT_HASH_LENGTH,
} from "../src/content-hash.ts";
import {
	storeContent,
	getStoredContent,
	sessionStore,
	normalizeCacheKey,
} from "../src/session-store.ts";
import { registerWebcontentTool } from "../src/tools/webcontent.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeMockPi() {
	const tools = {};
	return {
		tools,
		registerTool(tool) {
			tools[tool.name] = tool;
		},
	};
}

function getWebcontentTool() {
	const pi = makeMockPi();
	registerWebcontentTool(pi);
	return pi.tools["aio-webcontent"];
}

function drop(url) {
	sessionStore.delete(normalizeCacheKey(url));
}

// ─── content-hash helper ─────────────────────────────────────────────

test("hashContent: deterministic SHA-256 hex digest", () => {
	const a = hashContent("hello world");
	const b = hashContent("hello world");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{64}$/);
});

test("hashContent: different content yields different hashes", () => {
	assert.notEqual(hashContent("alpha"), hashContent("beta"));
});

test("shortHash / contentHashShort: 12-char default prefix", () => {
	const full = hashContent("some content");
	assert.equal(shortHash(full), full.slice(0, SHORT_HASH_LENGTH));
	assert.equal(shortHash(full).length, 12);
	assert.equal(contentHashShort("some content"), full.slice(0, 12));
	assert.equal(shortHash(full, 8).length, 8);
});

test("contentUnchanged: matches prior hash, false on first sighting", () => {
	const h = hashContent("payload");
	assert.equal(contentUnchanged("payload", h), true);
	assert.equal(contentUnchanged("payload-changed", h), false);
	assert.equal(contentUnchanged("payload", undefined), false);
});

test("hashesEqual: tolerates a truncated previous hash", () => {
	const full = hashContent("data");
	const truncated = full.slice(0, 16);
	assert.equal(hashesEqual(full, truncated), true);
	assert.equal(hashesEqual(truncated, full), true);
	assert.equal(hashesEqual(full, full), true);
	assert.equal(hashesEqual(full, hashContent("other")), false);
	assert.equal(hashesEqual(undefined, full), false);
	assert.equal(hashesEqual(full, undefined), false);
});

// ─── storeContent dedup + previous-version retention ─────────────────

test("storeContent: first sighting stamps a hash, no previous version", () => {
	const url = "https://example.com/f6/first";
	drop(url);
	storeContent(url, "T", "# A\n\none");
	const entry = getStoredContent(url);
	assert.ok(entry);
	assert.equal(entry.contentHash, hashContent("# A\n\none"));
	assert.equal(entry.previousContent, undefined);
	assert.equal(entry.previousContentHash, undefined);
	drop(url);
});

test("storeContent: re-storing identical content is detected as unchanged", () => {
	const url = "https://example.com/f6/same";
	drop(url);
	storeContent(url, "T", "# A\n\none");
	const firstHash = getStoredContent(url).contentHash;
	storeContent(url, "T", "# A\n\none");
	const entry = getStoredContent(url);
	assert.equal(entry.contentHash, firstHash);
	// No spurious diff baseline is created for a no-op re-store.
	assert.equal(entry.previousContent, undefined);
	assert.equal(entry.previousContentHash, undefined);
	drop(url);
});

test("storeContent: changed content retains the previous version + hash", () => {
	const url = "https://example.com/f6/change";
	drop(url);
	const v1 = "# A\n\none";
	const v2 = "# A\n\ntwo";
	storeContent(url, "T", v1);
	const v1Hash = getStoredContent(url).contentHash;
	storeContent(url, "T", v2);
	const entry = getStoredContent(url);
	assert.equal(entry.content, v2);
	assert.equal(entry.contentHash, hashContent(v2));
	assert.equal(entry.previousContent, v1);
	assert.equal(entry.previousContentHash, v1Hash);
	drop(url);
});

test("storeContent: unchanged re-store carries the diff baseline forward", () => {
	const url = "https://example.com/f6/carry";
	drop(url);
	storeContent(url, "T", "# A\n\none");
	const v1Hash = getStoredContent(url).contentHash;
	storeContent(url, "T", "# A\n\ntwo");
	// Re-store the current (v2) content unchanged.
	storeContent(url, "T", "# A\n\ntwo");
	const entry = getStoredContent(url);
	assert.equal(entry.content, "# A\n\ntwo");
	// Baseline (v1) is preserved across the no-op re-store.
	assert.equal(entry.previousContent, "# A\n\none");
	assert.equal(entry.previousContentHash, v1Hash);
	drop(url);
});

test("getStoredContent: backfills a missing hash on a legacy entry", () => {
	const url = "https://example.com/f6/legacy";
	drop(url);
	// Simulate a pre-F6 entry with no hash stamped.
	sessionStore.set(normalizeCacheKey(url), {
		url,
		title: "Legacy",
		content: "# L\n\nlegacy body",
		timestamp: Date.now(),
	});
	const entry = getStoredContent(url);
	assert.ok(entry);
	assert.equal(entry.contentHash, hashContent("# L\n\nlegacy body"));
	drop(url);
});

// ─── aio-webcontent: default retrieval (hash-aware) ──────────────────

test("webcontent: default retrieval exposes contentHash + version flags", async () => {
	const url = "https://example.com/f6/wc-default";
	drop(url);
	storeContent(url, "Title", "# H\n\nbody");
	const tool = getWebcontentTool();
	const res = await tool.execute("t1", { url });
	assert.equal(res.details.found, true);
	assert.equal(res.details.contentHash, shortHash(hashContent("# H\n\nbody")));
	assert.equal(res.details.unchanged, false);
	assert.equal(res.details.hasPreviousVersion, false);
	assert.match(res.content[0].text, /Content hash: /);
	drop(url);
});

test("webcontent: missing URL still reports found:false", async () => {
	const tool = getWebcontentTool();
	const res = await tool.execute("t2", {
		url: "https://example.com/f6/does-not-exist",
	});
	assert.equal(res.details.found, false);
});

// ─── aio-webcontent: diff-mode ───────────────────────────────────────

test("webcontent diff-mode: no previous version → graceful no-diff", async () => {
	const url = "https://example.com/f6/wc-diff-none";
	drop(url);
	storeContent(url, "T", "# A\n\none");
	const tool = getWebcontentTool();
	const res = await tool.execute("t3", { url, diff: true });
	assert.equal(res.details.found, true);
	assert.equal(res.details.diff, false);
	assert.equal(res.details.reason, "no-previous-version");
	assert.match(res.content[0].text, /No previous version to diff/);
	drop(url);
});

test("webcontent diff-mode: section-level diff of current vs previous", async () => {
	const url = "https://example.com/f6/wc-diff-change";
	drop(url);
	storeContent(url, "T", "# Intro\n\nold intro\n\n# Kept\n\nsame");
	storeContent(url, "T", "# Intro\n\nnew intro\n\n# Kept\n\nsame\n\n# Added\n\nbrand new");
	const tool = getWebcontentTool();
	const res = await tool.execute("t4", { url, diff: true });
	assert.equal(res.details.found, true);
	assert.equal(res.details.diff, true);
	assert.equal(res.details.unchanged, false);
	// "Intro" body changed; "Added" is new; "Kept" is untouched.
	assert.ok(res.details.changedSections.some((h) => /Intro/.test(h)));
	assert.ok(res.details.addedSections.some((h) => /Added/.test(h)));
	assert.ok(!res.details.changedSections.some((h) => /Kept/.test(h)));
	assert.match(res.content[0].text, /Changed sections/);
	assert.match(res.content[0].text, /Added sections/);
	drop(url);
});

test("webcontent diff-mode: identical current/previous reports unchanged", async () => {
	const url = "https://example.com/f6/wc-diff-identical";
	drop(url);
	// Seed an entry whose previous version equals its current content so
	// diffContent hits its identical short-circuit.
	const body = "# Same\n\nidentical body";
	const h = hashContent(body);
	sessionStore.set(normalizeCacheKey(url), {
		url,
		title: "T",
		content: body,
		timestamp: Date.now(),
		contentHash: h,
		previousContent: body,
		previousContentHash: h,
	});
	const tool = getWebcontentTool();
	const res = await tool.execute("t5", { url, diff: true });
	assert.equal(res.details.diff, true);
	assert.equal(res.details.unchanged, true);
	assert.match(res.content[0].text, /identical/i);
	drop(url);
});

test("webcontent diff-mode: default behavior unchanged when diff absent", async () => {
	const url = "https://example.com/f6/wc-no-diff";
	drop(url);
	storeContent(url, "T", "# A\n\none");
	storeContent(url, "T", "# A\n\ntwo");
	const tool = getWebcontentTool();
	const res = await tool.execute("t6", { url });
	// Without diff:true we get the full current content, not a diff.
	assert.equal(res.details.diff, undefined);
	assert.match(res.content[0].text, /two/);
	assert.ok(!/Changed sections/.test(res.content[0].text));
	drop(url);
});
