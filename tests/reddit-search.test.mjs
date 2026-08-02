/**
 * Tests for the Reddit CDP search vertical.
 *
 * These tests verify:
 * 1. searchReddit returns null when REDDIT_CDP_SEARCH is not set
 * 2. The env-gate behavior (no Chrome required for the null path)
 *
 * The full CDP path (Chrome required) is tested manually via:
 *   REDDIT_CDP_SEARCH=1 node reddit-cdp-search.mjs "langchain"
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

const { searchReddit } = await import("../src/verticals/reddit_search.ts");

test("Reddit search: returns null when REDDIT_CDP_SEARCH is not set", async () => {
	// Ensure env is not set (test runner should not set it)
	if (process.env.REDDIT_CDP_SEARCH) {
		console.warn("[skip] REDDIT_CDP_SEARCH is set — test skipped");
		return;
	}

	const result = await searchReddit("langchain");
	assert.strictEqual(
		result,
		null,
		"should return null when CDP search is disabled",
	);
});

test("Reddit search: returns null when REDDIT_CDP_SEARCH=0", async () => {
	const prev = process.env.REDDIT_CDP_SEARCH;
	process.env.REDDIT_CDP_SEARCH = "0";

	try {
		const result = await searchReddit("langchain");
		assert.strictEqual(
			result,
			null,
			"should return null when REDDIT_CDP_SEARCH=0",
		);
	} finally {
		if (prev === undefined) delete process.env.REDDIT_CDP_SEARCH;
		else process.env.REDDIT_CDP_SEARCH = prev;
	}
});

test("Reddit search: returns null when Chrome DevToolsActivePort is missing", async () => {
	const prev = process.env.REDDIT_CDP_SEARCH;
	const prevProfile = process.env.CDP_PROFILE_DIR;
	// Point to a non-existent profile directory
	process.env.REDDIT_CDP_SEARCH = "1";
	process.env.CDP_PROFILE_DIR = "/tmp/nonexistent-reddit-cdp-profile-xyz";

	try {
		const result = await searchReddit("langchain");
		assert.strictEqual(
			result,
			null,
			"should return null when Chrome is unavailable",
		);
	} finally {
		if (prev === undefined) delete process.env.REDDIT_CDP_SEARCH;
		else process.env.REDDIT_CDP_SEARCH = prev;
		if (prevProfile === undefined) delete process.env.CDP_PROFILE_DIR;
		else process.env.CDP_PROFILE_DIR = prevProfile;
	}
});
