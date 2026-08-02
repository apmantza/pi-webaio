/**
 * Tests for the Reddit CDP search vertical.
 *
 * These tests verify:
 * 1. searchReddit returns null when Chrome is unavailable (no env gate)
 * 2. The CDP path works when Chrome is running (manual smoke test)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

const { searchReddit } = await import("../src/verticals/reddit_search.ts");

test("Reddit search: returns null when Chrome DevToolsActivePort is missing", async () => {
	const prevProfile = process.env.CDP_PROFILE_DIR;
	// Point to a non-existent profile directory
	process.env.CDP_PROFILE_DIR = "/tmp/nonexistent-reddit-cdp-profile-xyz";

	try {
		const result = await searchReddit("langchain");
		assert.strictEqual(
			result,
			null,
			"should return null when Chrome is unavailable",
		);
	} finally {
		if (prevProfile === undefined) delete process.env.CDP_PROFILE_DIR;
		else process.env.CDP_PROFILE_DIR = prevProfile;
	}
});
