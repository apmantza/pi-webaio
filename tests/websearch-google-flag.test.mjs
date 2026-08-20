import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWebsearchTool } from "../src/tools/websearch.ts";

test("websearch google:false skips Google while preserving Reddit", async () => {
	let googleCalls = 0;
	let redditCalls = 0;
	const registered = [];

	registerWebsearchTool(
		{
			registerTool(tool) {
				registered.push(tool);
			},
		},
		{
			loadGoggles: async () => ({ name: "test", rules: [] }),
			searchWeb: async () => ({
				results: [
					{
						title: "HTTP result",
						url: "https://example.com/http",
						snippet: "http",
						domain: "example.com",
					},
				],
				ddgCount: 1,
				braveCount: 0,
				yahooCount: 0,
				bingCount: 0,
				redditCount: 0,
			}),
			ensureChrome: async () => ({ running: true, ready: true }),
			googleSearch: async () => {
				googleCalls++;
				throw new Error("Google should not run when google:false");
			},
			searchReddit: async () => {
				redditCalls++;
				return {
					ok: true,
					elapsed: 1,
					results: [
						{
							title: "Reddit result",
							url: "https://www.reddit.com/r/test/comments/1",
							subreddit: "test",
							score: 1,
							comments: 2,
						},
					],
				};
			},
			cdpAvailable: () => true,
			providerAvailable: () => true,
		},
	);

	const tool = registered[0];
	assert.ok(tool, "websearch tool must be registered");
	const result = await tool.execute("test-call", {
		query: "google-flag-regression",
		google: false,
		max: 10,
	});

	assert.equal(googleCalls, 0);
	assert.equal(redditCalls, 1);
	assert.equal(result.details.googleCount, 0);
	assert.equal(result.details.redditCount, 1);
	assert.doesNotMatch(result.content[0].text, /Google:/);
	assert.match(result.content[0].text, /Reddit:1/);
});
