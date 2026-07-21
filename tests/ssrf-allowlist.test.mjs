// ─── Tests for SSRF allow-list (CIDR) feature ──────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseCidr,
	parseAllowRanges,
	ipMatchesCidr,
	setSsrfAllowRangesForTest,
	isDangerousUrl,
} from "../src/security.ts";

// ─── parseCidr: valid inputs ────────────────────────────────────────

test("parseCidr: valid IPv4 CIDR /8", () => {
	const r = parseCidr("10.0.0.0/8");
	assert.ok(r !== null);
	assert.equal(r.prefixLen, 104); // 96 + 8
});

test("parseCidr: valid IPv4 CIDR /24", () => {
	const r = parseCidr("192.168.1.0/24");
	assert.ok(r !== null);
	assert.equal(r.prefixLen, 120); // 96 + 24
});

test("parseCidr: valid IPv4 CIDR /32 (host)", () => {
	const r = parseCidr("10.1.2.3/32");
	assert.ok(r !== null);
	assert.equal(r.prefixLen, 128);
});

test("parseCidr: valid IPv6 CIDR /8", () => {
	const r = parseCidr("fd00::/8");
	assert.ok(r !== null);
	assert.equal(r.prefixLen, 8);
});

test("parseCidr: valid IPv6 CIDR /128 (host)", () => {
	const r = parseCidr("fd00::1/128");
	assert.ok(r !== null);
	assert.equal(r.prefixLen, 128);
});

// ─── parseCidr: malformed inputs ────────────────────────────────────

test("parseCidr: missing slash returns null", () => {
	assert.equal(parseCidr("10.0.0.0"), null);
});

test("parseCidr: /0 returns null (not a useful allow range)", () => {
	assert.equal(parseCidr("0.0.0.0/0"), null);
	assert.equal(parseCidr("::/0"), null);
});

test("parseCidr: prefix > 32 for IPv4 returns null", () => {
	assert.equal(parseCidr("10.0.0.0/33"), null);
});

test("parseCidr: prefix > 128 for IPv6 returns null", () => {
	assert.equal(parseCidr("fd00::/129"), null);
});

test("parseCidr: non-numeric prefix returns null", () => {
	assert.equal(parseCidr("10.0.0.0/abc"), null);
});

test("parseCidr: garbage address returns null", () => {
	assert.equal(parseCidr("not.an.ip/24"), null);
});

test("parseCidr: empty string returns null", () => {
	assert.equal(parseCidr(""), null);
});

// ─── parseAllowRanges ───────────────────────────────────────────────

test("parseAllowRanges: parses multiple valid CIDRs", () => {
	const ranges = parseAllowRanges("10.0.0.0/8,192.168.1.0/24");
	assert.equal(ranges.length, 2);
});

test("parseAllowRanges: skips malformed entries silently", () => {
	const ranges = parseAllowRanges("10.0.0.0/8,garbage,192.168.1.0/24");
	assert.equal(ranges.length, 2);
});

test("parseAllowRanges: empty string returns empty array", () => {
	assert.deepEqual(parseAllowRanges(""), []);
});

test("parseAllowRanges: all-malformed returns empty array", () => {
	assert.deepEqual(parseAllowRanges("bad,worse,nope"), []);
});

// ─── ipMatchesCidr: IPv4 matching ───────────────────────────────────

test("ipMatchesCidr: 10.1.2.3 matches 10.0.0.0/8", () => {
	const cidr = parseCidr("10.0.0.0/8");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("10.1.2.3", cidr));
});

test("ipMatchesCidr: 10.255.255.255 matches 10.0.0.0/8", () => {
	const cidr = parseCidr("10.0.0.0/8");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("10.255.255.255", cidr));
});

test("ipMatchesCidr: 11.0.0.1 does NOT match 10.0.0.0/8", () => {
	const cidr = parseCidr("10.0.0.0/8");
	assert.ok(cidr !== null);
	assert.equal(ipMatchesCidr("11.0.0.1", cidr), false);
});

test("ipMatchesCidr: 192.168.1.50 matches 192.168.1.0/24", () => {
	const cidr = parseCidr("192.168.1.0/24");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("192.168.1.50", cidr));
});

test("ipMatchesCidr: 192.168.2.1 does NOT match 192.168.1.0/24", () => {
	const cidr = parseCidr("192.168.1.0/24");
	assert.ok(cidr !== null);
	assert.equal(ipMatchesCidr("192.168.2.1", cidr), false);
});

test("ipMatchesCidr: /32 matches only exact host", () => {
	const cidr = parseCidr("10.1.2.3/32");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("10.1.2.3", cidr));
	assert.equal(ipMatchesCidr("10.1.2.4", cidr), false);
});

// ─── ipMatchesCidr: IPv6 matching ───────────────────────────────────

test("ipMatchesCidr: fd00::1 matches fd00::/8", () => {
	const cidr = parseCidr("fd00::/8");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("fd00::1", cidr));
});

test("ipMatchesCidr: fc00::1 matches fc00::/7 (fc00 and fd00)", () => {
	const cidr = parseCidr("fc00::/7");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("fc00::1", cidr));
	assert.ok(ipMatchesCidr("fd00::1", cidr));
});

test("ipMatchesCidr: 2001::1 does NOT match fd00::/8", () => {
	const cidr = parseCidr("fd00::/8");
	assert.ok(cidr !== null);
	assert.equal(ipMatchesCidr("2001::1", cidr), false);
});

test("ipMatchesCidr: /128 matches only exact IPv6 host", () => {
	const cidr = parseCidr("fd00::1/128");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("fd00::1", cidr));
	assert.equal(ipMatchesCidr("fd00::2", cidr), false);
});

// ─── ipMatchesCidr: IPv4-mapped IPv6 ────────────────────────────────

test("ipMatchesCidr: ::ffff:10.1.2.3 matches IPv4 CIDR 10.0.0.0/8", () => {
	// An IPv4-mapped IPv6 address should be recognized as falling in the
	// IPv4 range when the CIDR is expressed in IPv4 notation.
	const cidr = parseCidr("10.0.0.0/8");
	assert.ok(cidr !== null);
	assert.ok(ipMatchesCidr("::ffff:10.1.2.3", cidr));
});

test("ipMatchesCidr: ::ffff:192.168.1.5 does NOT match 10.0.0.0/8", () => {
	const cidr = parseCidr("10.0.0.0/8");
	assert.ok(cidr !== null);
	assert.equal(ipMatchesCidr("::ffff:192.168.1.5", cidr), false);
});

// ─── Default-off: no allow-list = same block behavior ───────────────

test("isDangerousUrl: 10.x blocked by default (no allow-list)", async () => {
	setSsrfAllowRangesForTest([]);
	const dangerous = await isDangerousUrl("http://10.1.2.3/");
	assert.ok(dangerous, "10.x should be blocked with empty allow-list");
});

test("isDangerousUrl: 192.168.x blocked by default (no allow-list)", async () => {
	setSsrfAllowRangesForTest([]);
	const dangerous = await isDangerousUrl("http://192.168.1.100/");
	assert.ok(dangerous);
});

test("isDangerousUrl: 127.0.0.1 blocked by default (no allow-list)", async () => {
	setSsrfAllowRangesForTest([]);
	const dangerous = await isDangerousUrl("http://127.0.0.1/");
	assert.ok(dangerous);
});

// ─── isDangerousUrl integration with allow-list ─────────────────────

test("isDangerousUrl: 10.1.2.3 allowed when 10.0.0.0/8 is set", async () => {
	const ranges = parseAllowRanges("10.0.0.0/8");
	setSsrfAllowRangesForTest(ranges);
	const dangerous = await isDangerousUrl("http://10.1.2.3/");
	assert.equal(dangerous, false, "10.1.2.3 should be allowed via 10.0.0.0/8");
});

test("isDangerousUrl: 192.168.1.5 blocked when only 10.0.0.0/8 is set", async () => {
	const ranges = parseAllowRanges("10.0.0.0/8");
	setSsrfAllowRangesForTest(ranges);
	const dangerous = await isDangerousUrl("http://192.168.1.5/");
	assert.ok(dangerous, "192.168.1.5 is not in 10.0.0.0/8 so must be blocked");
});

test("isDangerousUrl: 192.168.1.5 allowed when 192.168.1.0/24 is set", async () => {
	const ranges = parseAllowRanges("192.168.1.0/24");
	setSsrfAllowRangesForTest(ranges);
	const dangerous = await isDangerousUrl("http://192.168.1.5/");
	assert.equal(dangerous, false);
});

test("isDangerousUrl: 10.99.0.1 blocked when only 10.0.0.0/24 is set", async () => {
	// 10.99.x.x is outside 10.0.0.0/24
	const ranges = parseAllowRanges("10.0.0.0/24");
	setSsrfAllowRangesForTest(ranges);
	const dangerous = await isDangerousUrl("http://10.99.0.1/");
	assert.ok(dangerous);
});

test("isDangerousUrl: public IP is never blocked regardless of allow-list", async () => {
	const ranges = parseAllowRanges("10.0.0.0/8");
	setSsrfAllowRangesForTest(ranges);
	// 8.8.8.8 is a public IP — allow-list has no effect on it
	const dangerous = await isDangerousUrl("http://8.8.8.8/");
	assert.equal(dangerous, false);
});

// ─── Cleanup: reset override after all tests ────────────────────────

test("cleanup: reset allow-list override", () => {
	setSsrfAllowRangesForTest(null);
	assert.ok(true);
});
