import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brokerPaths } from "../bin/google-cdp-broker.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER = resolve(ROOT, "bin/google-cdp-broker.mjs");
const sleep = (ms) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function connect(socketPath) {
	return new Promise((resolveConnect, rejectConnect) => {
		const socket = net.createConnection(socketPath);
		const fail = (error) => {
			socket.destroy();
			rejectConnect(error);
		};
		socket.once("connect", () => resolveConnect(socket));
		socket.once("error", fail);
	});
}

async function connectWhenReady(socketPath, child) {
	let lastError;
	for (let attempt = 0; attempt < 80; attempt++) {
		if (child.exitCode !== null)
			throw new Error(`broker exited with code ${child.exitCode}`);
		try {
			return await connect(socketPath);
		} catch (error) {
			lastError = error;
			await sleep(25);
		}
	}
	throw new Error(
		`broker socket did not become ready: ${lastError?.message || lastError}`,
	);
}

class ProcessClient {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.buffer = "";
		this.pending = new Map();
		socket.on("data", (chunk) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const response = JSON.parse(line);
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
		socket.on("close", () => {
			for (const pending of this.pending.values())
				pending.reject(new Error("broker connection closed"));
			this.pending.clear();
		});
	}

	request(op, fields = {}) {
		const id = `smoke-${this.nextId++}`;
		return new Promise((resolveRequest, rejectRequest) => {
			this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
			this.socket.write(`${JSON.stringify({ id, op, ...fields })}\n`);
		});
	}

	close() {
		this.socket.destroy();
	}
}

function waitForExit(child) {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolveExit, rejectExit) => {
		const timer = setTimeout(
			() => rejectExit(new Error("broker did not exit")),
			3000,
		);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveExit();
		});
	});
}

test("CLI broker smoke test crosses a real child-process IPC boundary", async () => {
	const profileDir = await mkdtemp(join(tmpdir(), "pi-webaio-broker-process-"));
	const paths = brokerPaths(profileDir);
	const child = spawn(process.execPath, [BROKER, "--profile", profileDir], {
		cwd: ROOT,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let client;
	try {
		client = new ProcessClient(await connectWhenReady(paths.socketPath, child));
		const health = await client.request("health");
		assert.equal(health.protocol, 1);
		const registration = await client.request("register", {
			clientId: "process-smoke-client",
			sessionId: "process-smoke-session",
		});
		assert.equal(typeof registration.capability, "string");
		const identity = {
			clientId: registration.clientId,
			sessionId: registration.sessionId,
			capability: registration.capability,
		};
		const lease = await client.request("lease", {
			...identity,
			provider: "google-search",
		});
		assert.equal(lease.mode, "registry-only");
		await client.request("release", { ...identity, ...lease });
		assert.equal(child.exitCode, null);
	} finally {
		client?.close();
		if (child.exitCode === null) child.kill();
		await waitForExit(child);
		await rm(profileDir, { recursive: true, force: true });
	}
});
