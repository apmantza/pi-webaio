/**
 * CDP lifecycle hardening tests (issue #91).
 *
 * Covers:
 * 1. Async event/close handlers rejecting after an await must never surface
 *    an unhandled rejection (CDPClient in _cdp-shared.ts and the CDP class
 *    in bin/cdp.mjs).
 * 2. waitForEvent() on an already-closed client rejects immediately instead
 *    of waiting out the timeout; onClose() registered after close fires
 *    immediately, exactly once.
 * 3. Daemon registry round-trip + stale-pid filtering used for daemon
 *    discovery on Windows (named pipes are not enumerable).
 *
 * No live Chrome — fake WebSocket servers, same style as
 * tests/reddit-search.test.mjs.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
	existsSync,
	writeFileSync,
	unlinkSync,
	readdirSync,
	readFileSync,
	mkdirSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { test } from "node:test";
import { WebSocketServer } from "ws";

const { CDPClient } = await import("../src/verticals/_cdp-shared.ts");
const {
	CDP,
	sockPath,
	_isPidAlive,
	_ownerPidFromEnv,
	_daemonRegistryPath,
	_writeDaemonRegistry,
	_removeDaemonRegistry,
	_listDaemonSocketsFromRegistry,
} = await import("../bin/cdp.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake Chrome: replies to every command with an event + empty result. */
async function startFakeChrome() {
	const wss = new WebSocketServer({ port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			let request;
			try {
				request = JSON.parse(data.toString());
			} catch {
				return;
			}
			socket.send(JSON.stringify({ method: "Test.event", params: { n: 1 } }));
			socket.send(JSON.stringify({ id: request.id, result: {} }));
		});
	});
	return {
		wss,
		url: `ws://127.0.0.1:${wss.address().port}`,
		async stop() {
			for (const client of wss.clients) client.terminate();
			await new Promise((resolve) => wss.close(resolve));
		},
	};
}

/** Track unhandled rejections for the duration of `fn`. */
async function captureUnhandled(fn) {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await fn();
		// Give Node a chance to report any pending unhandled rejections.
		await sleep(50);
		return unhandled;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

// ---------------------------------------------------------------------------
// P1 — async handler rejections
// ---------------------------------------------------------------------------

test("CDPClient: async event handler rejecting after await produces no unhandled rejection", async () => {
	const chrome = await startFakeChrome();
	const cdp = new CDPClient(chrome.url);
	try {
		const unhandled = await captureUnhandled(async () => {
			await cdp.connect();
			let fired = false;
			cdp.onEvent("Test.event", async () => {
				fired = true;
				await sleep(10);
				throw new Error("async event handler boom");
			});
			await cdp.send("Test.trigger");
			await sleep(30);
			assert.equal(fired, true, "event handler should have run");
		});
		assert.deepEqual(unhandled, []);
	} finally {
		cdp.close();
		await chrome.stop();
	}
});

test("CDPClient: async close handler rejecting produces no unhandled rejection", async () => {
	const chrome = await startFakeChrome();
	const cdp = new CDPClient(chrome.url);
	const unhandled = await captureUnhandled(async () => {
		await cdp.connect();
		let fired = 0;
		cdp.onClose(async () => {
			fired++;
			await sleep(10);
			throw new Error("async close handler boom");
		});
		cdp.close();
		// Registering after close must also fire immediately and safely.
		cdp.onClose(async () => {
			fired++;
			await sleep(10);
			throw new Error("late async close handler boom");
		});
		await sleep(30);
		assert.equal(fired, 2, "both close handlers should have run once");
	});
	assert.deepEqual(unhandled, []);
	await chrome.stop();
});

test("CDP (bin/cdp.mjs): async event and close handler rejections are swallowed", async () => {
	const chrome = await startFakeChrome();
	const cdp = new CDP();
	try {
		const unhandled = await captureUnhandled(async () => {
			await cdp.connect(chrome.url);
			let eventFired = false;
			let closeFired = 0;
			cdp.onEvent("Test.event", async () => {
				eventFired = true;
				await sleep(10);
				throw new Error("cdp.mjs event handler boom");
			});
			cdp.onClose(async () => {
				closeFired++;
				await sleep(10);
				throw new Error("cdp.mjs close handler boom");
			});
			await cdp.send("Test.trigger");
			cdp.close();
			cdp.onClose(async () => {
				closeFired++;
				await sleep(10);
				throw new Error("cdp.mjs late close handler boom");
			});
			await sleep(30);
			assert.equal(eventFired, true);
			assert.equal(closeFired, 2);
		});
		assert.deepEqual(unhandled, []);
	} finally {
		cdp.close();
		await chrome.stop();
	}
});

// ---------------------------------------------------------------------------
// P2 — waitForEvent()/onClose() on an already-closed client
// ---------------------------------------------------------------------------

test("CDPClient: waitForEvent after close rejects immediately, not on timeout", async () => {
	const cdp = new CDPClient("ws://unused");
	cdp.close();
	const started = Date.now();
	const wait = cdp.waitForEvent("Page.loadEventFired", 5000);
	await assert.rejects(wait.promise, /CDP connection closed/);
	assert.ok(
		Date.now() - started < 1000,
		"rejection must be immediate, not after the 5s timeout",
	);
	wait.cancel(); // must be a safe no-op after settlement
});

test("CDP (bin/cdp.mjs): waitForEvent after close rejects immediately", async () => {
	const cdp = new CDP();
	cdp.close();
	const started = Date.now();
	const wait = cdp.waitForEvent("Page.loadEventFired", 5000);
	await assert.rejects(wait.promise, /CDP connection closed/);
	assert.ok(Date.now() - started < 1000);
});

test("CDPClient: onClose registered after close fires immediately and once; double-close stays idempotent", async () => {
	const cdp = new CDPClient("ws://unused");
	cdp.close();
	let count = 0;
	const off = cdp.onClose(() => count++);
	assert.equal(count, 1, "late onClose must fire immediately");
	off();
	cdp.close(); // double close must not re-fire handlers
	await sleep(10);
	assert.equal(count, 1);
});

test("CDP (bin/cdp.mjs): onClose registered after close fires immediately and once", async () => {
	const cdp = new CDP();
	cdp.close();
	let count = 0;
	cdp.onClose(() => count++);
	assert.equal(count, 1);
	cdp.close();
	await sleep(10);
	assert.equal(count, 1);
});

test("CDPClient: a wait started before close settles exactly once on close", async () => {
	const chrome = await startFakeChrome();
	const cdp = new CDPClient(chrome.url);
	try {
		await cdp.connect();
		const wait = cdp.waitForEvent("Never.fires", 3000);
		let rejections = 0;
		let reason;
		wait.promise.catch((error) => {
			rejections++;
			reason = error;
		});
		cdp.close();
		await sleep(30);
		assert.equal(rejections, 1, "pending wait must settle exactly once");
		assert.match(reason.message, /CDP connection closed/);
	} finally {
		await chrome.stop();
	}
});

// ---------------------------------------------------------------------------
// P2 — daemon registry (Windows daemon discovery)
// ---------------------------------------------------------------------------

async function obtainDeadPid() {
	const child = spawn(process.execPath, ["-e", "0"]);
	await new Promise((resolve) => child.once("exit", resolve));
	return child.pid;
}

test("daemon registry: _isPidAlive distinguishes live and dead pids", async () => {
	const deadPid = await obtainDeadPid();
	assert.equal(_isPidAlive(process.pid), true);
	assert.equal(_isPidAlive(deadPid), false);
});

test("daemon registry: live entry round-trips through write/list", async () => {
	const targetId = `lftest-${process.pid}-${Date.now().toString(36)}`;
	const sp = sockPath(targetId);
	const connections = new Set();
	const server = net.createServer((conn) => {
		connections.add(conn);
		conn.on("close", () => connections.delete(conn));
		conn.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(sp, resolve));
	try {
		_writeDaemonRegistry(targetId);
		// Atomic write must not leave a stray .tmp file behind.
		const leftovers = readdirSync(
			dirname(_daemonRegistryPath(targetId)),
		).filter((f) => f.includes(`${targetId}.json.`) && f.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "no temp registry files should remain");
		const found = await _listDaemonSocketsFromRegistry();
		const entry = found.find((d) => d.targetId === targetId);
		assert.ok(entry, "live daemon entry should be discoverable");
		assert.equal(entry.socketPath, sp);
	} finally {
		_removeDaemonRegistry(targetId);
		for (const conn of connections) conn.destroy();
		await new Promise((resolve) => server.close(resolve));
		if (platform() !== "win32") {
			try {
				unlinkSync(sp);
			} catch {}
		}
	}
});

test("daemon registry: dead-pid entries are removed; corrupt entries are skipped but kept", async () => {
	const deadPid = await obtainDeadPid();
	const suffix = `${process.pid}-${Date.now().toString(36)}`;
	const staleId = `staletest-${suffix}`;
	const bogusId = `bogustest-${suffix}`;

	writeFileSync(
		_daemonRegistryPath(staleId),
		JSON.stringify({
			targetId: staleId,
			socketPath: "nowhere",
			pid: deadPid,
			startedAt: Date.now(),
		}),
	);
	writeFileSync(_daemonRegistryPath(bogusId), "{corrupt json");
	try {
		const found = await _listDaemonSocketsFromRegistry();
		assert.equal(
			found.some((d) => d.targetId === staleId),
			false,
			"dead-pid entry must be filtered out",
		);
		assert.equal(
			found.some((d) => d.targetId === bogusId),
			false,
		);
		assert.equal(
			existsSync(_daemonRegistryPath(staleId)),
			false,
			"stale entry file should be removed best-effort",
		);
		// Corrupt/torn entries must NOT be deleted on the read path: a
		// concurrent writer could otherwise lose a live daemon's entry.
		// Only the dead-pid check may remove entries.
		assert.equal(
			existsSync(_daemonRegistryPath(bogusId)),
			true,
			"corrupt entry must be kept (never delete on parse failure)",
		);
	} finally {
		_removeDaemonRegistry(staleId);
		_removeDaemonRegistry(bogusId);
	}
});

test("daemon registry: sweep removes aged .tmp orphans, keeps fresh ones, and preserves live .json entries", async () => {
	const suffix = `${process.pid}-${Date.now().toString(36)}`;
	const liveId = `sweeplive-${suffix}`;
	const sp = sockPath(liveId);
	const connections = new Set();
	const server = net.createServer((conn) => {
		connections.add(conn);
		conn.on("close", () => connections.delete(conn));
		conn.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(sp, resolve));
	const staleTmp = `${_daemonRegistryPath(`stale-${suffix}`)}.1234.tmp`;
	const freshTmp = `${_daemonRegistryPath(`fresh-${suffix}`)}.5678.tmp`;
	try {
		_writeDaemonRegistry(liveId); // also ensures the registry dir exists
		writeFileSync(staleTmp, '{"orphaned":true');
		writeFileSync(freshTmp, '{"mid-rename":true');
		// Fake a crash more than 10 minutes ago.
		const aged = new Date(Date.now() - 11 * 60 * 1000);
		utimesSync(staleTmp, aged, aged);

		const found = await _listDaemonSocketsFromRegistry();

		assert.equal(existsSync(staleTmp), false, "aged .tmp orphan must be swept");
		assert.equal(
			existsSync(freshTmp),
			true,
			"fresh .tmp file must survive (writer may be mid-rename)",
		);
		const entry = found.find((d) => d.targetId === liveId);
		assert.ok(entry, "live .json entry must still round-trip during the sweep");
		assert.equal(entry.socketPath, sp);
	} finally {
		_removeDaemonRegistry(liveId);
		for (const tmp of [staleTmp, freshTmp]) {
			try {
				unlinkSync(tmp);
			} catch {}
		}
		for (const conn of connections) conn.destroy();
		await new Promise((resolve) => server.close(resolve));
		if (platform() !== "win32") {
			try {
				unlinkSync(sp);
			} catch {}
		}
	}
});

test("daemon registry: alive pid with unreachable socket is skipped but kept", async () => {
	const targetId = `unreach-${process.pid}-${Date.now().toString(36)}`;
	// Registry entry pointing at a socket nobody listens on, but with a live pid.
	writeFileSync(
		_daemonRegistryPath(targetId),
		JSON.stringify({
			targetId,
			socketPath:
				platform() === "win32"
					? `\\\\.\\pipe\\cdp-${targetId}`
					: `${tmpdir().replaceAll("\\", "/")}/cdp-${targetId}.sock`,
			pid: process.pid,
			startedAt: Date.now(),
		}),
	);
	try {
		const found = await _listDaemonSocketsFromRegistry();
		assert.equal(
			found.some((d) => d.targetId === targetId),
			false,
			"unconnectable socket must be skipped",
		);
		assert.equal(
			existsSync(_daemonRegistryPath(targetId)),
			true,
			"entry with a live pid must be kept (could be a starting daemon)",
		);
	} finally {
		_removeDaemonRegistry(targetId);
	}
});

// ---------------------------------------------------------------------------
// P2 — session-owner coupling (#96)
// ---------------------------------------------------------------------------

test("daemon owner: _ownerPidFromEnv parses the session pid or returns null", () => {
	assert.equal(_ownerPidFromEnv({}), null);
	assert.equal(_ownerPidFromEnv({ PI_WEBAIO_SESSION_PID: "" }), null);
	assert.equal(_ownerPidFromEnv({ PI_WEBAIO_SESSION_PID: "abc" }), null);
	assert.equal(_ownerPidFromEnv({ PI_WEBAIO_SESSION_PID: "-5" }), null);
	assert.equal(
		_ownerPidFromEnv({ PI_WEBAIO_SESSION_PID: "1234" }),
		1234,
	);
	assert.equal(_ownerPidFromEnv({ PI_WEBAIO_SESSION_PID: "0" }), null);
});

test("daemon registry: ownerPid round-trips through write and is returned", async () => {
	const targetId = `owntest-${process.pid}-${Date.now().toString(36)}`;
	const sp = sockPath(targetId);
	const connections = new Set();
	const server = net.createServer((conn) => {
		connections.add(conn);
		conn.on("close", () => connections.delete(conn));
		conn.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(sp, resolve));
	try {
		const ownerPid = process.pid;
		_writeDaemonRegistry(targetId, ownerPid);
		const record = JSON.parse(
			readFileSync(_daemonRegistryPath(targetId), "utf8"),
		);
		assert.equal(record.pid, process.pid);
		assert.equal(record.ownerPid, ownerPid);
		const found = await _listDaemonSocketsFromRegistry();
		const entry = found.find((d) => d.targetId === targetId);
		assert.ok(entry, "live daemon entry should be discoverable");
		assert.equal(entry.socketPath, sp);
	} finally {
		_removeDaemonRegistry(targetId);
		for (const conn of connections) conn.destroy();
		await new Promise((resolve) => server.close(resolve));
		if (platform() !== "win32") {
			try {
				unlinkSync(sp);
			} catch {}
		}
	}
});

test("daemon registry: dead-owner entries are reaped; live-owner kept", async () => {
	const deadPid = await obtainDeadPid();
	const suffix = `${process.pid}-${Date.now().toString(36)}`;
	const deadOwnerId = `deadowner-${suffix}`;
	const liveOwnerId = `liveowner-${suffix}`;
	const spLive = sockPath(liveOwnerId);
	const connections = new Set();
	const server = net.createServer((conn) => {
		connections.add(conn);
		conn.on("close", () => connections.delete(conn));
		conn.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(spLive, resolve));
	try {
		// Dead owner: entry must be removed on the read path.
		writeFileSync(
			_daemonRegistryPath(deadOwnerId),
			JSON.stringify({
				targetId: deadOwnerId,
				socketPath: sockPath(deadOwnerId),
				pid: process.pid,
				ownerPid: deadPid,
				startedAt: Date.now(),
			}),
		);
		// Live owner (this test process): entry must survive.
		_writeDaemonRegistry(liveOwnerId, process.pid);

		const found = await _listDaemonSocketsFromRegistry();
		assert.equal(
			found.some((d) => d.targetId === deadOwnerId),
			false,
			"dead-owner entry must be filtered out",
		);
		assert.equal(
			existsSync(_daemonRegistryPath(deadOwnerId)),
			false,
			"dead-owner entry file should be removed best-effort",
		);
		assert.equal(
			found.some((d) => d.targetId === liveOwnerId),
			true,
			"live-owner entry must be kept",
		);
	} finally {
		_removeDaemonRegistry(deadOwnerId);
		_removeDaemonRegistry(liveOwnerId);
		for (const conn of connections) conn.destroy();
		await new Promise((resolve) => server.close(resolve));
		if (platform() !== "win32") {
			try {
				unlinkSync(spLive);
			} catch {}
		}
	}
});

test("daemon registry: entry with no ownerPid is kept (legacy format)", async () => {
	const targetId = `legacy-${process.pid}-${Date.now().toString(36)}`;
	const sp = sockPath(targetId);
	const connections = new Set();
	const server = net.createServer((conn) => {
		connections.add(conn);
		conn.on("close", () => connections.delete(conn));
		conn.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(sp, resolve));
	try {
		// Legacy entries predate ownerPid; the daemon still works, just with
		// no owner-death coupling (idle TTL remains the backstop).
		writeFileSync(
			_daemonRegistryPath(targetId),
			JSON.stringify({
				targetId,
				socketPath: sp,
				pid: process.pid,
				startedAt: Date.now(),
			}),
		);
		const found = await _listDaemonSocketsFromRegistry();
		assert.equal(
			found.some((d) => d.targetId === targetId),
			true,
			"legacy entry with live pid must be kept",
		);
	} finally {
		_removeDaemonRegistry(targetId);
		for (const conn of connections) conn.destroy();
		await new Promise((resolve) => server.close(resolve));
		if (platform() !== "win32") {
			try {
				unlinkSync(sp);
			} catch {}
		}
	}
});

test("daemon: exits within seconds when its session owner dies (#96)", async () => {
	const chrome = await startFakeChrome();
	const profileDir = `${tmpdir().replaceAll("\\", "/")}/cdp-owner-test-${process.pid}-${Date.now().toString(36)}`;
	mkdirSync(profileDir, { recursive: true });
	// Simulate the DevToolsActivePort file the daemon reads via getWsUrl().
	writeFileSync(
		`${profileDir}/DevToolsActivePort`,
		`${chrome.wss.address().port}\n/devtools/browser/owner-test\n`,
	);

	// The session owner: a short-lived child that outlives daemon startup.
	const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
	const targetId = `ownerexit-${owner.pid}-${Date.now().toString(36)}`;
	const cdpBin = fileURLToPath(new URL("../bin/cdp.mjs", import.meta.url));
	const daemon = spawn(
		process.execPath,
		[cdpBin, "_daemon", targetId],
		{
			env: {
				...process.env,
				CDP_PROFILE_DIR: profileDir,
				PI_WEBAIO_SESSION_PID: String(owner.pid),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let daemonErr = "";
	daemon.stderr.on("data", (d) => (daemonErr += d.toString()));
	try {
		// Wait for the daemon to come up and register.
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && !existsSync(_daemonRegistryPath(targetId))) {
			await sleep(100);
		}
		assert.ok(
			existsSync(_daemonRegistryPath(targetId)),
			`daemon should register; stderr: ${daemonErr.slice(0, 300)}`,
		);

		// Kill the session owner; the daemon must exit on its own within the
		// poll interval (OWNER_POLL_INTERVAL_MS = 5s) plus margin.
		owner.kill();
		const exited = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), 12000);
			daemon.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code === 0 || code === null);
			});
		});
		assert.equal(
			exited,
			true,
			`daemon should exit after owner death; stderr: ${daemonErr.slice(0, 300)}`,
		);
		assert.equal(
			existsSync(_daemonRegistryPath(targetId)),
			false,
			"daemon must remove its registry entry on owner-death shutdown",
		);
	} finally {
		owner.kill();
		if (daemon.exitCode === null) daemon.kill();
		_removeDaemonRegistry(targetId);
		await chrome.stop();
		try {
			rmSync(profileDir, { recursive: true, force: true });
		} catch {}
	}
});
