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

async function captureBrokerDiagnostic(fn) {
	const previousDebug = process.env.PI_WEBAIO_DEBUG;
	const previousError = console.error;
	let captured = "";
	process.env.PI_WEBAIO_DEBUG = "1";
	console.error = (...args) => {
		captured += args.map(String).join(" ") + "\n";
	};
	try {
		const value = await fn();
		return { value, captured };
	} finally {
		console.error = previousError;
		if (previousDebug === undefined) delete process.env.PI_WEBAIO_DEBUG;
		else process.env.PI_WEBAIO_DEBUG = previousDebug;
	}
}

function parseEnvelope(captured) {
	const match = captured.match(/\[pi-webaio:broker\] (\{.*\})/);
	assert.ok(match, `missing broker envelope: ${captured}`);
	return JSON.parse(match[1]);
}

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
		const legacy = await googleSearchWithDependencies(
			"legacy-shape",
			{},
			{
				legacySearch: async (query) => output(query),
			},
		);
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
			(error) => error.code === "connection_closed",
		);
	} finally {
		restoreFlag();
	}
});

test("navigation and extraction failures fall back through a fresh legacy path", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let closeCalls = 0;
	let legacyCalls = 0;
	try {
		for (const code of ["navigation_failed", "extraction_failed"]) {
			const result = await googleSearchWithDependencies(
			`${code}-query`,
			{ timeoutMs: 2000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					search: async () => {
						throw Object.assign(new Error(`${code} with broker target`), {
							code,
						});
					},
					close() {
						closeCalls++;
					},
				}),
				legacySearch: async (query) => {
					legacyCalls++;
					return output(query);
				},
				cleanupBroker: async (client) => client?.close(),
			},
			);
			assert.equal(result.query, `${code}-query`);
		}
		assert.equal(legacyCalls, 2);
		assert.equal(closeCalls, 2);
	} finally {
		restoreFlag();
	}
});

test("successful broker attempts emit a diagnostic envelope without result-shape changes", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	try {
		const { value, captured } = await captureBrokerDiagnostic(() =>
			googleSearchWithDependencies(
				"private broker query",
				{ timeoutMs: 2000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => ({
						search: async (query) => output(query),
						close() {},
					}),
				},
			),
		);
		const envelope = parseEnvelope(captured);
		assert.equal(value.query, "private broker query");
		assert.equal(envelope.schema, "pi-webaio.broker-attempt");
		assert.equal(envelope.version, 1);
		assert.equal(envelope.provider, "google-search");
		assert.equal(envelope.outcome, "success");
		assert.equal(envelope.fallbackOutcome, "not_attempted");
		assert.equal(envelope.queryLength, "private broker query".length);
		assert.equal(typeof envelope.queryHash, "string");
		assert.equal(captured.includes("private broker query"), false);
	} finally {
		restoreFlag();
	}
});

test("broker envelope sanitizes query, target, and capability data", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const query = "do not log this query";
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			googleSearchWithDependencies(
				query,
				{ timeoutMs: 2000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => ({
						search: async () => {
							throw Object.assign(
								new Error(
									`navigation failed for ${query}; target=0123456789abcdef0123456789abcdef capability=secret`,
								),
								{ code: "navigation_failed" },
							);
						},
						close() {},
					}),
					legacySearch: async (value) => output(value),
				},
			),
		);
		const envelope = parseEnvelope(captured);
		assert.equal(envelope.outcome, "failure");
		assert.equal(envelope.fallbackOutcome, "succeeded");
		assert.equal(envelope.phase, "navigation");
		assert.equal(captured.includes(query), false);
		assert.equal(captured.includes("0123456789abcdef0123456789abcdef"), false);
		assert.equal(captured.includes("capability=secret"), false);
	} finally {
		restoreFlag();
	}
});

test("explicit abort skips fallback and fences a late broker rejection", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const controller = new AbortController();
	let legacyCalls = 0;
	let unhandled = 0;
	const onUnhandled = () => {
		unhandled++;
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const brokerPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("late broker rejection")), 30);
		});
		const pending = googleSearchWithDependencies(
			"cancelled",
			{ timeoutMs: 500, signal: controller.signal },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					search: async () => brokerPromise,
					close() {},
				}),
				legacySearch: async () => {
					legacyCalls++;
					return output("wrong");
				},
			},
		);
		setTimeout(() => controller.abort(), 5);
		await assert.rejects(
			pending,
			(error) => error.code === "request_fenced",
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(legacyCalls, 0);
		assert.equal(unhandled, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		restoreFlag();
	}
});

test("expired broker deadlines skip fallback and preflight every broker callback", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let ensureCalls = 0;
	let connectCalls = 0;
	let searchCalls = 0;
	let legacyCalls = 0;
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			assert.rejects(
				googleSearchWithDependencies(
					"expired",
					{ deadlineAt: Date.now() - 1, timeoutMs: 1 },
					{
						ensureChrome: async () => {
							ensureCalls++;
							return { running: true, ready: true };
						},
						connectBroker: async () => {
							connectCalls++;
							return {
								search: async () => {
									searchCalls++;
									return output("wrong");
								},
								close() {},
							};
						},
						legacySearch: async () => {
							legacyCalls++;
							return output("wrong");
						},
					},
				),
				(error) => error.code === "connect_timeout",
			),
		);
		const envelope = parseEnvelope(captured);
		assert.equal(ensureCalls, 0);
		assert.equal(connectCalls, 0);
		assert.equal(searchCalls, 0);
		assert.equal(legacyCalls, 0);
		assert.equal(envelope.fallbackOutcome, "skipped");
		assert.equal(envelope.fallbackReason, "deadline");
	} finally {
		restoreFlag();
	}
});

test("broker diagnostic redacts complete auth credentials and JWTs at the envelope boundary", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const bearer = "Bearer full-bearer-credential-987654321";
	const basic = "Basic dXNlcjpmdWxsLWJhc2ljLXNlY3JldA==";
	const jwt = "eyJhbGciOiJIUzI1NiJ9.full-jwt-payload-987654321.signature-987654321";
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			googleSearchWithDependencies(
				"credential-envelope",
				{ timeoutMs: 2000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => ({
						search: async () => {
							throw Object.assign(
								new Error(
									`Authorization: ${bearer}; Authorization: ${basic}; token=${jwt}`,
								),
								{ code: "connection_closed" },
							);
						},
						close() {},
					}),
					legacySearch: async (query) => output(query),
				},
			),
		);
		const envelope = parseEnvelope(captured);
		const envelopeJson = JSON.stringify(envelope);
		for (const credential of [bearer, basic, jwt]) {
			assert.equal(captured.includes(credential), false, credential);
			assert.equal(envelopeJson.includes(credential), false, credential);
		}
	} finally {
		restoreFlag();
	}
});

test("caller abort fences fallback with a skipped envelope outcome", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const controller = new AbortController();
	controller.abort();
	let ensureCalls = 0;
	let legacyCalls = 0;
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			assert.rejects(
				googleSearchWithDependencies(
					"aborted-before-start",
					{ timeoutMs: 2000, signal: controller.signal },
					{
						ensureChrome: async () => {
							ensureCalls++;
							return { running: true, ready: true };
						},
						legacySearch: async () => {
							legacyCalls++;
							return output("wrong");
						},
					},
				),
				(error) => error.code === "request_fenced",
			),
		);
		const envelope = parseEnvelope(captured);
		assert.equal(ensureCalls, 0);
		assert.equal(legacyCalls, 0);
		assert.equal(envelope.fallbackOutcome, "skipped");
		assert.equal(envelope.fallbackReason, "aborted");
	} finally {
		restoreFlag();
	}
});

test("legacy failure is surfaced after broker failure and is diagnosed", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			assert.rejects(
				googleSearchWithDependencies(
					"legacy failure",
					{ timeoutMs: 2000 },
					{
						ensureChrome: async () => ({ running: true, ready: true }),
						connectBroker: async () => ({
							search: async () => {
								throw Object.assign(new Error("broker down"), {
									code: "connection_closed",
								});
							},
							close() {},
						}),
						legacySearch: async () => {
							throw new Error("legacy path failed");
						},
					},
				),
				(error) => error.message === "legacy path failed",
			),
		);
		const envelope = parseEnvelope(captured);
		assert.equal(envelope.fallbackOutcome, "failed");
	} finally {
		restoreFlag();
	}
});

test("cleanup failures are diagnosed and do not race legacy fallback", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let legacyCalls = 0;
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			assert.rejects(
				googleSearchWithDependencies(
					"cleanup-failure",
					{ timeoutMs: 2000 },
					{
						ensureChrome: async () => ({ running: true, ready: true }),
						connectBroker: async () => ({
							search: async () => {
								throw Object.assign(new Error("broker failed"), {
									code: "connection_closed",
								});
							},
							close() {},
						}),
						cleanupBroker: async () => {
							throw new Error("cleanup did not complete");
						},
						legacySearch: async (query) => {
							legacyCalls++;
							return output(query);
						},
					},
				),
				(error) => error.code === "connection_closed",
			),
		);
		const envelope = parseEnvelope(captured);
		assert.equal(legacyCalls, 0);
		assert.equal(envelope.fallbackOutcome, "skipped");
		assert.equal(envelope.fallbackReason, "cleanup_failed");
		assert.equal(envelope.cleanupOutcome, "failed");
		assert.match(envelope.cleanupError.message, /cleanup did not complete/);
	} finally {
		restoreFlag();
	}
});

test("search-phase connection errors retain the search phase", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			googleSearchWithDependencies(
				"search-phase",
				{ timeoutMs: 2000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => ({
						search: async () => {
							throw Object.assign(new Error("connection closed during search"), {
								code: "connection_closed",
							});
						},
						close() {},
					}),
					legacySearch: async (query) => output(query),
				},
			),
		);
		assert.equal(parseEnvelope(captured).phase, "search");
	} finally {
		restoreFlag();
	}
});

test("concurrent broker users are not closed by one failed fallback", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let searchStarts = 0;
	let releaseBoth;
	const bothSearching = new Promise((resolve) => {
		releaseBoth = resolve;
	});
	let releaseSecond;
	const secondFinished = new Promise((resolve) => {
		releaseSecond = resolve;
	});
	let closeCalls = 0;
	const sharedClient = {
		search: async (query) => {
			searchStarts++;
			if (searchStarts === 2) releaseBoth();
			if (query === "first") {
				await bothSearching;
				throw Object.assign(new Error("shared connection closed"), {
					code: "connection_closed",
				});
			}
			await secondFinished;
			return output(query);
		},
		close: () => {
			closeCalls++;
		},
	};
	try {
		const first = googleSearchWithDependencies(
			"first",
			{ timeoutMs: 2000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => sharedClient,
				cleanupBroker: async (client) => client?.close(),
				legacySearch: async (query) => output(`legacy-${query}`),
			},
		);
		const second = googleSearchWithDependencies(
			"second",
			{ timeoutMs: 2000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => sharedClient,
				cleanupBroker: async (client) => client?.close(),
				legacySearch: async (query) => output(`legacy-${query}`),
			},
		);
		const firstResult = await first;
		assert.equal(firstResult.query, "legacy-first");
		assert.equal(closeCalls, 0);
		releaseSecond();
		const secondResult = await second;
		assert.equal(secondResult.query, "second");
		assert.equal(closeCalls, 0);
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

test("broker client module satisfies the BrokerModule seam contract", async () => {
	// Regression: ensureGoogleBroker() loads this exact module and calls
	// module.brokerPaths() + module.connectGoogleCdpBroker(). A missing
	// export used to fail only at runtime inside the retry loop, silently
	// falling back to legacy for every broker search. Pin the contract here.
	const module = await import("../extractors/google-cdp-broker-client.mjs");
	assert.equal(typeof module.brokerPaths, "function");
	assert.equal(typeof module.connectGoogleCdpBroker, "function");
	const paths = module.brokerPaths();
	assert.equal(typeof paths.socketPath, "string");
	assert.ok(paths.socketPath.length > 0);
});
