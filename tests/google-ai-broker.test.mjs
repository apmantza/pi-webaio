import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test } from "node:test";
import { brokerPaths } from "../bin/google-cdp-broker.mjs";
import {
	closeGoogleBroker,
	googleSearchWithDependencies,
	isBrokerInfrastructureError,
	notifyGoogleBrokerProcessEventForTests,
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

function makeBrokerProcessFactory({ registerDelayMs = 0, failFirstSearch = false, failFirstSpawn = false } = {}) {
	// Never reuse the production/default endpoint: a previous fake server may
	// still be draining when the next test starts. The readiness promise also
	// makes tests wait for listen(2), rather than racing EADDRINUSE/ECONNREFUSED.
	const profileDir = `fake-broker-${randomUUID()}`;
	const path = brokerPaths(profileDir).socketPath;
	const children = [];
	let calls = 0;
	const factory = () => {
		calls++;
		const child = new EventEmitter();
		child.exitCode = null;
		child.signalCode = null;
		child.stdin = { end() {} };
		child.killCalls = 0;
		child.kill = () => {
			child.killCalls++;
			return true;
		};
		let resolveReady;
		let rejectReady;
		const ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const server = net.createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const request = JSON.parse(line);
					const respond = (result, error) =>
						socket.write(`${JSON.stringify({ id: request.id, ...(error ? { ok: false, error } : { ok: true, result }) })}\n`);
					if (request.op === "register") {
						setTimeout(
							() => respond({ capability: "c".repeat(64), heartbeatTtlMs: 60_000 }),
							registerDelayMs,
						);
					} else if (request.op === "heartbeat") {
						respond({});
					} else if (request.op === "search" && failFirstSearch && calls === 1) {
						respond(undefined, { code: "connection_closed", message: "fake child failure" });
					} else if (request.op === "search") {
						respond(output(request.query));
					}
				}
			});
		});
		server.once("error", rejectReady);
		if (!(failFirstSpawn && calls === 1)) server.listen(path, () => resolveReady());
		else {
			resolveReady();
			setTimeout(() => child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })), 0);
		}
		child.ready = ready;
		child.exitNow = () => {
			if (child.exitCode !== null) return;
			child.exitCode = 0;
			server.close();
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
		};
		children.push(child);
		return child;
	};
	factory.calls = () => calls;
	factory.children = children;
	factory.profileDir = () => profileDir;
	factory.waitForChild = async () => {
		while (children.length === 0)
			await new Promise((resolve) => setTimeout(resolve, 1));
		await children[0].ready;
		return children[0];
	};
	return factory;
}

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
		assert.match(envelope.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		assert.equal(captured.includes(`\"requestId\":\"${envelope.requestId}\"`), true);
		assert.equal(typeof envelope.queryHash, "string");
		assert.match(envelope.queryHash, /^[0-9a-f]{64}$/);
		assert.deepEqual(Object.keys(envelope).filter((key) => key === "schema" || key === "requestId" || key === "queryHash"), ["schema", "requestId", "queryHash"]);
		assert.equal(captured.includes("private broker query"), false);
	} finally {
		restoreFlag();
	}
});

test("broker envelope preserves its schema for adversarial query text", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	try {
		for (const query of ["q", "schema", "requestId", "quote \\\" } ,\\n { \\\"schema\\\":\\\"bad\\\" }"]) {
			const { captured } = await captureBrokerDiagnostic(() =>
				googleSearchWithDependencies(query, { timeoutMs: 2000 }, {
					ensureChrome: async () => ({ running: true, ready: true }),
					connectBroker: async () => ({
						search: async (value) => output(value),
						close() {},
					}),
				}),
			);
			const envelope = parseEnvelope(captured);
			assert.equal(envelope.schema, "pi-webaio.broker-attempt");
			assert.equal(envelope.provider, "google-search");
			assert.equal(envelope.queryLength, query.length);
			assert.equal(Object.hasOwn(envelope, "schema"), true);
			assert.equal(Object.hasOwn(envelope, "requestId"), true);
		}
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

test("late connector resolution is closed after caller abort", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const controller = new AbortController();
	let resolveConnect;
	let closeCalls = 0;
	try {
		const pendingConnect = new Promise((resolve) => { resolveConnect = resolve; });
		const request = googleSearchWithDependencies(
			"late connector",
			{ timeoutMs: 2000, signal: controller.signal },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => {
					controller.abort();
					return pendingConnect;
				},
			},
		);
		await assert.rejects(request, (error) => error.code === "request_fenced");
		const lateClient = {
			search: async () => output("unused"),
			close: () => { closeCalls++; },
		};
		resolveConnect(lateClient);
		const closeDeadline = Date.now() + 500;
		while (closeCalls === 0 && Date.now() < closeDeadline)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(closeCalls, 1);
	} finally {
		restoreFlag();
	}
});

test("two cancelled waiters close one late connector exactly once", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const firstController = new AbortController();
	const secondController = new AbortController();
	let resolveConnect;
	let closeCalls = 0;
	const pendingConnect = new Promise((resolve) => { resolveConnect = resolve; });
	const dependencies = {
		ensureChrome: async () => ({ running: true, ready: true }),
		connectBroker: async () => pendingConnect,
	};
	try {
		const first = googleSearchWithDependencies("late-one", { timeoutMs: 500, signal: firstController.signal }, dependencies);
		const second = googleSearchWithDependencies("late-two", { timeoutMs: 500, signal: secondController.signal }, dependencies);
		firstController.abort();
		secondController.abort();
		await assert.rejects(first, (error) => error.code === "request_fenced");
		await assert.rejects(second, (error) => error.code === "request_fenced");
		resolveConnect({ search: async () => output("unused"), close: () => { closeCalls++; } });
		const deadline = Date.now() + 500;
		while (closeCalls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(closeCalls, 1);
	} finally {
		restoreFlag();
	}
});

test("an old late client is not closed after a newer generation adopts it", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const controller = new AbortController();
	let resolveOld;
	let releaseNewSearch;
	let markNewSearchStarted;
	let closeCalls = 0;
	const newSearchStarted = new Promise((resolve) => { markNewSearchStarted = resolve; });
	const newSearchGate = new Promise((resolve) => { releaseNewSearch = resolve; });
	const oldClient = {
		search: async (query) => {
			markNewSearchStarted();
			await newSearchGate;
			return output(query);
		},
		close: () => { closeCalls++; },
	};
	const oldAttempt = new Promise((resolve) => { resolveOld = resolve; });
	try {
		const newer = googleSearchWithDependencies(
			"new generation",
			{ timeoutMs: 2_000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => oldClient,
			},
		);
		await newSearchStarted;

		const oldRequest = googleSearchWithDependencies(
			"old generation",
			{ timeoutMs: 2_000, signal: controller.signal },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => oldAttempt,
			},
		);
		controller.abort();
		await assert.rejects(oldRequest, (error) => error.code === "request_fenced");
		resolveOld(oldClient);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(closeCalls, 0);

		releaseNewSearch();
		assert.equal((await newer).query, "new generation");
	} finally {
		releaseNewSearch?.();
		await closeGoogleBroker();
		restoreFlag();
	}
	assert.equal(closeCalls, 1);
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

test("the final envelope boundary redacts short credentials and spaced broker ID labels", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const query = "short envelope query";
	const values = [
		"Authorization: Bearer b",
		"Authorization: Basic x",
		"a.b.c",
		"Target ID: target-short",
		"Session ID = session-short",
		"Client ID client-short",
		"api_key=ak",
		"cookies: ck",
		"client_secret cs",
		"cdpTargetId=ct",
		"cdpSessionId: csid",
		"leaseId lid",
		"requestId=rid",
	];
	try {
		const { captured } = await captureBrokerDiagnostic(() =>
			googleSearchWithDependencies(query, { timeoutMs: 2000 }, {
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					search: async () => {
						throw Object.assign(new Error(
							`Authorization: Bearer b; Authorization: Basic x; token=a.b.c; Target ID: target-short; Session ID = session-short; Client ID client-short; api_key=ak; cookies: ck; client_secret cs; cdpTargetId=ct; cdpSessionId: csid; leaseId lid; requestId=rid`,
						), { code: "connection_closed" });
					},
					close() {},
				}),
				legacySearch: async (value) => output(value),
			}),
		);
		for (const value of [query, ...values]) assert.equal(captured.includes(value), false, value);
		assert.match(captured, /redacted-authorization/);
		assert.match(captured, /redacted-id/);
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

test("cleanup timeout is bounded and does not block the next broker acquisition", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let connectCalls = 0;
	try {
		await assert.rejects(
			googleSearchWithDependencies("cleanup-timeout", { timeoutMs: 2000 }, {
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					search: async () => { throw Object.assign(new Error("broker failed"), { code: "connection_closed" }); },
					close() {},
				}),
				cleanupBroker: async () => new Promise(() => {}),
				legacySearch: async () => output("wrong"),
			}),
			(error) => error.code === "connection_closed",
		);
		const started = Date.now();
		const result = await googleSearchWithDependencies("after-cleanup-timeout", { timeoutMs: 2000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => {
				connectCalls++;
				return { search: async (query) => output(query), close() {} };
			},
		});
		assert.equal(result.query, "after-cleanup-timeout");
		assert.equal(connectCalls, 1);
		assert.ok(Date.now() - started < 1000);
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

test("disconnected broker clients are retired before replacement", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let connectCalls = 0;
	let oldCloseCalls = 0;
	const oldClient = { connected: false, search: async (query) => output(query), close: () => { oldCloseCalls++; } };
	const replacement = { connected: true, search: async (query) => output(query), close() {} };
	try {
		await googleSearchWithDependencies("disconnected", { timeoutMs: 2_000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => connectCalls++ === 0 ? oldClient : replacement,
		});
		assert.equal((await googleSearchWithDependencies("replacement", { timeoutMs: 2_000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => replacement,
		})).query, "replacement");
		assert.equal(oldCloseCalls, 1);
	} finally {
		await closeGoogleBroker();
		restoreFlag();
	}
});

test("runtime broker disable closes existing resources before legacy", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let closeCalls = 0;
	try {
		await googleSearchWithDependencies("broker-resource", { timeoutMs: 2_000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => ({ search: async (query) => output(query), close: () => { closeCalls++; } }),
		});
		delete process.env.PI_WEBAIO_CDP_BROKER;
		assert.equal((await googleSearchWithDependencies("legacy-after-toggle", {}, {
			legacySearch: async (query) => output(query),
		})).query, "legacy-after-toggle");
		assert.equal(closeCalls, 1);
	} finally {
		restoreFlag();
		await closeGoogleBroker();
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

test("close coalescing keeps expected-client and unqualified races distinct", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let releaseClose;
	const closeGate = new Promise((resolve) => { releaseClose = resolve; });
	let closeCalls = 0;
	const client = { search: async (query) => output(query), close: () => { closeCalls++; return closeGate; } };
	try {
		await googleSearchWithDependencies("close-race", { timeoutMs: 2_000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => client,
		});
		const expected = closeGoogleBroker(client);
		const unqualified = closeGoogleBroker();
		assert.notEqual(expected, unqualified);
		releaseClose();
		await Promise.all([expected, unqualified]);
		assert.equal(closeCalls, 1);
	} finally {
		await closeGoogleBroker();
		restoreFlag();
	}
});

test("a process-event fence defers shared-client teardown until the last user releases", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	let searchStarts = 0;
	let releaseSecond;
	const secondMayFinish = new Promise((resolve) => { releaseSecond = resolve; });
	let closeCalls = 0;
	const sharedClient = {
		search: async (query) => {
			searchStarts++;
			if (query === "first") {
				while (searchStarts < 2) await new Promise((resolve) => setTimeout(resolve, 1));
				await notifyGoogleBrokerProcessEventForTests(sharedClient);
				throw Object.assign(new Error("process exited"), { code: "connection_closed" });
			}
			await secondMayFinish;
			return output(query);
		},
		close: () => { closeCalls++; },
	};
	try {
		const first = googleSearchWithDependencies("first", { timeoutMs: 2000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => sharedClient,
			legacySearch: async (query) => output(`legacy-${query}`),
		});
		const second = googleSearchWithDependencies("second", { timeoutMs: 2000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			connectBroker: async () => sharedClient,
			legacySearch: async (query) => output(`legacy-${query}`),
		});
		const firstResult = await first;
		assert.equal(firstResult.query, "legacy-first");
		assert.equal(closeCalls, 0);
		releaseSecond();
		assert.equal((await second).query, "second");
		assert.equal(closeCalls, 1);
	} finally {
		restoreFlag();
	}
});

test("concurrent profiles do not share broker process or client state", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const firstFactory = makeBrokerProcessFactory({ registerDelayMs: 10 });
	const secondFactory = makeBrokerProcessFactory({ registerDelayMs: 10 });
	try {
		const [first, second] = await Promise.all([
			googleSearchWithDependencies("profile-a", { timeoutMs: 2_000 }, {
				ensureChrome: async () => ({ running: true, ready: true }),
				brokerProcessFactory: firstFactory,
				brokerProfileDir: firstFactory.profileDir(),
			}),
			googleSearchWithDependencies("profile-b", { timeoutMs: 2_000 }, {
				ensureChrome: async () => ({ running: true, ready: true }),
				brokerProcessFactory: secondFactory,
				brokerProfileDir: secondFactory.profileDir(),
			}),
		]);
		assert.equal(first.query, "profile-a");
		assert.equal(second.query, "profile-b");
		assert.equal(firstFactory.calls(), 1);
		assert.equal(secondFactory.calls(), 1);
	} finally {
		firstFactory.children.at(-1)?.exitNow();
		secondFactory.children.at(-1)?.exitNow();
		await closeGoogleBroker();
		restoreFlag();
	}
});

test("shared broker startup survives one caller aborting", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const factory = makeBrokerProcessFactory({ registerDelayMs: 35 });
	const controller = new AbortController();
	try {
		const first = googleSearchWithDependencies(
			"aborted startup waiter",
			{ timeoutMs: 2_000, signal: controller.signal },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				brokerProcessFactory: factory,
				brokerProfileDir: factory.profileDir(),
			},
		);
		await factory.waitForChild();
		setTimeout(() => controller.abort(), 5);
		const second = googleSearchWithDependencies(
			"surviving startup waiter",
			{ timeoutMs: 2_000 },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				brokerProcessFactory: factory,
				brokerProfileDir: factory.profileDir(),
			},
		);
		await assert.rejects(first, (error) => error.code === "request_fenced");
		assert.equal((await second).query, "surviving startup waiter");
		assert.equal(factory.calls(), 1);
	} finally {
		factory.children.at(-1)?.exitNow();
		await closeGoogleBroker();
		restoreFlag();
	}
});

test("shared startup is reaped when every waiter fences", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const factory = makeBrokerProcessFactory({ registerDelayMs: 35 });
	const firstController = new AbortController();
	const secondController = new AbortController();
	const unhandledRejections = [];
	const onUnhandledRejection = (error) => unhandledRejections.push(error);
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		const first = googleSearchWithDependencies(
			"fully fenced startup one",
			{ timeoutMs: 2_000, signal: firstController.signal },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				brokerProcessFactory: factory,
				brokerProfileDir: factory.profileDir(),
			},
		);
		const second = googleSearchWithDependencies(
			"fully fenced startup two",
			{ timeoutMs: 2_000, signal: secondController.signal },
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				brokerProcessFactory: factory,
				brokerProfileDir: factory.profileDir(),
			},
		);
		await factory.waitForChild();
		setTimeout(() => {
			firstController.abort();
			secondController.abort();
		}, 5);
		await assert.rejects(first, (error) => error.code === "request_fenced");
		await assert.rejects(second, (error) => error.code === "request_fenced");
		const reapDeadline = Date.now() + 700;
		while (factory.children[0]?.killCalls !== 1 && Date.now() < reapDeadline)
			await new Promise((resolve) => setTimeout(resolve, 5));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(factory.calls(), 1);
		assert.equal(factory.children[0].killCalls, 1);
		assert.deepEqual(unhandledRejections, []);
	} finally {
		factory.children.at(-1)?.exitNow();
		await closeGoogleBroker();
		restoreFlag();
		process.removeListener("unhandledRejection", onUnhandledRejection);
	}
});

test("spawn error without a child is terminal without permanently fencing replacement", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const factory = makeBrokerProcessFactory({ failFirstSpawn: true });
	try {
		const result = await googleSearchWithDependencies("after-spawn-error", { timeoutMs: 2_000 }, {
			ensureChrome: async () => ({ running: true, ready: true }),
			brokerProcessFactory: factory,
			brokerProfileDir: factory.profileDir(),
		});
		assert.equal(result.query, "after-spawn-error");
		assert.ok(factory.calls() >= 2);
	} finally {
		factory.children.at(-1)?.exitNow();
		await closeGoogleBroker();
		restoreFlag();
	}
});

test("actual ensure/child cleanup fences replacement until child exit", async () => {
	process.env.PI_WEBAIO_CDP_BROKER = "1";
	const factory = makeBrokerProcessFactory({ failFirstSearch: true });
	try {
		await assert.rejects(
			googleSearchWithDependencies(
				"child cleanup failure",
				{ timeoutMs: 2_000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					brokerProcessFactory: factory,
					brokerProfileDir: factory.profileDir(),
				},
			),
			(error) => error.code === "connection_closed",
		);
		assert.equal(factory.calls(), 1);
		// The bounded outer cleanup fence may settle just before the inner process
		// teardown timer; wait for the documented kill side effect without allowing
		// the test to race that bounded cleanup.
		const killDeadline = Date.now() + 500;
		while (factory.children[0].killCalls === 0 && Date.now() < killDeadline)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(factory.children[0].killCalls, 1);

		await assert.rejects(
			googleSearchWithDependencies(
				"must not overlap",
				{ timeoutMs: 120 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					brokerProcessFactory: factory,
					brokerProfileDir: factory.profileDir(),
				},
			),
			(error) => error.code === "connect_timeout" || error.code === "broker_process_pending",
		);
		assert.equal(factory.calls(), 1);

		factory.children[0].exitNow();
		assert.equal(
			(await googleSearchWithDependencies(
				"replacement after exit",
				{ timeoutMs: 2_000 },
				{
					ensureChrome: async () => ({ running: true, ready: true }),
					brokerProcessFactory: factory,
					brokerProfileDir: factory.profileDir(),
				},
			)).query,
			"replacement after exit",
		);
		assert.equal(factory.calls(), 2);
	} finally {
		factory.children.at(-1)?.exitNow();
		await closeGoogleBroker();
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
