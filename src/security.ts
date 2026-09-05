// ─── SSRF protection & secret scanning ─────────────────────────────
// Extracted from index.ts for use across all pi-webaio modules.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createFetchError, type FetchError } from "./tools/fetch-error.ts";

// ─── Local / private URL detection ─────────────────────────────────

/** Blocked metadata/magic hostnames — cloud provider instance metadata endpoints. */
const BLOCKED_HOSTS = new Set([
	"localhost",
	"ip6-localhost",
	"0.0.0.0",
	"metadata.google.internal",
	"169.254.169.254",
]);

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map((x) => Number(x));
	if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return true;
	const [a, b, c, d] = parts as [number, number, number, number];
	// RFC 7723 and RFC 8155 carve two globally reachable anycast hosts out
	// of the otherwise non-public 192.0.0.0/24 protocol-assignment block.
	if (a === 192 && b === 0 && c === 0 && (d === 9 || d === 10)) return false;
	return (
		a === 0 || // "this" network
		a === 10 || // RFC 1918
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // shared address space (RFC 6598)
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) || // RFC 1918
		(a === 192 && b === 0 && c === 0) || // IETF protocol assignments
		(a === 192 && b === 0 && c === 2) || // TEST-NET-1
		(a === 192 && b === 88 && c === 99) || // deprecated 6to4 relay anycast
		(a === 192 && b === 168) || // RFC 1918
		(a === 198 && (b === 18 || b === 19)) || // benchmarking (RFC 2544)
		(a === 198 && b === 51 && c === 100) || // TEST-NET-2
		(a === 203 && b === 0 && c === 113) || // TEST-NET-3
		a >= 224 // multicast and reserved
	);
}

function isPrivateIPv6(ip: string): boolean {
	const n = ip.toLowerCase();
	if (n === "::1" || n === "::") return true;

	const v4Mapped = n.match(/^::ffff:([\d.]+)$/);
	if (v4Mapped) return isPrivateIPv4(v4Mapped[1]!);

	const v4Compat = n.match(/^::([\d.]+)$/);
	if (v4Compat) return isPrivateIPv4(v4Compat[1]!);

	// Byte-level checks for transition mechanisms that embed an IPv4
	// address in the low bits. A prefix translating to a private/metadata
	// IPv4 is an SSRF vector, so evaluate the embedded address (same
	// approach as the 6to4 / Teredo string checks below).
	const bytes = ipv6ToBytes(n);
	if (bytes) {
		// Unique-local fc00::/7, link-local fe80::/10, and multicast ff00::/8.
		if ((bytes[0]! & 0xfe) === 0xfc) return true;
		if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
		if (bytes[0] === 0xff) return true;

		// 64:ff9b:1::/48 is the local-use translation prefix and is not
		// globally reachable. 64:ff9b::/96 is globally reachable, so permit it
		// only when its embedded IPv4 destination is public.
		const nat64Prefix =
			bytes[0] === 0x00 &&
			bytes[1] === 0x64 &&
			bytes[2] === 0xff &&
			bytes[3] === 0x9b;
		const nat64_48 = nat64Prefix && bytes[4] === 0x00 && bytes[5] === 0x01;
		if (nat64_48) return true;
		const nat64_96 = nat64Prefix && bytes.subarray(4, 12).every((b) => b === 0);
		if (nat64_96) {
			return isPrivateIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
		}

		// 6to4 embeds the destination IPv4 address in bits 16–48. Teredo
		// stores the client's IPv4 address, one's-complemented, in the final
		// 32 bits. Use bytes so compressed IPv6 spellings cannot bypass the
		// embedded-address checks.
		if (bytes[0] === 0x20 && bytes[1] === 0x02) {
			return isPrivateIPv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
		}
		if (
			bytes[0] === 0x20 &&
			bytes[1] === 0x01 &&
			bytes[2] === 0x00 &&
			bytes[3] === 0x00
		) {
			return isPrivateIPv4(
				`${bytes[12]! ^ 0xff}.${bytes[13]! ^ 0xff}.${bytes[14]! ^ 0xff}.${bytes[15]! ^ 0xff}`,
			);
		}

		// The IANA IPv6 special-purpose registry marks these ranges as not
		// globally reachable.
		if (
			bytes[0] === 0x01 &&
			bytes[1] === 0x00 &&
			bytes[2] === 0x00 &&
			bytes[3] === 0x00 &&
			bytes[4] === 0x00 &&
			bytes[5] === 0x00 &&
			bytes[6] === 0x00 &&
			bytes[7] === 0x01
		)
			return true; // 100:0:0:1::/64 dummy prefix
		if (
			bytes[0] === 0x20 &&
			bytes[1] === 0x01 &&
			bytes[2] === 0x0d &&
			bytes[3] === 0xb8
		)
			return true; // 2001:db8::/32 documentation
		if (
			bytes[0] === 0x3f &&
			bytes[1] === 0xff &&
			(bytes[2]! & 0xf0) === 0
		)
			return true; // 3fff::/20 documentation
		if (bytes[0] === 0x5f && bytes[1] === 0x00) return true; // SRv6 SIDs

		// 2001::/23 is non-public except for six globally reachable ranges.
		// Teredo was handled by the embedded-address check above.
		const inIetfAssignments =
			bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0;
		if (inIetfAssignments) {
			const isAnycast =
				bytes[2] === 0 &&
				bytes[3] === 1 &&
				bytes.subarray(4, 15).every((b) => b === 0) &&
				(bytes[15] === 1 || bytes[15] === 2 || bytes[15] === 3);
			const isAmt = bytes[2] === 0 && bytes[3] === 3;
			const isAs112 =
				bytes[2] === 0 && bytes[3] === 4 && bytes[4] === 1 && bytes[5] === 0x12;
			const isOrchidV2 =
				bytes[2] === 0 && (bytes[3]! & 0xf0) === 0x20;
			const isDroneDet = bytes[2] === 0 && (bytes[3]! & 0xf0) === 0x30;
			if (
				!isAnycast &&
				!isAmt &&
				!isAs112 &&
				!isOrchidV2 &&
				!isDroneDet
			)
				return true;
		}
		// IPv4-mapped hex form ::ffff:XXYY:ZZWW (the dotted-quad form is
		// handled by the regex above; this catches the hex spelling).
		const mappedHex =
			bytes.subarray(0, 10).every((b) => b === 0) &&
			bytes[10] === 0xff &&
			bytes[11] === 0xff;
		const compatibleHex = bytes.subarray(0, 12).every((b) => b === 0);
		if (mappedHex || compatibleHex) {
			return isPrivateIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
		}
	}

	return false;
}

/**
 * Validate an IP is in a private/internal/loopback range.
 * Covers all RFC 1918, RFC 6598 (CGN), RFC 3927 (link-local),
 * loopback (127.x, ::1), unique local IPv6 (fc00::/7, fd00::/8),
 * and link-local IPv6 (fe80::/10).
 */
export function isPrivateIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return isPrivateIPv4(ip);
	if (version === 6) return isPrivateIPv6(ip);
	return true; // unparsable = treat as dangerous
}

// ─── Cloud-metadata floor (absolute, un-overridable) ───────────────
// Instance-metadata endpoints are the single highest-value SSRF target
// (they hand out IAM credentials). Blocking them is a HARD FLOOR: unlike
// the RFC1918/CGN/link-local ranges below, this block can NEVER be relaxed
// by the config-driven CIDR allow-list (WEBAIO_SSRF_ALLOW_RANGES) or any
// env override. evaluateIp() checks this before consulting the allow-list,
// and createPinnedLookup() re-enforces it so a pinned IP can never be a
// metadata address even if a caller mistakenly pins one.

/** IPv4 cloud instance-metadata addresses (AWS/GCP/Azure/DigitalOcean). */
const METADATA_IPV4 = new Set(["169.254.169.254"]);
/** IPv6 cloud instance-metadata addresses (AWS IMDSv2). */
const METADATA_IPV6 = new Set(["fd00:ec2::254"]);

/**
 * Returns true if `ip` is a cloud instance-metadata endpoint. This is an
 * absolute deny floor — it is evaluated independently of, and takes
 * precedence over, the SSRF allow-list.
 */
export function isCloudMetadataIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return METADATA_IPV4.has(ip);
	if (version === 6) {
		const n = ip.toLowerCase();
		if (METADATA_IPV6.has(n)) return true;
		return embeddedIpv4Candidates(n).some((v4) => METADATA_IPV4.has(v4));
	}
	return false;
}

/**
 * Decode IPv4 destinations carried by mapped, compatible, NAT64, 6to4, and
 * Teredo IPv6 addresses. Multiple NAT64 local-prefix layouts are returned
 * because RFC 6052 permits several prefix lengths under 64:ff9b:1::/48.
 */
function embeddedIpv4Candidates(ip: string): string[] {
	const bytes = ipv6ToBytes(ip.toLowerCase());
	if (!bytes) return [];
	const out: string[] = [];
	const add = (a: number, b: number, c: number, d: number): void => {
		const candidate = `${a}.${b}.${c}.${d}`;
		if (!out.includes(candidate)) out.push(candidate);
	};

	const mapped =
		bytes.subarray(0, 10).every((b) => b === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff;
	const compatible = bytes.subarray(0, 12).every((b) => b === 0);
	if (mapped || compatible) add(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

	const nat64Prefix =
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b;
	if (nat64Prefix && bytes.subarray(4, 12).every((b) => b === 0)) {
		add(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!); // /96
	}
	if (nat64Prefix && bytes[4] === 0 && bytes[5] === 1) {
		add(bytes[6]!, bytes[7]!, bytes[9]!, bytes[10]!); // /48
		add(bytes[7]!, bytes[9]!, bytes[10]!, bytes[11]!); // /56
		add(bytes[9]!, bytes[10]!, bytes[11]!, bytes[12]!); // /64
		add(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!); // defensive
	}

	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		add(bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
	}
	if (
		bytes[0] === 0x20 &&
		bytes[1] === 0x01 &&
		bytes[2] === 0x00 &&
		bytes[3] === 0x00
	) {
		add(
			bytes[12]! ^ 0xff,
			bytes[13]! ^ 0xff,
			bytes[14]! ^ 0xff,
			bytes[15]! ^ 0xff,
		);
	}
	return out;
}

// ─── SSRF allow-list (CIDR ranges) ─────────────────────────────────

interface ParsedCidr {
	bytes: Uint8Array; // network address, always 16 bytes (IPv6 or IPv4-mapped)
	prefixLen: number; // 0–128
}

/** Expand a full 128-bit IPv6 address string into 16 bytes. */
function ipv6ToBytes(ip: string): Uint8Array | null {
	// Handle IPv4-mapped / IPv4-compat addresses embedded as ::ffff:a.b.c.d
	const v4Mapped = ip.match(/^::(?:ffff:)?([\d.]+)$/i);
	if (v4Mapped) {
		const v4 = ipv4ToBytes(v4Mapped[1]!);
		if (!v4) return null;
		const out = new Uint8Array(16);
		out[10] = 0xff;
		out[11] = 0xff;
		out.set(v4, 12);
		return out;
	}

	// Expand :: shorthand
	const halves = ip.split("::");
	if (halves.length > 2) return null;

	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];

	// Last group of right side might be an IPv4 literal (e.g. ::ffff:192.0.2.1)
	let v4Tail: Uint8Array | null = null;
	if (right.length > 0) {
		const last = right[right.length - 1]!;
		if (last.includes(".")) {
			v4Tail = ipv4ToBytes(last);
			if (!v4Tail) return null;
			right.splice(right.length - 1, 1);
		}
	}

	const totalGroups = 8 - (v4Tail ? 2 : 0);
	const missing = totalGroups - left.length - right.length;
	if (missing < 0 && halves.length === 1) return null;

	const groups: number[] = [
		...left.map((g) => parseInt(g, 16)),
		...Array(halves.length === 2 ? missing : 0).fill(0),
		...right.map((g) => parseInt(g, 16)),
	];

	if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;

	const out = new Uint8Array(16);
	for (let i = 0; i < groups.length; i++) {
		out[i * 2] = (groups[i]! >> 8) & 0xff;
		out[i * 2 + 1] = groups[i]! & 0xff;
	}
	if (v4Tail) {
		out.set(v4Tail, 12);
	}
	return out;
}

/** Convert a dotted-decimal IPv4 string to 4 bytes. */
function ipv4ToBytes(ip: string): Uint8Array | null {
	const parts = ip.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((x) => Number.isNaN(x) || x < 0 || x > 255)
	)
		return null;
	return new Uint8Array(parts as number[]);
}

/**
 * Parse a CIDR string (IPv4 or IPv6) into a canonical 16-byte form.
 * Returns null for malformed input.
 * /0 is treated as matching nothing (deny-all range is not a useful allow).
 */
export function parseCidr(cidr: string): ParsedCidr | null {
	const slash = cidr.lastIndexOf("/");
	if (slash === -1) return null;

	const addr = cidr.slice(0, slash).trim();
	const prefixStr = cidr.slice(slash + 1).trim();
	const prefixLen = Number(prefixStr);

	if (!Number.isInteger(prefixLen) || prefixLen < 1) return null;

	const version = isIP(addr);
	if (version === 4) {
		if (prefixLen > 32) return null;
		const v4 = ipv4ToBytes(addr);
		if (!v4) return null;
		// Embed as IPv4-mapped IPv6 for unified comparison
		const bytes = new Uint8Array(16);
		bytes[10] = 0xff;
		bytes[11] = 0xff;
		bytes.set(v4, 12);
		// IPv4 prefix offset by 96 (the IPv4-mapped prefix is 96 bits)
		return { bytes, prefixLen: 96 + prefixLen };
	}

	if (version === 6) {
		if (prefixLen > 128) return null;
		const bytes = ipv6ToBytes(addr);
		if (!bytes) return null;
		return { bytes, prefixLen };
	}

	return null;
}

/**
 * Convert an IP address string to a 16-byte canonical representation.
 * IPv4 addresses are embedded as IPv4-mapped IPv6 (::ffff:a.b.c.d).
 */
function ipToBytes(ip: string): Uint8Array | null {
	const version = isIP(ip);
	if (version === 4) {
		const v4 = ipv4ToBytes(ip);
		if (!v4) return null;
		const out = new Uint8Array(16);
		out[10] = 0xff;
		out[11] = 0xff;
		out.set(v4, 12);
		return out;
	}
	if (version === 6) {
		return ipv6ToBytes(ip);
	}
	return null;
}

/** Returns true if `ip` falls within the given CIDR range. */
export function ipMatchesCidr(ip: string, cidr: ParsedCidr): boolean {
	const ipBytes = ipToBytes(ip);
	if (!ipBytes) return false;

	let remaining = cidr.prefixLen;
	for (let i = 0; i < 16; i++) {
		if (remaining <= 0) break;
		const bits = Math.min(remaining, 8);
		const mask = 0xff & (0xff << (8 - bits));
		if ((ipBytes[i]! & mask) !== (cidr.bytes[i]! & mask)) return false;
		remaining -= bits;
	}
	return true;
}

/**
 * Parse a comma-separated CIDR list string.
 * Malformed entries are silently skipped.
 */
export function parseAllowRanges(str: string): ParsedCidr[] {
	return str
		.split(",")
		.map((s) => parseCidr(s.trim()))
		.filter((x): x is ParsedCidr => x !== null);
}

// Lazy-parsed cache from WEBAIO_SSRF_ALLOW_RANGES
let _cachedRanges: ParsedCidr[] | null = null;
let _testOverride: ParsedCidr[] | null = null;

/** Override allow-ranges for testing without touching process.env. */
export function setSsrfAllowRangesForTest(ranges: ParsedCidr[] | null): void {
	_testOverride = ranges;
	_cachedRanges = null;
}

function getAllowRanges(): ParsedCidr[] {
	if (_testOverride !== null) return _testOverride;
	if (_cachedRanges !== null) return _cachedRanges;
	const raw = process.env["WEBAIO_SSRF_ALLOW_RANGES"] ?? "";
	_cachedRanges = raw.trim() ? parseAllowRanges(raw) : [];
	return _cachedRanges;
}

/** Returns true if `ip` is permitted by the configured allow-list. */
function isAllowed(ip: string, ranges: ParsedCidr[]): boolean {
	if (ranges.length === 0) return false;
	if (ranges.some((r) => ipMatchesCidr(ip, r))) return true;
	// IPv4-compatible IPv6 literals are canonicalized to hex by URL parsing.
	// Let an explicit IPv4 allow-range apply to the same embedded destination.
	return embeddedIpv4Candidates(ip).some((v4) =>
		ranges.some((r) => ipMatchesCidr(v4, r)),
	);
}

/**
 * Ranges that are NEVER legitimately public and are NOT cloud-metadata
 * endpoints proper, but which an attacker can abuse to reach internal
 * services or confuse resolvers. Like the metadata floor, this block is
 * absolute: it is evaluated before, and independently of, the CIDR
 * allow-list, so `WEBAIO_SSRF_ALLOW_RANGES` can never relax it.
 */
export function isNeverPublicFloorIp(ip: string): boolean {
	if (isIP(ip) !== 6) return false;
	const bytes = ipv6ToBytes(ip.toLowerCase());
	if (!bytes) return false;
	// 100::/64 — RFC 6666 discard-only prefix. Never legitimately routable;
	// first 64 bits are 0100:0000:0000:0000.
	if (
		bytes[0] === 0x01 &&
		bytes[1] === 0x00 &&
		bytes.subarray(2, 8).every((b) => b === 0)
	) {
		return true;
	}
	return false;
}

/**
 * Evaluate a single IP against the SSRF policy.
 *
 * Order matters for the security guarantees:
 *  1. Cloud-metadata floor — absolute deny, ignores the allow-list.
 *  2. Never-public floor (e.g. RFC 6666 discard-only) — absolute deny.
 *  3. Private/loopback/link-local ranges — denied UNLESS explicitly
 *     permitted by the config-driven CIDR allow-list.
 *  4. Everything else (public IPs) — allowed.
 *
 * `explicitlyAllowed` is true only when a private/internal IP was permitted
 * by an explicit allow-range. Callers use it to decide whether a dangerous
 * service port may still be reached (an explicit allow-range opts in).
 */
function evaluateIp(
	ip: string,
	ranges: ParsedCidr[],
): { dangerous: boolean; reason?: string; explicitlyAllowed?: boolean } {
	if (isCloudMetadataIp(ip)) {
		return { dangerous: true, reason: "cloud-metadata" };
	}
	if (isNeverPublicFloorIp(ip)) {
		return { dangerous: true, reason: "reserved-range" };
	}
	if (isPrivateIp(ip)) {
		if (isAllowed(ip, ranges))
			return { dangerous: false, explicitlyAllowed: true };
		return { dangerous: true, reason: "private-range" };
	}
	return { dangerous: false };
}

/** A DNS resolver returning every resolved address for a host. */
type DnsResolver = (
	host: string,
) => Promise<Array<{ address: string; family: number }>>;

/** Default resolver backed by node:dns/promises `lookup`. */
const defaultDnsResolver: DnsResolver = async (host) => {
	const records = await dnsLookup(host, { all: true, verbatim: true });
	return records.map((r) => ({ address: r.address, family: r.family }));
};

export interface SsrfValidation {
	/** True when the URL must be blocked. */
	dangerous: boolean;
	/** Machine-readable reason when dangerous (e.g. "cloud-metadata"). */
	reason?: string;
	/**
	 * The validated, safe IPs that DNS resolved to — i.e. the exact
	 * addresses that passed validation. Callers feed these to
	 * {@link createPinnedLookup} so the outbound socket dials the same IP
	 * that was validated, closing the re-resolve TOCTOU gap. Empty whenever
	 * the URL is dangerous (or blocked before resolution).
	 */
	pinnedIps: string[];
}

/**
 * Deep SSRF validation. Resolves DNS exactly once and validates ALL
 * returned IPs against the cloud-metadata floor and the
 * private/loopback/link-local ranges (subject to the CIDR allow-list).
 * Also blocks known metadata hostnames and cloud magic hostnames.
 *
 * FAIL-CLOSED: every abnormal condition — unparsable URL, DNS resolution
 * error, an empty answer set, or any unexpected throw — yields
 * `dangerous: true`. There is no path through this function that fails
 * open.
 *
 * The `resolve` parameter is dependency-injected so tests can exercise the
 * DNS-dependent branches (pinning, fail-closed, metadata floor on resolved
 * IPs) offline without touching the network.
 */
export async function validateUrlForSsrf(
	url: string,
	resolve: DnsResolver = defaultDnsResolver,
): Promise<SsrfValidation> {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();
		const ranges = getAllowRanges();
		const portBlocked = isDangerousPort(effectivePort(u));

		// Quick block: known dangerous hostnames (includes
		// metadata.google.internal — absolute, pre-allow-list).
		if (BLOCKED_HOSTS.has(host)) {
			return { dangerous: true, reason: "blocked-host", pinnedIps: [] };
		}

		// Quick block: literal IP hostnames.
		const cleanedIp = host.replace(/^\[|\]$/g, "");
		if (isIP(cleanedIp)) {
			const ev = evaluateIp(cleanedIp, ranges);
			if (!ev.dangerous && portBlocked && !ev.explicitlyAllowed) {
				return { dangerous: true, reason: "dangerous-port", pinnedIps: [] };
			}
			return {
				dangerous: ev.dangerous,
				reason: ev.reason,
				pinnedIps: ev.dangerous ? [] : [cleanedIp],
			};
		}

		// Quick block: .local and obvious private prefixes (fast path).
		if (isPrivateHostname(host)) {
			return { dangerous: true, reason: "private-prefix", pinnedIps: [] };
		}

		// Deep check: resolve DNS ONCE and validate every IP. The same
		// resolution result is returned as `pinnedIps` so the caller can
		// pin the validated addresses into the actual connection.
		let records: Array<{ address: string; family: number }>;
		try {
			records = await resolve(host);
		} catch {
			// DNS failure — fail closed.
			return { dangerous: true, reason: "dns-error", pinnedIps: [] };
		}
		// An empty answer set is not a safe answer — fail closed.
		if (!Array.isArray(records) || records.length === 0) {
			return { dangerous: true, reason: "dns-empty", pinnedIps: [] };
		}

		const pinnedIps: string[] = [];
		let allExplicitlyAllowed = true;
		for (const record of records) {
			const ev = evaluateIp(record.address, ranges);
			if (ev.dangerous) {
				// Any single bad address poisons the whole answer set.
				return { dangerous: true, reason: ev.reason, pinnedIps: [] };
			}
			if (!ev.explicitlyAllowed) allExplicitlyAllowed = false;
			pinnedIps.push(record.address);
		}

		// Dangerous service port: only reachable when EVERY resolved address
		// was explicitly opted into via the allow-list. A public (or merely
		// non-allow-listed) address on a DB/admin port is blocked. Fail-closed
		// on mixed answer sets.
		if (portBlocked && !allExplicitlyAllowed) {
			return { dangerous: true, reason: "dangerous-port", pinnedIps: [] };
		}

		return { dangerous: false, pinnedIps };
	} catch {
		// Unparsable URL or any unexpected throw — fail closed.
		return { dangerous: true, reason: "unparseable", pinnedIps: [] };
	}
}

/**
 * Deep SSRF check: resolves DNS and validates ALL returned IPs
 * against private/loopback/link-local ranges. Also blocks known
 * metadata endpoints and cloud magic hostnames.
 *
 * Thin boolean wrapper over {@link validateUrlForSsrf} for callers that
 * only need the allow/deny decision. Fail-closed.
 */
export async function isDangerousUrl(url: string): Promise<boolean> {
	return (await validateUrlForSsrf(url)).dangerous;
}

// ─── SSRF verdict → FetchError (truthful surfacing) ────────────────
//
// The guard is fail-closed BY DESIGN: anything it cannot positively
// validate is treated as dangerous. But the *diagnosis* must be honest.
// A host that simply has no DNS records is a DNS problem, not a security
// hazard — telling the agent the request "targeted a private/internal
// address" (the generic blocked_ssrf summary) when the verdict was really
// a resolution failure is actively misleading: the address isn't private,
// and the correct remediation (fix/check the hostname) is completely
// different from an SSRF block.
//
// So DNS-class verdicts (``dns-error`` / ``dns-empty``) surface as
// `dns_error` — the same code the natural fetch path produces when the
// fetcher itself fails to resolve — while genuine SSRF hazards stay
// `blocked_ssrf` with the machine reason embedded in the message.
const SSRF_DNS_REASONS = new Set(["dns-error", "dns-empty"]);

/** Map an SSRF-guard verdict to the phase-aware FetchError a caller should throw. */
export function ssrfVerdictToFetchError(
	url: string,
	verdict: SsrfValidation,
): FetchError {
	const reason = verdict.reason ?? "unparseable";
	if (SSRF_DNS_REASONS.has(reason)) {
		// DNS resolution failure / empty answer set: honest DNS error. Phase
		// `connecting` + category `network` match the natural dns_error path
		// (classifyError → ENOTFOUND/getaddrinfo/DNS). Retryable stays at the
		// code default (dns_error is retryable) so transient resolver
		// hiccups keep their usual retry semantics; a host with genuinely no
		// records simply won't come back, same as a normal fetch.
		return createFetchError(
			"dns_error",
			`[SECURITY] SSRF pre-check: ${safeHostname(url)} has no resolvable DNS records (${reason}) — nothing to validate or connect to.`, // eslint-disable-line max-len
			{ url, phase: "connecting" },
		);
	}
	// Genuine SSRF hazard: keep the recognizer-compatible prefix (fetch-error.ts
	// classifyError keys on "blocked request to private/internal url") and add
	// the machine reason for diagnostics.
	return createFetchError(
		"blocked_ssrf",
		`[SECURITY] Blocked request to private/internal URL: ${url}${
			reason && reason !== "unparseable" ? ` (reason: ${reason})` : ""
		}`, // eslint-disable-line max-len
		{ url, phase: "validation" },
		{ retryable: false },
	);
}

/** Best-effort hostname for error messages; falls back to the raw URL. */
function safeHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

// ─── Dangerous service ports ────────────────────────────────────────
// Admin / datastore service ports that should essentially never be the
// target of a web fetch. Blocking them is additive defense-in-depth: even
// an otherwise-reachable host is refused on these ports UNLESS the target
// IP was explicitly opted into via WEBAIO_SSRF_ALLOW_RANGES (see
// evaluateIp `explicitlyAllowed`), so a deliberately allow-listed internal
// database can still be reached by an operator who asked for it.
const DANGEROUS_PORTS = new Set([
	22, // ssh
	23, // telnet
	25, // smtp
	135, // msrpc
	139, // netbios
	445, // smb
	1099, // java rmi
	1433, // mssql
	1521, // oracle
	2049, // nfs
	3306, // mysql
	3389, // rdp
	5432, // postgres
	5900, // vnc
	5984, // couchdb
	6379, // redis
	9200, // elasticsearch
	9300, // elasticsearch transport
	11211, // memcached
	27017, // mongodb
	50000, // sap
]);

/** True when `port` is a blocked admin/datastore service port. */
export function isDangerousPort(port: number | null | undefined): boolean {
	if (port == null || Number.isNaN(port)) return false;
	return DANGEROUS_PORTS.has(port);
}

/** Resolve a URL's effective numeric port (protocol default when absent). */
function effectivePort(u: URL): number | null {
	if (u.port) return Number(u.port);
	if (u.protocol === "http:") return 80;
	if (u.protocol === "https:") return 443;
	return null;
}

/**
 * Synchronous, DNS-free SSRF pre-check for a single URL. Used to gate
 * redirect hops and subresource requests in the Playwright fallback (see
 * fetch.ts), where each mid-chain `Location` cannot be run through the async
 * DNS validator. It catches the high-value cases — literal private/metadata
 * IPs, blocked metadata hostnames, `.local`, private host prefixes, and
 * dangerous service ports — without a resolver call. Hostnames that would
 * only be caught after DNS resolution are NOT covered here (documented
 * limitation); the initial navigation is still fully validated by
 * {@link validateUrlForSsrf}. Fail-closed on an unparsable URL.
 */
export function fastSsrfBlock(url: string): {
	dangerous: boolean;
	reason?: string;
} {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { dangerous: true, reason: "unparseable" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		return { dangerous: false };
	}
	const host = u.hostname.toLowerCase();
	if (BLOCKED_HOSTS.has(host)) {
		return { dangerous: true, reason: "blocked-host" };
	}
	const ranges = getAllowRanges();
	const cleanedIp = host.replace(/^\[|\]$/g, "");
	if (isIP(cleanedIp)) {
		const ev = evaluateIp(cleanedIp, ranges);
		if (
			!ev.dangerous &&
			isDangerousPort(effectivePort(u)) &&
			!ev.explicitlyAllowed
		) {
			return { dangerous: true, reason: "dangerous-port" };
		}
		return { dangerous: ev.dangerous, reason: ev.reason };
	}
	if (isPrivateHostname(host)) {
		return { dangerous: true, reason: "private-prefix" };
	}
	return { dangerous: false };
}

/**
 * Fast-path private-network hostname check shared by the SSRF validators:
 * returns true when the hostname is obviously private (dot-local or a
 * private IPv4 prefix), without resolving DNS (dedup, jscpd).
 */
function isPrivateHostname(host: string): boolean {
	if (host.endsWith(".local")) return true;
	if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
	if (host.startsWith("172.")) {
		const octet = Number.parseInt(host.split(".")[1] ?? "0", 10);
		if (octet >= 16 && octet <= 31) return true;
	}
	return false;
}

// ─── DNS pinning ───────────────────────────────────────────────────

/**
 * Build a Node-style DNS `lookup` function (the signature accepted by
 * `net.connect`, `http.request`, and undici `Agent({ connect: { lookup } })`)
 * that ignores the resolver and returns only the supplied, already-validated
 * IPs.
 *
 * This is what closes the re-resolve TOCTOU: validation resolves DNS once
 * (see {@link validateUrlForSsrf} → `pinnedIps`); the connector then uses
 * this lookup so the socket dials the exact IP that passed validation,
 * instead of re-resolving and potentially getting a different (internal)
 * address between validation and connect.
 *
 * Defense in depth: metadata IPs are filtered out unconditionally, so a
 * pinned lookup can never hand out a cloud-metadata address even if a
 * caller mistakenly pins one.
 *
 * The returned function supports all three Node call shapes:
 *   lookup(host, cb)                 → cb(null, address, family)
 *   lookup(host, family, cb)         → cb(null, address, family)
 *   lookup(host, { all: true }, cb)  → cb(null, [{ address, family }])
 * If no pinned address matches the requested family it fails closed with
 * an ENOTFOUND error rather than falling back to the real resolver.
 */
export function createPinnedLookup(
	pinnedIps: string[],
): (hostname: string, options: unknown, callback?: unknown) => void {
	const pins = pinnedIps
		.map((ip) => ({ address: ip, family: isIP(ip) }))
		.filter((p) => p.family !== 0)
		.filter(
			(p) => !isCloudMetadataIp(p.address) && !isNeverPublicFloorIp(p.address),
		);

	return function pinnedLookup(
		hostname: string,
		options: unknown,
		callback?: unknown,
	): void {
		let opts: { family?: number; all?: boolean } = {};
		let cb = callback as (
			err: NodeJS.ErrnoException | null,
			address?: string | Array<{ address: string; family: number }>,
			family?: number,
		) => void;
		if (typeof options === "function") {
			cb = options as typeof cb;
			opts = {};
		} else if (typeof options === "number") {
			opts = { family: options };
		} else if (options && typeof options === "object") {
			opts = options as { family?: number; all?: boolean };
		}

		const family = opts.family ?? 0;
		const matches = family ? pins.filter((p) => p.family === family) : pins;

		if (matches.length === 0) {
			const err = new Error(
				`No pinned address available for ${hostname}`,
			) as NodeJS.ErrnoException;
			err.code = "ENOTFOUND";
			(err as { hostname?: string }).hostname = hostname;
			cb(err);
			return;
		}

		if (opts.all === true) {
			cb(
				null,
				matches.map((p) => ({ address: p.address, family: p.family })),
			);
			return;
		}
		cb(null, matches[0]!.address, matches[0]!.family);
	};
}

// ─── Secret scanning ───────────────────────────────────────────────

interface SecretMatch {
	type: string;
	pattern: RegExp;
}

const SECRET_PATTERNS: SecretMatch[] = [
	{ type: "AWS Access Key ID", pattern: /AKIA[0-9A-Z]{16}/ },
	{
		type: "AWS Secret Key",
		pattern:
			/(aws_?secret(_access)?_?key|secret_access_key|aws_secret_access_key)[=:/%22'_-]*[0-9a-zA-Z/+]{40}/i,
	},
	{ type: "GitHub PAT (classic)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
	{
		type: "GitHub PAT (fine-grained)",
		pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,
	},
	{ type: "GitHub OAuth", pattern: /gho_[a-zA-Z0-9]{36}/ },
	{ type: "GitHub App Token", pattern: /(ghs_|ghu_)[a-zA-Z0-9]{36}/ },
	{ type: "GitHub Actions Token", pattern: /ghp_[a-zA-Z0-9]{36}/ },
	{ type: "GitLab PAT", pattern: /glpat-[a-zA-Z0-9-]{20,}/ },
	{ type: "npm Token", pattern: /npm_[a-zA-Z0-9]{36}/ },
	{ type: "PyPI Token", pattern: /pypi-[a-zA-Z0-9_-]{50,}/ },
	{
		type: "Slack Bot Token",
		pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/,
	},
	{ type: "Stripe Live Key", pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
	{ type: "Stripe Test Key", pattern: /sk_test_[a-zA-Z0-9]{24,}/ },
	{ type: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
	{
		type: "SendGrid API Key",
		pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/,
	},
	{ type: "DigitalOcean PAT", pattern: /dop_v1_[a-f0-9]{64}/ },
	// OpenAI: legacy sk- keys are 48 chars; sk-proj- and sk-svcacct- are
	// longer. Pattern requires at least 20 trailing chars to avoid false
	// positives on short random strings, but stays loose enough for new
	// formats.
	{
		type: "OpenAI API Key",
		pattern: /sk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,}/,
	},
	// Anthropic: sk-ant-api03- is the current format; older sk-ant-
	// prefixes exist too. Require at least 20 trailing chars.
	{
		type: "Anthropic API Key",
		pattern: /sk-ant-(?:api03-)?[a-zA-Z0-9_-]{20,}/,
	},
	// Supabase service_role / anon keys
	{
		type: "Supabase Service Key",
		pattern:
			/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{40,}\.[a-zA-Z0-9_-]{20,}/,
	},
	// Vercel tokens
	{ type: "Vercel Token", pattern: /vercel_[a-zA-Z0-9]{24,}/ },
	// Cloudflare API tokens
	{ type: "Cloudflare API Token", pattern: /cf-[a-zA-Z0-9_-]{40}/ },
	{
		type: "Private Key",
		pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
	},
	{ type: "Password in URL", pattern: /:\/\/[^\s:@]+:([^\s@]+)@/ },
];

export function scanForSecrets(text: string): {
	found: boolean;
	matches: string[];
} {
	const matches: string[] = [];
	for (const { type, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			matches.push(type);
		}
	}
	return { found: matches.length > 0, matches };
}
