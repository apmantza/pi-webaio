// Process crash guard (issue #125 — "pi agent shouldn't crash in timeout").
//
// Recurrence this prevents: Node's default unhandled-rejection mode kills the
// whole host process when any promise rejects without a handler — e.g. a
// background search lane that settles (or times out) after its tool call has
// already returned. The user's pi session died this way more than once
// (#125: "when a timeout happens it raises exception and isn't catching pi
// agent to crash … extension could reach timeout but not crash agent").
// Individual lanes are already guarded (probes over the real broker/Google
// machinery: late-rejecting lanes, late-resolving lanes, broker process
// death, no-socket deadline, user cancel — all clean, zero unhandled
// rejections); this guard is the net over every path, including code loaded
// into the host that pi-webaio does not own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/** Spawn a node child running `script` as an ESM module with TS stripping. */
function spawnNode(script, extraArgs = []) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", script, ...extraArgs],
			{
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("baseline: without the guard a stray rejection kills the host (issue #125 recurrence)", async () => {
	// Documents the defect shape the guard exists for: on pre-fix code there
	// is no guard anywhere in the host process, so this exact script — a
	// promise that rejects after its caller detached, the shape of a late
	// timeout lane — crashes the process under Node's default mode.
	// Asserted version-independently: the host must die before printing ALIVE
	// (Node's default mode prints the bare error, not an ERR_ code name).
	const { code, stdout, stderr } = await spawnNode(
		`new Promise((_, reject) => setTimeout(() => reject(new Error("stray timeout rejection")), 10));` +
			`setTimeout(() => { console.log("ALIVE"); process.exit(0); }, 500);`,
	);
	assert.notEqual(code, 0, "host must crash without the guard (documents the defect)");
	assert.doesNotMatch(stdout, /ALIVE/, "host must die before reaching the survival marker");
	assert.match(stderr, /stray timeout rejection/, "the rejection reason must reach stderr");
});

test("guard keeps the host alive through stray rejection + timer throw and records both", async () => {
	const script = `
		const guard = await import("./src/crash-guard.ts");
		guard.installCrashGuard();
		// Shape 1: background lane rejects after its caller detached (issue #125).
		new Promise((_, reject) => setTimeout(() => reject(new Error("stray timeout rejection")), 10));
		// Shape 2: synchronous throw inside a timer callback.
		setTimeout(() => { throw new Error("timer boom"); }, 20);
		setTimeout(() => {
			console.log("ALIVE");
			console.log(JSON.stringify({
				records: guard.crashGuardRecords().map((r) => ({ kind: r.kind, message: r.message })),
			}));
			process.exit(0);
		}, 500);
	`;
	const { code, stdout, stderr } = await spawnNode(script);
	assert.equal(code, 0, `host must survive with the guard; stderr: ${stderr}`);
	assert.match(stdout, /ALIVE/);
	const payload = JSON.parse(stdout.match(/\{.*\}/s)[0]);
	const kinds = payload.records.map((r) => r.kind).sort();
	assert.deepEqual(kinds, ["uncaughtException", "unhandledRejection"]);
	assert.ok(payload.records.some((r) => /stray timeout rejection/.test(r.message)));
	assert.ok(payload.records.some((r) => /timer boom/.test(r.message)));
	// Bounded observability: the first record writes one stderr line even
	// without PI_WEBAIO_DEBUG so a silent survival is still reportable (#125
	// arrived with no evidence at all).
	assert.match(stderr, /\[pi-webaio:crash-guard\] suppressed a fatal process error/);
});

test("guard records are bounded: first 5 keep stacks, the rest collapse into a counter", async () => {
	// Runs in a child process: node:test attributes stray rejections inside a
	// test to the test itself (failureType: 'unhandledRejection') even when
	// another listener also records them, so the in-process shape cannot pass
	// under the runner. The child exercises the same real seam.
	const script = `
		const guard = await import("./src/crash-guard.ts");
		guard.installCrashGuard();
		guard.installCrashGuard(); // idempotent: no duplicate handlers
		for (let i = 0; i < 7; i++) {
			// Deliberately unhandled: only the guard's listener receives these.
			void Promise.reject(new Error(\`stray-\${i}\`));
		}
		setTimeout(() => {
			console.log(JSON.stringify({
				records: guard.crashGuardRecords().map((r) => ({
					message: r.message,
					stackLength: r.stack?.length ?? 0,
					stackFirstLine: (r.stack ?? "").split("\\n")[0],
				})),
				suppressed: guard.crashGuardSuppressedCount(),
			}));
			process.exit(0);
		}, 100);
	`;
	const { code, stdout, stderr } = await spawnNode(script);
	assert.equal(code, 0, `child must survive; stderr: ${stderr}`);
	const payload = JSON.parse(stdout.trim().split("\n").pop());
	assert.equal(payload.records.length, 5, "records capped at 5");
	assert.match(payload.records[0].message, /stray-0/);
	assert.equal(payload.suppressed, 2, "excess events counted, not recorded");
	// Each record keeps a bounded stack so the first events stay debuggable.
	assert.ok(payload.records[0].stackLength > 0 && payload.records[0].stackLength <= 2000);
	assert.match(payload.records[0].stackFirstLine, /stray-0/);
});
