// ─── Secret redaction (output/error masking) ────────────────────────
// H2: complement the block-on-secret scanner in security.ts. Where
// security.ts *blocks* a fetch whose URL contains a secret (high
// precision required to avoid false-positive fetch refusals), this
// module *masks* secrets that appear in OUTPUT — error messages,
// echoed URLs, and rendered previews — so a credential that slips
// through in a response body, a header echo, or an error string never
// lands in the agent's context window.
//
// DECOUPLING NOTE: this module is intentionally SELF-CONTAINED. It
// does NOT import the pattern table from security.ts. Detection and
// redaction have different precision needs (detection must be
// high-precision to avoid blocking legitimate fetches; redaction can
// be broader because masking is non-destructive to the request). It
// also keeps H2 independent of concurrent edits to security.ts (H1).
//
// PRECISION TRADE-OFFS (body text):
//   Docs and articles legitimately discuss API keys ("set api_key to
//   your key", "the token parameter"). Aggressively scrubbing every
//   key-shaped word would corrupt legitimate content. So:
//     - Key/value forms only match on a real ASSIGNMENT (key=value or
//       key: value) whose VALUE passes an entropy check (digits, mixed
//       case, or symbols). A bare word mention ("the api_key param")
//       or a placeholder assignment with a low-entropy value
//       ("token=getToken", "password=password") is left untouched.
//     - Unambiguous shapes (Authorization headers, JWTs, private-key
//       blocks, password-in-URL userinfo) are always masked — they
//       essentially never appear in legitimate prose by accident.
//   The caller decides where this runs: we apply it to error messages
//   and short TUI previews/URLs, NOT to the full saved page body, so
//   long-form documentation is never rewritten.
//
// Idempotency: the placeholder format `[REDACTED:<type>]` is chosen so
// that no pattern here can re-match it (no `eyJ`, no `-----BEGIN`, no
// `://user:`, no `Authorization:`, and `REDACTED` is not a key name),
// so redacting already-redacted text is a stable no-op.

/** Placeholder types emitted by redactSecrets. */
export type RedactionType =
	| "auth-header"
	| "jwt"
	| "private-key"
	| "password"
	| "api-key"
	| "token"
	| "secret";

/** Stable placeholder for a masked secret. */
export function redactionPlaceholder(type: RedactionType): string {
	return `[REDACTED:${type}]`;
}

// ─── Authorization headers ──────────────────────────────────────────
// `Authorization: Bearer <tok>`, `Authorization: Basic <tok>`,
// `authorization=token <tok>`. Unambiguous — always mask the token.
const AUTH_HEADER_RE =
	/\b(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

// ─── JWTs ───────────────────────────────────────────────────────────
// Three base64url segments; the header segment always starts `eyJ`
// (the base64 of `{"alg"`/`{"typ"`). Requiring all three segments to
// be reasonably long keeps this high-precision.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

// ─── Private-key blocks ─────────────────────────────────────────────
// Full BEGIN…END block first, then a stray BEGIN line (truncated body).
const PRIVATE_KEY_BLOCK_RE =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[^\n]*/g;

// ─── Password-in-URL (userinfo) ─────────────────────────────────────
// `scheme://user:pass@host`. The `//` anchor excludes `mailto:`, and
// the trailing `@` distinguishes userinfo from a `host:port` pair.
const PASSWORD_URL_RE = /(\/\/[^\s:@/]+:)([^\s@/]+)(@)/g;

// ─── Key/value & query-param assignments ────────────────────────────
// api_key=…, apikey=…, access_token=…, token=…, secret=…, password=…,
// in both `key=value` and `key: value` forms, optionally quoted.
// Written as a literal (not `new RegExp`) so there is no dynamic
// pattern construction. Group 3 is the opening quote; \3 backrefs it
// so a quoted value must close with the same quote.
const KV_RE =
	/(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|pwd)(\s*[:=]\s*)(["']?)([A-Za-z0-9._~+=/-]+)(\3)/gi;

/**
 * Entropy guard for key/value redaction. Real secrets carry digits,
 * mixed case, or symbols; plain lowercase words ("function", "null",
 * "password") and short placeholders do not, so we leave those alone
 * to avoid corrupting documentation prose / code samples.
 */
function looksLikeSecretValue(value: string): boolean {
	if (value.length < 8) return false;
	const hasDigit = /\d/.test(value);
	const hasUpper = /[A-Z]/.test(value);
	const hasLower = /[a-z]/.test(value);
	const hasSymbol = /[-_.~+/]/.test(value);
	if (hasDigit) return true;
	if (hasUpper && hasLower) return true;
	if ((hasUpper || hasLower) && hasSymbol) return true;
	return false;
}

/** Map a matched key name to a redaction type. */
function kvType(key: string): RedactionType {
	const k = key.toLowerCase();
	if (k.includes("key")) return "api-key";
	if (k.includes("token")) return "token";
	if (k.includes("secret")) return "secret";
	return "password"; // password / passwd / pwd
}

/**
 * Mask secrets in `text` in-place, returning a new string with each
 * secret replaced by a stable `[REDACTED:<type>]` placeholder. Safe to
 * call on already-redacted text (idempotent) and on secret-free text
 * (returns it unchanged). Never throws on non-string input — coerces
 * to string so it can wrap arbitrary error/URL fields defensively.
 */
export function redactSecrets(text: string): string {
	if (text == null) return "";
	if (typeof text !== "string") text = String(text);
	if (!text) return text;

	let out = text;

	// Unambiguous shapes first.
	out = out.replace(
		AUTH_HEADER_RE,
		(_m, lead: string) => `${lead}${redactionPlaceholder("auth-header")}`,
	);
	out = out.replace(JWT_RE, redactionPlaceholder("jwt"));
	out = out.replace(PRIVATE_KEY_BLOCK_RE, redactionPlaceholder("private-key"));
	out = out.replace(PRIVATE_KEY_BEGIN_RE, redactionPlaceholder("private-key"));
	out = out.replace(
		PASSWORD_URL_RE,
		(_m, lead: string, _pw: string, at: string) =>
			`${lead}${redactionPlaceholder("password")}${at}`,
	);

	// Key/value + query-param assignments (entropy-guarded).
	out = out.replace(
		KV_RE,
		(
			match: string,
			key: string,
			sep: string,
			openQuote: string,
			value: string,
			closeQuote: string,
		) => {
			if (!looksLikeSecretValue(value)) return match; // leave prose/code alone
			return `${key}${sep}${openQuote}${redactionPlaceholder(kvType(key))}${closeQuote}`;
		},
	);

	return out;
}
