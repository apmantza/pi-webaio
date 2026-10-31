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

// ─── A bare `host:port` is not a scheme (CodeRabbit on #166) ─────────
//
// The F4 fix introduced a regression: `/^([a-zA-Z][a-zA-Z0-9+.-]*):/` admits `.`
// in the scheme name, exactly as RFC 3986 does, so `example.com:8443/path`
// matched with scheme `example.com` and was refused as `unsupported_protocol`.
// The removed inline regexes prefixed `https://` onto that input and it worked.
// `new URL()` is no help — it parses `localhost:3000` as protocol `localhost:`,
// so the parser cannot disambiguate either and the rule has to be explicit.
//
// Recurrence prevented: a documented, previously-working input shape
// (`host:port`, the usual way to reach a local dev server) starts being refused
// with a misleading "unsupported protocol" after a scheme-validation change.
test("F4: a bare host:port is still fetched over https, not refused", () => {
	for (const [input, host] of [
		["localhost:3000", "localhost"],
		["example.com:8443/path", "example.com"],
		["sub.example.co.uk:443/x", "sub.example.co.uk"],
		["127.0.0.1:8080/api", "127.0.0.1"],
		// A host with an *empty* port, which is what `"${HOST}:${PORT}/path"` yields
		// when PORT is unset. The dot in the token is what keeps it a host, since
		// there is no port number to match on: without that check it is refused as
		// scheme `example.com`. This is the only input shape where the dot check
		// changes an allow/reject decision rather than just the error code.
		["example.com:/path", "example.com"],
		["foo:80", "foo"],
	]) {
		const r = normalizeFetchTarget(input);
		assert.ok(r.ok, `${input} must be fetched, got ${r.code} (${r.scheme ?? ""})`);
		assert.equal(r.hostname, host);
		assert.equal(r.parsed.protocol, "https:");
	}
});

// The rejection path must stay fail-closed while the host:port shape is allowed,
// so the two are asserted together rather than in isolation.
test("F4: allowing host:port does not widen the scheme refusal", () => {
	for (const input of [
		"file:///etc/passwd",
		"javascript:alert(1)",
		"data:text/html,x",
		"blob:https://example.com",
		"filesystem:https://x/y",
		"view-source:https://x",
		"gopher://example.com",
		"FiLe:///x",
	]) {
		const r = normalizeFetchTarget(input);
		assert.ok(!r.ok, `${input} must be refused`);
		assert.equal(r.code, "unsupported_protocol", input);
	}
});

// A non-http scheme whose payload happens to be port-like degrades to a harmless
// https URL for a nonexistent host rather than a file/javascript URL. Recording
// the trade-off the disambiguation makes, so it is not mistaken for a hole.
test("F4: a scheme spelled like a port degrades to https, never to its own handler", () => {
	const r = normalizeFetchTarget("javascript:123");
	if (r.ok) assert.equal(r.parsed.protocol, "https:");
	else assert.equal(r.code, "unsupported_protocol");
});
