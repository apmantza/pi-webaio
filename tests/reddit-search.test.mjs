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

const {
	cdpIsAvailable,
	captureMainContext,
	clearMainContext,
	CDPClient,
	evalInMainContext,
} = await import("../src/verticals/_cdp-shared.ts");
const { searchReddit, isRedditBlocked } = await import(
	"../src/verticals/reddit_search.ts",
);

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

test("Reddit block detection uses the boolean Runtime.evaluate value", () => {
	assert.equal(isRedditBlocked(true), true);
	assert.equal(isRedditBlocked(false), false);
	assert.equal(isRedditBlocked("true"), false);
});

test("Reddit search closes a created target when session setup fails", async () => {
	const profile = await mkdtemp(join(tmpdir(), "pi-webaio-reddit-profile-"));
	let closeCount = 0;
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	const wss = new WebSocketServer({ server });
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString());
			if (request.method === "Target.getTargets") {
				socket.send(JSON.stringify({ id: request.id, result: { targetInfos: [] } }));
			} else if (request.method === "Target.createTarget") {
				socket.send(JSON.stringify({ id: request.id, result: { targetId: "target-91" } }));
			} else if (request.method === "Target.attachToTarget") {
				socket.send(JSON.stringify({ id: request.id, error: { message: "attach failed" } }));
			} else if (request.method === "Target.closeTarget") {
				closeCount++;
				socket.send(JSON.stringify({ id: request.id, result: {} }));
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await writeFile(join(profile, "DevToolsActivePort"), `${port}\n/devtools/browser/test\n`);
	const previous = process.env.CDP_PROFILE_DIR;
	process.env.CDP_PROFILE_DIR = profile;
	try {
		const result = await searchReddit("setup failure");
		assert.equal(result?.ok, false);
		assert.match(result?.error ?? "", /attach failed/);
		assert.equal(closeCount, 1);
	} finally {
		if (previous === undefined) delete process.env.CDP_PROFILE_DIR;
		else process.env.CDP_PROFILE_DIR = previous;
		await new Promise((resolve) => wss.close(resolve));
		await new Promise((resolve) => server.close(resolve));
	}
});

test("Reddit search recovers a leaked target when the createTarget response is lost", async () => {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);

	const profile = await mkdtemp(join(tmpdir(), "pi-webaio-reddit-profile-"));
	const methods = [];
	const closedTargets = [];
	const preExisting = {
		targetId: "pre-1",
		type: "page",
		url: "https://example.com/",
	};
	const leaked = { targetId: "leaked-1", type: "page", url: "about:blank" };
	let createUrl;
	let getTargetsCalls = 0;
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	const wss = new WebSocketServer({ server });
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString());
			methods.push(request.method);
			if (request.method === "Target.getTargets") {
				getTargetsCalls++;
				// Snapshot call sees only the pre-existing target; the
				// recovery call also sees the orphaned target, carrying the
				// exact marker URL the client requested in createTarget.
				const orphan = createUrl ? { ...leaked, url: createUrl } : leaked;
				const targetInfos =
					getTargetsCalls === 1 ? [preExisting] : [preExisting, orphan];
				socket.send(JSON.stringify({ id: request.id, result: { targetInfos } }));
			} else if (request.method === "Target.createTarget") {
				createUrl = request.params?.url;
				// Chrome creates the target but the CDP response is lost:
				// never reply (the client times out and must recover).
			} else if (request.method === "Target.closeTarget") {
				closedTargets.push(request.params.targetId);
				socket.send(JSON.stringify({ id: request.id, result: { success: true } }));
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await writeFile(join(profile, "DevToolsActivePort"), `${port}\n/devtools/browser/test\n`);
	const previous = process.env.CDP_PROFILE_DIR;
	process.env.CDP_PROFILE_DIR = profile;
	try {
		const result = await searchReddit("lost create response");
		assert.equal(result?.ok, false, "should settle with an error result");
		assert.match(result?.error ?? "", /no target id/);
		assert.equal(getTargetsCalls, 2, "snapshot + recovery getTargets calls");
		assert.ok(
			createUrl?.startsWith("data:text/plain,pi-webaio-"),
			"createTarget uses a unique marker URL",
		);
		assert.deepEqual(closedTargets, ["leaked-1"], "recovered orphan is closed");
		assert.ok(!closedTargets.includes("pre-1"), "pre-existing target untouched");
		// Give any stray promise rejections a tick to surface.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(unhandled, [], "no unhandled rejections");
	} finally {
		process.off("unhandledRejection", onUnhandled);
		if (previous === undefined) delete process.env.CDP_PROFILE_DIR;
		else process.env.CDP_PROFILE_DIR = previous;
		await new Promise((resolve) => wss.close(resolve));
		await new Promise((resolve) => server.close(resolve));
	}
});

test("Reddit search settles cleanly and closes the socket when closeTarget fails", async () => {
	const profile = await mkdtemp(join(tmpdir(), "pi-webaio-reddit-profile-"));
	let closeAttempts = 0;
	let socketClosed = false;
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	const wss = new WebSocketServer({ server });
	wss.on("connection", (socket) => {
		socket.on("close", () => {
			socketClosed = true;
		});
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString());
			if (request.method === "Target.getTargets") {
				socket.send(JSON.stringify({ id: request.id, result: { targetInfos: [] } }));
			} else if (request.method === "Target.createTarget") {
				socket.send(JSON.stringify({ id: request.id, result: { targetId: "target-close-fail" } }));
			} else if (request.method === "Target.attachToTarget") {
				// Force a fast setup failure so teardown runs with a known
				// targetId against a still-open connection.
				socket.send(JSON.stringify({ id: request.id, error: { message: "attach denied" } }));
			} else if (request.method === "Target.closeTarget") {
				closeAttempts++;
				socket.send(JSON.stringify({ id: request.id, error: { message: "close denied" } }));
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await writeFile(join(profile, "DevToolsActivePort"), `${port}\n/devtools/browser/test\n`);
	const previous = process.env.CDP_PROFILE_DIR;
	process.env.CDP_PROFILE_DIR = profile;
	try {
		const result = await searchReddit("close failure");
		assert.equal(result?.ok, false, "should settle with an error result");
		assert.match(result?.error ?? "", /attach denied/, "original error survives teardown");
		assert.equal(closeAttempts, 2, "closeTarget retried exactly once");
		// The CDP socket must be dropped even though teardown failed.
		const deadline = Date.now() + 2_000;
		while (!socketClosed && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(socketClosed, true, "CDP socket closed after failed teardown");
	} finally {
		if (previous === undefined) delete process.env.CDP_PROFILE_DIR;
		else process.env.CDP_PROFILE_DIR = previous;
		await new Promise((resolve) => wss.close(resolve));
		await new Promise((resolve) => server.close(resolve));
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
	await writeFile(
		join(dir, "DevToolsActivePort"),
		`${port}\n/devtools/browser/test\n`,
	);
	try {
		assert.equal(await cdpIsAvailable(join(dir, "DevToolsActivePort")), true);
		await Promise.race([
			closed,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("response socket remained open")),
					500,
				),
			),
		]);
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
	await assert.rejects(
		captureMainContext(failing, "session-failed"),
		/session closed/,
	);
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
				for (const handler of listeners)
					handler({
						context: {
							id: 7,
							auxData: { isDefault: true, type: "default", frameId: "root" },
						},
					});
			}
			if (method === "Page.getFrameTree")
				return { frameTree: { frame: { id: "root" } } };
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
