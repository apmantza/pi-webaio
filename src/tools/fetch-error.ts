// ─── Phase-aware FetchError ──────────────────────────────────────
// Extracted from webfetch.ts and content.ts. A discriminated union of
// error shapes that captures WHERE in the fetch pipeline the failure
// happened (validation → connect → TLS → wait → headers → download →
// process → write) and WHAT kind of error it was (DNS, timeout, HTTP,
// bot block, parse, etc.).
//
// Backwards compatible with FetchErrorInfo — the existing payload that
// PullResult.errorInfo carries. Use toFetchErrorInfo(err) to convert.
//
// References:
//   packages/core/src/extract.ts (smart-fetch)
//   packages/core/src/format.ts  (smart-fetch)
//   packages/core/src/tool.ts    (smart-fetch)

import { redactSecrets } from "../redact.ts";

// ─── Codes (26) ───────────────────────────────────────────────────

/** A specific failure category. Independent of WHERE it happened. */
export type FetchErrorCode =
	// validation (input was bad before we even tried)
	| "invalid_url"
	| "private_ip"
	| "blocked_secret"
	| "blocked_ssrf"
	| "redirect_loop"
	// connect (couldn't establish a connection)
	| "dns_error"
	| "connect_error"
	| "tls_error"
	| "aborted"
	// wait (connected but server didn't reply in time)
	| "timeout"
	| "rate_limited"
	// response (got headers back but they say no)
	| "http_error"
	| "not_found"
	| "auth_required"
	// download (body retrieval failed or wrong shape)
	| "download_error"
	| "empty_body"
	| "binary_content"
	| "checksum_mismatch"
	// process (body came back but we couldn't turn it into something)
	| "parse_error"
	| "encoding_error"
	| "out_of_memory"
	// block (server refused the request as a bot / paywall)
	| "blocked"
	| "paywall"
	| "bot_detected"
	// catch-all
	| "no_content"
	| "unknown";

// ─── Legacy payload (backwards compatible with the old FetchErrorInfo) ──
//
// Defined here (not in types.ts) so fetch-error.ts has no import edge to
// types.ts: types.ts re-exports this type for consumers that still use
// FetchErrorInfo directly. This breaks the types.ts <-> fetch-error.ts
// circular dependency (madge).

/** The legacy error-info payload carried by PullResult.errorInfo. */
export interface FetchErrorInfo {
	message: string;
	code?:
		| "invalid_url"
		| "http_error"
		| "timeout"
		| "network_error"
		| "no_content"
		| "blocked"
		| "processing_error"
		| "download_error"
		| "too_many_redirects"
		| "unknown";
	phase?: "validation" | "connecting" | "waiting" | "loading" | "processing";
	retryable?: boolean;
	statusCode?: number;
}

// ─── Phases (10) ──────────────────────────────────────────────────

/** A timeline stage in the fetch pipeline. */
export type FetchPhase =
	| "validation"
	| "connecting"
	| "tls"
	| "waiting"
	| "headers"
	| "downloading"
	| "processing"
	| "rendering"
	| "writing"
	| "finished";

// ─── Context (per-error metadata) ─────────────────────────────────

export interface FetchErrorContext {
	/** URL that was requested (may differ from finalUrl after redirects) */
	url: string;
	/** URL after redirects, if known */
	finalUrl?: string;
	/** Phase where the error occurred */
	phase: FetchPhase;
	/** Effective timeout configured for the request, in ms */
	timeoutMs?: number;
	/** HTTP status code (if we got headers) */
	statusCode?: number;
	/** Content-Type header (if we got headers) */
	mimeType?: string;
	/** Total content length from Content-Length header (bytes) */
	contentLength?: number;
	/** Bytes actually downloaded before failure */
	downloadedBytes?: number;
	/** Wall time spent on this attempt in ms */
	elapsedMs?: number;
	/** 1-based attempt number (1 = first try) */
	attempt?: number;
	/** Scrape mode that was used */
	mode?: "fast" | "fingerprint" | "browser" | "auto";
	/** Original underlying error (Error instance, string, etc.) */
	cause?: unknown;
}

// ─── FetchError shape ─────────────────────────────────────────────

/**
 * Phase-aware fetch error. Frozen plain object — use createFetchError
 * to construct. Carry it in PullResult.errorInfo via toFetchErrorInfo.
 */
export interface FetchError extends FetchErrorContext {
	message: string;
	code: FetchErrorCode;
	retryable: boolean;
	/** Stable category for grouping in logs / metrics */
	category: FetchErrorCategory;
	/** ISO timestamp of when this error was constructed */
	timestamp: string;
}

type FetchErrorCategory =
	| "validation"
	| "network"
	| "server"
	| "client"
	| "blocked"
	| "processing"
	| "unknown";

const CATEGORY_BY_CODE: Record<FetchErrorCode, FetchErrorCategory> = {
	invalid_url: "validation",
	private_ip: "validation",
	blocked_secret: "validation",
	blocked_ssrf: "validation",
	redirect_loop: "client",
	dns_error: "network",
	connect_error: "network",
	tls_error: "network",
	aborted: "network",
	timeout: "network",
	rate_limited: "server",
	http_error: "server",
	not_found: "server",
	auth_required: "server",
	download_error: "network",
	empty_body: "server",
	binary_content: "client",
	checksum_mismatch: "network",
	parse_error: "processing",
	encoding_error: "processing",
	out_of_memory: "processing",
	blocked: "blocked",
	paywall: "blocked",
	bot_detected: "blocked",
	no_content: "server",
	unknown: "unknown",
};

// ─── Retryable matrix ─────────────────────────────────────────────

const DEFAULT_RETRYABLE = new Set<FetchErrorCode>([
	"dns_error",
	"connect_error",
	"aborted",
	"timeout",
	"rate_limited",
	"http_error",
	"download_error",
	"blocked",
	"bot_detected",
	"paywall",
	"empty_body",
]);

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableCode(code: FetchErrorCode): boolean {
	return DEFAULT_RETRYABLE.has(code);
}

// ─── Constructor ──────────────────────────────────────────────────

/**
 * Build a FetchError. `retryable` is auto-derived from `code` and
 * `statusCode`; pass an explicit value to override.
 */
export function createFetchError(
	code: FetchErrorCode,
	message: string,
	ctx: FetchErrorContext,
	overrides: { retryable?: boolean } = {},
): FetchError {
	const retryable =
		overrides.retryable ??
		(code === "http_error" && ctx.statusCode !== undefined
			? RETRYABLE_STATUS.has(ctx.statusCode)
			: isRetryableCode(code));

	const err: FetchError = Object.freeze({
		message,
		code,
		phase: ctx.phase,
		retryable,
		category: CATEGORY_BY_CODE[code],
		timestamp: new Date().toISOString(),
		url: ctx.url,
		finalUrl: ctx.finalUrl,
		timeoutMs: ctx.timeoutMs,
		statusCode: ctx.statusCode,
		mimeType: ctx.mimeType,
		contentLength: ctx.contentLength,
		downloadedBytes: ctx.downloadedBytes,
		elapsedMs: ctx.elapsedMs,
		attempt: ctx.attempt,
		mode: ctx.mode,
		cause: ctx.cause,
	});
	return err;
}

// ─── classifyError — Node error → FetchError ──────────────────────

interface ClassifyContext
	extends Omit<FetchErrorContext, "phase" | "code" | "message"> {}

/**
 * Inspect an unknown error (Node network error, throw, AbortError, etc.)
 * and return a FetchError with the best-matching code/phase/message.
 * Pass context for fields like url, timeoutMs, etc.
 */
export function classifyError(err: unknown, ctx: ClassifyContext): FetchError {
	const e = err as
		| (Error & {
				code?: string;
				cause?: unknown;
		  })
		| undefined;
	const msg = (e?.message ?? String(err ?? "")).trim() || "Unknown error";
	const nodeCode = e?.code;
	const lower = msg.toLowerCase();

	// ── Body too large (caller caught the byte-budget guard)
	if (
		nodeCode === "ERR_RESPONSE_TOO_LARGE" ||
		lower.includes("exceeds the") ||
		lower.includes("byte limit")
	) {
		return createFetchError("download_error", msg, {
			...ctx,
			phase: "downloading",
			contentLength: (err as any)?.contentLength ?? ctx.contentLength,
			downloadedBytes: (err as any)?.bytesRead ?? ctx.downloadedBytes,
		});
	}

	// ── Timeout / abort
	if (nodeCode === "ABORT_ERR" || lower.includes("aborted")) {
		return createFetchError("aborted", msg, { ...ctx, phase: "waiting" });
	}
	if (
		nodeCode === "ETIMEDOUT" ||
		lower.includes("timeout") ||
		lower.includes("timed out") ||
		lower.includes("etimedout")
	) {
		return createFetchError("timeout", msg, { ...ctx, phase: "waiting" });
	}

	// ── TLS
	if (
		nodeCode === "CERT_HAS_EXPIRED" ||
		nodeCode === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
		nodeCode === "SELF_SIGNED_CERT_IN_CHAIN" ||
		nodeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
		nodeCode === "ERR_TLS_CERT_ALTNAME_INVALID" ||
		lower.includes("certificate") ||
		lower.includes("tls") ||
		lower.includes("ssl")
	) {
		return createFetchError("tls_error", msg, { ...ctx, phase: "tls" });
	}

	// ── DNS
	if (
		nodeCode === "ENOTFOUND" ||
		nodeCode === "EAI_AGAIN" ||
		lower.includes("getaddrinfo") ||
		lower.includes("dns")
	) {
		return createFetchError("dns_error", msg, { ...ctx, phase: "connecting" });
	}

	// ── Connect
	if (
		nodeCode === "ECONNREFUSED" ||
		nodeCode === "ECONNRESET" ||
		nodeCode === "EHOSTUNREACH" ||
		nodeCode === "ENETUNREACH" ||
		lower.includes("econnrefused") ||
		lower.includes("econnreset") ||
		lower.includes("network") ||
		lower.includes("socket hang up")
	) {
		return createFetchError("connect_error", msg, {
			...ctx,
			phase: "connecting",
		});
	}

	// ── Redirect loop
	if (lower.includes("too many redirects") || lower.includes("redirect loop")) {
		return createFetchError("redirect_loop", msg, {
			...ctx,
			phase: "headers",
		});
	}

	// ── SSRF guard block (fetchWithRetry / fetchWithPlaywright throw a
	// plain Error when isDangerousUrl / validateUrlForSsrf denies a URL).
	// Recognise the message so it surfaces as a precise blocked_ssrf code
	// instead of degrading to the generic unknown/downloading fallback.
	if (
		lower.includes("blocked request to private/internal url") ||
		lower.includes("blocked unsafe url")
	) {
		return createFetchError(
			"blocked_ssrf",
			msg,
			{ ...ctx, phase: "validation" },
			{ retryable: false },
		);
	}

	// ── Fallback
	return createFetchError("unknown", msg, { ...ctx, phase: "downloading" });
}

// ─── buildUserFacingFetchErrorSummary ─────────────────────────────

/**
 * Produce a one-line, TUI-friendly error message. Designed to fit on
 * a single 80-col line: starts with a verb ("The server …", "We
 * couldn't …"), no trailing punctuation in the status code section.
 *
 * Examples:
 *   "The server rate-limited this request. (HTTP 429)"
 *   "We couldn't find that page on the server. (HTTP 404)"
 *   "The server didn't reply in time. (15.0s timeout)"
 *   "We couldn't establish a secure connection. (TLS error)"
 *   "The site is blocking automated requests. (Cloudflare)"
 */
export function buildUserFacingFetchErrorSummary(err: FetchError): string {
	const status = formatStatusTail(err);
	const prefix = prefixFor(err);
	const core = prefix;

	// Short, human status tail.
	const tail = status ? ` (${status})` : "";

	// Combine, cap to a sane line length, single space between segments.
	const line = `${core}${tail}`.replace(/\s+/g, " ").trim();

	// H2: never let a secret surface in user-facing error output. The
	// fallback prefix echoes err.message and the status tail can echo
	// err.cause.message — either may carry a credential (e.g. an
	// Authorization header or token in an underlying error). Masking
	// here is a no-op on secret-free messages.
	const redacted = redactSecrets(line);

	// Hard cap: TUI may have narrow widths.
	return redacted.length > 200 ? `${redacted.slice(0, 197)}…` : redacted;
}

function prefixFor(err: FetchError): string {
	const m = err.message;
	const c = err.code;

	// Code-driven prefixes (preferred — they ignore noisy underlying messages).
	switch (c) {
		case "invalid_url":
			return `We couldn't understand the URL you provided.`;
		case "private_ip":
			return `Requests to private/internal addresses are blocked for safety.`;
		case "blocked_secret":
			return `We blocked the request — it appeared to contain a secret or token.`;
		case "blocked_ssrf":
			return `We blocked the request — it targeted a private/internal address.`;
		case "redirect_loop":
			return `The page kept redirecting in a loop and we gave up.`;
		case "dns_error":
			return `We couldn't resolve the hostname.`;
		case "connect_error":
			return `We couldn't connect to the server.`;
		case "tls_error":
			return `We couldn't establish a secure connection.`;
		case "aborted":
			return `The request was aborted.`;
		case "timeout":
			return `The server didn't reply in time.`;
		case "rate_limited":
			return `The server rate-limited this request.`;
		case "http_error":
			return `The server returned an error response.`;
		case "not_found":
			return `We couldn't find that page on the server.`;
		case "auth_required":
			return `The server requires authentication we don't have.`;
		case "download_error":
			return `The download was interrupted.`;
		case "empty_body":
			return `The server returned an empty response.`;
		case "binary_content":
			return `The response is binary content (not text/markdown).`;
		case "checksum_mismatch":
			return `The downloaded content's checksum didn't match.`;
		case "parse_error":
			return `We couldn't parse the response.`;
		case "encoding_error":
			return `We couldn't decode the response's text encoding.`;
		case "out_of_memory":
			return `The response was too large to fit in memory.`;
		case "blocked":
		case "bot_detected":
			return `The site is blocking automated requests.`;
		case "paywall":
			return `The article is behind a paywall.`;
		case "no_content":
			return `The server didn't return any content.`;
		case "unknown":
			return `An unexpected error occurred.`;
	}

	// Fallback: short-circuit the raw message so it still fits.
	if (m.length < 120) return m;
	return `${m.slice(0, 117)}…`;
}

function formatStatusTail(err: FetchError): string {
	const parts: string[] = [];

	if (err.statusCode) {
		parts.push(`HTTP ${err.statusCode}`);
	}

	if (err.code === "timeout" && err.timeoutMs) {
		parts.push(`${(err.timeoutMs / 1000).toFixed(1)}s timeout`);
	} else if (err.code === "timeout" && err.elapsedMs) {
		parts.push(`after ${(err.elapsedMs / 1000).toFixed(1)}s`);
	}

	if (err.contentLength && err.downloadedBytes !== undefined) {
		const pct = Math.floor((err.downloadedBytes / err.contentLength) * 100);
		parts.push(`${pct}% of ${formatBytes(err.contentLength)}`);
	}

	if (err.code === "tls_error" && err.cause instanceof Error) {
		parts.push(err.cause.message.split("\n")[0].slice(0, 60));
	}

	return parts.join(" · ");
}

// ─── suggestRetryTimeoutMs ────────────────────────────────────────

const MIN_SUGGESTED_TIMEOUT_MS = 5_000;
const MAX_SUGGESTED_TIMEOUT_MS = 180_000;
const TIMEOUT_BUFFER_RATIO = 0.2;

/**
 * Given a FetchError that suggests we ran out of time, return a new
 * timeout (in ms) that would likely have succeeded, or undefined if
 * we can't make a useful guess.
 *
 * Heuristics:
 *   1. If we know contentLength and downloadedBytes, extrapolate from
 *      bytes/ms to estimate full download time + 20% buffer.
 *   2. If we have elapsedMs but no size info, double the time spent
 *      (it's a better-than-nothing lower bound).
 *   3. If we have nothing useful, return undefined.
 */
export function suggestRetryTimeoutMs(err: FetchError): number | undefined {
	if (err.code !== "timeout") return undefined;

	const elapsed = err.elapsedMs ?? 0;
	const downloaded = err.downloadedBytes ?? 0;
	const total = err.contentLength ?? 0;

	// Case 1: known size, partial download
	if (downloaded > 0 && total > 0 && elapsed > 0) {
		const bytesPerMs = downloaded / elapsed;
		if (bytesPerMs <= 0) return undefined;
		const remainingBytes = total - downloaded;
		const remainingMs = remainingBytes / bytesPerMs;
		const withBuffer = Math.ceil(
			(elapsed + remainingMs) * (1 + TIMEOUT_BUFFER_RATIO),
		);
		return clampTimeout(withBuffer);
	}

	// Case 2: unknown size, partial download
	if (downloaded > 0 && elapsed > 0) {
		return clampTimeout(Math.ceil(elapsed * 2));
	}

	// Case 3: no progress — connection stall. Double elapsed as a probe.
	if (elapsed > 0) {
		return clampTimeout(Math.max(MIN_SUGGESTED_TIMEOUT_MS, elapsed * 2));
	}

	return undefined;
}

function clampTimeout(ms: number): number {
	return Math.max(
		MIN_SUGGESTED_TIMEOUT_MS,
		Math.min(MAX_SUGGESTED_TIMEOUT_MS, ms),
	);
}

// ─── isFetchError / toFetchErrorInfo ──────────────────────────────

export function isFetchError(value: unknown): value is FetchError {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.message === "string" &&
		typeof v.code === "string" &&
		typeof v.phase === "string" &&
		typeof v.retryable === "boolean" &&
		typeof v.category === "string" &&
		typeof v.url === "string" &&
		typeof v.timestamp === "string"
	);
}

/**
 * Convert a FetchError to the legacy FetchErrorInfo shape used by
 * PullResult.errorInfo. Keeps backwards compat with everything that
 * still consumes FetchErrorInfo (storage, prompt injection, etc.).
 */
export function toFetchErrorInfo(err: FetchError): FetchErrorInfo {
	return {
		message: err.message,
		code: legacyCodeFromFetchErrorCode(err.code),
		phase: legacyPhaseFromFetchPhase(err.phase),
		retryable: err.retryable,
		statusCode: err.statusCode,
	};
}

/**
 * Build a FetchErrorInfo from any error — used at API boundaries
 * where callers still expect the legacy shape.
 */
export function fetchErrorInfoFromUnknown(
	err: unknown,
	ctx: ClassifyContext,
): FetchErrorInfo {
	const fe = classifyError(err, ctx);
	return toFetchErrorInfo(fe);
}

// Legacy code mapping — collapses the 26-code union back to the 10
// legacy codes. Best-effort; any new code maps to its category's
// legacy code.
function legacyCodeFromFetchErrorCode(
	code: FetchErrorCode,
): FetchErrorInfo["code"] {
	switch (code) {
		case "invalid_url":
		case "private_ip":
		case "blocked_secret":
		case "blocked_ssrf":
		case "redirect_loop":
			return "invalid_url";
		case "dns_error":
		case "connect_error":
		case "tls_error":
		case "aborted":
			return "network_error";
		case "timeout":
			return "timeout";
		case "rate_limited":
		case "http_error":
		case "not_found":
		case "auth_required":
		case "empty_body":
		case "no_content":
			return "http_error";
		case "download_error":
		case "checksum_mismatch":
			return "download_error";
		case "binary_content":
			return "no_content";
		case "parse_error":
		case "encoding_error":
		case "out_of_memory":
			return "processing_error";
		case "blocked":
		case "paywall":
		case "bot_detected":
			return "blocked";
		case "unknown":
			return "unknown";
	}
}

function legacyPhaseFromFetchPhase(phase: FetchPhase): FetchErrorInfo["phase"] {
	switch (phase) {
		case "validation":
			return "validation";
		case "connecting":
		case "tls":
		case "waiting":
		case "headers":
			return "connecting";
		case "downloading":
		case "rendering":
		case "writing":
		case "processing":
		case "finished":
			return "loading";
	}
}

// ─── formatBytes (helper) ─────────────────────────────────────────

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── retryableByName (for legacy callers) ─────────────────────────

/** Map legacy FetchErrorInfo to whether a retry is worth trying. */
function isLegacyRetryable(info: FetchErrorInfo): boolean {
	if (info.retryable !== undefined) return info.retryable;
	if (info.statusCode !== undefined) {
		return RETRYABLE_STATUS.has(info.statusCode);
	}
	return false;
}
