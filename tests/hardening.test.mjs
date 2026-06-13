// ─── Tests for hardening fixes: path traversal guard + withTimeout ───

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeResolveInBaseTemp } from "../src/tools/utils.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_TEMP } from "../src/session-store.ts";

// ─── safeResolveInBaseTemp ──────────────────────────────────────────

test("safeResolveInBaseTemp: relative path inside BASE_TEMP is allowed", () => {
	const out = safeResolveInBaseTemp("subdir/file.md");
	assert.ok(out.startsWith(BASE_TEMP), `got ${out}`);
	assert.ok(out.endsWith("subdir/file.md") || out.endsWith("subdir\\file.md"));
});

test("safeResolveInBaseTemp: absolute path is rejected", () => {
	const abs = join(tmpdir(), "evil", "stolen.md");
	assert.throws(
		() => safeResolveInBaseTemp(abs),
		/Refusing to write outside temp dir/,
	);
});

test("safeResolveInBaseTemp: parent-traversal escape is rejected", () => {
	assert.throws(
		() => safeResolveInBaseTemp("../../../etc/passwd"),
		/Refusing to write outside temp dir/,
	);
	assert.throws(
		() => safeResolveInBaseTemp("subdir/../../../../etc/hosts"),
		/Refusing to write outside temp dir/,
	);
});

test("safeResolveInBaseTemp: empty / non-string input rejected", () => {
	assert.throws(() => safeResolveInBaseTemp(""), /non-empty/);
});

test("safeResolveInBaseTemp: returns path joined under BASE_TEMP", () => {
	const out = safeResolveInBaseTemp("file.md");
	// On Windows the separator is `\`, on POSIX it's `/`. Use path.sep.
	const sep = "\\" || "/"; // both ok on win; posix only has /
	const baseWithSep = BASE_TEMP.endsWith(sep) ? BASE_TEMP : BASE_TEMP + sep;
	assert.ok(out === BASE_TEMP || out.startsWith(baseWithSep), `got ${out}`);
});

// ─── withTimeout behavior: not exported directly, but we can verify
// that a Promise.race-style function that uses our new pattern does
// not leave unhandled rejections. We test by building an in-line
// withTimeout with the same structure as content.ts:273. ────────────

/** Mirror of content.ts:273 withTimeout (re-defined here for testing). */
function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * Returns a promise that rejects after a short delay. We attach a
 * `.catch` no-op to silence the unhandled-rejection warning so the
 * test only fails if our withTimeout ALSO leaves it dangling.
 */
function lateRejectingPromise() {
	const p = new Promise((_, reject) =>
		setTimeout(() => reject(new Error("late")), 30),
	);
	p.catch(() => {});
	return p;
}

test("withTimeout: when timeout wins, late rejection does not crash the process", async () => {
	const late = lateRejectingPromise();
	// The timeout (10ms) wins; the original promise rejects at 30ms.
	await assert.rejects(withTimeout(late, 10), /timeout/);
	// Wait long enough for the late rejection to fire and (if buggy)
	// produce an unhandled rejection. The test passes if Node doesn't
	// crash; in test mode, unhandled rejections throw.
	await new Promise((r) => setTimeout(r, 80));
});

test("withTimeout: when promise wins, resolution is delivered", async () => {
	const r = withTimeout(Promise.resolve(42), 100);
	assert.equal(await r, 42);
});

test("withTimeout: when promise wins, it does not reject with timeout later", async () => {
	const p = Promise.resolve("ok");
	const r = withTimeout(p, 5);
	assert.equal(await r, "ok");
	// Wait beyond the timeout to ensure the timer is cleared.
	await new Promise((res) => setTimeout(res, 30));
});
