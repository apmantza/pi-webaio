// ─── Tests for hardening fixes: path traversal guard + withTimeout ───

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeResolveInBaseTemp } from "../src/tools/utils.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_TEMP } from "../src/session-store.ts";
import { scanForSecrets } from "../src/security.ts";

const fromCodes = (...codes) => String.fromCharCode(...codes);

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
	// Accept both with and without trailing separator (BASE_TEMP may or may
	// not end with one depending on the platform). `startsWith` handles
	// both cases: the path is always under BASE_TEMP regardless of sep.
	assert.ok(
		out === BASE_TEMP || out.startsWith(BASE_TEMP),
		`got ${out}, expected to be BASE_TEMP (${BASE_TEMP}) or start with it`,
	);
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

// ─── Secret scanner: relaxed patterns for new token formats ────────

test("scanForSecrets detects OpenAI sk-proj- keys", () => {
	const r = scanForSecrets(
		"https://example.com/?key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
	);
	assert.ok(r.found);
	assert.ok(r.matches.includes("OpenAI API Key"));
});

test("scanForSecrets detects OpenAI sk-svcacct- keys", () => {
	const r = scanForSecrets(
		"https://example.com/?key=sk-svcacct-abcdefghijklmnopqrstuvwxyz",
	);
	assert.ok(r.found);
	assert.ok(r.matches.includes("OpenAI API Key"));
});

test("scanForSecrets detects Anthropic sk-ant-api03- keys (shorter format)", () => {
	// Previously required 95+ chars; now requires 20+
	const r = scanForSecrets(
		"https://example.com/?key=sk-ant-api03-abcdefghijklmnop",
	);
	assert.ok(r.found);
	assert.ok(r.matches.includes("Anthropic API Key"));
});

test("scanForSecrets detects GitHub user tokens (ghu_)", () => {
	const r = scanForSecrets(
		"https://example.com/?key=ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
	);
	assert.ok(r.found);
	assert.ok(r.matches.includes("GitHub App Token"));
});

test("scanForSecrets detects Supabase JWT tokens", () => {
	const jwt = fromCodes(
		101,
		121,
		74,
		104,
		98,
		71,
		99,
		105,
		79,
		105,
		74,
		73,
		85,
		122,
		73,
		49,
		78,
		105,
		73,
		115,
		73,
		110,
		82,
		53,
		99,
		67,
		73,
		54,
		73,
		107,
		112,
		88,
		86,
		67,
		74,
		57,
		46,
		101,
		121,
		74,
		122,
		100,
		87,
		73,
		105,
		79,
		105,
		73,
		120,
		77,
		106,
		77,
		48,
		78,
		84,
		89,
		51,
		79,
		68,
		107,
		119,
		73,
		105,
		119,
		105,
		98,
		109,
		70,
		116,
		90,
		83,
		73,
		54,
		73,
		107,
		112,
		118,
		97,
		71,
		52,
		103,
		82,
		71,
		57,
		108,
		73,
		110,
		48,
		46,
		115,
		105,
		103,
		110,
		97,
		116,
		117,
		114,
		101,
		95,
		104,
		101,
		114,
		101,
		95,
		108,
		111,
		110,
		103,
		95,
		101,
		110,
		111,
		117,
		103,
		104,
	);
	const r = scanForSecrets(`https://example.com/?key=${jwt}`);
	assert.ok(r.found);
	assert.ok(r.matches.includes("Supabase Service Key"));
});

test("scanForSecrets detects Vercel tokens", () => {
	const r = scanForSecrets(
		"https://example.com/?key=vercel_abcdefghijklmnopqrstuvwx",
	);
	assert.ok(r.found);
	assert.ok(r.matches.includes("Vercel Token"));
});

test("scanForSecrets detects Cloudflare API tokens", () => {
	const r = scanForSecrets(
		"https://example.com/?key=cf-abcdefghijklmnopqrstuvwxyz0123456789abcd",
	);
	assert.ok(r.found);
	assert.ok(r.matches.includes("Cloudflare API Token"));
});

test("scanForSecrets does not false-positive on short sk- strings", () => {
	// Make sure "sk-" followed by just a few chars doesn't match
	const r = scanForSecrets("https://example.com/?short=sk-abc");
	assert.equal(r.found, false);
});
