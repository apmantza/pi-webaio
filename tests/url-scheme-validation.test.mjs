// ─── Non-http(s) schemes must be rejected, not mangled (issue #165, F4) ───
//
// The tool path did `if (!/^https?:\/\//i.test(url)) url = "https://" + url`.
// That regex only recognises the two-slash form, so:
//
//   aio-webfetch("file:///etc/passwd")
//     -> "Failed to fetch https://file:///etc/passwd … couldn't resolve the
//         hostname [phase=connecting code=dns_error category=network retryable=true]"
//
// Wrong error class (network instead of validation), marked retryable, and it
// spends a DNS lookup on a host spelled `file`. `https:/x` was worse: WHATWG URL
// parses that fine (host `x`), but the regex missed it and produced
// `https://https:/x` — a lookup for host `https`.
//
// The shared taxonomy already has `unsupported_protocol`; only the static API
// emitted it. This helper is the single place the tool path decides a scheme.
//
// Recurrence prevented: a scheme mistake surfacing as a retryable network error.
import assert from "node:assert";
import test from "node:test";
import { normalizeFetchTarget } from "../src/tools/utils.ts";

// ─── The defect: explicit non-http schemes are refused, not prefixed ───

test("F4: file: is rejected as unsupported_protocol, never fetched", () => {
	const r = normalizeFetchTarget("file:///etc/passwd");
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.code, "unsupported_protocol");
	assert.equal(r.scheme, "file:");
	// The exact mangling this fix removes.
	assert.ok(
		!(r.url ?? "").includes("https://file:"),
		`the target must not be prefixed into a DNS lookup: ${r.url}`,
	);
});

test("F4: other non-http schemes are refused too", () => {
	for (const [input, scheme] of [
		["ftp://files.example.com/pub/x.tar.gz", "ftp:"],
		["javascript:alert(1)", "javascript:"],
		["mailto:someone@example.com", "mailto:"],
		["data:text/html,<script>alert(1)</script>", "data:"],
		["ws://sock.example.com/live", "ws:"],
	]) {
		const r = normalizeFetchTarget(input);
		assert.equal(r.ok, false, `${input} must be refused`);
		if (r.ok) continue;
		assert.equal(r.code, "unsupported_protocol", `${input} -> ${r.code}`);
		assert.equal(r.scheme, scheme);
	}
});

test("F4: a single-slash https: keeps its real host", () => {
	// WHATWG parses `https:/x` as host `x`; the old regex did not recognise it
	// and produced a lookup for host `https`.
	const r = normalizeFetchTarget("https:/x");
	assert.equal(r.ok, true);
	if (!r.ok) return;
	const u = new URL(r.url);
	assert.equal(u.protocol, "https:");
	assert.equal(u.hostname, "x");
	assert.notEqual(u.hostname, "https");
});

// ─── The behaviour that must be preserved ───

test("F4: a bare host still gets https://", () => {
	for (const input of ["example.com", "example.com/path", "www.example.com/a?b=1"]) {
		const r = normalizeFetchTarget(input);
		assert.equal(r.ok, true, `${input} should resolve`);
		if (!r.ok) continue;
		assert.equal(new URL(r.url).protocol, "https:");
	}
});

test("F4: protocol-relative URLs get a scheme", () => {
	const r = normalizeFetchTarget("//example.com/a");
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(new URL(r.url).hostname, "example.com");
});

test("F4: http and uppercase schemes are accepted as-is", () => {
	for (const input of ["http://example.com/a", "HTTP://example.com/a", "https://x.dev"]) {
		const r = normalizeFetchTarget(input);
		assert.equal(r.ok, true, `${input} must be accepted`);
		if (!r.ok) continue;
		assert.match(new URL(r.url).protocol, /^https?:$/);
	}
});

test("F4: genuinely unparsable input is invalid_url, not unsupported_protocol", () => {
	for (const input of ["", "   ", "http://", "::::", "not a url at all"]) {
		const r = normalizeFetchTarget(input);
		assert.equal(r.ok, false, `${JSON.stringify(input)} must be refused`);
		if (r.ok) continue;
		assert.equal(
			r.code,
			"invalid_url",
			`${JSON.stringify(input)} -> ${r.code} (scheme must not be invented)`,
		);
	}
});

test("F4: surrounding whitespace is trimmed, not turned into a host", () => {
	const r = normalizeFetchTarget("  https://example.com/a  ");
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(new URL(r.url).hostname, "example.com");
});

// ─── One seam, no leftover inline regexes on the fetch paths ───

// The exact prefix expression the fix replaces. Written with String.raw so the
// backslashes stay literal instead of needing a nested regex literal.
const OLD_PREFIX = String.raw`/^https?:\/\//i.test(`;

test("F4: the fetch paths use the shared guard", async () => {
	const { readFile } = await import("node:fs/promises");
	const base = new URL("../src/", import.meta.url).pathname;
	for (const f of ["tools/webfetch.ts", "tools/webpull.ts"]) {
		const src = await readFile(base + f, "utf8");
		assert.ok(
			src.includes("normalizeFetchTarget"),
			`${f} must route scheme decisions through the shared guard`,
		);
		assert.ok(
			!src.includes(OLD_PREFIX),
			`${f} still carries its own scheme-prefix regex`,
		);
	}
});
