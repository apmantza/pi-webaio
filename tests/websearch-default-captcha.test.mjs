import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWebsearchTool } from "../src/tools/websearch.ts";
import { googleSearchWithDependencies } from "../src/google-ai.ts";

function setup(overrides = {}) {
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
			googleSearch: async (_query, options) => {
				if (overrides.googleSearch) return overrides.googleSearch(_query, options);
				return {
					results: Array.from({ length: 8 }, (_, i) => ({
						title: `g${i}`,
						url: `https://example.com/g${i}`,
						snippet: "g",
					})),
					timings: {},
				};
			},
			searchReddit: async () => null,
			cdpAvailable: () => true,
			providerAvailable: () => true,
			...overrides.deps,
		},
	);
	return registered[0];
}

test("websearch max defaults to 8 (no broker SERP pagination on the default path)", async () => {
	let observedMax;
	const tool = setup({
		googleSearch: async (_query, options) => {
			observedMax = options?.maxResults;
			return {
				results: [{ title: "g", url: "https://example.com/g", snippet: "g" }],
				timings: {},
			};
		},
	});
	const result = await tool.execute("t-default", { query: "default max probe" });
	assert.equal(
		observedMax,
		8,
		"googleSearch receives maxResults=8 when max is omitted",
	);
	assert.equal(result.details.googleCount, 1);
});

test("websearch maps captcha_blocked to a blocked googleStatus with count 0", async () => {
	const tool = setup({
		googleSearch: async () => {
			const error = new Error(
				"Google redirected the search to a CAPTCHA page (/sorry/)",
			);
			error.code = "captcha_blocked";
			throw error;
		},
	});
	const result = await tool.execute("t-captcha", {
		query: "captcha status probe",
	});
	assert.equal(result.details.googleCount, 0);
	assert.match(result.details.googleStatus ?? "", /blocked/i);
});

test("captcha_blocked error propagates without legacy fallback (googleSearchWithDependencies)", async () => {
	let legacyCalls = 0;
	await assert.rejects(
		googleSearchWithDependencies(
			"captcha gate tool-level",
			{ maxResults: 8, timeoutMs: 15_000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					connected: true,
					async search() {
						const error = new Error("captcha page (/sorry/)");
						error.code = "captcha_blocked";
						throw error;
					},
					async close() {},
				}),
				legacySearch: async () => {
					legacyCalls++;
					throw new Error("legacy must not run for captcha_blocked");
				},
				cleanupBroker: async () => {},
			},
		),
		(error) => error?.code === "captcha_blocked",
	);
	assert.equal(legacyCalls, 0);
});
