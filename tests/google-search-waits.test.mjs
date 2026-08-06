import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isGoogleSearchUrl,
	jsEvalLiteral,
	submitSearch,
	waitForCondition,
} from "../extractors/google-search.mjs";

test("jsEvalLiteral escapes code-generation hazards", () => {
	const literal = jsEvalLiteral('</script>\u2028\u2029');
	assert.equal(literal, '"\\u003c/script\\u003e\\u2028\\u2029"');
});

test("isGoogleSearchUrl accepts Google search URLs and rejects lookalikes", () => {
	assert.equal(
		isGoogleSearchUrl(
			"https://www.google.com/search?q=pi+coding+agent&hl=en",
			"pi coding agent",
		),
		true,
	);
	for (const host of [
		"www.google.de",
		"www.google.fr",
		"www.google.ca",
		"www.google.co.uk",
		"www.google.com.br",
	]) {
		assert.equal(
			isGoogleSearchUrl(
				`https://${host}/search?q=pi+coding+agent`,
				"pi coding agent",
			),
			true,
			host,
		);
	}
	assert.equal(
		isGoogleSearchUrl(
			"https://evil.example/search?q=pi+coding+agent",
			"pi coding agent",
		),
		false,
	);
	assert.equal(
		isGoogleSearchUrl(
			"https://www.google.com/search?q=other",
			"pi coding agent",
		),
		false,
	);
});

test("submitSearch propagates CDP submission failures", async () => {
	await assert.rejects(
		() =>
			submitSearch("tab", async () => {
				throw new Error("submit failed");
			}),
		/submit failed/,
	);
	let expression = "";
	await submitSearch("tab", async (_args) => {
		expression = _args[2];
		return "";
	});
	assert.match(expression, /HTMLFormElement\.prototype\.submit\.call/);
	assert.match(expression, /Google search form is unavailable/);
});

test("waitForCondition returns an immediately available value without sleeping", async () => {
	let sleeps = 0;
	const value = await waitForCondition(async () => "ready", {
		timeoutMs: 100,
		sleepFn: async () => {
			sleeps++;
		},
	});
	assert.equal(value, "ready");
	assert.equal(sleeps, 0);
});

test("waitForCondition retries with bounded intervals until ready", async () => {
	let attempts = 0;
	let now = 0;
	const sleeps = [];
	const value = await waitForCondition(
		async () => {
			attempts++;
			return attempts === 3 ? true : null;
		},
		{
			timeoutMs: 1000,
			intervalMs: 100,
			nowFn: () => now,
			sleepFn: async (ms) => {
				sleeps.push(ms);
				now += ms;
			},
		},
	);
	assert.equal(value, true);
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [100, 100]);
});

test("waitForCondition forwards remaining time to each probe", async () => {
	let now = 0;
	const probeBudgets = [];
	const value = await waitForCondition(
		async (probeTimeoutMs) => {
			probeBudgets.push(probeTimeoutMs);
			return probeBudgets.length === 2 ? true : null;
		},
		{
			timeoutMs: 250,
			intervalMs: 100,
			nowFn: () => now,
			sleepFn: async (ms) => {
				now += ms;
			},
		},
	);
	assert.equal(value, true);
	assert.deepEqual(probeBudgets, [250, 150]);
});

test("waitForCondition returns null at the deadline", async () => {
	let now = 0;
	const sleeps = [];
	const value = await waitForCondition(async () => null, {
		timeoutMs: 250,
		intervalMs: 100,
		nowFn: () => now,
		sleepFn: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
	});
	assert.equal(value, null);
	assert.deepEqual(sleeps, [100, 100, 50]);
});
