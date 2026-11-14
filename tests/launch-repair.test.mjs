/**
 * GreedySearch Chrome lifecycle hardening tests.
 *
 * Recurrence (observed 2026-11-14): a 5-day-old Chrome launched with a
 * different --user-data-dir (~/.cache/pi-webaio/chrome-profile, env override)
 * held port 9222 while bin/launch.mjs reported "already running" (pid-file
 * only) and bin/cdp.mjs's getWsUrl failed with "GreedySearch DevToolsActivePort
 * not found at /tmp/greedysearch-chrome-profile". The Google lane stayed
 * broken until launch.mjs --kill was run by hand.
 *
 * Covered:
 * 1. launch.mjs isRunning() validates that the tracked pid actually belongs
 *    to the profile dir THIS environment resolves, and reaps a foreign /
 *    stale one (fix 1). OS-agnostic cmdlineOf: /proc on Linux, ps on macOS,
 *    PowerShell Get-CimInstance on Windows — null means "skip validation".
 * 2. cdp.mjs getWsUrl() runs ONE bounded repair via launch.mjs when the
 *    profile port file is missing, then fails closed (fix 2). PI_WEBAIO_CDP_REPAIR=0
 *    opts out; no repair is attempted for the user's main-Chrome path.
 *
 * No live Chrome: real child processes are plain `node -e` timers, the
 * repair runs through an injected fake. Linux-only branches are gated on
 * process.platform so the suite stays green on all CI matrices.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const isLinux = process.platform === "linux";

const launch = await import("../bin/launch.mjs");
const cdp = await import("../bin/cdp.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn a bounded dummy child (a plain node timer, no Chrome). */
function spawnDummy(embedProfile) {
	// `--user-data-dir` as a real argv entry makes node exit 9 (bad option);
	// embedding the path in the -e script text puts it in the cmdline instead.
	const script = embedProfile
		? `const p = ${JSON.stringify(embedProfile)}; setTimeout(() => {}, 8000)`
		: "setTimeout(() => {}, 8000)";
	return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

test("cmdlineOf reads a real pid on Linux and returns null for dead pids", () => {
	if (!isLinux) return; // /proc is the Linux source; others covered by null path
	const cmdline = launch.cmdlineOf(process.pid);
	assert.ok(cmdline, "cmdline of the running test process is readable");
	assert.ok(
		cmdline.includes("node"),
		"cmdline mentions the node executable",
	);
	assert.equal(launch.cmdlineOf(99999999), null, "dead pid → null (skip)");
});

test("isRunning returns false for a dead tracked pid", () => {
	writeFileSync(launch._pidFile, "99999999\n", "utf8");
	try {
		assert.equal(launch.isRunning(), false);
	} finally {
		try {
			rmSync(launch._pidFile, { force: true });
		} catch {}
	}
});

test("isRunning reaps an alive pid from a FOREIGN profile dir", async () => {
	if (!isLinux) return; // reap depends on cmdlineOf; validated on Linux
	const child = spawnDummy();
	try {
		// The dummy's cmdline has no --user-data-dir with our profile: foreign.
		await sleep(300); // let /proc/<pid>/cmdline materialize
		writeFileSync(launch._pidFile, `${child.pid}\n`, "utf8");
		assert.equal(launch.isRunning(), false, "foreign pid is not 'running'");
		// The reap kills the child and drops the stale pid record.
		await sleep(200);
		let killed = false;
		try {
			process.kill(child.pid, 0);
		} catch {
			killed = true;
		}
		assert.ok(killed, "foreign-profile Chrome (dummy) was reaped");
		assert.equal(
			launch.isRunning(),
			false,
			"pid record was dropped with the pid",
		);
	} finally {
		try {
			child.kill("SIGKILL");
		} catch {}
		try {
			rmSync(launch._pidFile, { force: true });
		} catch {}
	}
});

test("isRunning accepts an alive pid whose cmdline carries THIS profile dir", async () => {
	if (!isLinux) return;
	const child = spawnDummy(launch._profileDir);
	try {
		await sleep(300);
		writeFileSync(launch._pidFile, `${child.pid}\n`, "utf8");
		assert.equal(launch.isRunning(), child.pid, "matching profile accepted");
		// And it was NOT reaped:
		await sleep(200);
		assert.doesNotThrow(() => process.kill(child.pid, 0), "child survived");
	} finally {
		try {
			child.kill("SIGKILL");
		} catch {}
		try {
			rmSync(launch._pidFile, { force: true });
		} catch {}
	}
});

test("getWsUrl reads the profile port file without repair when present", () => {
	const dir = mkdtempSync(join(tmpdir(), "webaio-lr-port-"));
	try {
		writeFileSync(join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/x", "utf8");
		assert.equal(
			cdp.getWsUrl({ profileDir: dir, repair: false }),
			"ws://localhost:9333/devtools/browser/x",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getWsUrl fails closed with the documented error when repair is off", () => {
	const dir = mkdtempSync(join(tmpdir(), "webaio-lr-miss-"));
	try {
		assert.throws(
			() => cdp.getWsUrl({ profileDir: dir, repair: false }),
			(err) =>
				err.message.includes(
					`GreedySearch DevToolsActivePort not found at ${dir.replaceAll("\\", "/")}/DevToolsActivePort`,
				) &&
				err.message.includes("Refusing to fall back to the main Chrome session"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getWsUrl runs the bounded repair once when the port file is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "webaio-lr-repair-"));
	const calls = [];
	try {
		assert.throws(
			() =>
				cdp.getWsUrl({
					profileDir: dir,
					run: (p) => {
						calls.push(p);
					},
				}),
			(err) => err.message.includes("not found at"),
			"still fails closed when the repair does not produce a port file",
		);
		assert.equal(calls.length, 1, "exactly one repair attempt");
		assert.ok(
			calls[0].endsWith("launch.mjs"),
			"repair invokes launch.mjs next to cdp.mjs",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getWsUrl repairs through to success when the port file appears", () => {
	const dir = mkdtempSync(join(tmpdir(), "webaio-lr-heal-"));
	const portPath = join(dir, "DevToolsActivePort");
	const calls = [];
	try {
		// Fake repair that behaves like launch.mjs: writes the port file.
		const ws = cdp.getWsUrl({
			profileDir: dir,
			run: (p) => {
				calls.push(p);
				writeFileSync(portPath, "9444\n/devtools/browser/healed", "utf8");
			},
		});
		assert.equal(calls.length, 1);
		assert.equal(ws, "ws://localhost:9444/devtools/browser/healed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PI_WEBAIO_CDP_REPAIR=0 disables the repair attempt entirely", () => {
	const dir = mkdtempSync(join(tmpdir(), "webaio-lr-optout-"));
	const prev = process.env.PI_WEBAIO_CDP_REPAIR;
	const calls = [];
	process.env.PI_WEBAIO_CDP_REPAIR = "0";
	try {
		assert.throws(
			() =>
				cdp.getWsUrl({
					profileDir: dir,
					run: (p) => calls.push(p),
				}),
			() => true,
		);
		assert.equal(calls.length, 0, "opt-out means no repair child at all");
	} finally {
		if (prev === undefined) delete process.env.PI_WEBAIO_CDP_REPAIR;
		else process.env.PI_WEBAIO_CDP_REPAIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repair failure is swallowed — the fail-closed error still surfaces", () => {
	const dir = mkdtempSync(join(tmpdir(), "webaio-lr-fail-"));
	try {
		assert.throws(
			() =>
				cdp.getWsUrl({
					profileDir: dir,
					run: () => {
						throw new Error("launch failed");
					},
				}),
			(err) => err.message.includes("not found at"),
			"the original error, not the repair's error, reaches the caller",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
