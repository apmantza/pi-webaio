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
/** Poll until fn() is truthy or timeout — deterministic replacement for
 * fixed sleeps when awaiting async broker cleanup under load. */
async function waitFor(fn, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await sleep(10);
	}
	return false;
}

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
			// Readiness-probe expressions carry the `h3:` marker from
			// GOOGLE_SEARCH_READINESS_SCRIPT; serve them from a dedicated queue
			// so tests can pin each gate branch independently of full-script
			// responses. Absent queue => empty result => broker falls back to
			// forceFull (the pre-gate behavior all older tests rely on).
			if (message.params?.expression?.includes("h3:")) {
				const next = behavior.readinessResults?.[behavior._readinessCount ?? 0];
				behavior._readinessCount = (behavior._readinessCount ?? 0) + 1;
				result = next == null ? {} : { result: { value: next } };
			} else {
				behavior._fullEvalCount = (behavior._fullEvalCount ?? 0) + 1;
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
			}
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
