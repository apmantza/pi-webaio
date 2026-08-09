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
	| "secret"
	| "base64-blob";

/** Stable placeholder for a masked secret. */
export function redactionPlaceholder(type: RedactionType): string {
	return `[REDACTED:${type}]`;
}

/**
 * Broker diagnostics have a smaller and stricter trust boundary than normal
 * fetched text.  These fields are credential/opaque-ID carriers even when
 * their values are short, quoted, or otherwise fail the general entropy
 * checks below.  Keep the labels intact so the diagnostic remains useful,
 * while replacing the complete value.
 */
export type BrokerEnvelopeFieldType =
	| "redacted-authorization"
	| "redacted-credential"
	| "redacted-id";

/** Normalize broker diagnostic field aliases without changing their spelling in output. */
export function normalizeBrokerEnvelopeField(field: string): string {
	return field.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

// Keep normalized aliases and their source spellings in one table. The
// normalizer accepts camelCase, snake_case, kebab-case, and spaced JSON-ish
// labels; the word lists also drive the text matcher, so structured and text
// scrubbing cannot silently diverge.
const BROKER_ENVELOPE_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
	apikey: ["api", "key"],
	accesskey: ["access", "key"],
	accesstoken: ["access", "token"],
	authtoken: ["auth", "token"],
	refreshtoken: ["refresh", "token"],
	sessiontoken: ["session", "token"],
	idtoken: ["id", "token"],
	clientsecret: ["client", "secret"],
	clientcredential: ["client", "credential"],
	clientcredentials: ["client", "credentials"],
	secretkey: ["secret", "key"],
	secret: ["secret"],
	token: ["token"],
	password: ["password"],
	passwd: ["passwd"],
	pwd: ["pwd"],
	cookie: ["cookie"],
	cookies: ["cookies"],
	authorization: ["authorization"],
	auth: ["auth"],
	credential: ["credential"],
	credentials: ["credentials"],
	capability: ["capability"],
	capabilities: ["capabilities"],
	clientid: ["client", "id"],
	targetid: ["target", "id"],
	sessionid: ["session", "id"],
	leaseid: ["lease", "id"],
	requestid: ["request", "id"],
	cdptargetid: ["cdp", "target", "id"],
	cdpsessionid: ["cdp", "session", "id"],
	brokerid: ["broker", "id"],
	connectionid: ["connection", "id"],
	client: ["client"],
	target: ["target"],
	session: ["session"],
	lease: ["lease"],
	request: ["request"],
};
const BROKER_ENVELOPE_CREDENTIAL_FIELDS = new Set([
	"apikey", "accesskey", "accesstoken", "authtoken", "refreshtoken",
	"sessiontoken", "idtoken", "clientsecret", "clientcredential",
	"clientcredentials", "secretkey", "secret", "token", "password",
	"passwd", "pwd", "cookie", "cookies", "authorization", "auth",
	"credential", "credentials", "capability", "capabilities",
]);
const BROKER_ENVELOPE_ID_FIELDS = new Set([
	"clientid", "targetid", "sessionid", "leaseid", "requestid",
	"cdptargetid", "cdpsessionid", "brokerid", "connectionid", "client",
	"target", "session", "lease", "request",
]);

/** Return the strict envelope category for a field alias, or undefined for ordinary fields. */
export function brokerEnvelopeFieldType(
	field: string,
): BrokerEnvelopeFieldType | undefined {
	const normalized = normalizeBrokerEnvelopeField(field);
	if (normalized === "authorization" || normalized === "auth")
		return "redacted-authorization";
	if (BROKER_ENVELOPE_ID_FIELDS.has(normalized)) return "redacted-id";
	if (BROKER_ENVELOPE_CREDENTIAL_FIELDS.has(normalized))
		return "redacted-credential";
	return undefined;
}

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const brokerEnvelopeFieldPatterns = Object.keys(BROKER_ENVELOPE_FIELD_ALIASES)
	// Permit separators between any letters as well as between semantic words.
	// This keeps text scrubbing aligned with normalizeBrokerEnvelopeField(), so
	// e.g. accessToken/access_token/access-token/access token are one alias.
	.map((alias) => [...alias].map(escapeRegExp).join("[\\s_-]*"))
	.sort((left, right) => right.length - left.length);
const BROKER_ENVELOPE_FIELD_RE = new RegExp(
	`(^|[^A-Za-z0-9_])(["']?)(${brokerEnvelopeFieldPatterns.join("|")})(?:\\\\?["'])?`,
	"gi",
);

/**
 * Scrub key/value fields in a broker diagnostic string. This intentionally
 * does not use entropy heuristics and does not replace arbitrary occurrences
 * of a caller-provided query. It understands JSON-ish quoted values (including
 * escaped quotes), unquoted assignments, and whitespace-delimited fields.
 */
export function redactBrokerEnvelopeFields(text: string): string {
	if (text == null) return "";
	if (typeof text !== "string") text = String(text);
	if (!text) return text;

	let output = "";
	let cursor = 0;
	BROKER_ENVELOPE_FIELD_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = BROKER_ENVELOPE_FIELD_RE.exec(text))) {
		const fieldEnd = BROKER_ENVELOPE_FIELD_RE.lastIndex;
		let valueStart = fieldEnd;
		while (/\s/.test(text[valueStart] || "")) valueStart++;
		let separatorEnd = valueStart;
		if (text[separatorEnd] === ":" || text[separatorEnd] === "=") {
			separatorEnd++;
			while (/\s/.test(text[separatorEnd] || "")) separatorEnd++;
		} else if (separatorEnd === fieldEnd) {
			// A bare field label is not a value assignment.
			continue;
		}
		if (separatorEnd >= text.length) continue;

		let valueEnd = separatorEnd;
		let opening = "";
		let closing = "";
		if (text[valueEnd] === "{" || text[valueEnd] === "[") {
			const stack = [text[valueEnd] === "{" ? "}" : "]"];
			let quote = "";
			for (valueEnd++; valueEnd < text.length && stack.length > 0; valueEnd++) {
				const character = text[valueEnd];
				if (quote) {
					if (character === "\\") valueEnd++;
					else if (character === quote) quote = "";
					continue;
				}
				if (character === '"' || character === "'") {
					quote = character;
					continue;
				}
				if (character === "{" || character === "[")
					stack.push(character === "{" ? "}" : "]");
				else if (character === stack[stack.length - 1]) stack.pop();
			}
		} else if (text[valueEnd] === "\\" && (text[valueEnd + 1] === '"' || text[valueEnd + 1] === "'")) {
			opening = text.slice(valueEnd, valueEnd + 2);
			valueEnd += 2;
			for (; valueEnd < text.length; valueEnd++) {
				if (text[valueEnd] === "\\" && text[valueEnd + 1] === opening[1]) {
					closing = opening;
					break;
				}
				if (text[valueEnd] === "\\") {
					valueEnd++;
					continue;
				}
			}
		} else if (text[valueEnd] === '"' || text[valueEnd] === "'") {
			opening = text[valueEnd++];
			for (; valueEnd < text.length; valueEnd++) {
				if (text[valueEnd] === "\\") {
					valueEnd++;
					continue;
				}
				if (text[valueEnd] === opening) {
					closing = opening;
					break;
				}
			}
		} else {
			while (
				valueEnd < text.length &&
				!/[\s,;\]}]/.test(text[valueEnd])
			)
				valueEnd++;
		}
		if (valueEnd <= separatorEnd) continue;

		const fieldType = brokerEnvelopeFieldType(match[3]);
		if (!fieldType) continue;
		const replacement = `[${fieldType}]`;
		output += text.slice(cursor, separatorEnd);
		if (opening && !closing) {
			// An opening quote without a matching close is still a sensitive
			// assignment. Fail closed by consuming the entire remaining value;
			// continuing here would append it unchanged after the loop.
			output += opening + replacement;
			cursor = text.length;
			BROKER_ENVELOPE_FIELD_RE.lastIndex = text.length;
			break;
		}
		output += opening + replacement + closing;
		cursor = closing ? valueEnd + closing.length : valueEnd;
		BROKER_ENVELOPE_FIELD_RE.lastIndex = cursor;
	}
	return output + text.slice(cursor);
}

/**
 * Scrub a broker diagnostic value before JSON serialization. Sensitive field
 * names win over value type: numbers, booleans, nulls, arrays, and objects are
 * all replaced when carried by a credential/ID alias. Ordinary strings still
 * receive the broad, entropy-aware redactor. The recursion deliberately builds
 * plain JSON data, so custom toJSON methods cannot reintroduce a raw value.
 */
export function scrubBrokerEnvelopeValue(
	value: unknown,
	key?: string,
	preserveRootRequestId = false,
): unknown {
	const isRootCorrelationId =
		preserveRootRequestId &&
		key === "requestId" &&
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
	const fieldType = key ? brokerEnvelopeFieldType(key) : undefined;
	if (fieldType && !isRootCorrelationId) return `[${fieldType}]`;
	if (typeof value === "string")
		return isRootCorrelationId ? value : redactBrokerEnvelopeFields(redactSecrets(value));
	if (Array.isArray(value))
		return value.map((item) => scrubBrokerEnvelopeValue(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entryValue]) => [
				entryKey,
				scrubBrokerEnvelopeValue(
					entryValue,
					entryKey,
					preserveRootRequestId && entryKey === "requestId",
				),
			]),
		);
	}
	if (typeof value === "bigint") return String(value);
	if (typeof value === "function" || typeof value === "symbol") return undefined;
	return value;
}

// ─── Authorization headers ──────────────────────────────────────────
// Authorization forms may be emitted by different transports as
// `Authorization: Bearer <tok>`, `Authorization Bearer <tok>`,
// `authorization=Basic <tok>`, or as a standalone `Bearer <tok>` /
// `Basic <tok>`. These are unambiguous, so short values are masked too.
const AUTH_HEADER_RE =
	/\b((?:authorization\s*(?:[:=]\s*)?(?:bearer|basic|token)|(?:bearer|basic))\s+)([A-Za-z0-9._~+/=-]+)(?=$|[\s,;"'\]}])/gi;

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

// ─── Long high-entropy base64 blobs ────────────────────────────────────
// A standalone run of >=40 base64 characters that carries real entropy
// (at least one digit AND both upper- and lower-case) is almost always an
// embedded credential / opaque token rather than prose. Run LAST, after the
// unambiguous shapes, so JWT segments and private-key bodies are already
// masked. The look-behinds skip data-URIs (`data:…base64,<payload>`) and the
// entropy guard in the replacer skips pure-hex digests (git SHAs etc., which
// are lowercase-only) and pure-alpha strings. Bounded length (<=512) keeps
// the match and any backtracking tiny.
const BASE64_BLOB_RE =
	/(?<![A-Za-z0-9+/=])(?<!base64,)(?<!data:)([A-Za-z0-9+/]{40,512}={0,2})(?![A-Za-z0-9+/=])/g;

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

	// Long high-entropy base64 blobs (embedded tokens), run last.
	out = out.replace(BASE64_BLOB_RE, (match: string, blob: string) => {
		if (!looksLikeBase64Secret(blob)) return match;
		return redactionPlaceholder("base64-blob");
	});

	return out;
}

/**
 * Entropy guard for base64-blob redaction. Require at least one digit AND
 * both upper- and lower-case letters so we mask opaque tokens but leave
 * pure-hex digests (lowercase-only git SHAs / checksums) and pure-alpha
 * strings alone. Padding (`=`) alone is not enough to qualify.
 */
function looksLikeBase64Secret(blob: string): boolean {
	const body = blob.replace(/=+$/, "");
	if (body.length < 40) return false;
	return /[0-9]/.test(body) && /[a-z]/.test(body) && /[A-Z]/.test(body);
}
