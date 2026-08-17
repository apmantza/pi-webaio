import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BrowserCdpTransport,
	CdpTransportError,
} from "../bin/cdp-browser-transport.mjs";
import {
	GoogleCdpBroker,
	TARGET_MARKER_PREFIX,
	brokerProfileHashFor,
} from "../bin/google-cdp-broker.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket extends EventEmitter {
	constructor(url, behavior = {}) {
		super();
		this.url = url;
		this.behavior = behavior;
		this.sent = [];
		this.readyState = 0;
		setImmediate(() => {
			this.readyState = 1;
			this.emit("open");
		});
	}

	send(payload) {
		let message;
		try {
			message = JSON.parse(payload);
		} catch (error) {
			this.emit("error", error);
			return;
		}
		this.sent.push(message);
		this.behavior.onCommand?.(this, message);
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		setImmediate(() => this.emit("close"));
	}

	respond(message) {
		this.emit("message", JSON.stringify(message));
	}
}

function fakeTransport(behavior = {}) {
	let socket;
	const transport = new BrowserCdpTransport({
		port: 9222,
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({
				Browser: "FakeChrome/1",
				webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
			}),
		}),
		WebSocketImpl: class extends FakeSocket {
			constructor(url) {
				super(url, behavior);
				socket = this;
			}
		},
		connectTimeoutMs: 100,
		defaultTimeoutMs: 100,
	});
	return {
		transport,
		get socket() {
			return socket;
		},
	};
}

function respondToCommands(behavior = {}) {
	return (socket, message) => {
		if (behavior.delay?.has(message.method)) return;
		let result = behavior.results?.[message.method];
		if (result === undefined && message.method === "Target.createTarget")
			result = { targetId: "private-target-1" };
		if (result === undefined && message.method === "Target.attachToTarget")
			result = { sessionId: "private-session-1" };
		if (result === undefined && message.method === "Target.getTargets")
			result = {
				targetInfos:
					typeof behavior.targetInfos === "function"
						? behavior.targetInfos()
						: (behavior.targetInfos ?? []),
			};
		if (
			result === undefined &&
			message.method === "Runtime.evaluate" &&
			message.params?.expression === "location.href"
		)
			result = { result: { value: "about:blank" } };
		if (result === undefined) result = {};
		setImmediate(() => {
			socket.respond({ id: message.id, sessionId: message.sessionId, result });
		});
	};
}

function respondToSearch(behavior = {}) {
	let evaluationCount = 0;
	let currentLocation = "about:blank";
	return (socket, message) => {
		if (behavior.delay?.has(message.method)) return;
		let result;
		if (message.method === "Target.createTarget")
			result = { targetId: "private-search-target" };
		else if (message.method === "Target.attachToTarget")
			result = { sessionId: "private-search-session" };
		else if (message.method === "Page.navigate") {
			if (behavior.navigationError && message.params?.url !== "about:blank")
				result = { errorText: behavior.navigationError };
			else if (behavior.resetError && message.params?.url === "about:blank")
				result = { errorText: behavior.resetError };
			else {
				currentLocation = message.params?.url || currentLocation;
				result = {};
			}
		} else if (
			message.method === "Runtime.evaluate" &&
			message.params?.expression === "location.href"
		) {
			result = { result: { value: currentLocation } };
		} else if (message.method === "Runtime.evaluate") {
			const next = behavior.evaluationResults?.[evaluationCount++];
			result = {
				result: {
					value: next || {
						ready: true,
						results: [
							{
								title: "Example result",
								url: "https://example.test/result",
								snippet: "Example snippet",
							},
						],
					},
				},
			};
		} else result = {};
		setImmediate(() =>
			socket.respond({ id: message.id, sessionId: message.sessionId, result }),
		);
	};
}

class Client {
	constructor(socketPath) {
		this.socketPath = socketPath;
		this.socket = null;
		this.buffer = "";
		this.nextId = 1;
		this.pending = new Map();
		this.identity = {};
	}

	async connect() {
		const net = await import("node:net");
		this.socket = net.default.createConnection(this.socketPath);
		this.socket.on("data", (chunk) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line) continue;
				let response;
				try {
					response = JSON.parse(line);
				} catch {
					continue;
				}
				const pending = this.pending.get(response.id);
				if (!pending) continue;
				this.pending.delete(response.id);
				if (response.ok) pending.resolve(response.result);
				else
					pending.reject(
						Object.assign(new Error(response.error.message), response.error),
					);
			}
		});
		await new Promise((resolve, reject) => {
			this.socket.once("connect", resolve);
			this.socket.once("error", reject);
		});
		return this;
	}

	request(op, fields = {}) {
		const id = `cdp-${this.nextId++}`;
		const body = { id, op, ...fields };
		if (op !== "register" && op !== "health") Object.assign(body, this.identity);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.write(`${JSON.stringify(body)}\n`);
		});
	}

	async register() {
		const result = await this.request("register", {
			clientId: "cdp-test-client",
			sessionId: "cdp-test-session",
		});
		this.identity = {
			clientId: result.clientId,
			sessionId: result.sessionId,
			capability: result.capability,
		};
	}

	close() {
		this.socket?.destroy();
	}
}

async function setupBroker(behavior = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-cdp-test-"));
	const fake = fakeTransport(behavior);
	const broker = new GoogleCdpBroker({
		profileDir: root,
		connectCdp: true,
		cdpTransport: fake.transport,
	});
	const started = await broker.start();
	assert.equal(started.ok, true, JSON.stringify(started));
	const client = await new Client(broker.socketPath).connect();
	await client.register();
	return { root, broker, client, fake };
}

async function teardown(setup) {
	setup.client.close();
	await setup.broker.stop();
	await rm(setup.root, { recursive: true, force: true });
}

test("browser transport routes browser and session responses/events", async () => {
	const fake = fakeTransport();
	await fake.transport.connect();
	const events = [];
	fake.transport.onSessionEvent("session-1", (event) => events.push(event));
	const browserRequest = fake.transport.send("Browser.getVersion");
	const sessionRequest = fake.transport.send(
		"Runtime.enable",
		{},
		{ sessionId: "session-1" },
	);
	const sent = fake.socket.sent;
	assert.equal(sent[0].id, 1);
	assert.equal(sent[1].id, 2);
	assert.equal(sent[1].sessionId, "session-1");
	fake.socket.respond({
		id: 2,
		sessionId: "session-1",
		result: { enabled: true },
	});
	fake.socket.respond({
		method: "Runtime.consoleAPICalled",
		sessionId: "session-1",
		params: {},
	});
	fake.socket.respond({ id: 1, result: { product: "FakeChrome" } });
	assert.deepEqual(await browserRequest, { product: "FakeChrome" });
	assert.deepEqual(await sessionRequest, { enabled: true });
	assert.equal(events[0].sessionId, "session-1");
	await fake.transport.close();
});

test("transport rejects pending requests once and fences cancellation, deadlines, and late responses", async () => {
	const behavior = { delay: new Set(["Slow.command"]) };
	const fake = fakeTransport(behavior);
	await fake.transport.connect();
	const controller = new AbortController();
	const cancelled = fake.transport.send(
		"Slow.command",
		{},
		{ signal: controller.signal },
	);
	controller.abort();
	await assert.rejects(cancelled, (error) => error.code === "request_fenced");
	fake.socket.respond({ id: 1, result: { late: true } });
	assert.equal(fake.transport.pending.size, 0);
	const deadline = fake.transport.send(
		"Slow.command",
		{},
		{ deadlineAt: Date.now() + 5 },
	);
	await assert.rejects(deadline, (error) => error.code === "request_fenced");
	const disconnect = fake.transport.send("Slow.command");
	fake.socket.close();
	await assert.rejects(disconnect, (error) => error.code === "cdp_disconnected");
	assert.equal(fake.transport.pending.size, 0);
	assert.equal(fake.transport.generation, 2);
	await fake.transport.close();
});

test("CDP broker owns target lifecycle and never exposes CDP IDs", async () => {
	const setup = await setupBroker({ onCommand: respondToCommands() });
	try {
		const lease = await setup.client.request("lease", {
			provider: "google-search",
		});
		assert.equal(lease.mode, "cdp");
		assert.equal("targetId" in lease, false);
		// The startup crash-orphan sweep (#95 P2 item 2) fires an initial
		// Target.getTargets; the first createTarget follows it.
		const createIndex = setup.fake.socket.sent.findIndex(
			(message) => message.method === "Target.createTarget",
		);
		assert.ok(createIndex >= 0, "createTarget should be sent");
		assert.equal(
			setup.fake.socket.sent[createIndex].method,
			"Target.createTarget",
		);
		assert.deepEqual(setup.fake.socket.sent[createIndex].params, {
			url: setup.broker.targetMarker,
		});
		assert.equal(
			setup.fake.socket.sent[createIndex + 1].method,
			"Target.attachToTarget",
		);
		assert.deepEqual(setup.fake.socket.sent[createIndex + 1].params, {
			targetId: "private-target-1",
			flatten: true,
		});
		assert.equal(setup.fake.socket.sent[createIndex + 1].sessionId, undefined);
		await setup.client.request("reset", {
			leaseId: lease.leaseId,
			generation: lease.generation,
		});
		const resetNavigate = setup.fake.socket.sent.find(
			(message) => message.method === "Page.navigate",
		);
		assert.equal(resetNavigate?.method, "Page.navigate");
		assert.deepEqual(resetNavigate?.params, { url: "about:blank" });
		assert.equal(resetNavigate?.sessionId, "private-session-1");
		await setup.client.request("release", {
			leaseId: lease.leaseId,
			generation: lease.generation,
		});
		await assert.rejects(
			setup.client.request("release", {
				leaseId: lease.leaseId,
				targetId: "forged",
			}),
			(error) => error.code === "invalid_request",
		);
	} finally {
		await teardown(setup);
	}
});

test("CDP loss bumps generation, quarantines targets, and rejects in-flight lifecycle work", async () => {
	const behavior = { delay: new Set(["Target.createTarget"]) };
	const setup = await setupBroker({ onCommand: respondToCommands(behavior) });
	try {
		const pending = setup.client.request("lease", {
			provider: "google-search",
		});
		await sleep(5);
		setup.fake.socket.close();
		await assert.rejects(pending, (error) =>
			["cdp_disconnected", "request_fenced"].includes(error.code),
		);
		await sleep(5);
		const health = await setup.client.request("health");
		assert.equal(health.cdp.connected, false);
		assert.equal(health.cdp.generation, 2);
		assert.equal(health.registry.targets, 0);
		assert.equal(health.registry.active, 0);
	} finally {
		await teardown(setup);
	}
});

test("failed attach closes the private target", async () => {
	// Use a command responder that emits a protocol error for attach.
	const behavior = {
		onCommand(socket, message) {
			if (message.method === "Target.createTarget")
				return setImmediate(() =>
					socket.respond({
						id: message.id,
						result: { targetId: "private-target-2" },
					}),
				);
			if (message.method === "Target.attachToTarget")
				return setImmediate(() =>
					socket.respond({
						id: message.id,
						error: { message: "attach failed" },
					}),
				);
			if (message.method === "Target.closeTarget")
				return setImmediate(() => socket.respond({ id: message.id, result: {} }));
		},
	};
	const fake = fakeTransport(behavior);
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-cdp-failure-"));
	const broker = new GoogleCdpBroker({
		profileDir: root,
		connectCdp: true,
		cdpTransport: fake.transport,
	});
	assert.equal((await broker.start()).ok, true);
	const client = await new Client(broker.socketPath).connect();
	await client.register();
	try {
		await assert.rejects(
			client.request("lease", { provider: "google-search" }),
			(error) => error.code === "cdp_error",
		);
		await sleep(5);
		assert.equal(fake.socket.sent.at(-1).method, "Target.closeTarget");
		assert.equal(broker.registry.snapshot().active, 0);
	} finally {
		client.close();
		await broker.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("broker-owned search navigates canonically, extracts results, resets, and releases", async () => {
	const setup = await setupBroker({
		onCommand: respondToSearch({
			evaluationResults: [
				{ ready: false, results: [] },
				{
					ready: true,
					results: [
						{
							title: "First",
							url: "https://example.test/first",
							snippet: "First snippet",
						},
						{
							title: "Second",
							url: "https://example.test/second",
							snippet: "Second snippet",
						},
					],
				},
			],
		}),
	});
	try {
		const result = await setup.client.request("search", {
			provider: "google-search",
			query: "pi broker",
			maxResults: 2,
		});
		assert.deepEqual(result.results, [
			{
				title: "First",
				url: "https://example.test/first",
				snippet: "First snippet",
			},
			{
				title: "Second",
				url: "https://example.test/second",
				snippet: "Second snippet",
			},
		]);
		assert.equal(result.url, "https://www.google.com/search?q=pi+broker&num=2");
		// Search phase timings are additive on the envelope, numeric, and
		// non-negative on a successful fake-CDP search.
		assert.ok(result.timings, "search envelope carries timings");
		for (const key of [
			"targetSetupMs",
			"navigationMs",
			"extractionMs",
			"resetMs",
		]) {
			assert.equal(
				typeof result.timings[key],
				"number",
				`timings.${key} is a number`,
			);
			assert.ok(Number.isFinite(result.timings[key]), `timings.${key} is finite`);
			assert.ok(result.timings[key] >= 0, `timings.${key} is non-negative`);
		}
		assert.equal(setup.broker.registry.snapshot().active, 0);
		assert.equal(setup.broker.registry.snapshot().targets, 1);
		const searchNavigation = setup.fake.socket.sent.find(
			(message) =>
				message.method === "Page.navigate" &&
				message.params?.url?.includes("/search?"),
		);
		assert.equal(
			searchNavigation?.params.url,
			"https://www.google.com/search?q=pi+broker&num=2",
		);
		const evaluations = setup.fake.socket.sent.filter(
			(message) => message.method === "Runtime.evaluate",
		);
		assert.ok(evaluations.length >= 3);
		assert.equal(typeof evaluations[0].params.expression, "string");
		assert.equal(evaluations[0].params.expression, "location.href");
		assert.equal(
			evaluations.some((message) =>
				message.params.expression.includes("pi broker"),
			),
			false,
		);
		const resetNavigation = setup.fake.socket.sent.find(
			(message) =>
				message.method === "Page.navigate" && message.params?.url === "about:blank",
		);
		assert.ok(resetNavigation);
	} finally {
		await teardown(setup);
	}
});

test("pagination navigates ?start=10 and merges a second SERP page end-to-end", async () => {
	// Fake-CDP integration test for the real paginated flow (MEDIUM-3 from
	// the adversarial review): exercises the actual Page.navigate →
	// isGoogleSearchLocation verification → per-page extraction interplay
	// across start=0 and start=10, not just the stub merge.
	//
	// Page 1 renders 3 organics (clears the minResults=3 extraction gate);
	// Page 2 (the mock's Page.navigate sets currentLocation, and since
	// isGoogleSearchLocation is start-agnostic the location check passes)
	// renders 2 NEW organics, clearing its scaled-down gate of 2. maxResults
	// 5 → the broker must navigate start=10, extract, merge (5 unique), and
	// return with degraded unset (a full SERP, not an interrupted one).
	const setup = await setupBroker({
		onCommand: respondToSearch({
			evaluationResults: [
				{ ready: false, results: [] },
				{
					ready: true,
					results: [
						{ title: "P1A", url: "https://example.test/p1a", snippet: "S" },
						{ title: "P1B", url: "https://example.test/p1b", snippet: "S" },
						{ title: "P1C", url: "https://example.test/p1c", snippet: "S" },
					],
				},
				{ ready: true, results: [] },
				{
					ready: true,
					results: [
						{ title: "P2A", url: "https://example.test/p2a", snippet: "S" },
						{ title: "P2B", url: "https://example.test/p2b", snippet: "S" },
					],
				},
			],
		}),
	});
	try {
		const result = await setup.client.request("search", {
			provider: "google-search",
			query: "pi pages",
			maxResults: 5,
		});
		assert.deepEqual(
			result.results.map((r) => r.title),
			["P1A", "P1B", "P1C", "P2A", "P2B"],
			"merged across ?start=0 and ?start=10, page order preserved",
		);
		const paginatedNavigation = setup.fake.socket.sent.find(
			(message) =>
				message.method === "Page.navigate" &&
				message.params?.url?.includes("start=10"),
		);
		assert.ok(
			paginatedNavigation,
			"a page-2 navigation with ?start=10 was issued",
		);
		assert.equal(result.degraded, undefined, "full SERP: degraded flag unset");
		assert.equal(setup.broker.registry.snapshot().active, 0);
	} finally {
		await teardown(setup);
	}
});

test("search validates bounded inputs and rejects broker escape hatches", async () => {
	const setup = await setupBroker({ onCommand: respondToSearch() });
	try {
		for (const fields of [
			{ query: "   ", maxResults: 1 },
			{ query: "valid", maxResults: 26 },
			{ query: "valid", maxResults: 1, targetId: "forged" },
			{ query: "valid", maxResults: 1, expression: "alert(1)" },
			{ query: "valid", maxResults: 1, url: "https://evil.test" },
		]) {
			await assert.rejects(
				setup.client.request("search", {
					provider: "google-search",
					...fields,
				}),
				(error) => error.code === "invalid_request",
			);
		}
		// The startup crash-orphan sweep sends an initial Target.getTargets
		// (#95 P2 item 2); the invalid requests themselves must not have
		// reached CDP.
		assert.equal(
			setup.fake.socket.sent.filter((m) => m.method !== "Target.getTargets")
				.length,
			0,
		);
	} finally {
		await teardown(setup);
	}
});

test("registry-only search returns cdp_required without allocating a lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-search-registry-"));
	const broker = new GoogleCdpBroker({ profileDir: root });
	assert.equal((await broker.start()).ok, true);
	const client = await new Client(broker.socketPath).connect();
	try {
		await client.register();
		await assert.rejects(
			client.request("search", {
				provider: "google-search",
				query: "registry mode",
				maxResults: 1,
			}),
			(error) => error.code === "cdp_required",
		);
		assert.equal(broker.registry.snapshot().active, 0);
	} finally {
		client.close();
		await broker.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("search deadline and cancellation quarantine the private target", async () => {
	const setup = await setupBroker({
		onCommand: respondToSearch({ delay: new Set(["Runtime.evaluate"]) }),
	});
	try {
		await assert.rejects(
			setup.client.request("search", {
				provider: "google-search",
				query: "deadline",
				maxResults: 1,
				deadlineAt: Date.now() + 30,
			}),
			(error) => ["request_fenced", "deadline_expired"].includes(error.code),
		);
		await sleep(5);
		assert.equal(setup.broker.registry.snapshot().active, 0);
		assert.equal(setup.broker.registry.snapshot().targets, 0);
		assert.equal(setup.fake.socket.sent.at(-1).method, "Target.closeTarget");
	} finally {
		await teardown(setup);
	}

	const cancelled = await setupBroker({
		onCommand: respondToSearch({ delay: new Set(["Runtime.evaluate"]) }),
	});
	try {
		const search = cancelled.client.request("search", {
			provider: "google-search",
			query: "cancel",
			maxResults: 1,
		});
		await sleep(10);
		await cancelled.client.request("cancel", { requestId: "cdp-2" });
		await assert.rejects(search, (error) => error.code === "request_fenced");
		assert.equal(cancelled.broker.registry.snapshot().active, 0);
		assert.equal(cancelled.broker.registry.snapshot().targets, 0);
		assert.equal(cancelled.fake.socket.sent.at(-1).method, "Target.closeTarget");
	} finally {
		await teardown(cancelled);
	}
});

test("navigation and reset failures dirty and close the target", async () => {
	for (const behavior of [
		{ navigationError: "net::ERR_FAILED" },
		{ resetError: "net::ERR_RESET" },
	]) {
		const setup = await setupBroker({ onCommand: respondToSearch(behavior) });
		try {
			await assert.rejects(
				setup.client.request("search", {
					provider: "google-search",
					query: "dirty target",
					maxResults: 1,
				}),
				(error) =>
					["cdp_error", "navigation_failed", "reset_failed"].includes(error.code),
			);
			await sleep(5);
			assert.equal(setup.broker.registry.snapshot().active, 0);
			assert.equal(setup.broker.registry.snapshot().targets, 0);
			assert.equal(setup.fake.socket.sent.at(-1).method, "Target.closeTarget");
		} finally {
			await teardown(setup);
		}
	}
});

test("broker search waits past a partial mid-render snapshot before returning (#101)", async () => {
	// Regression for the partial-result bug: extraction previously returned
	// on the FIRST successful poll, so a mid-render snapshot of 1 result was
	// served instead of the full set. The mock yields 1 result first, then 4;
	// the broker must poll again and return the fuller set.
	const setup = await setupBroker({
		onCommand: respondToSearch({
			evaluationResults: [
				{ ready: false, results: [] },
				{
					ready: true,
					results: [
						{ title: "Only", url: "https://example.test/only", snippet: "Partial" },
					],
				},
				{
					ready: true,
					results: [
						{ title: "First", url: "https://example.test/first", snippet: "S1" },
						{ title: "Second", url: "https://example.test/second", snippet: "S2" },
						{ title: "Third", url: "https://example.test/third", snippet: "S3" },
						{ title: "Fourth", url: "https://example.test/fourth", snippet: "S4" },
					],
				},
			],
		}),
	});
	try {
		const result = await setup.client.request("search", {
			provider: "google-search",
			query: "pi partial",
			// maxResults == the scripted page-1 set, so pagination never
			// triggers and the test stays focused on the partial-snapshot
			// wait (issue #101). With a larger max the broker now paginates,
			// which would consume the mock's default "Example result"
			// fallback and change the assertion.
			maxResults: 4,
		});
		assert.deepEqual(
			result.results.map((r) => r.title),
			["First", "Second", "Third", "Fourth"],
			"broker must wait for the fuller result set, not the 1-result snapshot",
		);
	} finally {
		await teardown(setup);
	}
});

// ─── Crash-orphan target recovery (#95 P2 item 2) ─────────────────

test("startup sweep closes marker-owned orphans from a prior broker generation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-orphan-test-"));
	const orphanHash = brokerProfileHashFor(root);
	const orphanId = "prior-gen-orphan-1";
	const unrelatedId = "user-tab-1";
	const otherProfileId = "other-profile-1";
	// Simulate a prior broker that crashed: its marker URL carries the same
	// profile hash but a DIFFERENT nonce than this instance's.
	const priorNonce = "prior-broker-nonce";
	const fake = fakeTransport({
		onCommand: respondToCommands({
			targetInfos: [
				{
					targetId: orphanId,
					url: `${TARGET_MARKER_PREFIX}${orphanHash}:${priorNonce}`,
				},
				{
					targetId: unrelatedId,
					url: "https://example.test/user-page",
				},
				{
					targetId: otherProfileId,
					url: `${TARGET_MARKER_PREFIX}someotherhash:${priorNonce}`,
				},
			],
		}),
	});
	const broker = new GoogleCdpBroker({
		profileDir: root,
		connectCdp: true,
		cdpTransport: fake.transport,
	});
	const started = await broker.start();
	assert.equal(started.ok, true, JSON.stringify(started));
	try {
		const closed = fake.socket.sent.filter(
			(message) => message.method === "Target.closeTarget",
		);
		assert.equal(closed.length, 1, "exactly one orphan target must be closed");
		assert.equal(
			closed[0]?.params?.targetId,
			orphanId,
			"the prior-generation marker orphan is the one closed",
		);
	} finally {
		await broker.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("startup sweep preserves this generation's own marker targets", async () => {
	const ownId = "own-gen-target";
	// A target with THIS instance's marker (same profile hash + nonce) is
	// created by the live broker itself and must never be closed.
	const setup = await setupBroker({
		onCommand: respondToCommands({
			targetInfos: [
				{
					targetId: ownId,
					url: `${TARGET_MARKER_PREFIX}dummyhash:dummynonce`,
				},
			],
		}),
	});
	try {
		// Manually simulate this broker owning the target (post-sweep attach).
		setup.broker.cdpTargets.set("own", {
			targetId: "own",
			cdpTargetId: ownId,
		});
		// Re-run the sweep; the target is owned by this instance -> skipped.
		const closed = await setup.broker.recoverOrphanTargets();
		assert.equal(closed, 0, "owned target must not be closed");
	} finally {
		await teardown(setup);
	}
});

test("startup sweep survives close failures and skips non-marker targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-closefail-test-"));
	const failHash = brokerProfileHashFor(root);
	const failId = "close-fail-target";
	const keepId = "keep-target";
	const calls = [];
	const fake = fakeTransport({
		onCommand: (socket, message) => {
			if (message.method === "Target.getTargets") {
				calls.push(message.method);
				socket.respond({
					id: message.id,
					sessionId: message.sessionId,
					result: {
						targetInfos: [
							{
								targetId: failId,
								url: `${TARGET_MARKER_PREFIX}${failHash}:prior-nonce`,
							},
							{
								targetId: keepId,
								url: "https://example.test/unrelated",
							},
						],
					},
				});
				return;
			}
			if (message.method === "Target.closeTarget") {
				calls.push(message.method);
				// Simulate a close failure: respond with an error.
				setImmediate(() =>
					socket.respond({
						id: message.id,
						sessionId: message.sessionId,
						error: { message: "close failed" },
					}),
				);
				return;
			}
			socket.respond({
				id: message.id,
				sessionId: message.sessionId,
				result: {},
			});
		},
	});
	const broker = new GoogleCdpBroker({
		profileDir: root,
		connectCdp: true,
		cdpTransport: fake.transport,
	});
	const started = await broker.start();
	assert.equal(started.ok, true, JSON.stringify(started));
	try {
		// Sweep already ran at startup; verify it attempted the close once
		// and did not throw (best-effort), and never closed the unrelated tab.
		assert.equal(calls.filter((c) => c === "Target.closeTarget").length, 1);
		assert.equal(
			calls.filter((c) => c === "Target.closeTarget").length +
				calls.filter((c) => c === "Target.getTargets").length,
			2,
		);
		assert.equal(broker.runtimeError, null);
	} finally {
		await broker.stop();
		await rm(root, { recursive: true, force: true });
	}
});

assert.equal(CdpTransportError.prototype instanceof Error, true);
