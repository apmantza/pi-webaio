import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWebsearchTool } from "../src/tools/websearch.ts";
import { buildEngineStatusMap } from "../src/search.ts";

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

test("websearch returns at the response target and marks late Reddit as timeout", async () => {
	let redditStarted = false;
	let observedEngineDeadline = 0;
	const registered = [];

	registerWebsearchTool(
		{
			registerTool(tool) {
				registered.push(tool);
			},
		},
		{
			loadGoggles: async () => ({ name: "test", rules: [] }),
			searchWeb: async (_query, _goggles, options) => {
				observedEngineDeadline = options?.engineDeadlineMs ?? 0;
				return {
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
					engineStatus: buildEngineStatusMap([
						{ id: "ddg", httpStatus: 200, count: 1, latencyMs: 5 },
					]),
				};
			},
			ensureChrome: async () => ({ running: true, ready: true }),
			googleSearch: async () => ({
				results: [
					{
						title: "Google result",
						url: "https://example.com/google",
						snippet: "google",
					},
				],
			}),
			searchReddit: async () => {
				redditStarted = true;
				return new Promise(() => {});
			},
			cdpAvailable: () => true,
			providerAvailable: () => true,
			searchDeadlineMs: 500,
			responseTargetMs: 50,
			httpEngineDeadlineMs: 40,
			googleLaneMaxMs: 50,
		},
	);

	const started = Date.now();
	const result = await registered[0].execute("test-call", {
		query: "response-target-reddit-timeout",
		google: true,
		max: 10,
	});
	const elapsed = Date.now() - started;

	assert.ok(
		elapsed < 250,
		`response target should return promptly, took ${elapsed}ms`,
	);
	assert.equal(observedEngineDeadline, 40);
	assert.equal(redditStarted, true);
	assert.equal(result.details.timedOut, true);
	assert.equal(result.details.responseBudgetMs, 50);
	assert.equal(result.details.googleCount, 1);
	assert.equal(result.details.redditCount, 0);
	assert.match(result.details.redditStatus, /response budget 50ms/);
	assert.equal(result.details.engineStatus.reddit.status, "timeout");
	assert.equal(result.details.engineStatus.reddit.latencyMs, 50);
	assert.match(result.content[0].text, /Google:1/);
	assert.match(result.content[0].text, /Reddit: timed out after/);
});

test("websearch synthesizes HTTP engine timeouts when HTTP misses the response target", async () => {
	const registered = [];

	registerWebsearchTool(
		{
			registerTool(tool) {
				registered.push(tool);
			},
		},
		{
			loadGoggles: async () => ({ name: "test", rules: [] }),
			searchWeb: async () => new Promise(() => {}),
			ensureChrome: async () => ({ running: true, ready: true }),
			googleSearch: async () => ({
				results: [
					{
						title: "Google only",
						url: "https://example.com/google-only",
						snippet: "google",
					},
				],
			}),
			searchReddit: async () => ({ ok: true, elapsed: 1, results: [] }),
			cdpAvailable: () => true,
			providerAvailable: (provider) => provider !== "reddit",
			searchDeadlineMs: 500,
			responseTargetMs: 40,
			httpEngineDeadlineMs: 35,
			googleLaneMaxMs: 40,
		},
	);

	const started = Date.now();
	const result = await registered[0].execute("test-call", {
		query: "response-target-http-timeout",
		google: true,
		max: 10,
	});
	const elapsed = Date.now() - started;

	assert.ok(
		elapsed < 250,
		`response target should return promptly, took ${elapsed}ms`,
	);
	assert.equal(result.details.timedOut, true);
	assert.equal(result.details.googleCount, 1);
	for (const id of ["ddg", "brave", "yahoo", "bing"]) {
		assert.equal(result.details.engineStatus[id].status, "timeout");
		assert.equal(result.details.engineStatus[id].latencyMs, 40);
	}
	assert.match(result.content[0].text, /Google:1/);
	assert.match(result.content[0].text, /DDG: timed out after/);
});

test("websearch classifies searchReddit's own response-budget miss as timeout, not error", async () => {
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
				engineStatus: buildEngineStatusMap([
					{ id: "ddg", httpStatus: 200, count: 1, latencyMs: 5 },
				]),
			}),
			ensureChrome: async () => ({ running: true, ready: true }),
			googleSearch: async () => ({ results: [] }),
			// Simulate searchReddit noticing the deadline itself and returning its
			// ok:false + "response budget" error marker (#97 adversarial review).
			searchReddit: async () => ({
				ok: false,
				query: "x",
				count: 0,
				results: [],
				elapsed: 40,
				error: "Reddit search missed the aio-websearch response budget",
			}),
			cdpAvailable: () => true,
			providerAvailable: () => true,
			searchDeadlineMs: 500,
			responseTargetMs: 50,
			httpEngineDeadlineMs: 40,
			googleLaneMaxMs: 40,
		},
	);

	const result = await registered[0].execute("test-call", {
		query: "reddit-budget-miss-classification",
		google: true,
		max: 10,
	});

	assert.match(result.details.redditStatus, /^timeout \(response budget/);
	assert.equal(result.details.engineStatus.reddit.status, "timeout");
});

test("websearch serializes Reddit CDP after Google when both lanes are enabled", async () => {
	const events = [];
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
				events.push("google-start");
				await new Promise((resolve) => setTimeout(resolve, 20));
				events.push("google-done");
				return {
					results: [
						{
							title: "Google result",
							url: "https://example.com/google",
							snippet: "google",
						},
					],
				};
			},
			searchReddit: async () => {
				events.push("reddit-start");
				assert.deepEqual(events, ["google-start", "google-done", "reddit-start"]);
				return { ok: true, elapsed: 1, results: [] };
			},
			cdpAvailable: () => true,
			providerAvailable: () => true,
		},
	);

	const result = await registered[0].execute("test-call", {
		query: "cdp-lane-ordering",
		google: true,
		max: 10,
	});

	assert.deepEqual(events, ["google-start", "google-done", "reddit-start"]);
	assert.equal(result.details.googleCount, 1);
});
