import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GoogleCdpBroker,
	LeaseRegistry,
	MAX_FRAME_BYTES,
} from "../bin/google-cdp-broker.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TestClient {
	constructor(socketPath) {
		this.socketPath = socketPath;
		this.nextId = 1;
		this.pending = new Map();
		this.unkeyed = [];
		this.buffer = "";
		this.socket = null;
	}

	async connect() {
		this.socket = net.createConnection(this.socketPath);
		this.socket.on("close", () => {
			const error = Object.assign(new Error("Connection closed"), {
				code: "connection_closed",
			});
			for (const resolve of this.pending.values())
				resolve({ ok: false, error });
			this.pending.clear();
		});
		this.socket.on("data", (chunk) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let response;
				try {
					response = JSON.parse(line);
				} catch {
					continue;
				}
				const pending =
					response.id === null
						? this.unkeyed.shift()
						: this.pending.get(String(response.id)) || this.unkeyed.shift();
				if (!pending) continue;
				if (response.id !== null) this.pending.delete(String(response.id));
				pending(response);
			}
		});
		await new Promise((resolve, reject) => {
			this.socket.once("connect", resolve);
			this.socket.once("error", reject);
		});
		return this;
	}

	send(op, fields = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(String(id), (response) =>
				response.ok
					? resolve(response.result)
					: reject(
							Object.assign(new Error(response.error.message), response.error),
						),
			);
			this.socket.write(`${JSON.stringify({ id, op, ...fields })}\n`);
		});
	}

	raw(line) {
		return new Promise((resolve) => {
			this.unkeyed.push(resolve);
			this.socket.write(`${line}\n`);
		});
	}

	destroy() {
		this.socket?.destroy();
	}
}

async function makeBroker(options = {}) {
	const profileDir = await mkdtemp(join(tmpdir(), "pi-webaio-broker-test-"));
	const broker = new GoogleCdpBroker({ profileDir, ...options });
	const started = await broker.start();
	assert.equal(started.ok, true, JSON.stringify(started));
	return { broker, profileDir };
}

async function stopBroker(testSetup) {
	await testSetup.broker.stop();
	await rm(testSetup.profileDir, { recursive: true, force: true });
}

async function registeredClient(
	broker,
	clientId,
	sessionId = `${clientId}-session`,
) {
	return new TestClient(broker.socketPath).connect().then(async (client) => {
		await client.send("register", { clientId, sessionId });
		return client;
	});
}

test("protocol framing returns request ids and structured malformed-request errors", async () => {
	const setup = await makeBroker();
	const client = await new TestClient(setup.broker.socketPath).connect();
	try {
		const health = await client.send("health");
		assert.equal(health.protocol, 1);
		const malformed = await client.raw("{not-json");
		assert.equal(malformed.id, null);
		assert.equal(malformed.error.code, "malformed_json");

		const duplicate = client.send("health");
		// Reusing an id is tested with a raw frame because TestClient normally increments it.
		const first = await duplicate;
		assert.equal(first.registry.active, 0);
		const duplicateResponse = await new Promise((resolve) => {
			client.unkeyed.push(resolve);
			client.socket.write('{"id":1,"op":"health"}\n');
		});
		assert.equal(duplicateResponse.error.code, "duplicate_request_id");
	} finally {
		client.destroy();
		await stopBroker(setup);
	}
});

test("duplicate broker startup loses the atomic profile lock", async () => {
	const profileDir = await mkdtemp(join(tmpdir(), "pi-webaio-broker-race-"));
	const first = new GoogleCdpBroker({ profileDir });
	const second = new GoogleCdpBroker({ profileDir });
	try {
		const [a, b] = await Promise.all([first.start(), second.start()]);
		assert.equal(a.ok, true);
		assert.equal(b.ok, false);
		const winner = a.ok ? a : b;
		const loser = a.ok ? b : a;
		assert.equal(loser.error.code, "already_running");
		assert.ok(winner.result.ownerNonce);
	} finally {
		await first.stop();
		await second.stop();
		await rm(profileDir, { recursive: true, force: true });
	}
});

test("two clients receive different provider leases", async () => {
	const setup = await makeBroker();
	const a = await registeredClient(setup.broker, "client-a");
	const b = await registeredClient(setup.broker, "client-b");
	try {
		const [leaseA, leaseB] = await Promise.all([
			a.send("lease", {
				sessionId: "client-a-session",
				provider: "google-search",
			}),
			b.send("lease", {
				sessionId: "client-b-session",
				provider: "google-search",
			}),
		]);
		assert.notEqual(leaseA.leaseId, leaseB.leaseId);
		assert.notEqual(leaseA.targetId, leaseB.targetId);
		assert.equal(leaseA.mode, "registry-only");
		await a.send("release", leaseA);
		await b.send("release", leaseB);
	} finally {
		a.destroy();
		b.destroy();
		await stopBroker(setup);
	}
});

test("same client and provider serialize behind the first lease", async () => {
	const setup = await makeBroker();
	const client = await registeredClient(setup.broker, "serial");
	try {
		const first = await client.send("lease", {
			sessionId: "serial-session",
			provider: "google-search",
		});
		let settled = false;
		const secondPromise = client
			.send("lease", {
				sessionId: "serial-session",
				provider: "google-search",
				waitMs: 500,
			})
			.then((lease) => {
				settled = true;
				return lease;
			});
		await sleep(30);
		assert.equal(settled, false);
		await client.send("release", first);
		const second = await secondPromise;
		assert.equal(second.provider, "google-search");
		await client.send("release", second);
	} finally {
		client.destroy();
		await stopBroker(setup);
	}
});

test("heartbeat expiry and orphan cleanup reclaim leases", async () => {
	const registry = new LeaseRegistry({ ttlMs: 20, orphanTtlMs: 20 });
	registry.register({ clientId: "expiry", sessionId: "expiry-session" });
	const lease = await registry.lease({
		clientId: "expiry",
		sessionId: "expiry-session",
		provider: "google-search",
		ttlMs: 10,
	});
	registry.sweep(Date.now() + 100);
	assert.equal(registry.snapshot().active, 0);
	assert.throws(
		() =>
			registry.heartbeat({
				clientId: "expiry",
				sessionId: "expiry-session",
				leaseId: lease.leaseId,
				targetId: lease.targetId,
				generation: lease.generation,
			}),
		(error) =>
			error.code === "not_registered" || error.code === "lease_not_found",
	);
});

test("stale target generations are rejected and stale leases are cleaned", async () => {
	const registry = new LeaseRegistry();
	registry.register({ clientId: "stale", sessionId: "stale-session" });
	const lease = await registry.lease({
		clientId: "stale",
		sessionId: "stale-session",
		provider: "google-search",
	});
	registry.bumpBrowserGeneration();
	assert.throws(
		() =>
			registry.release({
				clientId: "stale",
				leaseId: lease.leaseId,
				targetId: lease.targetId,
				generation: lease.generation,
			}),
		(error) => error.code === "stale_generation",
	);
	assert.equal(registry.snapshot().active, 0);
});

test("release returns targets to the registry and respects global/provider caps", async () => {
	const registry = new LeaseRegistry({
		globalCap: 1,
		providerCaps: { "google-search": 1 },
	});
	registry.register({ clientId: "cap-a", sessionId: "cap-a-session" });
	registry.register({ clientId: "cap-b", sessionId: "cap-b-session" });
	const first = await registry.lease({
		clientId: "cap-a",
		sessionId: "cap-a-session",
		provider: "google-search",
	});
	await assert.rejects(
		registry.lease({
			clientId: "cap-b",
			sessionId: "cap-b-session",
			provider: "google-search",
		}),
		(error) => error.code === "capacity_exhausted",
	);
	registry.release({
		clientId: "cap-a",
		leaseId: first.leaseId,
		targetId: first.targetId,
		generation: first.generation,
	});
	const second = await registry.lease({
		clientId: "cap-b",
		sessionId: "cap-b-session",
		provider: "google-search",
	});
	assert.equal(second.targetId, first.targetId);
	registry.release({
		clientId: "cap-b",
		leaseId: second.leaseId,
		targetId: second.targetId,
		generation: second.generation,
	});
	assert.equal(registry.snapshot().active, 0);
});

test("disconnect releases active and queued work; late requests are fenced", async () => {
	const setup = await makeBroker();
	const client = await registeredClient(setup.broker, "disconnect");
	try {
		const first = await client.send("lease", {
			sessionId: "disconnect-session",
			provider: "google-search",
		});
		const late = client.send("lease", {
			sessionId: "disconnect-session",
			provider: "google-search",
			waitMs: 1000,
		});
		client.destroy();
		await assert.rejects(late, (error) => error.code === "connection_closed");
		await sleep(20);
		assert.equal(setup.broker.registry.snapshot().active, 0);
		// The release arrived too late to mutate the registry and cannot revive the target.
		assert.throws(
			() =>
				setup.broker.registry.release({
					clientId: "disconnect",
					leaseId: first.leaseId,
					targetId: first.targetId,
					generation: first.generation,
				}),
			(error) => error.code === "lease_not_found",
		);
	} finally {
		await stopBroker(setup);
	}
});

test("oversized frames are rejected without an uncaught broker exception", async () => {
	const setup = await makeBroker();
	const socket = net.createConnection(setup.broker.socketPath);
	try {
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const response = await new Promise((resolve) => {
			socket.once("data", (chunk) => resolve(JSON.parse(chunk.toString())));
			socket.write(`${"x".repeat(MAX_FRAME_BYTES)}\n`);
		});
		assert.equal(response.ok, false);
		assert.equal(response.error.code, "frame_too_large");
	} finally {
		socket.destroy();
		await stopBroker(setup);
	}
});
