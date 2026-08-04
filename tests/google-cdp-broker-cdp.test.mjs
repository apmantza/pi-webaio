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
import { GoogleCdpBroker } from "../bin/google-cdp-broker.mjs";

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
		if (op !== "register" && op !== "health")
			Object.assign(body, this.identity);
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
	await assert.rejects(
		disconnect,
		(error) => error.code === "cdp_disconnected",
	);
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
		assert.equal(setup.fake.socket.sent[0].method, "Target.createTarget");
		assert.deepEqual(setup.fake.socket.sent[0].params, { url: "about:blank" });
		assert.equal(setup.fake.socket.sent[1].method, "Target.attachToTarget");
		assert.deepEqual(setup.fake.socket.sent[1].params, {
			targetId: "private-target-1",
			flatten: true,
		});
		assert.equal(setup.fake.socket.sent[1].sessionId, undefined);
		await setup.client.request("reset", {
			leaseId: lease.leaseId,
			generation: lease.generation,
		});
		assert.equal(setup.fake.socket.sent[2].method, "Page.navigate");
		assert.deepEqual(setup.fake.socket.sent[2].params, { url: "about:blank" });
		assert.equal(setup.fake.socket.sent[2].sessionId, "private-session-1");
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
				return setImmediate(() =>
					socket.respond({ id: message.id, result: {} }),
				);
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
				message.method === "Page.navigate" &&
				message.params?.url === "about:blank",
		);
		assert.ok(resetNavigation);
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
		assert.equal(setup.fake.socket.sent.length, 0);
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
		assert.equal(
			cancelled.fake.socket.sent.at(-1).method,
			"Target.closeTarget",
		);
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
					["cdp_error", "navigation_failed", "reset_failed"].includes(
						error.code,
					),
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

assert.equal(CdpTransportError.prototype instanceof Error, true);
