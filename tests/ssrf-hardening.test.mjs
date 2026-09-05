// ─── Tests for H1 SSRF hardening ────────────────────────────────────
//
// Covers the three H1 guarantees plus the DNS-pinning primitive:
//   1. DNS-pinning      — createPinnedLookup() + validateUrlForSsrf()
//                         return the *validated* IPs so the connector dials
//                         the same address that passed validation (closes
//                         the re-resolve TOCTOU). A re-resolve to an
//                         internal IP is blocked.
//   2. Fail-closed      — any guard exception (DNS error, empty answer,
//                         unparseable URL, unexpected throw) => DENY.
//   3. Metadata floor   — the cloud-metadata block (169.254.169.254 &
//                         equivalents, metadata.google.internal) is absolute
//                         and cannot be relaxed by the CIDR allow-list.
//
// All DNS-dependent branches are exercised through the injected `resolve`
// parameter of validateUrlForSsrf() — NO real network calls, matching the
// offline mocking pattern used elsewhere in this suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	validateUrlForSsrf,
	isDangerousUrl,
	isCloudMetadataIp,
	createPinnedLookup,
	parseAllowRanges,
	setSsrfAllowRangesForTest,
	ssrfVerdictToFetchError,
} from "../src/security.ts";
import { buildHostResolverRules } from "../src/fetch.ts";

/** Build a fake resolver that returns the given addresses (family auto). */
function resolverReturning(addresses) {
	return async () =>
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
}

/** A fake resolver that always throws (simulates getaddrinfo failure). */
async function throwingResolver() {
	throw new Error("getaddrinfo ENODATA");
}

// ─── isCloudMetadataIp (the absolute floor primitive) ───────────────

test("isCloudMetadataIp: 169.254.169.254 is metadata", () => {
	assert.equal(isCloudMetadataIp("169.254.169.254"), true);
});

test("isCloudMetadataIp: AWS IMDSv2 IPv6 fd00:ec2::254 is metadata", () => {
	assert.equal(isCloudMetadataIp("fd00:ec2::254"), true);
});

test("isCloudMetadataIp: IPv4-mapped ::ffff:169.254.169.254 is metadata", () => {
	assert.equal(isCloudMetadataIp("::ffff:169.254.169.254"), true);
});

test("isCloudMetadataIp: IPv4-compatible ::169.254.169.254 is metadata", () => {
	assert.equal(isCloudMetadataIp("::169.254.169.254"), true);
});

test("isCloudMetadataIp: transition encodings of metadata stay on the floor", () => {
	for (const ip of [
		"64:ff9b::a9fe:a9fe",
		"64:ff9b:1:a9fe:a9:fe00::",
		"64:ff9b:1:aba9:fe:a9fe::",
		"64:ff9b:1:abcd:a9:fea9:fe00:0",
		"2002:a9fe:a9fe::",
		"2001:0:4136:e378:8000:63bf:5601:5601",
	]) {
		assert.equal(isCloudMetadataIp(ip), true, ip);
	}
});

test("isCloudMetadataIp: public IP is not metadata", () => {
	assert.equal(isCloudMetadataIp("8.8.8.8"), false);
	assert.equal(isCloudMetadataIp("93.184.216.34"), false);
});

test("isCloudMetadataIp: other link-local IP is not metadata (floor is specific)", () => {
	// 169.254.1.1 is link-local (private) but NOT a metadata endpoint — the
	// floor must not over-match, or it would shadow the allow-list for the
	// whole 169.254/16 range.
	assert.equal(isCloudMetadataIp("169.254.1.1"), false);
});

// ─── Non-public address coverage ────────────────────────────────────

for (const [label, url] of [
	["IPv4 protocol-assignment range", "http://192.0.0.8/"],
	["IPv4 documentation range TEST-NET-1", "http://192.0.2.1/"],
	["IPv4 deprecated 6to4 relay range", "http://192.88.99.1/"],
	["IPv4 6a44-relay anycast", "http://192.88.99.2/"],
	["IPv4 documentation range TEST-NET-2", "http://198.51.100.1/"],
	["IPv4 documentation range TEST-NET-3", "http://203.0.113.1/"],
	["IPv4 multicast", "http://224.0.0.1/"],
	["IPv4 reserved", "http://240.0.0.1/"],
	["IPv6 local-use translation prefix", "http://[64:ff9b:1::808:808]/"],
	["IPv6 translation of private IPv4", "http://[64:ff9b::a00:1]/"],
	["IPv6 dummy prefix", "http://[100:0:0:1::1]/"],
	["6to4 with compressed private IPv4 payload", "http://[2002:a00:1::]/"],
	[
		"Teredo with compressed private IPv4 payload",
		"http://[2001:0:4136:e378:8000:63bf:f5ff:fffe]/",
	],
	["IPv6 benchmarking", "http://[2001:2::1]/"],
	["IPv6 deprecated ORCHID", "http://[2001:10::1]/"],
	["IPv6 documentation", "http://[2001:db8::1]/"],
	["IPv6 documentation (3fff::/20)", "http://[3fff::1]/"],
	["IPv6 segment-routing SIDs", "http://[5f00::1]/"],
	["IPv6 link-local outside fe80::/16", "http://[febf::1]/"],
	["IPv6 multicast", "http://[ff02::1]/"],
]) {
	test(`non-public ranges: ${label} is blocked`, async () => {
		setSsrfAllowRangesForTest([]);
		const r = await validateUrlForSsrf(url);
		assert.equal(r.dangerous, true);
		assert.equal(r.reason, "private-range");
		assert.deepEqual(r.pinnedIps, []);
	});
}

for (const [label, url] of [
	["IPv4 PCP anycast exception", "http://192.0.0.9/"],
	["IPv4 TURN anycast exception", "http://192.0.0.10/"],
	["IPv4 address before protocol assignments", "http://191.255.255.255/"],
	["IPv4 address after protocol assignments", "http://192.0.1.1/"],
	["IPv4 address before benchmarking", "http://198.17.255.255/"],
	["IPv4 address after benchmarking", "http://198.20.0.1/"],
	["IPv4 unicast below multicast", "http://223.255.255.255/"],
	["IPv6 well-known translation of public IPv4", "http://[64:ff9b::808:808]/"],
	["6to4 with compressed public IPv4 payload", "http://[2002:808:808::]/"],
	[
		"Teredo with compressed public IPv4 payload",
		"http://[2001:0:4136:e378:8000:63bf:f7f7:f7f7]/",
	],
	["IPv6 PCP anycast exception", "http://[2001:1::1]/"],
	["IPv6 TURN anycast exception", "http://[2001:1::2]/"],
	["IPv6 DNS-SD anycast exception", "http://[2001:1::3]/"],
	["IPv6 AMT exception", "http://[2001:3::1]/"],
	["IPv6 AS112 exception", "http://[2001:4:112::1]/"],
	["IPv6 ORCHIDv2 first block", "http://[2001:20::1]/"],
	["IPv6 ORCHIDv2 final block", "http://[2001:2f:ffff::1]/"],
	["IPv6 Drone Remote ID first block", "http://[2001:30::1]/"],
	["IPv6 Drone Remote ID final block", "http://[2001:3f:ffff::1]/"],
	["IPv6 address after 3fff::/20 documentation", "http://[3fff:1000::1]/"],
	["IPv6 address after 5f00::/16 SRv6 SIDs", "http://[5f01::1]/"],
]) {
	test(`public range exceptions: ${label} is allowed`, async () => {
		setSsrfAllowRangesForTest([]);
		const r = await validateUrlForSsrf(url);
		assert.equal(r.dangerous, false);
		assert.ok(r.pinnedIps.length > 0);
	});
}

test("non-public ranges: expanded IPv6 documentation spelling is blocked", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://[2001:0db8:0000:0000:0000:0000:0000:0001]/",
	);
	assert.equal(r.dangerous, true);
});

test("non-public ranges: IPv4-mapped documentation address is blocked", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf("http://[::ffff:192.0.2.1]/");
	assert.equal(r.dangerous, true);
});

test("non-public ranges: canonical IPv4-compatible private forms are blocked", async () => {
	setSsrfAllowRangesForTest([]);
	for (const url of ["http://[::127.0.0.1]/", "http://[::10.0.0.1]/"]) {
		const r = await validateUrlForSsrf(url);
		assert.equal(r.dangerous, true, url);
		assert.equal(r.reason, "private-range", url);
	}
});

test("non-public ranges: mask boundaries classify both sides", async () => {
	setSsrfAllowRangesForTest([]);
	for (const url of [
		"http://[100:0:0:1:ffff:ffff:ffff:ffff]/",
		"http://[2001:1f:ffff:ffff:ffff:ffff:ffff:ffff]/",
		"http://[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]/",
		"http://[5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/",
	]) {
		assert.equal((await validateUrlForSsrf(url)).dangerous, true, url);
	}
	for (const url of [
		"http://[100:0:0:2::1]/",
		"http://[3fff:1000::1]/",
		"http://[5f01::1]/",
	]) {
		assert.equal((await validateUrlForSsrf(url)).dangerous, false, url);
	}
});

test("non-public ranges: exact IPv6 exception boundaries do not widen", async () => {
	setSsrfAllowRangesForTest([]);
	for (const url of [
		"http://[2001:1::4]/",
		"http://[2001:2:ffff::1]/",
		"http://[2001:4:111::1]/",
		"http://[2001:4:113::1]/",
	]) {
		assert.equal((await validateUrlForSsrf(url)).dangerous, true, url);
	}
});

test("non-public ranges: mixed DNS answer with documentation address is blocked", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://mixed.example/",
		resolverReturning(["93.184.216.34", "203.0.113.1"]),
	);
	assert.equal(r.dangerous, true);
	assert.deepEqual(r.pinnedIps, []);
});

test("non-public ranges: explicit CIDR allow-list permits configured ranges and compatible forms", async () => {
	setSsrfAllowRangesForTest(
		parseAllowRanges("10.0.0.0/8,203.0.113.0/24,3fff::/20"),
	);
	try {
		for (const url of [
			"http://203.0.113.1/",
			"http://[3fff::1]/",
			"http://[::10.0.0.1]/",
		]) {
			assert.equal((await validateUrlForSsrf(url)).dangerous, false, url);
		}
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

// ─── Metadata floor is non-overridable by the allow-list ────────────

test("metadata floor: 169.254.169.254 literal blocked even when 169.254.0.0/16 is allowed", async () => {
	setSsrfAllowRangesForTest(parseAllowRanges("169.254.0.0/16"));
	try {
		const r = await validateUrlForSsrf(
			"http://169.254.169.254/latest/meta-data/",
		);
		assert.equal(
			r.dangerous,
			true,
			"metadata IP must be blocked despite allow-list",
		);
		assert.deepEqual(r.pinnedIps, []);
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

test("metadata floor: literal fd00:ec2::254 (AWS IMDSv6) blocked via evaluateIp even when fd00:ec2::/24 is allowed", async () => {
	// fd00:ec2::254 is a metadata endpoint but NOT in BLOCKED_HOSTS, so this
	// exercises the evaluateIp() floor on the literal-IP branch specifically
	// (independent of the blocked-host quick path).
	setSsrfAllowRangesForTest(parseAllowRanges("fd00:ec2::/24"));
	try {
		const r = await validateUrlForSsrf("http://[fd00:ec2::254]/");
		assert.equal(r.dangerous, true, "metadata IPv6 must hit the absolute floor");
		assert.equal(r.reason, "cloud-metadata");
		assert.deepEqual(r.pinnedIps, []);
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

test("metadata floor: resolved 169.254.169.254 blocked even when 169.254.0.0/16 is allowed", async () => {
	setSsrfAllowRangesForTest(parseAllowRanges("169.254.0.0/16"));
	try {
		// An attacker-controlled hostname that resolves to the metadata IP.
		const r = await validateUrlForSsrf(
			"http://evil.example.com/",
			resolverReturning(["169.254.169.254"]),
		);
		assert.equal(r.dangerous, true, "resolved metadata IP must hit the floor");
		assert.equal(r.reason, "cloud-metadata");
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

test("metadata floor: transition encodings stay blocked when their outer ranges are allowed", async () => {
	setSsrfAllowRangesForTest(
		parseAllowRanges("64:ff9b::/32,2002::/16,2001::/32"),
	);
	try {
		for (const url of [
			"http://[64:ff9b::a9fe:a9fe]/",
			"http://[64:ff9b:1:a9fe:a9:fe00::]/",
			"http://[64:ff9b:1:aba9:fe:a9fe::]/",
			"http://[2002:a9fe:a9fe::]/",
			"http://[2001:0:4136:e378:8000:63bf:5601:5601]/",
		]) {
			const r = await validateUrlForSsrf(url);
			assert.equal(r.dangerous, true, url);
			assert.equal(r.reason, "cloud-metadata", url);
		}
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

test("metadata floor: metadata.google.internal blocked regardless of allow-list", async () => {
	setSsrfAllowRangesForTest(parseAllowRanges("0.0.0.0/0"));
	try {
		// Even a /0 allow-all cannot relax the blocked-host floor.
		assert.equal(await isDangerousUrl("http://metadata.google.internal/"), true);
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

test("metadata floor: contrast — ordinary private IP IS relaxable by allow-list", async () => {
	// Proves the floor is specific to metadata, not a blanket deny: 10.x is
	// allowed when 10.0.0.0/8 is configured (existing allow-list behavior).
	setSsrfAllowRangesForTest(parseAllowRanges("10.0.0.0/8"));
	try {
		const r = await validateUrlForSsrf("http://10.1.2.3/");
		assert.equal(r.dangerous, false, "10.x should be allowed via allow-list");
	} finally {
		setSsrfAllowRangesForTest(null);
	}
});

// ─── DNS-pinning: validated IP is the pinned IP ─────────────────────

test("pinning: public resolution is allowed and pins the exact validated IPs", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://example.com/",
		resolverReturning(["93.184.216.34", "2606:2800:220:1::248"]),
	);
	assert.equal(r.dangerous, false);
	// The pinned IPs are exactly the addresses that passed validation —
	// the same resolution used for validation is handed to the connector.
	assert.deepEqual(r.pinnedIps, ["93.184.216.34", "2606:2800:220:1::248"]);
});

test("pinning: createPinnedLookup dials the validated IP, ignoring the resolver", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://example.com/",
		resolverReturning(["93.184.216.34"]),
	);
	assert.equal(r.dangerous, false);

	const lookup = createPinnedLookup(r.pinnedIps);
	const dialed = await new Promise((resolve, reject) => {
		// Ask for a DIFFERENT hostname — the pinned lookup must ignore it
		// and return the validated IP (that is the whole point of pinning).
		lookup("attacker-rebind.example.net", {}, (err, address, family) => {
			if (err) return reject(err);
			resolve({ address, family });
		});
	});
	assert.equal(dialed.address, "93.184.216.34");
	assert.equal(dialed.family, 4);
});

test("pinning: re-resolve to an internal IP is blocked (TOCTOU closed at validation)", async () => {
	setSsrfAllowRangesForTest([]);
	// Simulate DNS rebinding: the answer set contains an internal IP.
	const r = await validateUrlForSsrf(
		"http://rebind.example.com/",
		resolverReturning(["93.184.216.34", "127.0.0.1"]),
	);
	assert.equal(r.dangerous, true, "any internal address poisons the answer set");
	assert.deepEqual(
		r.pinnedIps,
		[],
		"no pins are ever produced for a dangerous URL",
	);
});

test("pinning: a resolver returning only an internal IP yields no usable pin", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://internal.example.com/",
		resolverReturning(["10.0.0.5"]),
	);
	assert.equal(r.dangerous, true);
	assert.deepEqual(r.pinnedIps, []);
});

// ─── createPinnedLookup call-shapes + defense in depth ──────────────

test("createPinnedLookup: all:true returns every pinned address", () => {
	const lookup = createPinnedLookup(["93.184.216.34", "2606:2800:220:1::248"]);
	lookup("h", { all: true }, (err, addresses) => {
		assert.equal(err, null);
		assert.deepEqual(addresses, [
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:2800:220:1::248", family: 6 },
		]);
	});
});

test("createPinnedLookup: numeric family option filters pins", () => {
	const lookup = createPinnedLookup(["93.184.216.34", "2606:2800:220:1::248"]);
	lookup("h", 6, (err, address, family) => {
		assert.equal(err, null);
		assert.equal(address, "2606:2800:220:1::248");
		assert.equal(family, 6);
	});
});

test("createPinnedLookup: (host, cb) two-arg form works", () => {
	const lookup = createPinnedLookup(["93.184.216.34"]);
	lookup("h", (err, address, family) => {
		assert.equal(err, null);
		assert.equal(address, "93.184.216.34");
		assert.equal(family, 4);
	});
});

test("createPinnedLookup: fails closed (ENOTFOUND) when no pin matches the family", () => {
	const lookup = createPinnedLookup(["93.184.216.34"]); // IPv4 only
	lookup("h", { family: 6 }, (err, address) => {
		assert.ok(err, "must error, not fall back to the real resolver");
		assert.equal(err.code, "ENOTFOUND");
		assert.equal(address, undefined);
	});
});

test("createPinnedLookup: fails closed (ENOTFOUND) when given no pins", () => {
	const lookup = createPinnedLookup([]);
	lookup("h", {}, (err) => {
		assert.ok(err);
		assert.equal(err.code, "ENOTFOUND");
	});
});

test("createPinnedLookup: never hands out a metadata IP even if one is pinned", () => {
	// Defense in depth: even a caller that mistakenly pins the metadata IP
	// gets nothing back rather than a metadata address.
	const lookup = createPinnedLookup(["169.254.169.254"]);
	lookup("h", {}, (err) => {
		assert.ok(err, "metadata pin must be filtered out");
		assert.equal(err.code, "ENOTFOUND");
	});
});

// ─── Fail-closed on guard exceptions ────────────────────────────────

test("fail-closed: DNS resolution error => dangerous", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://nxdomain.example.com/",
		throwingResolver,
	);
	assert.equal(r.dangerous, true);
	assert.equal(r.reason, "dns-error");
	assert.deepEqual(r.pinnedIps, []);
});

test("fail-closed: empty DNS answer set => dangerous", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://empty.example.com/",
		resolverReturning([]),
	);
	assert.equal(r.dangerous, true);
	assert.equal(r.reason, "dns-empty");
});

test("fail-closed: resolver returning non-array => dangerous", async () => {
	setSsrfAllowRangesForTest([]);
	const r = await validateUrlForSsrf(
		"http://weird.example.com/",
		async () => null,
	);
	assert.equal(r.dangerous, true);
});

test("fail-closed: unparseable URL => dangerous", async () => {
	assert.equal(await isDangerousUrl("not a url"), true);
	const r = await validateUrlForSsrf("::::");
	assert.equal(r.dangerous, true);
	assert.equal(r.reason, "unparseable");
});

test("fail-closed: isDangerousUrl wrapper denies on DNS error", async () => {
	// The boolean wrapper (used by content.ts local-knowledge pre-check)
	// must inherit fail-closed.
	setSsrfAllowRangesForTest([]);
	assert.equal(await isDangerousUrl("http://127.0.0.1/"), true);
});

// ─── Truthful surfacing: SSRF verdict → FetchError ──────────────────
// The guard is fail-closed, but the DIAGNOSIS must be honest: a host with
// no DNS records is a DNS problem, not an SSRF block (regression: zcode.dev
// surfaced as "targeted a private/internal address" when the apex simply
// had no address records).

test("verdict→error: dns-error surfaces as dns_error, NOT blocked_ssrf", () => {
	const err = ssrfVerdictToFetchError("https://zcode.dev/", {
		dangerous: true,
		reason: "dns-error",
		pinnedIps: [],
	});
	assert.equal(err.code, "dns_error");
	assert.equal(err.phase, "connecting");
	assert.equal(err.category, "network");
	assert.match(err.message, /no resolvable DNS records/i);
	assert.match(err.message, /zcode\.dev/);
});

test("verdict→error: dns-empty surfaces as dns_error, NOT blocked_ssrf", () => {
	const err = ssrfVerdictToFetchError("https://empty.example/", {
		dangerous: true,
		reason: "dns-empty",
		pinnedIps: [],
	});
	assert.equal(err.code, "dns_error");
	assert.equal(err.phase, "connecting");
	assert.equal(err.category, "network");
});

test("verdict→error: private-range stays blocked_ssrf with reason + recognizer prefix", () => {
	const err = ssrfVerdictToFetchError("https://10.0.0.5/", {
		dangerous: true,
		reason: "private-range",
		pinnedIps: [],
	});
	assert.equal(err.code, "blocked_ssrf");
	assert.equal(err.phase, "validation");
	assert.equal(err.category, "validation");
	assert.equal(err.retryable, false);
	// classifyError keys on this prefix — keep it intact for genuine blocks.
	assert.match(err.message, /blocked request to private\/internal url/i);
	assert.match(err.message, /reason: private-range/);
});

test("verdict→error: metadata stays blocked_ssrf", () => {
	const err = ssrfVerdictToFetchError(
		"http://169.254.169.254/latest/meta-data/",
		{ dangerous: true, reason: "cloud-metadata", pinnedIps: [] },
	);
	assert.equal(err.code, "blocked_ssrf");
	assert.equal(err.phase, "validation");
});

// ─── buildHostResolverRules (Playwright pin wiring) ─────────────────

test("buildHostResolverRules: maps hostname to the first validated IP", () => {
	const args = buildHostResolverRules("example.com", [
		"93.184.216.34",
		"1.2.3.4",
	]);
	assert.deepEqual(args, [
		"--host-resolver-rules=MAP example.com 93.184.216.34",
	]);
});

test("buildHostResolverRules: no rule for an IP-literal host", () => {
	assert.deepEqual(
		buildHostResolverRules("93.184.216.34", ["93.184.216.34"]),
		[],
	);
});

test("buildHostResolverRules: no rule when there are no validated pins", () => {
	assert.deepEqual(buildHostResolverRules("example.com", []), []);
});

// ─── cleanup ────────────────────────────────────────────────────────

test("cleanup: reset allow-list override", () => {
	setSsrfAllowRangesForTest(null);
	assert.ok(true);
});
