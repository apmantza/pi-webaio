/**
 * Tests for the Reddit vertical's network-block detection.
 *
 * The original bug: extractReddit returned ok:false with empty content
 * when Reddit's anti-bot wall blocked us. The pullPageEnhanced wrapper
 * ignored vertical.ok and treated the result as success with empty
 * content — leaving the user with no error message and no body.
 *
 * The fix:
 *   1. extractReddit detects the specific block reasons (network security,
 *      rate limit, server error) and returns a clear error message.
 *   2. pullPageEnhanced honors vertical.ok:false and propagates the error.
 *
 * These tests stub the global fetch to simulate Reddit's responses
 * without making real network calls.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Build a fake Reddit block page — the 403 body is ~190KB of mostly
 * CSS with the diagnostic message at the very end. The stub returns
 * the same shape so the detection code exercises the real path.
 */
function buildBlockPage(marker = "You've been blocked by network security.") {
	// ~180KB of CSS-like padding, then the marker at the end (mirroring
	// the real Reddit 403 page where the marker is at byte 189,327).
	const padding = "x".repeat(180000);
	return (
		padding +
		marker +
		" If you think you've been blocked by mistake, file a ticket below."
	);
}

/**
 * Stub global fetch with a Reddit simulator. Routes by URL suffix:
 *   - <post>.json   → 403 + block page
 *   - <post>        → 200 + "Please wait for verification" page
 *   - reddit.com/.json → 200 + "[]" (working control)
 */
function stubRedditFetch(opts = {}) {
	const originalFetch = globalThis.fetch;
	const blockBody = opts.blockBody ?? buildBlockPage();
	const verifyBody =
		opts.verifyBody ?? "Please wait for verification. " + "x".repeat(8000);

	globalThis.fetch = async (url) => {
		const u = String(url);
		if (opts.overrides?.[u]) {
			const o = opts.overrides[u];
			return new Response(o.body, {
				status: o.status,
				headers: { "content-type": o.type || "text/html" },
			});
		}
		if (u.endsWith("/.json")) {
			// Reddit home .json
			return new Response("[]", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (u.endsWith(".json")) {
			// Post .json
			return new Response(blockBody, {
				status: 403,
				headers: { "content-type": "text/html" },
			});
		}
		// Main HTML page
		return new Response(verifyBody, {
			status: 200,
			headers: { "content-type": "text/html" },
		});
	};
	return () => {
		globalThis.fetch = originalFetch;
	};
}

const { extractReddit } = await import("../src/verticals/reddit.ts");

// ─── Network block detection ───────────────────────────────────────

test("Reddit: network block produces specific error message", async () => {
	const restore = stubRedditFetch();
	try {
		const result = await extractReddit(
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/",
			async (u) => {
				const res = await fetch(u);
				if (!res.ok) return null;
				const text = await res.text();
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			},
		);
		assert.strictEqual(result?.ok, false);
		assert.ok(result?.error, "should have an error message");
		// The new error should mention the network block, not just "unavailable"
		assert.ok(
			/anti-bot|blocked|network security/i.test(result.error),
			`error should mention the block reason. got: ${result.error}`,
		);
		// CRITICAL: result.ok must be false (the original bug was that
		// pullPageEnhanced treated vertical.ok:false as ok:true)
		assert.strictEqual(result.content, "");
	} finally {
		restore();
	}
});

test("Reddit: rate-limit (403 without block marker) reports rate limit", async () => {
	const restore = stubRedditFetch({
		blockBody: "rate limit exceeded. try again in 5 minutes.",
	});
	try {
		const result = await extractReddit(
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/",
			async (u) => {
				const res = await fetch(u);
				if (!res.ok) return null;
				const text = await res.text();
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			},
		);
		assert.strictEqual(result?.ok, false);
		assert.ok(result?.error);
		// Should mention rate-limit
		assert.ok(
			/rate.?limit|403|wait/i.test(result.error),
			`error should mention rate limit. got: ${result.error}`,
		);
	} finally {
		restore();
	}
});

test("Reddit: 5xx server error reports server error", async () => {
	const restore = stubRedditFetch({
		overrides: {
			// The .json URL is built by url.replace(/\/?$/, ".json"), which
			// strips the trailing slash. Override the no-slash variant.
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test.json": {
				body: "Internal Server Error",
				status: 503,
			},
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/": {
				body: "Internal Server Error",
				status: 503,
			},
		},
	});
	try {
		const result = await extractReddit(
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/",
			async (u) => {
				const res = await fetch(u);
				if (!res.ok) return null;
				const text = await res.text();
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			},
		);
		assert.strictEqual(result?.ok, false);
		assert.ok(result?.error);
		assert.ok(
			/503|server error|temporarily/i.test(result.error),
			`error should mention 503 / server error. got: ${result.error}`,
		);
	} finally {
		restore();
	}
});

test("Reddit: Reddit fully down (both main and home fail) reports network down", async () => {
	const restore = stubRedditFetch({
		overrides: {
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/": {
				body: "Service Unavailable",
				status: 503,
			},
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test.json": {
				body: "Service Unavailable",
				status: 503,
			},
			"https://www.reddit.com/.json": {
				body: "Service Unavailable",
				status: 503,
			},
		},
	});
	try {
		const result = await extractReddit(
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/",
			async (u) => {
				const res = await fetch(u);
				if (!res.ok) return null;
				const text = await res.text();
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			},
		);
		assert.strictEqual(result?.ok, false);
		assert.ok(result?.error);
		assert.ok(
			/both|temporarily down|down from this network/i.test(result.error),
			`error should mention both endpoints failing. got: ${result.error}`,
		);
	} finally {
		restore();
	}
});

test("Reddit: 404 on post reports post-not-found", async () => {
	const restore = stubRedditFetch({
		overrides: {
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/": {
				body: "page not found",
				status: 404,
			},
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test.json": {
				body: "page not found",
				status: 404,
			},
		},
	});
	try {
		const result = await extractReddit(
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/",
			async (u) => {
				const res = await fetch(u);
				if (!res.ok) return null;
				const text = await res.text();
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			},
		);
		assert.strictEqual(result?.ok, false);
		assert.ok(result?.error);
		assert.ok(
			/404|deleted|not found/i.test(result?.error ?? ""),
			`error should mention 404 / deleted. got: ${result?.error}`,
		);
	} finally {
		restore();
	}
});

test("Reddit: working .json returns parsed post data", async () => {
	// Stub: .json returns valid Reddit listing shape
	const restore = stubRedditFetch({
		overrides: {
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test.json": {
				body: JSON.stringify([
					{
						data: {
							children: [
								{
									data: {
										title: "Test Post",
										author: "tester",
										subreddit: "ZaiGLM",
										score: 42,
										num_comments: 7,
										selftext: "Hello world",
										permalink: "/r/ZaiGLM/comments/abc/test/",
										created_utc: 1700000000,
									},
								},
							],
						},
					},
					{
						data: {
							children: [],
						},
					},
				]),
				status: 200,
				type: "application/json",
			},
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/": {
				body: "<html>ok</html>",
				status: 200,
			},
			"https://www.reddit.com/.json": {
				body: "[]",
				status: 200,
				type: "application/json",
			},
		},
	});
	try {
		const result = await extractReddit(
			"https://www.reddit.com/r/ZaiGLM/comments/abc/test/",
			async (u) => {
				const res = await fetch(u);
				if (!res.ok) return null;
				const text = await res.text();
				try {
					return JSON.parse(text);
				} catch {
					return null;
				}
			},
		);
		assert.strictEqual(result?.ok, true);
		assert.strictEqual(result?.title, "Test Post");
		assert.ok(result?.content?.includes("Test Post"));
		assert.ok(result?.content?.includes("r/ZaiGLM"));
	} finally {
		restore();
	}
});

test("Reddit: matchesReddit matches post URLs", async () => {
	const { matchesReddit } = await import("../src/verticals/reddit.ts");
	assert.strictEqual(
		matchesReddit("https://www.reddit.com/r/ZaiGLM/comments/abc/test/"),
		true,
	);
	assert.strictEqual(
		matchesReddit("https://reddit.com/r/ZaiGLM/comments/abc/test/"),
		true,
	);
	assert.strictEqual(
		matchesReddit("https://www.reddit.com/r/ZaiGLM/"),
		false,
		"subreddit root should not match",
	);
	assert.strictEqual(
		matchesReddit("https://example.com/r/ZaiGLM/comments/abc/"),
		false,
		"non-reddit host should not match",
	);
});
