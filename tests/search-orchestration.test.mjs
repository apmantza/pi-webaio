import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectProviderResults,
	shouldRunGoogle,
	shouldRunReddit,
} from "../src/search-orchestration.ts";

test("collectProviderResults returns settled providers before the deadline", async () => {
	const result = await collectProviderResults(
		[
			["fast", Promise.resolve("ready")],
			["empty", Promise.reject(new Error("provider failed"))],
		],
		100,
	);

	assert.equal(result.timedOut, false);
	assert.deepEqual(result.values, { fast: "ready" });
});

test("collectProviderResults returns partial results at the deadline", async () => {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const started = Date.now();

	try {
		const result = await collectProviderResults(
			[
				["fast", Promise.resolve("ready")],
				[
					"late",
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("late provider failure")), 40),
					),
				],
			],
			10,
		);

		assert.equal(result.timedOut, true);
		assert.deepEqual(result.values, { fast: "ready" });
		assert.ok(Date.now() - started < 100, "deadline should return promptly");

		// Let the abandoned provider settle. Its rejection must already be
		// observed and must not become a host-level unhandled rejection.
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("shouldRunReddit requires opt-in, CDP, and provider availability", () => {
	assert.equal(shouldRunReddit(true, true, true), true);
	assert.equal(shouldRunReddit(false, true, true), false, "not requested");
	assert.equal(shouldRunReddit(true, false, true), false, "no CDP");
	assert.equal(shouldRunReddit(true, true, false), false, "provider cooled down");
});

test("shouldRunGoogle requires the flag, CDP, and provider availability", () => {
	assert.equal(shouldRunGoogle(true, true, true), true);
	assert.equal(shouldRunGoogle(false, true, true), false);
	assert.equal(shouldRunGoogle(true, false, true), false);
	assert.equal(shouldRunGoogle(true, true, false), false);
});
