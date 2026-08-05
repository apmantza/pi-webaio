import assert from "node:assert/strict";
import { test } from "node:test";
import {
	googleSearchWithDependencies,
	isBrokerInfrastructureError,
} from "../src/google-ai.ts";

const savedFlag = process.env.PI_WEBAIO_CDP_BROKER;

function restoreFlag() {
	if (savedFlag === undefined) delete process.env.PI_WEBAIO_CDP_BROKER;
	else process.env.PI_WEBAIO_CDP_BROKER = savedFlag;
}

const output = (query) => ({
	query,
	url: "https://www.google.com/search",
	results: [],
});

test("Google broker branch is opt-in and legacy remains the default", async () => {
	delete process.env.PI_WEBAIO_CDP_BROKER;
	let legacyCalls = 0;
	let brokerCalls = 0;
	try {
		const result = await googleSearchWithDependencies(
			"legacy",
			{},
			{
				legacySearch: async (query) => {
					legacyCalls++;
					return output(query);
				},
				connectBroker: async () => {
					brokerCalls++;
					throw new Error("must not connect");
				},
			},
		);
		assert.equal(result.query, "legacy");
		assert.equal(legacyCalls, 1);
		assert.equal(brokerCalls, 0);
	} finally {
		restoreFlag();
	}
});

test("broker branch passes deadline and returns the existing output shape", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let ensured = false;
	let received;
	try {
		const result = await googleSearchWithDependencies(
			"broker",
			{ timeoutMs: 2000, maxResults: 4 },
			{
				ensureChrome: async () => {
					ensured = true;
					return { running: true, ready: true };
				},
				connectBroker: async (options) => {
					received = options;
					return {
						search: async (query, searchOptions) => {
							assert.equal(searchOptions.maxResults, 4);
							assert.equal(searchOptions.deadlineAt, options.deadlineAt);
							return output(query);
						},
						close() {},
					};
				},
			},
		);
		assert.equal(ensured, true);
		assert.equal(typeof received.deadlineAt, "number");
		assert.equal(result.query, "broker");
	} finally {
		restoreFlag();
	}
});

test("broker branch passes search timings through additively", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const timings = {
		targetSetupMs: 12.5,
		navigationMs: 34,
		extractionMs: 5.25,
		resetMs: 3,
	};
	try {
		const withTimings = await googleSearchWithDependencies(
			"timings",
			{ timeoutMs: 2000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					search: async (query) => ({ ...output(query), timings }),
					close() {},
				}),
			},
		);
		assert.equal(withTimings.query, "timings");
		assert.deepEqual(withTimings.timings, timings);

		// A broker that reports no timings leaves the shape untouched.
		const withoutTimings = await googleSearchWithDependencies(
			"no-timings",
			{ timeoutMs: 2000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					search: async (query) => output(query),
					close() {},
				}),
			},
		);
		assert.equal("timings" in withoutTimings, false);

		// The legacy path never carries timings.
		delete process.env.PI_WEBAIO_CDP_BROKER;
		const legacy = await googleSearchWithDependencies("legacy-shape", {}, {
			legacySearch: async (query) => output(query),
		});
		assert.equal("timings" in legacy, false);
	} finally {
		restoreFlag();
	}
});

test("broker startup/IPC failure falls back only with budget remaining", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let legacyCalls = 0;
	try {
		const result = await googleSearchWithDependencies(
			"fallback",
			{ timeoutMs: 2000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => {
					throw Object.assign(new Error("pipe closed"), {
						code: "connection_closed",
					});
				},
				legacySearch: async (query, options) => {
					legacyCalls++;
					assert.ok(options.deadlineAt > Date.now());
					return output(query);
				},
			},
		);
		assert.equal(result.query, "fallback");
		assert.equal(legacyCalls, 1);

		const expired = Date.now() + 100;
		await assert.rejects(
			googleSearchWithDependencies(
				"no-fallback",
				{ deadlineAt: expired, timeoutMs: 100 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => {
						throw Object.assign(new Error("pipe closed"), {
							code: "connection_closed",
						});
					},
					legacySearch: async () => {
						throw new Error("legacy should not run");
					},
				},
			),
			(error) => error.code === "connect_timeout",
		);
	} finally {
		restoreFlag();
	}
});

test("navigation/search failures are not converted into successful fallback results", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	try {
		await assert.rejects(
			googleSearchWithDependencies(
				"navigation-failure",
				{ timeoutMs: 2000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => ({
						search: async () => {
							throw Object.assign(new Error("navigation failed"), {
								code: "navigation_failed",
							});
						},
						close() {},
					}),
					legacySearch: async () => output("incorrect-fallback"),
				},
			),
			(error) => error.code === "navigation_failed",
		);
	} finally {
		restoreFlag();
	}
});

test("broker infrastructure classification is narrow", () => {
	assert.equal(
		isBrokerInfrastructureError({ code: "connection_closed" }),
		true,
	);
	assert.equal(
		isBrokerInfrastructureError({ code: "navigation_failed" }),
		false,
	);
	assert.equal(isBrokerInfrastructureError(new Error("plain")), false);
});
