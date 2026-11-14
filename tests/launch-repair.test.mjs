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
 * 2. Empty/whitespace cmdline output normalizes to null (unavailable →
 *    never kill) — luna-5.6 review finding #1.
 * 3. Single-flight launch lock: acquire/steal/release semantics —
 *    luna-5.6 review finding #2.
 * 4. cdp.mjs getWsUrl() runs ONE bounded repair via launch.mjs when the
 *    profile port file is missing, then fails closed (fix 2).
 *    PI_WEBAIO_CDP_REPAIR=0 opts out.
 *
 * Probe hygiene: GREEDYSEARCH_STATE_DIR is set BEFORE launch.mjs is
 * imported, so pid/mode/lock records live in a mkdtemp fixture dir — the
 * real /tmp/greedysearch-chrome.* records of a concurrently running
 * GreedySearch Chrome are never touched (luna-5.6 review finding #3).
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

// MUST run before bin/launch.mjs is imported (its STATE_DIR const is
// computed at import time). No top-level await — node 22 collapses an
// async-entry file into a single file-level test and stops reporting the
// individual tests (luna-5.6 review finding #4).
const STATE_DIR = mkdtempSync(join(tmpdir(), "webaio-lr-state-"));
process.env.GREEDYSEARCH_STATE_DIR = STATE_DIR;

const isLinux = process.platform === "linux";

let launch, cdp;
async function loadModules() {
	if (!launch) {
		launch = await import("../bin/launch.mjs");
		cdp = await import("../bin/cdp.mjs");
	}
	return { launch, cdp };
}

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

function cleanupPidFile() {
	try {
		rmSync(join(STATE_DIR, "greedysearch-chrome.pid"), { force: true });
	} catch {}
}

test("cmdlineOf reads a real pid on Linux and returns null for dead pids", async () => {
	if (!isLinux) return; // /proc is the Linux source; others covered by null path
	const { launch } = await loadModules();
	const cmdline = launch.cmdlineOf(process.pid);
	assert.ok(cmdline, "cmdline of the running test process is readable");
	assert.ok(
		cmdline.includes("node"),
		"cmdline mentions the node executable",
	);
	assert.equal(launch.cmdlineOf(99999999), null, "dead pid → null (skip)");
});

test("_normalizeCmdline: empty/whitespace output is UNAVAILABLE (null), never 'foreign'", async () => {
	const { launch } = await loadModules();
	// luna-5.6 finding #1: PowerShell/ps can emit blank output for a live
	// process whose CommandLine is null. "" must not kill it.
	assert.equal(launch._normalizeCmdline(null), null);
	assert.equal(launch._normalizeCmdline(undefined), null);
	assert.equal(launch._normalizeCmdline(""), null);
	assert.equal(launch._normalizeCmdline("   \n \r\n"), null);
	assert.equal(launch._normalizeCmdline("chrome --flag"), "chrome --flag");
	assert.equal(
		launch._normalizeCmdline("  chrome --flag \n"),
		"chrome --flag",
		"valid output is trimmed",
	);
});

test("isRunning returns false for a dead tracked pid", async () => {
	const { launch } = await loadModules();
	writeFileSync(launch._pidFile, "99999999\n", "utf8");
	try {
		assert.equal(launch.isRunning(), false);
	} finally {
		cleanupPidFile();
	}
});

test("isRunning reaps an alive pid from a FOREIGN profile dir", async () => {
	if (!isLinux) return; // reap depends on cmdlineOf; validated on Linux
	const { launch } = await loadModules();
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
		cleanupPidFile();
	}
});

test("isRunning accepts an alive pid whose cmdline carries THIS profile dir", async () => {
	if (!isLinux) return;
	const { launch } = await loadModules();
	// Embed the profile dir in the script text so it lands in /proc cmdline.
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
		cleanupPidFile();
	}
});

test("launch lock: acquire writes our pid, release removes it", async () => {
	const { launch } = await loadModules();
	const { readFileSync } = await import("node:fs");
	try {
		assert.equal(await launch.acquireLaunchLock(1000), true, "acquired");
		assert.equal(
			readFileSync(launch._lockFile, "utf8").trim(),
			String(process.pid),
			"lock records the holder pid",
		);
		launch.releaseLaunchLock();
		assert.throws(
			() => readFileSync(launch._lockFile, "utf8"),
			"lock file removed on release",
		);
	} finally {
		launch.releaseLaunchLock();
	}
});

test("launch lock: an ALIVE holder blocks; a DEAD holder's lock is stolen", async () => {
	const { launch } = await loadModules();
	const { readFileSync } = await import("node:fs");
	try {
		// Simulate an alive holder (this test process) — bounded wait expires.
		writeFileSync(launch._lockFile, String(process.pid), "utf8");
		const started = Date.now();
		assert.equal(
			await launch.acquireLaunchLock(200),
			false,
			"alive holder blocks the acquire",
		);
		assert.ok(
			Date.now() - started >= 150,
			"the acquire actually waited, not busy-failed",
		);
		// Dead holder: a pid we know is gone.
		writeFileSync(launch._lockFile, "99999999", "utf8");
		assert.equal(
			await launch.acquireLaunchLock(1000),
			true,
			"dead holder's lock is stolen",
		);
		assert.equal(
			readFileSync(launch._lockFile, "utf8").trim(),
			String(process.pid),
		);
	} finally {
		launch.releaseLaunchLock();
	}
});

test("getWsUrl reads the profile port file without repair when present", async () => {
	const { cdp } = await loadModules();
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

test("getWsUrl fails closed with the documented error when repair is off", async () => {
	const { cdp } = await loadModules();
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

test("getWsUrl runs the bounded repair once when the port file is missing", async () => {
	const { cdp } = await loadModules();
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

test("getWsUrl repairs through to success when the port file appears", async () => {
	const { cdp } = await loadModules();
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

test("PI_WEBAIO_CDP_REPAIR=0 disables the repair attempt entirely", async () => {
	const { cdp } = await loadModules();
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

test("repair failure is swallowed — the fail-closed error still surfaces", async () => {
	const { cdp } = await loadModules();
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
