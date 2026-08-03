/**
 * Tests for the Reddit CDP search vertical.
 *
 * These tests verify:
 * 1. searchReddit returns null when Chrome is unavailable (no env gate)
 * 2. The CDP path works when Chrome is running (manual smoke test)
 */

import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";

const { cdpIsAvailable, captureMainContext, clearMainContext, CDPClient, evalInMainContext } =
	await import("../src/verticals/_cdp-shared.ts");
const { searchReddit } = await import("../src/verticals/reddit_search.ts");

test("Reddit search: returns null when Chrome DevToolsActivePort is missing", async () => {
	const prevProfile = process.env.CDP_PROFILE_DIR;
	// Point to a non-existent profile directory
	process.env.CDP_PROFILE_DIR = "/tmp/nonexistent-reddit-cdp-profile-xyz";

	try {
		const result = await searchReddit("langchain");
		assert.strictEqual(
			result,
			null,
			"should return null when Chrome is unavailable",
		);
	} finally {
		if (prevProfile === undefined) delete process.env.CDP_PROFILE_DIR;
		else process.env.CDP_PROFILE_DIR = prevProfile;
	}
});

test("CDP event timeout: an abandoned wait does not leak an unhandled rejection", async () => {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);

	try {
		// This models navigation failing before the caller can await its
		// competing Page.loadEventFired wait.
		const cdp = new CDPClient("ws://unused");
		cdp.waitForEvent("Page.loadEventFired", 10);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.strictEqual(unhandled.length, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("CDPClient rejects connect failures and pre-connect sends promptly", async () => {
	const cdp = new CDPClient("ws://127.0.0.1:1");
	await assert.rejects(cdp.connect(), /WebSocket error/);
	await assert.rejects(cdp.send("Before.connect"), /closed/);
	cdp.close();
});

test("CDPClient clears response timers and closes idempotently", async () => {
	const wss = new WebSocketServer({ port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString());
			socket.send(JSON.stringify({ id: request.id, result: { ok: true } }));
		});
	});
	const port = wss.address().port;
	const cdp = new CDPClient(`ws://127.0.0.1:${port}`);
	try {
		await cdp.connect();
		assert.deepEqual(await cdp.send("Runtime.evaluate"), { ok: true });
		cdp.close();
		cdp.close();
	} finally {
		await new Promise((resolve) => wss.close(resolve));
	}
});

test("CDPClient.close settles pending requests without waiting for timeout", async () => {
	const wss = new WebSocketServer({ port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", () => {});
	const port = wss.address().port;
	const cdp = new CDPClient(`ws://127.0.0.1:${port}`);
	try {
		await cdp.connect();
		const pending = cdp.send("Never.responds");
		cdp.close();
		await assert.rejects(pending, /CDP connection closed/);
	} finally {
		await new Promise((resolve) => wss.close(resolve));
	}
});

test("CDP liveness probe consumes and closes the response", async () => {
	let requestClosed;
	const closed = new Promise((resolve) => (requestClosed = resolve));
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"Browser":"test"}');
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	server.on("connection", (socket) => socket.once("close", requestClosed));
	const dir = await mkdtemp(join(tmpdir(), "pi-webaio-cdp-"));
	const port = server.address().port;
	await writeFile(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/test\n`);
	try {
		assert.equal(await cdpIsAvailable(join(dir, "DevToolsActivePort")), true);
		await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("response socket remained open")), 500))]);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("execution-context listener is removed when Runtime.enable fails", async () => {
	let removed = false;
	const failing = {
		onEvent() {
			return () => (removed = true);
		},
		async send() {
			throw new Error("session closed");
		},
	};
	await assert.rejects(captureMainContext(failing, "session-failed"), /session closed/);
	assert.equal(removed, true);
});

test("execution-context listener cleanup and explicit cache cleanup", async () => {
	const calls = [];
	const listeners = new Set();
	const fake = {
		onEvent(_method, handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		async send(method) {
			calls.push(method);
			if (method === "Runtime.enable") {
				for (const handler of listeners) handler({ context: { id: 7, auxData: { isDefault: true, type: "default", frameId: "root" } } });
			}
			if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
			if (method === "Runtime.evaluate") return { result: { value: "ok" } };
			return {};
		},
	};
	assert.equal(await captureMainContext(fake, "session-a"), 7);
	assert.equal(listeners.size, 0);
	await evalInMainContext(fake, "session-a", "1");
	clearMainContext("session-a");
	await evalInMainContext(fake, "session-a", "1");
	assert.equal(calls.filter((method) => method === "Runtime.enable").length, 3);
});
