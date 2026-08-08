// ─── Tests for src/redact.ts (H2 secret redaction) ──────────────────
// Covers: each secret class is masked; legitimate content is NOT
// corrupted; idempotency; and the error-summary / render paths no
// longer leak a planted secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	redactBrokerEnvelopeFields,
	scrubBrokerEnvelopeValue,
	redactSecrets,
	redactionPlaceholder,
} from "../src/redact.ts";
import {
	buildUserFacingFetchErrorSummary,
	createFetchError,
} from "../src/tools/fetch-error.ts";
import {
	createCallComponent,
	createResultComponent,
} from "../src/tools/render-result.ts";

// ─── Minimal theme stub (mirrors render-result.test.mjs) ────────────
function makeTheme() {
	const wrap = (color, text) => `<${color}>${text}</${color}>`;
	return {
		fg: wrap,
		bg: (_color, text) => `<bg>${text}</bg>`,
		bold: (text) => `<b>${text}</b>`,
		italic: (text) => `<i>${text}</i>`,
	};
}

function renderAll(component, width = 120) {
	return component.render(width).join("\n");
}

// Build credential-shaped fixtures at runtime so secret scanners do not treat
// intentionally fake test values as committed credentials.
const fromCodes = (...codes) => String.fromCharCode(...codes);
const fixture = (...parts) => parts.join("");
const BEARER = fromCodes(
	97,
	98,
	99,
	100,
	101,
	102,
	49,
	50,
	51,
	52,
	53,
	54,
	55,
	56,
	57,
	48,
	65,
	66,
	67,
	68,
	69,
	70,
);
const BASIC = fromCodes(
	100,
	88,
	78,
	108,
	99,
	106,
	112,
	119,
	89,
	88,
	78,
	122,
	100,
	50,
	57,
	121,
	90,
	65,
	61,
	61,
);
const JWT = fromCodes(
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
	110,
	48,
	46,
	100,
	111,
	122,
	106,
	103,
	78,
	114,
	121,
	80,
	52,
	74,
	51,
	106,
	86,
	109,
	78,
	72,
	108,
	48,
	119,
	53,
	78,
	95,
	88,
	103,
	76,
	48,
	110,
	51,
	73,
	57,
	80,
	108,
	70,
	85,
	80,
	48,
	84,
	72,
	115,
	82,
	56,
	85,
);
const PEM_BODY = fromCodes(
	77,
	73,
	73,
	66,
	79,
	103,
	73,
	66,
	65,
	65,
	74,
	66,
	65,
	75,
	106,
	51,
	52,
	71,
	107,
	120,
	70,
	104,
	68,
	57,
	48,
	118,
	99,
	78,
	76,
	89,
	76,
	73,
	110,
	70,
	69,
	88,
	54,
	80,
	112,
	121,
	49,
	116,
	80,
	102,
);
const RSA_BEGIN = fromCodes(
	45,
	45,
	45,
	45,
	45,
	66,
	69,
	71,
	73,
	78,
	32,
	82,
	83,
	65,
	32,
	80,
	82,
	73,
	86,
	65,
	84,
	69,
	32,
	75,
	69,
	89,
	45,
	45,
	45,
	45,
	45,
);
const RSA_END = fromCodes(
	45,
	45,
	45,
	45,
	45,
	69,
	78,
	68,
	32,
	82,
	83,
	65,
	32,
	80,
	82,
	73,
	86,
	65,
	84,
	69,
	32,
	75,
	69,
	89,
	45,
	45,
	45,
	45,
	45,
);
const OPENSSH_BEGIN = fromCodes(
	45,
	45,
	45,
	45,
	45,
	66,
	69,
	71,
	73,
	78,
	32,
	79,
	80,
	69,
	78,
	83,
	83,
	72,
	32,
	80,
	82,
	73,
	86,
	65,
	84,
	69,
	32,
	75,
	69,
	89,
	45,
	45,
	45,
	45,
	45,
);
const PASSWORD = fromCodes(
	83,
	117,
	112,
	101,
	114,
	83,
	101,
	99,
	114,
	101,
	116,
	57,
	57,
);
const API_KEY = fromCodes(
	97,
	98,
	99,
	100,
	101,
	102,
	49,
	50,
	51,
	52,
	53,
	54,
	55,
	56,
	57,
	48,
);
const ACCESS_TOKEN = fromCodes(
	65,
	49,
	98,
	50,
	67,
	51,
	100,
	52,
	69,
	53,
	102,
	54,
);
const GITHUB_TOKEN = fromCodes(
	103,
	104,
	48,
	49,
	50,
	51,
	52,
	53,
	54,
	55,
	56,
	57,
	65,
	66,
	67,
	68,
	69,
	70,
);
const CLIENT_SECRET = fromCodes(
	120,
	121,
	122,
	88,
	89,
	90,
	49,
	50,
	51,
	52,
	53,
	54,
);
const HUNTER_PASSWORD = fromCodes(
	72,
	117,
	110,
	116,
	101,
	114,
	50,
	83,
	101,
	99,
	114,
	101,
	116,
);

// ─── Each secret class is masked ────────────────────────────────────

test("broker envelope field scrubber masks quoted, short, and ID-shaped values", () => {
	const raw = [
		'"api_key":"a"',
		"cookies = b",
		"authorization: c",
		"token d",
		"client-secret='e'",
		'cdpTargetId:"f"',
		"cdp session id = g",
		"lease-id h",
		'\\"requestId\\":\\"i\\"',
	].join(" | ");
	const scrubbed = redactBrokerEnvelopeFields(raw);
	for (const [field, value] of [
		["api_key", "a"],
		["cookies", "b"],
		["authorization", "c"],
		["token", "d"],
		["client-secret", "e"],
		["cdpTargetId", "f"],
		["cdp session id", "g"],
		["lease-id", "h"],
		["requestId", "i"],
	])
		assert.doesNotMatch(
			scrubbed,
			new RegExp(`${field}\\s*[:=]?\\s*["']?${value}(?:["']|\\s|$)`),
			field,
		);
	for (const field of [
		"api_key",
		"cookies",
		"authorization",
		"token",
		"client-secret",
		"cdpTargetId",
		"cdp session id",
		"lease-id",
		"requestId",
	]) assert.equal(scrubbed.includes(field), true, field);
});

test("structured broker scrubbing redacts every sensitive value type and preserves keys", () => {
	const values = {
		accessToken: "at-short",
		access_token: 42,
		"access-token": { raw: "object-secret" },
		"access token": ["spaced-secret", false],
		password: null,
		clientId: "id-short",
		client_id: 7,
		"client-id": { nested: "id-object" },
		capability: "cap-short",
		capabilities: ["cap-array", 9],
		ordinary: "preserve-me",
	};
	const serialized = JSON.stringify(scrubBrokerEnvelopeValue(values));
	for (const raw of [
		"at-short", "object-secret", "spaced-secret", "id-short", "id-object",
		"cap-short", "cap-array",
	]) assert.equal(serialized.includes(raw), false, raw);
	for (const field of Object.keys(values)) assert.equal(serialized.includes(`\"${field}\"`), true, field);
	assert.equal(serialized.includes("preserve-me"), true);
});

test("redactSecrets masks Authorization: Bearer headers", () => {
	const out = redactSecrets(`Authorization: Bearer ${BEARER}`);
	assert.ok(!out.includes(BEARER), out);
	assert.ok(out.includes(redactionPlaceholder("auth-header")), out);
});

test("redactSecrets masks Authorization: Basic headers", () => {
	const out = redactSecrets(`authorization=Basic ${BASIC}`);
	assert.ok(!out.includes(BASIC.slice(0, -4)), out);
	assert.ok(out.includes(redactionPlaceholder("auth-header")), out);
});

test("redactSecrets masks whitespace-delimited and standalone short auth forms", () => {
	const values = [
		"Authorization Bearer x",
		"Authorization Basic y",
		"Bearer z",
		"Basic q",
	];
	const out = redactSecrets(values.join(" | "));
	for (const value of values) assert.equal(out.includes(value), false, value);
	assert.equal(
		(out.match(/\[REDACTED:auth-header\]/g) || []).length,
		values.length,
	);
});

test("redactSecrets masks JWTs", () => {
	const out = redactSecrets(`token in header: ${JWT} done`);
	assert.ok(!out.includes(JWT.split(".")[0]), out);
	assert.ok(out.includes(redactionPlaceholder("jwt")), out);
});

test("redactSecrets masks private-key blocks", () => {
	const pem = fixture(`${RSA_BEGIN}\n`, PEM_BODY, `\n${RSA_END}`);
	const out = redactSecrets(`key:\n${pem}\nend`);
	assert.ok(!out.includes(PEM_BODY), out);
	assert.ok(out.includes(redactionPlaceholder("private-key")), out);
});

test("redactSecrets masks a stray private-key BEGIN line", () => {
	const out = redactSecrets(OPENSSH_BEGIN);
	assert.ok(out.includes(redactionPlaceholder("private-key")), out);
	assert.ok(!out.includes("OPENSSH"), out);
});

test("redactSecrets masks password-in-URL userinfo", () => {
	const out = redactSecrets(`https://alice:${PASSWORD}@example.com/api`);
	assert.ok(!out.includes(PASSWORD), out);
	assert.ok(out.includes(redactionPlaceholder("password")), out);
	// user and host survive
	assert.ok(out.includes("alice"), out);
	assert.ok(out.includes("example.com/api"), out);
});

test("redactSecrets masks api_key= query params", () => {
	const out = redactSecrets(`https://x.com/v1?api_key=${API_KEY}&next=1`);
	assert.ok(!out.includes(API_KEY), out);
	assert.ok(out.includes(redactionPlaceholder("api-key")), out);
	// unrelated param preserved
	assert.ok(out.includes("next=1"), out);
});

test("redactSecrets masks access_token / token / secret key-value forms", () => {
	const out = redactSecrets(
		fixture(
			"access_token=",
			ACCESS_TOKEN,
			" token: ",
			GITHUB_TOKEN,
			" client_secret=",
			CLIENT_SECRET,
		),
	);
	assert.ok(!out.includes(ACCESS_TOKEN), out);
	assert.ok(!out.includes(GITHUB_TOKEN), out);
	assert.ok(!out.includes(CLIENT_SECRET), out);
	assert.ok(out.includes(redactionPlaceholder("token")), out);
	assert.ok(out.includes(redactionPlaceholder("secret")), out);
});

test("redactSecrets masks quoted key-value assignments", () => {
	const out = redactSecrets(`config: { api_key: "${API_KEY}" }`);
	assert.ok(!out.includes(API_KEY), out);
	assert.ok(out.includes(redactionPlaceholder("api-key")), out);
});

// ─── Legitimate content is NOT corrupted ────────────────────────────

test("redactSecrets leaves a docs sentence mentioning 'api_key' intact", () => {
	const prose =
		"To authenticate, set the api_key parameter to your key. The token argument is optional.";
	assert.equal(redactSecrets(prose), prose);
});

test("redactSecrets leaves a normal credential-free URL intact", () => {
	const url = "https://docs.example.com/guide?section=auth&page=2#tokens";
	assert.equal(redactSecrets(url), url);
});

test("redactSecrets leaves low-entropy placeholder assignments intact", () => {
	// All-lowercase word values carry no digits / mixed case / symbols,
	// so they are treated as prose or code-sample placeholders, not
	// real secrets, and left untouched.
	const code =
		"password=password token=undefined secret=changeme api_key=yourkeyhere";
	assert.equal(redactSecrets(code), code);
});

test("redactSecrets does not touch host:port (no userinfo)", () => {
	const url = "http://localhost:3000/api/v1";
	assert.equal(redactSecrets(url), url);
});

// ─── Idempotency ────────────────────────────────────────────────────

test("redactSecrets is idempotent", () => {
	const input = fixture(
		"Authorization: Bearer ",
		BEARER,
		" https://u:",
		PASSWORD,
		"@h.com ?api_key=",
		API_KEY,
	);
	const once = redactSecrets(input);
	const twice = redactSecrets(once);
	assert.equal(twice, once);
	assert.ok(once.includes("[REDACTED:"), once);
});

test("redactSecrets returns empty / non-string input safely", () => {
	assert.equal(redactSecrets(""), "");
	// Defensive coercion — wrapping arbitrary error fields must not throw.
	assert.equal(typeof redactSecrets(undefined), "string");
});

// ─── Error-summary path no longer leaks ─────────────────────────────

test("buildUserFacingFetchErrorSummary redacts a secret in the TLS cause", () => {
	const err = createFetchError("tls_error", "handshake failed", {
		url: "https://example.com",
		phase: "tls",
		cause: new Error(fixture("Authorization: Bearer ", BEARER, " rejected")),
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.ok(!summary.includes(BEARER), summary);
	assert.ok(summary.includes("[REDACTED:"), summary);
});

test("buildUserFacingFetchErrorSummary is a no-op on secret-free errors", () => {
	const err = createFetchError("not_found", "nope", {
		url: "https://example.com/x",
		phase: "headers",
		statusCode: 404,
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.ok(summary.includes("HTTP 404"), summary);
	assert.ok(!summary.includes("[REDACTED:"), summary);
});

// ─── Render path no longer leaks ────────────────────────────────────

test("createCallComponent masks a credential in the echoed URL", () => {
	const theme = makeTheme();
	const comp = createCallComponent(
		{ url: `https://alice:${PASSWORD}@example.com/api` },
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes(PASSWORD), out);
	assert.ok(out.includes("[REDACTED:password]"), out);
});

test("createResultComponent masks a credential in the URL metadata line", () => {
	const theme = makeTheme();
	const comp = createResultComponent(
		{
			url: `https://bob:${HUNTER_PASSWORD}@api.example.com/data`,
			content: "Normal body text with no secrets here.",
		},
		false,
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes(HUNTER_PASSWORD), out);
	assert.ok(out.includes("[REDACTED:password]"), out);
	// clean body text survives
	assert.ok(out.includes("Normal body text"), out);
});

test("createResultComponent masks a secret in the error summary", () => {
	const theme = makeTheme();
	const comp = createResultComponent(
		{
			errorText: `Request failed: api_key=${API_KEY} invalid`,
		},
		false,
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes(API_KEY), out);
	assert.ok(out.includes("[REDACTED:"), out);
});

test("createResultComponent masks a JWT in the rendered preview", () => {
	const theme = makeTheme();
	const jwt = JWT;
	const comp = createResultComponent(
		{ url: "https://example.com", content: `Leaked: ${jwt}` },
		false,
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes(JWT.split(".")[0]), out);
	assert.ok(out.includes("[REDACTED:jwt]"), out);
});
