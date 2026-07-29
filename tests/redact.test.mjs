// ─── Tests for src/redact.ts (H2 secret redaction) ──────────────────
// Covers: each secret class is masked; legitimate content is NOT
// corrupted; idempotency; and the error-summary / render paths no
// longer leak a planted secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactionPlaceholder } from "../src/redact.ts";
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

// ─── Each secret class is masked ────────────────────────────────────

test("redactSecrets masks Authorization: Bearer headers", () => {
	const out = redactSecrets("Authorization: Bearer abcdef1234567890ABCDEF");
	assert.ok(!out.includes("abcdef1234567890ABCDEF"), out);
	assert.ok(out.includes(redactionPlaceholder("auth-header")), out);
});

test("redactSecrets masks Authorization: Basic headers", () => {
	const out = redactSecrets("authorization=Basic dXNlcjpwYXNzd29yZA==");
	assert.ok(!out.includes("dXNlcjpwYXNzd29yZA"), out);
	assert.ok(out.includes(redactionPlaceholder("auth-header")), out);
});

test("redactSecrets masks JWTs", () => {
	const jwt =
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
	const out = redactSecrets(`token in header: ${jwt} done`);
	assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), out);
	assert.ok(out.includes(redactionPlaceholder("jwt")), out);
});

test("redactSecrets masks private-key blocks", () => {
	const pem =
		"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\n-----END RSA PRIVATE KEY-----";
	const out = redactSecrets(`key:\n${pem}\nend`);
	assert.ok(!out.includes("MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf"), out);
	assert.ok(out.includes(redactionPlaceholder("private-key")), out);
});

test("redactSecrets masks a stray private-key BEGIN line", () => {
	const out = redactSecrets("-----BEGIN OPENSSH PRIVATE KEY-----");
	assert.ok(out.includes(redactionPlaceholder("private-key")), out);
	assert.ok(!out.includes("OPENSSH"), out);
});

test("redactSecrets masks password-in-URL userinfo", () => {
	const out = redactSecrets("https://alice:SuperSecret99@example.com/api");
	assert.ok(!out.includes("SuperSecret99"), out);
	assert.ok(out.includes(redactionPlaceholder("password")), out);
	// user and host survive
	assert.ok(out.includes("alice"), out);
	assert.ok(out.includes("example.com/api"), out);
});

test("redactSecrets masks api_key= query params", () => {
	const out = redactSecrets("https://x.com/v1?api_key=abcdef1234567890&next=1");
	assert.ok(!out.includes("abcdef1234567890"), out);
	assert.ok(out.includes(redactionPlaceholder("api-key")), out);
	// unrelated param preserved
	assert.ok(out.includes("next=1"), out);
});

test("redactSecrets masks access_token / token / secret key-value forms", () => {
	const out = redactSecrets(
		"access_token=A1b2C3d4E5f6 token: gh0123456789ABCDEF client_secret=xyzXYZ123456",
	);
	assert.ok(!out.includes("A1b2C3d4E5f6"), out);
	assert.ok(!out.includes("gh0123456789ABCDEF"), out);
	assert.ok(!out.includes("xyzXYZ123456"), out);
	assert.ok(out.includes(redactionPlaceholder("token")), out);
	assert.ok(out.includes(redactionPlaceholder("secret")), out);
});

test("redactSecrets masks quoted key-value assignments", () => {
	const out = redactSecrets('config: { api_key: "abcdef1234567890" }');
	assert.ok(!out.includes("abcdef1234567890"), out);
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
	const code = "password=password token=undefined secret=changeme api_key=yourkeyhere";
	assert.equal(redactSecrets(code), code);
});

test("redactSecrets does not touch host:port (no userinfo)", () => {
	const url = "http://localhost:3000/api/v1";
	assert.equal(redactSecrets(url), url);
});

// ─── Idempotency ────────────────────────────────────────────────────

test("redactSecrets is idempotent", () => {
	const input =
		"Authorization: Bearer abcdef1234567890 https://u:SecretPass1@h.com ?api_key=abcdef1234567890";
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
	const err = createFetchError(
		"tls_error",
		"handshake failed",
		{
			url: "https://example.com",
			phase: "tls",
			cause: new Error("Authorization: Bearer abcdef1234567890 rejected"),
		},
	);
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.ok(!summary.includes("abcdef1234567890"), summary);
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
		{ url: "https://alice:SuperSecret99@example.com/api" },
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes("SuperSecret99"), out);
	assert.ok(out.includes("[REDACTED:password]"), out);
});

test("createResultComponent masks a credential in the URL metadata line", () => {
	const theme = makeTheme();
	const comp = createResultComponent(
		{
			url: "https://bob:Hunter2Secret@api.example.com/data",
			content: "Normal body text with no secrets here.",
		},
		false,
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes("Hunter2Secret"), out);
	assert.ok(out.includes("[REDACTED:password]"), out);
	// clean body text survives
	assert.ok(out.includes("Normal body text"), out);
});

test("createResultComponent masks a secret in the error summary", () => {
	const theme = makeTheme();
	const comp = createResultComponent(
		{ errorText: "Request failed: api_key=abcdef1234567890 invalid" },
		false,
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes("abcdef1234567890"), out);
	assert.ok(out.includes("[REDACTED:"), out);
});

test("createResultComponent masks a JWT in the rendered preview", () => {
	const theme = makeTheme();
	const jwt =
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
	const comp = createResultComponent(
		{ url: "https://example.com", content: `Leaked: ${jwt}` },
		false,
		theme,
	);
	const out = renderAll(comp);
	assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), out);
	assert.ok(out.includes("[REDACTED:jwt]"), out);
});
