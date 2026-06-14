// ─── SSRF protection & secret scanning ─────────────────────────────
// Extracted from index.ts for use across all pi-webaio modules.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

// ─── Local / private URL detection ─────────────────────────────────

/** Blocked metadata/magic hostnames — cloud provider instance metadata endpoints. */
export const BLOCKED_HOSTS = new Set([
	"localhost",
	"ip6-localhost",
	"0.0.0.0",
	"metadata.google.internal",
	"169.254.169.254",
]);

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map((x) => Number(x));
	if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return true;
	const [a, b] = parts as [number, number];
	return (
		a === 10 || // RFC 1918
		a === 127 || // loopback
		(a === 172 && b >= 16 && b <= 31) || // RFC 1918
		(a === 192 && b === 168) || // RFC 1918
		(a === 169 && b === 254) || // link-local
		(a === 100 && b >= 64 && b <= 127) || // CGN (RFC 6598)
		a === 0 // "this" network
	);
}

function isPrivateIPv6(ip: string): boolean {
	const n = ip.toLowerCase();
	if (n === "::1" || n === "::") return true;
	if (n.startsWith("fc") || n.startsWith("fd") || n.startsWith("fe80"))
		return true;

	const v4Mapped = n.match(/^::ffff:([\d.]+)$/);
	if (v4Mapped) return isPrivateIPv4(v4Mapped[1]!);

	const v4Compat = n.match(/^::([\d.]+)$/);
	if (v4Compat) return isPrivateIPv4(v4Compat[1]!);

	const sixTo4 = n.match(
		/^2002:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})/i,
	);
	if (sixTo4) {
		const v4 = [
			parseInt(sixTo4[1]!, 16),
			parseInt(sixTo4[2]!, 16),
			parseInt(sixTo4[3]!, 16),
			parseInt(sixTo4[4]!, 16),
		].join(".");
		return isPrivateIPv4(v4);
	}

	const teredo = n.match(
		/^2001:0(?:000)?:.*?:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})$/i,
	);
	if (teredo) {
		const v4 = [
			parseInt(teredo[1]!, 16) ^ 0xff,
			parseInt(teredo[2]!, 16) ^ 0xff,
			parseInt(teredo[3]!, 16) ^ 0xff,
			parseInt(teredo[4]!, 16) ^ 0xff,
		].join(".");
		return isPrivateIPv4(v4);
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
	return true; // unparseable = treat as dangerous
}

/**
 * Deep SSRF check: resolves DNS and validates ALL returned IPs
 * against private/loopback/link-local ranges. Also blocks known
 * metadata endpoints and cloud magic hostnames.
 */
export async function isDangerousUrl(url: string): Promise<boolean> {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();

		// Quick block: known dangerous hostnames
		if (BLOCKED_HOSTS.has(host)) return true;

		// Quick block: literal IP in private range
		const cleanedIp = host.replace(/^\[|\]$/g, "");
		if (isIP(cleanedIp)) {
			return isPrivateIp(cleanedIp);
		}

		// Quick block: .local and obvious private prefixes (fast path)
		if (host.endsWith(".local")) return true;
		if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
		if (host.startsWith("172.")) {
			const octet = Number.parseInt(host.split(".")[1] ?? "0", 10);
			if (octet >= 16 && octet <= 31) return true;
		}

		// Deep check: resolve DNS and validate every IP
		try {
			const records = await dnsLookup(host, { all: true, verbatim: true });
			for (const record of records) {
				if (isPrivateIp(record.address)) return true;
			}
		} catch {
			// DNS failure — treat as potentially dangerous
			return true;
		}

		return false;
	} catch {
		return true; // unparseable URL = dangerous
	}
}

// ─── Secret scanning ───────────────────────────────────────────────

export interface SecretMatch {
	type: string;
	pattern: RegExp;
}

export const SECRET_PATTERNS: SecretMatch[] = [
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
		pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{40,}\.[a-zA-Z0-9_-]{20,}/,
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
