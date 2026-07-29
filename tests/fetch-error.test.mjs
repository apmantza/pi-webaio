// ─── Tests for fetch-error.ts ────────────────────────────────────
// Phase-aware FetchError classification, user-facing summary
// generation, and retry-timeout suggestion.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildUserFacingFetchErrorSummary,
	classifyError,
	createFetchError,
	fetchErrorInfoFromUnknown,
	isFetchError,
	isRetryableCode,
	suggestRetryTimeoutMs,
	toFetchErrorInfo,
} from "../src/tools/fetch-error.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * @param {Partial<import("../src/tools/fetch-error.ts").FetchError>} overrides
 * @returns {import("../src/tools/fetch-error.ts").FetchError}
 */
function makeErr(overrides = {}) {
	return createFetchError(
		overrides.code ?? "unknown",
		overrides.message ?? "Test error",
		{
			url: overrides.url ?? "https://example.com",
			finalUrl: overrides.finalUrl,
			phase: overrides.phase ?? "downloading",
			timeoutMs: overrides.timeoutMs,
			statusCode: overrides.statusCode,
			mimeType: overrides.mimeType,
			contentLength: overrides.contentLength,
			downloadedBytes: overrides.downloadedBytes,
			elapsedMs: overrides.elapsedMs,
			attempt: overrides.attempt,
			mode: overrides.mode,
			cause: overrides.cause,
		},
		{ retryable: overrides.retryable },
	);
}

// ─── createFetchError ─────────────────────────────────────────────

test("createFetchError: returns frozen object", () => {
	const err = makeErr();
	assert.ok(Object.isFrozen(err), "should be frozen");
});

test("createFetchError: populates all fields", () => {
	const err = createFetchError("timeout", "Slow server", {
		url: "https://x.com",
		phase: "waiting",
		timeoutMs: 15000,
		elapsedMs: 14900,
		downloadedBytes: 1_000_000,
		contentLength: 5_000_000,
	});
	assert.equal(err.message, "Slow server");
	assert.equal(err.code, "timeout");
	assert.equal(err.phase, "waiting");
	assert.equal(err.category, "network");
	assert.equal(err.retryable, true);
	assert.equal(err.timeoutMs, 15000);
	assert.equal(err.downloadedBytes, 1_000_000);
	assert.match(err.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("createFetchError: retryable derived from code", () => {
	assert.equal(makeErr({ code: "timeout" }).retryable, true);
	assert.equal(makeErr({ code: "not_found" }).retryable, false);
	assert.equal(makeErr({ code: "blocked" }).retryable, true);
	assert.equal(makeErr({ code: "private_ip" }).retryable, false);
});

test("createFetchError: retryable derived from statusCode for http_error", () => {
	assert.equal(
		makeErr({ code: "http_error", statusCode: 500 }).retryable,
		true,
	);
	assert.equal(
		makeErr({ code: "http_error", statusCode: 404 }).retryable,
		false,
	);
	assert.equal(
		makeErr({ code: "http_error", statusCode: 429 }).retryable,
		true,
	);
	assert.equal(
		makeErr({ code: "http_error", statusCode: 503 }).retryable,
		true,
	);
});

test("createFetchError: explicit retryable overrides default", () => {
	assert.equal(makeErr({ code: "not_found", retryable: true }).retryable, true);
	assert.equal(makeErr({ code: "timeout", retryable: false }).retryable, false);
});

test("createFetchError: category maps correctly", () => {
	assert.equal(makeErr({ code: "invalid_url" }).category, "validation");
	assert.equal(makeErr({ code: "dns_error" }).category, "network");
	assert.equal(makeErr({ code: "http_error" }).category, "server");
	assert.equal(makeErr({ code: "binary_content" }).category, "client");
	assert.equal(makeErr({ code: "blocked" }).category, "blocked");
	assert.equal(makeErr({ code: "parse_error" }).category, "processing");
	assert.equal(makeErr({ code: "unknown" }).category, "unknown");
});

// ─── classifyError ────────────────────────────────────────────────

test("classifyError: ABORT_ERR → aborted (waiting)", () => {
	const err = classifyError(
		Object.assign(new Error("aborted"), { code: "ABORT_ERR" }),
		{ url: "https://x.com" },
	);
	assert.equal(err.code, "aborted");
	assert.equal(err.phase, "waiting");
});

test("classifyError: timeout messages → timeout", () => {
	const err1 = classifyError(new Error("Request timed out"), {
		url: "https://x.com",
	});
	assert.equal(err1.code, "timeout");
	assert.equal(err1.phase, "waiting");

	const err2 = classifyError(
		Object.assign(new Error("econnreset"), { code: "ETIMEDOUT" }),
		{ url: "https://x.com" },
	);
	assert.equal(err2.code, "timeout");
});

test("classifyError: TLS error → tls_error (tls phase)", () => {
	const err = classifyError(
		Object.assign(new Error("certificate has expired"), {
			code: "CERT_HAS_EXPIRED",
		}),
		{ url: "https://x.com" },
	);
	assert.equal(err.code, "tls_error");
	assert.equal(err.phase, "tls");
});

test("classifyError: ENOTFOUND → dns_error (connecting)", () => {
	const err = classifyError(
		Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
		{ url: "https://nope.invalid" },
	);
	assert.equal(err.code, "dns_error");
	assert.equal(err.phase, "connecting");
});

test("classifyError: ECONNREFUSED → connect_error", () => {
	const err = classifyError(
		Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		}),
		{ url: "https://x.com" },
	);
	assert.equal(err.code, "connect_error");
	assert.equal(err.phase, "connecting");
});

test("classifyError: ECONNRESET → connect_error", () => {
	const err = classifyError(
		Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
		{ url: "https://x.com" },
	);
	assert.equal(err.code, "connect_error");
});

test("classifyError: redirect loop → redirect_loop", () => {
	const err = classifyError(new Error("Too many redirects detected"), {
		url: "https://x.com",
	});
	assert.equal(err.code, "redirect_loop");
});

test("classifyError: unknown error → unknown (downloading)", () => {
	const err = classifyError(new Error("something weird"), {
		url: "https://x.com",
	});
	assert.equal(err.code, "unknown");
	assert.equal(err.phase, "downloading");
});

test("classifyError: null/undefined → unknown", () => {
	const err1 = classifyError(null, { url: "https://x.com" });
	assert.equal(err1.code, "unknown");
	const err2 = classifyError(undefined, { url: "https://x.com" });
	assert.equal(err2.code, "unknown");
});

test("classifyError: non-Error object → unknown", () => {
	const err = classifyError("just a string", { url: "https://x.com" });
	assert.equal(err.code, "unknown");
	assert.equal(err.message, "just a string");
});

// ─── buildUserFacingFetchErrorSummary ─────────────────────────────

test("buildUserFacingFetchErrorSummary: timeout includes elapsed info", () => {
	const err = makeErr({
		code: "timeout",
		phase: "waiting",
		timeoutMs: 15000,
		elapsedMs: 15000,
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /didn't reply in time/i);
	assert.match(summary, /15\.0s timeout/);
});

test("buildUserFacingFetchErrorSummary: timeout with partial download shows %", () => {
	const err = makeErr({
		code: "timeout",
		phase: "downloading",
		elapsedMs: 14000,
		downloadedBytes: 1_000_000,
		contentLength: 5_000_000, // 4.8 MB in base-1024
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /20% of 4\.8 MB/);
});

test("buildUserFacingFetchErrorSummary: timeout with smaller total (1MB)", () => {
	const err = makeErr({
		code: "timeout",
		phase: "downloading",
		elapsedMs: 5000,
		downloadedBytes: 524_288, // 50%
		contentLength: 1_048_576, // 1.0 MB
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /50% of 1\.0 MB/);
});

test("buildUserFacingFetchErrorSummary: 404 → not found", () => {
	const err = makeErr({ code: "not_found", statusCode: 404 });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /couldn't find that page/i);
	assert.match(summary, /HTTP 404/);
});

test("buildUserFacingFetchErrorSummary: 429 → rate limited", () => {
	const err = makeErr({ code: "rate_limited", statusCode: 429 });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /rate-limited/i);
	assert.match(summary, /HTTP 429/);
});

test("buildUserFacingFetchErrorSummary: 500 → http error", () => {
	const err = makeErr({ code: "http_error", statusCode: 500 });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /error response/i);
	assert.match(summary, /HTTP 500/);
});

test("buildUserFacingFetchErrorSummary: blocked → blocking", () => {
	const err = makeErr({ code: "blocked" });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /blocking automated/i);
});

test("buildUserFacingFetchErrorSummary: paywall → paywall", () => {
	const err = makeErr({ code: "paywall" });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /paywall/i);
});

test("buildUserFacingFetchErrorSummary: DNS error", () => {
	const err = makeErr({ code: "dns_error" });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /resolve the hostname/i);
});

test("buildUserFacingFetchErrorSummary: TLS error", () => {
	const err = makeErr({ code: "tls_error" });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /secure connection/i);
});

test("buildUserFacingFetchErrorSummary: invalid URL", () => {
	const err = makeErr({ code: "invalid_url" });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /couldn't understand the URL/i);
});

test("buildUserFacingFetchErrorSummary: private IP", () => {
	const err = makeErr({ code: "private_ip" });
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /private\/internal/i);
});

test("buildUserFacingFetchErrorSummary: long status tail still under 200", () => {
	// 5xx + huge contentLength produces a long status tail.
	const err = makeErr({
		code: "http_error",
		statusCode: 500,
		contentLength: 5_000_000,
		downloadedBytes: 1_000_000,
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.ok(summary.length <= 200, `summary too long: ${summary.length}`);
});

test("buildUserFacingFetchErrorSummary: unknown code → short fallback", () => {
	const err = makeErr({
		code: "unknown",
		message: "Some long underlying error message that we should still fit",
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.ok(summary.length > 0);
	assert.ok(summary.length < 300);
});

// ─── suggestRetryTimeoutMs ────────────────────────────────────────

test("suggestRetryTimeoutMs: returns undefined for non-timeout", () => {
	assert.equal(
		suggestRetryTimeoutMs(makeErr({ code: "not_found" })),
		undefined,
	);
	assert.equal(
		suggestRetryTimeoutMs(makeErr({ code: "http_error", statusCode: 500 })),
		undefined,
	);
});

test("suggestRetryTimeoutMs: extrapolates from partial download", () => {
	// 5MB downloaded in 5s; total 20MB → 20s total; +20% buffer = 24s
	const err = makeErr({
		code: "timeout",
		elapsedMs: 5000,
		downloadedBytes: 5_000_000,
		contentLength: 20_000_000,
	});
	const suggested = suggestRetryTimeoutMs(err);
	assert.ok(suggested !== undefined);
	assert.equal(suggested, 24_000);
});

test("suggestRetryTimeoutMs: unknown total size → 2x elapsed", () => {
	const err = makeErr({
		code: "timeout",
		elapsedMs: 3000,
		downloadedBytes: 100_000,
	});
	assert.equal(suggestRetryTimeoutMs(err), 6000);
});

test("suggestRetryTimeoutMs: no progress → 2x elapsed", () => {
	const err = makeErr({ code: "timeout", elapsedMs: 8000 });
	assert.equal(suggestRetryTimeoutMs(err), 16_000);
});

test("suggestRetryTimeoutMs: respects minimum (5s)", () => {
	const err = makeErr({ code: "timeout", elapsedMs: 1000 });
	const suggested = suggestRetryTimeoutMs(err);
	assert.ok(suggested !== undefined && suggested >= 5000);
});

test("suggestRetryTimeoutMs: respects maximum (180s)", () => {
	const err = makeErr({
		code: "timeout",
		elapsedMs: 100_000,
		downloadedBytes: 1_000_000,
		contentLength: 100_000_000_000, // way more than we'll ever need
	});
	const suggested = suggestRetryTimeoutMs(err);
	assert.ok(suggested !== undefined && suggested <= 180_000);
});

test("suggestRetryTimeoutMs: returns undefined with no data", () => {
	const err = makeErr({ code: "timeout" });
	assert.equal(suggestRetryTimeoutMs(err), undefined);
});

// ─── isFetchError ────────────────────────────────────────────────

test("isFetchError: true for FetchError instances", () => {
	assert.equal(isFetchError(makeErr()), true);
	assert.equal(
		isFetchError(
			makeErr({ code: "blocked", statusCode: 403, phase: "headers" }),
		),
		true,
	);
});

test("isFetchError: false for non-FetchError values", () => {
	assert.equal(isFetchError(null), false);
	assert.equal(isFetchError(undefined), false);
	assert.equal(isFetchError("string"), false);
	assert.equal(isFetchError(42), false);
	assert.equal(isFetchError({}), false);
	assert.equal(isFetchError(new Error("plain")), false);
	assert.equal(isFetchError({ message: "x", code: "timeout" }), false); // missing required fields
});

// ─── toFetchErrorInfo / fetchErrorInfoFromUnknown ────────────────

test("toFetchErrorInfo: preserves message, code, statusCode", () => {
	const err = makeErr({
		code: "http_error",
		statusCode: 503,
		phase: "loading",
		retryable: true,
	});
	const info = toFetchErrorInfo(err);
	assert.equal(info.message, err.message);
	assert.equal(info.statusCode, 503);
	assert.equal(info.retryable, true);
});

test("toFetchErrorInfo: maps phases back to legacy 5-phase model", () => {
	assert.equal(
		toFetchErrorInfo(makeErr({ phase: "validation" })).phase,
		"validation",
	);
	assert.equal(
		toFetchErrorInfo(makeErr({ phase: "connecting" })).phase,
		"connecting",
	);
	assert.equal(toFetchErrorInfo(makeErr({ phase: "tls" })).phase, "connecting");
	assert.equal(
		toFetchErrorInfo(makeErr({ phase: "headers" })).phase,
		"connecting",
	);
	assert.equal(
		toFetchErrorInfo(makeErr({ phase: "downloading" })).phase,
		"loading",
	);
	assert.equal(
		toFetchErrorInfo(makeErr({ phase: "processing" })).phase,
		"loading",
	);
	assert.equal(
		toFetchErrorInfo(makeErr({ phase: "rendering" })).phase,
		"loading",
	);
});

test("toFetchErrorInfo: maps new codes to legacy 10-code set", () => {
	const validLegacyCodes = new Set([
		"invalid_url",
		"http_error",
		"timeout",
		"network_error",
		"no_content",
		"blocked",
		"processing_error",
		"download_error",
		"too_many_redirects",
		"unknown",
	]);
	for (const code of [
		"invalid_url",
		"private_ip",
		"dns_error",
		"tls_error",
		"timeout",
		"http_error",
		"not_found",
		"download_error",
		"parse_error",
		"blocked",
		"paywall",
	]) {
		const info = toFetchErrorInfo(makeErr({ code }));
		assert.ok(
			validLegacyCodes.has(info.code ?? "unknown"),
			`code ${code} mapped to non-legacy ${info.code}`,
		);
	}
});

test("fetchErrorInfoFromUnknown: classifies then maps", () => {
	const info = fetchErrorInfoFromUnknown(
		Object.assign(new Error("getaddrinfo ENOTFOUND"), {
			code: "ENOTFOUND",
		}),
		{ url: "https://nope.invalid" },
	);
	assert.equal(info.code, "network_error");
	assert.equal(info.phase, "connecting");
	assert.equal(info.retryable, true);
});

// ─── isRetryableCode ─────────────────────────────────────────────

test("isRetryableCode: matches the default matrix", () => {
	assert.equal(isRetryableCode("timeout"), true);
	assert.equal(isRetryableCode("dns_error"), true);
	assert.equal(isRetryableCode("blocked"), true);
	assert.equal(isRetryableCode("paywall"), true);
	assert.equal(isRetryableCode("not_found"), false);
	assert.equal(isRetryableCode("invalid_url"), false);
	assert.equal(isRetryableCode("private_ip"), false);
});

// ─── blocked_ssrf (SSRF guard block) ─────────────────────────────

test("createFetchError: blocked_ssrf has validation phase + category, not retryable", () => {
	const err = createFetchError(
		"blocked_ssrf",
		"[SECURITY] Blocked request to private/internal URL: https://169.254.169.254/",
		{ url: "https://169.254.169.254/", phase: "validation" },
		{ retryable: false },
	);
	assert.equal(err.code, "blocked_ssrf");
	assert.equal(err.phase, "validation");
	assert.equal(err.category, "validation");
	assert.equal(err.retryable, false);
});

test("createFetchError: blocked_ssrf category mirrors blocked_secret", () => {
	assert.equal(makeErr({ code: "blocked_ssrf" }).category, "validation");
	assert.equal(
		makeErr({ code: "blocked_ssrf" }).category,
		makeErr({ code: "blocked_secret" }).category,
	);
});

test("isRetryableCode: blocked_ssrf is not retryable", () => {
	assert.equal(isRetryableCode("blocked_ssrf"), false);
});

test("classifyError: SSRF block message → blocked_ssrf (validation)", () => {
	const err = classifyError(
		new Error(
			"[SECURITY] Blocked request to private/internal URL: https://169.254.169.254/latest/meta-data/",
		),
		{ url: "https://169.254.169.254/latest/meta-data/" },
	);
	assert.equal(err.code, "blocked_ssrf");
	assert.equal(err.phase, "validation");
	assert.equal(err.category, "validation");
	assert.equal(err.retryable, false);
});

test("classifyError: fetchWithPlaywright 'Blocked unsafe URL' → blocked_ssrf", () => {
	const err = classifyError(
		new Error("Blocked unsafe URL: https://10.0.0.1/"),
		{
			url: "https://10.0.0.1/",
		},
	);
	assert.equal(err.code, "blocked_ssrf");
	assert.equal(err.phase, "validation");
	assert.equal(err.retryable, false);
});

test("buildUserFacingFetchErrorSummary: blocked_ssrf renders a clear message", () => {
	const err = makeErr({
		code: "blocked_ssrf",
		phase: "validation",
		message:
			"[SECURITY] Blocked request to private/internal URL: https://169.254.169.254/",
	});
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /private\/internal/i);
	assert.match(summary, /blocked/i);
	assert.ok(summary.length <= 200);
});

test("toFetchErrorInfo: blocked_ssrf maps to legacy invalid_url", () => {
	const info = toFetchErrorInfo(
		makeErr({ code: "blocked_ssrf", phase: "validation" }),
	);
	assert.equal(info.code, "invalid_url");
	assert.equal(info.phase, "validation");
	assert.equal(info.retryable, false);
});

// ─── Integration: full pipeline ─────────────────────────────────

test("integration: thrown Node ENOTFOUND → user-friendly summary + retryable", () => {
	const err = classifyError(
		Object.assign(new Error("getaddrinfo ENOTFOUND"), {
			code: "ENOTFOUND",
		}),
		{ url: "https://nope.invalid" },
	);
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /couldn't resolve/i);
	assert.equal(err.retryable, true);
});

test("integration: throw null in worker → safe FetchError", () => {
	const err = classifyError(null, { url: "https://x.com" });
	assert.equal(err.code, "unknown");
	assert.equal(err.retryable, false);
	assert.equal(err.phase, "downloading");
});

test("integration: FetchError thrown in worker → preserved as-is", () => {
	const original = makeErr({ code: "blocked", phase: "headers" });
	const thrown = { ...original }; // simulate a thrown object
	const detected = isFetchError(thrown);
	assert.equal(detected, true);
});

// ─── P2 polish: real progress from smartFetch ──────────────────

test("integration: classifyError respects enriched progress from readResponseTextWithProgress", () => {
	// Simulates an error thrown by readResponseTextWithProgress when the
	// body is too large: it carries bytesRead and contentLength so we can
	// show how far we got before the kill switch.
	const err = Object.assign(new Error("Response exceeds 50.0MB byte limit"), {
		code: "ERR_RESPONSE_TOO_LARGE",
		bytesRead: 5_000_000, // got 4.8 MB before the kill switch
		contentLength: 20_000_000, // server said 19.1 MB total
	});
	const fe = classifyError(err, { url: "https://huge.example.com/file.zip" });
	assert.equal(fe.code, "download_error");
	assert.equal(fe.phase, "downloading");
	assert.equal(fe.downloadedBytes, 5_000_000);
	assert.equal(fe.contentLength, 20_000_000);
	// suggestRetryTimeoutMs is for timeout-class errors only —
	// a "too large" download needs a higher byte budget, not a longer
	// timeout. So we expect undefined.
	assert.equal(suggestRetryTimeoutMs(fe), undefined);
	// The summary should mention the size so the agent knows the right
	// remedy (raise MAX_RESPONSE_BYTES).
	const summary = buildUserFacingFetchErrorSummary(fe);
	assert.match(summary, /download/i);
});

test("integration: createFetchError preserves every FetchErrorContext field", () => {
	const err = createFetchError("timeout", "Timed out reading body", {
		url: "https://huge.example.com/file",
		finalUrl: "https://huge.example.com/file",
		phase: "downloading",
		timeoutMs: 30000,
		statusCode: 200,
		mimeType: "application/zip",
		contentLength: 200_000_000, // 191 MB
		downloadedBytes: 50_000_000, // 50 MB in 30s = 1.67 MB/s
		elapsedMs: 30000,
		attempt: 1,
		mode: "fingerprint",
		cause: new Error("socket hang up"),
	});
	assert.equal(err.url, "https://huge.example.com/file");
	assert.equal(err.finalUrl, "https://huge.example.com/file");
	assert.equal(err.timeoutMs, 30000);
	assert.equal(err.statusCode, 200);
	assert.equal(err.mimeType, "application/zip");
	assert.equal(err.contentLength, 200_000_000);
	assert.equal(err.downloadedBytes, 50_000_000);
	assert.equal(err.elapsedMs, 30000);
	assert.equal(err.attempt, 1);
	assert.equal(err.mode, "fingerprint");
	assert.ok(err.cause instanceof Error);
	// Smart suggested timeout:
	//  50 MB downloaded in 30s → 1.67 MB/s
	//  150 MB remaining → ~90s
	//  total 30s + 90s = 120s; +20% buffer = 144s
	const suggested = suggestRetryTimeoutMs(err);
	assert.ok(suggested !== undefined);
	assert.ok(
		suggested >= 130000 && suggested <= 160000,
		`got ${suggested}ms, expected 130-160s`,
	);
});

test("integration: HTTP 503 after 2s produces a retryable FetchError with 5xx reason", () => {
	const err = createFetchError("http_error", "HTTP 503", {
		url: "https://flaky.example.com",
		phase: "headers",
		statusCode: 503,
		elapsedMs: 2000,
		attempt: 1,
		mode: "auto",
	});
	assert.equal(err.code, "http_error");
	assert.equal(err.category, "server");
	assert.equal(err.retryable, true);
	const summary = buildUserFacingFetchErrorSummary(err);
	assert.match(summary, /error response/i);
	assert.match(summary, /HTTP 503/);
});
