import { isIP } from "node:net";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import {
	createTransport as createWreqTransport,
	fetch as wreqFetch,
	getOperatingSystems,
	getProfiles,
} from "wreq-js";
import type { BrowserAlias, BrowserProfile, EmulationOS } from "wreq-js";
import { detectBotBlock } from "./bot-detection.ts";
import { extractClientSideRedirect } from "./client-redirect.ts";
import {
	binarySignature,
	decodeResponseBody,
	htmlToPlainText,
	isHtmlContentType,
	isJsonContentType,
	isLikelyJsonBody,
	isTextualContentType,
	looksBinary,
	normalizeContentType,
	sniffContentType,
} from "./http-text.ts";
import { redactSecrets } from "./redact.ts";
import {
	scanForSecrets,
	validateUrlForSsrf,
	type SsrfValidation,
} from "./security.ts";
import {
	classifyError,
	fetchErrorCategory,
	isRetryableCode,
	type FetchErrorCategory,
	type FetchErrorCode,
	type FetchPhase,
} from "./tools/fetch-error.ts";
import { loadPdfParseCtor, type PdfParseCtor } from "./types.ts";

export const DEFAULT_WEBFETCH_BROWSER = "chrome_145";
export const DEFAULT_WEBFETCH_OS = "windows";
export const DEFAULT_WEBFETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
export const DEFAULT_MAX_REDIRECTS = 10;
export const DEFAULT_MAX_RETRIES = 2;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_FORMATS = new Set<StaticWebFetchFormat>([
	"markdown",
	"html",
	"text",
	"json",
	"raw",
]);
const CROSS_ORIGIN_HEADER_ALLOWLIST = new Set([
	"accept",
	"accept-language",
	"user-agent",
]);
const BROWSER_ALIASES = new Set([
	"chrome",
	"edge",
	"firefox",
	"firefox_android",
	"firefox_private",
	"okhttp",
	"opera",
	"safari",
	"safari_ios",
	"safari_ipad",
]);
const CREDENTIAL_PARAMETER = /^(?:(?:x[-_](?:amz|goog))[-_])?(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|bearer|client[-_]?secret|credential|csrf|id[-_]?token|jwt|oauth[-_]?token|password|passwd|private[-_]?key|refresh[-_]?token|secret(?:[-_]?key)?|security[-_]?token|session(?:[-_]?id)?|signature|sig|token|xsrf)$/i;
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_REQUEST_HEADERS = new Set([
	"connection",
	"content-length",
	"host",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const ALLOWED_OPTION_NAMES = new Set([
	"browser",
	"os",
	"headers",
	"proxy",
	"timeoutMs",
	"maxChars",
	"maxResponseBytes",
	"maxRedirects",
	"maxRetries",
	"format",
	"removeImages",
	"includeReplies",
	"signal",
]);
const CLEANUP_WAIT_MS = 100;

export type StaticWebFetchFormat = "markdown" | "html" | "text" | "json" | "raw";
export type StaticWebFetchReplyPolicy = boolean | "extractors";

export interface StaticWebFetchOptions {
	browser?: BrowserProfile | BrowserAlias;
	os?: EmulationOS;
	headers?: Record<string, string>;
	proxy?: string;
	timeoutMs?: number;
	maxChars?: number;
	maxResponseBytes?: number;
	maxRedirects?: number;
	maxRetries?: number;
	format?: StaticWebFetchFormat;
	removeImages?: boolean;
	includeReplies?: StaticWebFetchReplyPolicy;
	signal?: AbortSignal;
}

/**
 * Failure codes for this entrypoint.
 *
 * This is the project-wide {@link FetchErrorCode} taxonomy, not a
 * parallel one: pi-webaio has a single error model shared by the pi
 * tools, the MCP server, and this static API, so a consumer's `switch`
 * over codes works the same on every surface.
 */
export type StaticWebFetchErrorCode = FetchErrorCode;

/** Timeline stage, from the shared {@link FetchPhase} taxonomy. */
export type StaticWebFetchPhase = FetchPhase;

export interface StaticWebFetchError {
	code: StaticWebFetchErrorCode;
	message: string;
	phase: StaticWebFetchPhase;
	/** Coarse bucket from the shared taxonomy (validation/network/server/client/blocked/processing/unknown). */
	category: FetchErrorCategory;
	retryable: boolean;
	statusCode?: number;
}

export interface StaticWebFetchSuccess {
	ok: true;
	kind: "content";
	url: string;
	finalUrl: string;
	redirects: string[];
	statusCode: number;
	statusText: string;
	contentType?: string;
	format: StaticWebFetchFormat;
	content: string;
	truncated: boolean;
	title: string;
	author: string;
	published: string;
	site: string;
	language: string;
	description: string;
	/** Word count for the full extracted content before maxChars truncation. */
	wordCount: number;
	fullContentChars: number;
	outputChars: number;
	browser: BrowserProfile | BrowserAlias;
	os: EmulationOS;
	downloadedBytes: number;
	contentLength: number | null;
	elapsedMs: number;
	browserEscalated: false;
	remoteFallbackUsed: false;
	persisted: false;
	proxyUsed: boolean;
	targetPinning: "local" | "proxy-dependent";
}

export interface StaticWebFetchFailure {
	ok: false;
	url: string;
	finalUrl?: string;
	redirects: string[];
	elapsedMs: number;
	error: StaticWebFetchError;
}

export type StaticWebFetchResult = StaticWebFetchSuccess | StaticWebFetchFailure;

interface HeaderReader {
	get(name: string): string | null;
}

interface BodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): unknown;
}

interface ResponseBody {
	getReader(): BodyReader;
	cancel?(): unknown;
}

interface StaticResponse {
	url?: string;
	status: number;
	statusText?: string;
	ok?: boolean;
	headers: HeaderReader;
	body?: ResponseBody | null;
	arrayBuffer?(): Promise<ArrayBuffer>;
}

interface StaticTransport {
	close(): Promise<void>;
}

export interface StaticWebFetchDependencies {
	validateUrl(url: string): Promise<SsrfValidation>;
	createTransport(options: {
		browser: BrowserProfile | BrowserAlias;
		os: EmulationOS;
		proxy?: string;
		resolve?: Record<string, string[]>;
	}): Promise<StaticTransport>;
	request(
		url: string,
		init: {
			redirect: "manual";
			headers: Record<string, string>;
			signal: AbortSignal;
			timeout: number;
			transport: StaticTransport;
		},
	): Promise<StaticResponse>;
	sleep(ms: number): Promise<void>;
	loadPdfParser(): Promise<PdfParseCtor>;
}

interface ByteBudget {
	remaining: number;
	total: number;
}

interface DownloadedResponse {
	url: string;
	status: number;
	statusText: string;
	headers: HeaderReader;
	body: Uint8Array;
	downloadedBytes: number;
	contentLength: number | null;
	redirects: string[];
}

interface ExtractedContent {
	content: string;
	title?: string;
	author?: string;
	published?: string;
	site?: string;
	language?: string;
	description?: string;
	wordCount?: number;
}

class RetryAttempt extends Error {
	readonly delayMs: number;

	constructor(delayMs: number) {
		super("retry request");
		this.delayMs = delayMs;
	}
}

class StaticFetchException extends Error {
	readonly code: StaticWebFetchErrorCode;
	readonly phase: StaticWebFetchError["phase"];
	readonly category: FetchErrorCategory;
	readonly retryable: boolean;
	readonly statusCode?: number;
	readonly finalUrl?: string;
	readonly redirects: string[];

	constructor(
		code: StaticWebFetchErrorCode,
		message: string,
		options: {
			phase: StaticWebFetchError["phase"];
			retryable?: boolean;
			statusCode?: number;
			finalUrl?: string;
			redirects?: string[];
		},
	) {
		super(redactErrorText(message));
		this.name = "StaticFetchException";
		this.code = code;
		this.phase = options.phase;
		this.category = fetchErrorCategory(code);
		// Default from the shared retry matrix so every pi-webaio surface agrees
		// on which codes are worth retrying; callers may still override.
		this.retryable = options.retryable ?? isRetryableCode(code);
		this.statusCode = options.statusCode;
		this.finalUrl = options.finalUrl;
		this.redirects = options.redirects ?? [];
	}
}

const defaultDependencies: StaticWebFetchDependencies = {
	validateUrl: validateUrlForSsrf,
	createTransport: async (options) => {
		return createWreqTransport({
			browser: options.browser,
			os: options.os,
			proxy: options.proxy,
			resolve: options.resolve,
		});
	},
	// SAFETY: the public dependency seam uses the subset of wreq RequestInit
	// needed by this entrypoint; the default transport is a real wreq Transport.
	request: async (url, init) => wreqFetch(url, init as any),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	loadPdfParser: loadPdfParseCtor,
};

function numericOption(
	value: number | undefined,
	fallback: number,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new StaticFetchException(
			"invalid_option",
			`${name} must be an integer between ${minimum} and ${maximum}`,
			{ phase: "validation" },
		);
	}
	return value;
}

function validateRuntimeOptions(
	options: StaticWebFetchOptions | null | undefined,
): asserts options is StaticWebFetchOptions {
	if (
		options === null ||
		options === undefined ||
		typeof options !== "object" ||
		Array.isArray(options) ||
		(Object.getPrototypeOf(options) !== Object.prototype &&
			Object.getPrototypeOf(options) !== null)
	) {
		throw new StaticFetchException("invalid_option", "options must be a plain object", {
			phase: "validation",
		});
	}
	const unknown = Object.keys(options).filter((name) => !ALLOWED_OPTION_NAMES.has(name));
	if (unknown.length > 0) {
		throw new StaticFetchException(
			"invalid_option",
			`Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
			{ phase: "validation" },
		);
	}
	if (options.format !== undefined && !SUPPORTED_FORMATS.has(options.format)) {
		throw new StaticFetchException(
			"invalid_option",
			"format must be markdown, html, text, json, or raw",
			{ phase: "validation" },
		);
	}
	if (
		options.headers !== undefined &&
		(typeof options.headers !== "object" ||
			options.headers === null ||
			Array.isArray(options.headers) ||
			(Object.getPrototypeOf(options.headers) !== Object.prototype &&
				Object.getPrototypeOf(options.headers) !== null) ||
			Object.values(options.headers).some(
				(value) => typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value),
			) ||
			Object.keys(options.headers).some(
				(name) =>
					!HTTP_HEADER_NAME.test(name) ||
					FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase()),
			))
	) {
		throw new StaticFetchException(
			"invalid_option",
			"headers contain an invalid or transport-controlled name or value",
			{ phase: "validation" },
		);
	}
	for (const [name, value] of [
		["browser", options.browser],
		["os", options.os],
		["proxy", options.proxy],
	] as const) {
		if (value !== undefined && typeof value !== "string") {
			throw new StaticFetchException("invalid_option", `${name} must be a string`, {
				phase: "validation",
			});
		}
	}
	if (options.browser !== undefined) {
		let supported = BROWSER_ALIASES.has(options.browser);
		try {
			supported ||= getProfiles().includes(options.browser as BrowserProfile);
		} catch {
			// Fail closed when a concrete profile cannot be enumerated.
		}
		if (!supported) {
			throw new StaticFetchException("invalid_option", "browser is not a supported wreq profile", {
				phase: "validation",
			});
		}
	}
	if (options.os !== undefined) {
		let supported = ["windows", "macos", "linux", "android", "ios"].includes(options.os);
		try {
			supported = getOperatingSystems().includes(options.os);
		} catch {
			// Keep the stable public OS list when the native binding cannot enumerate.
		}
		if (!supported) {
			throw new StaticFetchException("invalid_option", "os is not supported by wreq", {
				phase: "validation",
			});
		}
	}
	if (options.removeImages !== undefined && typeof options.removeImages !== "boolean") {
		throw new StaticFetchException("invalid_option", "removeImages must be a boolean", {
			phase: "validation",
		});
	}
	if (
		options.includeReplies !== undefined &&
		typeof options.includeReplies !== "boolean" &&
		options.includeReplies !== "extractors"
	) {
		throw new StaticFetchException(
			"invalid_option",
			'includeReplies must be a boolean or "extractors"',
			{ phase: "validation" },
		);
	}
	if (
		options.signal !== undefined &&
		(typeof options.signal !== "object" ||
			typeof options.signal.aborted !== "boolean" ||
			typeof options.signal.addEventListener !== "function" ||
			typeof options.signal.removeEventListener !== "function")
	) {
		throw new StaticFetchException("invalid_option", "signal must be an AbortSignal", {
			phase: "validation",
		});
	}
}

function parseHttpUrl(value: string, label = "URL"): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new StaticFetchException("invalid_url", `Invalid ${label}: ${redactUrl(value)}`, {
			phase: "validation",
		});
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new StaticFetchException(
			"unsupported_protocol",
			`${label} must use http or https, got ${parsed.protocol}`,
			{ phase: "validation" },
		);
	}
	return parsed;
}

function abortException(signal: AbortSignal): StaticFetchException {
	const reason = signal.reason;
	const timedOut =
		reason instanceof Error &&
		((reason as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
			reason.name === "TimeoutError");
	return new StaticFetchException(
		timedOut ? "timeout" : "aborted",
		timedOut ? "The request timed out" : "The request was aborted",
		{ phase: "waiting", retryable: timedOut },
	);
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortException(signal);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortException(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortException(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
	signal: AbortSignal;
	dispose(): void;
} {
	const controller = new AbortController();
	const onParentAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onParentAbort();
	else parent?.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => {
		const error = new Error(`Request timed out after ${timeoutMs}ms`) as NodeJS.ErrnoException;
		error.code = "ETIMEDOUT";
		controller.abort(error);
	}, timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

async function boundedCleanup(
	action: () => Promise<unknown>,
	signal: AbortSignal,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const cleanup = Promise.resolve()
		.then(action)
		.catch(() => {});
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, CLEANUP_WAIT_MS);
	});
	const aborted = new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else {
			onAbort = resolve;
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	await Promise.race([cleanup, deadline, aborted]);
	if (timer) clearTimeout(timer);
	if (onAbort) signal.removeEventListener("abort", onAbort);
}

function safeCancel(target: { cancel?: () => unknown } | null | undefined): void {
	if (!target?.cancel) return;
	try {
		const result = target.cancel();
		if (result && typeof (result as Promise<unknown>).catch === "function") {
			(result as Promise<unknown>).catch(() => {});
		}
	} catch {
		// Cancellation is best-effort; the transport is also closed in finally.
	}
}

async function readBody(
	response: StaticResponse,
	budget: ByteBudget,
	signal: AbortSignal,
): Promise<{ body: Uint8Array; downloadedBytes: number; contentLength: number | null }> {
	const header = response.headers.get("content-length");
	const parsedLength = header === null ? Number.NaN : Number.parseInt(header, 10);
	const contentLength = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null;
	if (contentLength !== null && contentLength > budget.remaining) {
		safeCancel(response.body);
		throw new StaticFetchException(
			"response_too_large",
			`Response Content-Length ${contentLength} exceeds the remaining ${budget.remaining} byte input budget`,
			{ phase: "downloading" },
		);
	}

	if (!response.body) {
		if (!response.arrayBuffer) return { body: new Uint8Array(), downloadedBytes: 0, contentLength };
		const buffer = await raceWithAbort(response.arrayBuffer(), signal);
		budget.remaining -= buffer.byteLength;
		budget.total += buffer.byteLength;
		if (budget.remaining < 0) {
			throw new StaticFetchException(
				"response_too_large",
				"Response exceeded the aggregate input budget",
				{ phase: "downloading" },
			);
		}
		return {
			body: new Uint8Array(buffer),
			downloadedBytes: buffer.byteLength,
			contentLength,
		};
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let downloadedBytes = 0;
	try {
		while (true) {
			const { done, value } = await raceWithAbort(reader.read(), signal);
			if (done) break;
			if (!value) continue;
			downloadedBytes += value.byteLength;
			budget.remaining -= value.byteLength;
			budget.total += value.byteLength;
			if (budget.remaining < 0) {
				throw new StaticFetchException(
					"response_too_large",
					"Response exceeded the aggregate input budget",
					{ phase: "downloading" },
				);
			}
			chunks.push(value);
		}
	} catch (error) {
		safeCancel(reader);
		throw error;
	}

	const body = new Uint8Array(downloadedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body, downloadedBytes, contentLength };
}

function isRetryableNetworkError(error: unknown): boolean {
	if (error instanceof StaticFetchException) return error.retryable;
	const value = error as NodeJS.ErrnoException | undefined;
	const message = (value?.message ?? String(error)).toLowerCase();
	return (
		value?.code === "ECONNRESET" ||
		value?.code === "ETIMEDOUT" ||
		value?.code === "EAI_AGAIN" ||
		message.includes("connection reset") ||
		message.includes("error sending request") ||
		message.includes("fetch failed") ||
		message.includes("timed out")
	);
}

/**
 * Turn a throw from the transport into the shared error taxonomy.
 *
 * `classifyError` is the same classifier the pi tools and the MCP server use,
 * but its catch-all is `unknown` at phase `downloading` — and at this point we
 * know the failure happened in the transport, so an unrecognised throw is
 * reported as the canonical `connect_error` rather than losing the phase.
 */
function classifyTransportError(
	error: unknown,
	url: string,
	redirects: string[],
): StaticFetchException {
	if (error instanceof StaticFetchException) return error;
	const classified = classifyError(error, { url, finalUrl: url });
	if (classified.code === "unknown") {
		return new StaticFetchException("connect_error", classified.message, {
			phase: "connecting",
			finalUrl: url,
			redirects,
		});
	}
	return new StaticFetchException(classified.code, classified.message, {
		phase: classified.phase,
		retryable: classified.retryable,
		statusCode: classified.statusCode,
		finalUrl: url,
		redirects,
	});
}

function retryDelay(attempt: number): number {
	return Math.min(4000, 500 * 2 ** attempt);
}

function requireHostnamePins(
	parsed: URL,
	verdict: SsrfValidation,
	label: "request" | "proxy",
): void {
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) return;
	if (
		verdict.pinnedIps.length === 0 ||
		verdict.pinnedIps.some((address) => isIP(address) === 0)
	) {
		throw new StaticFetchException(
			"dns_error",
			`${label === "proxy" ? "Proxy" : "Request"} hostname did not produce validated DNS pins`,
			{ phase: "validation" },
		);
	}
}

function resolveMap(parsed: URL, pins: string[]): Record<string, string[]> | undefined {
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) || pins.length === 0) return undefined;
	return { [host]: [...pins] };
}

function headersForCrossOriginRedirect(
	headers: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) =>
			CROSS_ORIGIN_HEADER_ALLOWLIST.has(name.toLowerCase()),
		),
	);
}

function redirectTarget(response: StaticResponse, currentUrl: string): string | null {
	if (!REDIRECT_STATUS.has(response.status)) return null;
	const location = response.headers.get("location");
	if (!location) return null;
	try {
		return new URL(location, currentUrl).href;
	} catch {
		throw new StaticFetchException("invalid_url", "Server returned an invalid redirect URL", {
			phase: "headers",
			finalUrl: currentUrl,
		});
	}
}

function fallbackHtmlContent(
	html: string,
	format: StaticWebFetchFormat,
	removeImages: boolean,
): ExtractedContent {
	const { document } = parseHTML(html);
	document.querySelectorAll("script,style,noscript,template,nav,footer,header").forEach((node) => node.remove());
	if (removeImages) document.querySelectorAll("img,picture,figure").forEach((node) => node.remove());
	const main = document.querySelector("main,article") ?? document.body;
	const title =
		document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ??
		document.querySelector("title")?.textContent?.trim() ??
		document.querySelector("h1")?.textContent?.trim() ??
		"";
	const raw = main?.outerHTML ?? "";
	const plain = htmlToPlainText(raw);
	return {
		content: format === "html" ? raw : plain,
		title,
		wordCount: plain ? plain.split(/\s+/).length : 0,
	};
}

const denyExtractionNetwork: typeof globalThis.fetch = async () => {
	throw new Error("Network access is disabled in the static extraction entrypoint");
};

async function extractHtml(
	html: string,
	url: string,
	format: StaticWebFetchFormat,
	options: StaticWebFetchOptions,
	signal: AbortSignal,
): Promise<ExtractedContent> {
	throwIfAborted(signal);
	const markdown = format === "markdown";
	try {
		const { document } = parseHTML(html);
		const result = await raceWithAbort(
			Defuddle(document as unknown as Document, url, {
				markdown,
				removeImages: options.removeImages ?? false,
				includeReplies: options.includeReplies ?? "extractors",
				useAsync: false,
				fetch: denyExtractionNetwork,
			}),
			signal,
		);
		let content = result.content ?? "";
		if (format === "text" && content) content = htmlToPlainText(content);
		if (content.trim()) {
			return {
				content,
				title: result.title,
				author: result.author,
				published: result.published,
				site: result.site || result.domain,
				language: result.language,
				description: result.description,
				wordCount: result.wordCount,
			};
		}
	} catch (error) {
		if (signal.aborted) throw abortException(signal);
		// The DOM fallback below keeps extraction usable when Defuddle rejects.
	}
	try {
		return fallbackHtmlContent(html, format, options.removeImages ?? false);
	} catch (error) {
		if (signal.aborted) throw abortException(signal);
		throw new StaticFetchException(
			"parse_error",
			`Could not extract HTML content: ${(error as Error)?.message ?? String(error)}`,
			{ phase: "processing", finalUrl: url },
		);
	}
}

async function extractPdf(
	body: Uint8Array,
	url: string,
	format: StaticWebFetchFormat,
	signal: AbortSignal,
	loadParser: () => Promise<PdfParseCtor>,
): Promise<ExtractedContent> {
	if (format === "raw" || format === "json" || format === "html") {
		throw new StaticFetchException(
			"binary_content",
			`PDF responses support markdown or text output, not ${format}`,
			{ phase: "processing", finalUrl: url },
		);
	}
	let parser: InstanceType<PdfParseCtor>;
	try {
		const PdfParse = await raceWithAbort(loadParser(), signal);
		parser = new PdfParse({ data: body });
	} catch (error) {
		if (signal.aborted) throw abortException(signal);
		throw new StaticFetchException(
			"parse_error",
			`Could not load the PDF parser: ${(error as Error)?.message ?? String(error)}`,
			{ phase: "processing", finalUrl: url },
		);
	}
	try {
		await raceWithAbort(parser.load(), signal);
		const parsed = await raceWithAbort(parser.getText(), signal);
		if (!parsed.text?.trim()) {
			throw new StaticFetchException("no_content", "No text was extracted from the PDF", {
				phase: "processing",
				finalUrl: url,
			});
		}
		let title = "Document";
		try {
			title = new URL(url).pathname.split("/").filter(Boolean).pop() || title;
		} catch {
			// URL validation already ran; keep the fallback title.
		}
		return {
			content:
				format === "markdown"
					? `## PDF Content (${parsed.total} pages)\n\n${parsed.text}`
					: parsed.text,
			title,
			wordCount: parsed.text.trim().split(/\s+/).length,
		};
	} catch (error) {
		if (error instanceof StaticFetchException) throw error;
		if (signal.aborted) throw abortException(signal);
		// A corrupt or mislabelled PDF is a content failure, not a transport one:
		// report it as non-retryable parse_error instead of letting the catch-all
		// in failureResult() degrade it to a retryable network error.
		throw new StaticFetchException(
			"parse_error",
			`Could not parse the PDF: ${(error as Error)?.message ?? String(error)}`,
			{ phase: "processing", finalUrl: url },
		);
	} finally {
		await boundedCleanup(() => parser.destroy(), signal);
	}
}

async function download(
	url: string,
	options: StaticWebFetchOptions,
	dependencies: StaticWebFetchDependencies,
	signal: AbortSignal,
	limits: {
		timeoutMs: number;
		maxResponseBytes: number;
		maxRedirects: number;
		maxRetries: number;
	},
): Promise<DownloadedResponse> {
	let current = parseHttpUrl(url).href;
	let headers: Record<string, string> = {
		Accept:
			options.format === "raw"
				? "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,text/markdown;q=0.8,text/plain;q=0.8,*/*;q=0.7"
				: "text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.8,*/*;q=0.7",
		"Accept-Language": "en-US,en;q=0.9",
		...options.headers,
	};
	const redirects: string[] = [];
	const seen = new Set([current]);
	const byteBudget: ByteBudget = {
		remaining: limits.maxResponseBytes,
		total: 0,
	};
	let proxy: URL | undefined;
	let proxyPins: string[] = [];
	if (options.proxy) {
		try {
			proxy = new URL(options.proxy);
		} catch {
			throw new StaticFetchException("invalid_url", "Invalid proxy URL", {
				phase: "validation",
			});
		}
		if (!["http:", "https:", "socks5:", "socks5h:"].includes(proxy.protocol)) {
			throw new StaticFetchException(
				"unsupported_protocol",
				`Proxy must use http, https, socks5, or socks5h, got ${proxy.protocol}`,
				{ phase: "validation" },
			);
		}
		const proxyVerdict = await raceWithAbort(dependencies.validateUrl(proxy.href), signal);
		if (proxyVerdict.dangerous) {
			throw new StaticFetchException(
				proxyVerdict.reason === "dns-error" || proxyVerdict.reason === "dns-empty"
					? "dns_error"
					: "blocked_ssrf",
				`Proxy destination was blocked (${proxyVerdict.reason ?? "unsafe destination"})`,
				{ phase: "validation" },
			);
		}
		requireHostnamePins(proxy, proxyVerdict, "proxy");
		proxyPins = proxyVerdict.pinnedIps;
	}

	while (true) {
		throwIfAborted(signal);
		const secret = scanForSecrets(current);
		if (secret.found) {
			throw new StaticFetchException(
				"blocked_secret",
				`Request URL contains potential secret material (${secret.matches.join(", ")})`,
				{ phase: "validation", finalUrl: current, redirects },
			);
		}
		const parsed = parseHttpUrl(current);
		const verdict = await raceWithAbort(dependencies.validateUrl(current), signal);
		if (verdict.dangerous) {
			throw new StaticFetchException(
				verdict.reason === "dns-error" || verdict.reason === "dns-empty"
					? "dns_error"
					: "blocked_ssrf",
				`Request destination was blocked (${verdict.reason ?? "unsafe destination"})`,
				{ phase: "validation", finalUrl: current, redirects },
			);
		}
		requireHostnamePins(parsed, verdict, "request");

		let nextUrl: string | null = null;
		for (let attempt = 0; attempt <= limits.maxRetries; attempt++) {
			throwIfAborted(signal);
			const resolve = {
				...resolveMap(parsed, verdict.pinnedIps),
				...(proxy ? resolveMap(proxy, proxyPins) : undefined),
			};
			const transportPromise = dependencies.createTransport({
				browser: options.browser ?? DEFAULT_WEBFETCH_BROWSER,
				os: options.os ?? DEFAULT_WEBFETCH_OS,
				proxy: options.proxy,
				...(Object.keys(resolve).length > 0 ? { resolve } : {}),
			});
			// If cancellation wins before creation finishes, close the late transport
			// instead of dropping a native connection pool with no owner.
			transportPromise.then(
				(transport) => {
					if (signal.aborted) transport.close().catch(() => {});
				},
				() => {},
			);
			const transport = await raceWithAbort(transportPromise, signal);
			let retryMs: number | undefined;
			try {
				const requestPromise = dependencies.request(current, {
					redirect: "manual",
					headers,
					signal,
					timeout: limits.timeoutMs,
					transport,
				});
				// A custom or defective transport may ignore AbortSignal. Dispose of a
				// response that arrives after the caller has already stopped waiting.
				requestPromise.then(
					(response) => {
						if (signal.aborted) safeCancel(response.body);
					},
					() => {},
				);
				const response = await raceWithAbort(requestPromise, signal);

				if (RETRYABLE_STATUS.has(response.status) && attempt < limits.maxRetries) {
					safeCancel(response.body);
					throw new RetryAttempt(retryDelay(attempt));
				}

				const target = redirectTarget(response, current);
				if (target) {
					safeCancel(response.body);
					if (redirects.length >= limits.maxRedirects) {
						throw new StaticFetchException(
							"too_many_redirects",
							`Redirect limit (${limits.maxRedirects}) exceeded`,
							{ phase: "headers", finalUrl: current, redirects },
						);
					}
					const normalizedTarget = parseHttpUrl(target, "redirect URL").href;
					if (seen.has(normalizedTarget)) {
						throw new StaticFetchException("redirect_loop", "Redirect loop detected", {
							phase: "headers",
							finalUrl: normalizedTarget,
							redirects,
						});
					}
					if (new URL(current).origin !== new URL(normalizedTarget).origin) {
						headers = headersForCrossOriginRedirect(headers);
					}
					redirects.push(normalizedTarget);
					seen.add(normalizedTarget);
					nextUrl = normalizedTarget;
					break;
				}

				const body = await readBody(response, byteBudget, signal);
				const responseUrl = response.url ?? current;
				const responseText = decodeResponseBody(
					body.body,
					response.headers.get("content-type"),
				);
				const responseType = sniffContentType(
					response.headers.get("content-type"),
					responseText,
				);
				const clientTarget =
					response.status >= 200 &&
					response.status < 300 &&
					isHtmlContentType(responseType)
						? extractClientSideRedirect(responseText, responseUrl)
						: null;
				if (clientTarget) {
					if (redirects.length >= limits.maxRedirects) {
						throw new StaticFetchException(
							"too_many_redirects",
							`Redirect limit (${limits.maxRedirects}) exceeded`,
							{ phase: "headers", finalUrl: responseUrl, redirects },
						);
					}
					const normalizedTarget = parseHttpUrl(clientTarget, "redirect URL").href;
					if (seen.has(normalizedTarget)) {
						throw new StaticFetchException("redirect_loop", "Redirect loop detected", {
							phase: "headers",
							finalUrl: normalizedTarget,
							redirects,
						});
					}
					if (new URL(current).origin !== new URL(normalizedTarget).origin) {
						headers = headersForCrossOriginRedirect(headers);
					}
					redirects.push(normalizedTarget);
					seen.add(normalizedTarget);
					nextUrl = normalizedTarget;
					break;
				}
				return {
					url: responseUrl,
					status: response.status,
					statusText: response.statusText ?? "",
					headers: response.headers,
					body: body.body,
					downloadedBytes: byteBudget.total,
					contentLength: body.contentLength,
					redirects,
				};
			} catch (error) {
				if (signal.aborted) throw abortException(signal);
				if (error instanceof RetryAttempt) retryMs = error.delayMs;
				else if (attempt < limits.maxRetries && isRetryableNetworkError(error)) {
					retryMs = retryDelay(attempt);
				} else throw classifyTransportError(error, current, redirects);
			} finally {
				await boundedCleanup(() => transport.close(), signal);
			}
			if (retryMs !== undefined) {
				await raceWithAbort(dependencies.sleep(retryMs), signal);
				continue;
			}
		}
		if (!nextUrl) {
			throw new StaticFetchException("connect_error", "Request failed after retries", {
				phase: "connecting",
				finalUrl: current,
				redirects,
				retryable: true,
			});
		}
		current = nextUrl;
	}
}

function redactCredentialPairs(value: string): string {
	return value.replace(
		/(^|[?&#;])([^?&#;=]+)=([^&#;\s]*)/g,
		(match, separator: string, rawName: string) => {
			let name = rawName;
			try {
				name = decodeURIComponent(rawName);
			} catch {
				// Keep the encoded name for the credential-key check.
			}
			return CREDENTIAL_PARAMETER.test(name)
				? `${separator}${rawName}=[REDACTED]`
				: match;
		},
	);
}

function redactUrl(value: unknown): string {
	const text = typeof value === "string" ? value : String(value);
	try {
		const parsed = new URL(text);
		if (parsed.username) parsed.username = "[REDACTED]";
		if (parsed.password) parsed.password = "[REDACTED]";
		for (const name of [...parsed.searchParams.keys()]) {
			let decoded = name;
			try {
				decoded = decodeURIComponent(name);
			} catch {
				// URLSearchParams already decoded ordinary names.
			}
			if (CREDENTIAL_PARAMETER.test(decoded)) {
				parsed.searchParams.set(name, "[REDACTED]");
			}
		}
		if (parsed.hash) parsed.hash = redactCredentialPairs(parsed.hash.slice(1));
		return redactSecrets(redactCredentialPairs(parsed.href));
	} catch {
		return redactSecrets(redactCredentialPairs(text));
	}
}

function redactErrorText(value: unknown): string {
	const text = typeof value === "string" ? value : String(value);
	const urlsRedacted = text.replace(
		/https?:\/\/[^\s<>"']+/gi,
		(candidate) => redactUrl(candidate),
	);
	return redactSecrets(redactCredentialPairs(urlsRedacted));
}

function failureResult(
	url: string,
	startedAt: number,
	error: unknown,
): StaticWebFetchFailure {
	if (error instanceof StaticFetchException) {
		return {
			ok: false,
			url: redactUrl(url),
			finalUrl: error.finalUrl ? redactUrl(error.finalUrl) : undefined,
			redirects: error.redirects.map((redirect) => redactUrl(redirect)),
			elapsedMs: Date.now() - startedAt,
			error: {
				code: error.code,
				message: error.message,
				phase: error.phase,
				category: error.category,
				retryable: error.retryable,
				statusCode: error.statusCode,
			},
		};
	}
	// Unexpected throws go through the shared classifier rather than a bespoke
	// timeout guess, so this surface reports the same code/phase/category as the
	// pi tools and the MCP server instead of inventing a retryable network error.
	const classified = classifyError(error, { url: redactUrl(url) });
	return {
		ok: false,
		url: redactUrl(url),
		redirects: [],
		elapsedMs: Date.now() - startedAt,
		error: {
			code: classified.code,
			message: redactErrorText(classified.message),
			phase: classified.phase,
			category: classified.category,
			retryable: classified.retryable,
			statusCode: classified.statusCode,
		},
	};
}

export function createStaticWebFetcher(
	overrides: Partial<StaticWebFetchDependencies> = {},
): (url: string, options?: StaticWebFetchOptions) => Promise<StaticWebFetchResult> {
	const dependencies: StaticWebFetchDependencies = {
		...defaultDependencies,
		...overrides,
	};
	return async (url, options = {}) => {
		const startedAt = Date.now();
		let timeout: ReturnType<typeof requestSignal> | undefined;
		try {
			if (typeof url !== "string") {
				throw new StaticFetchException("invalid_url", "URL must be a string", {
					phase: "validation",
				});
			}
			validateRuntimeOptions(options);
			parseHttpUrl(url);
			const timeoutMs = numericOption(
				options.timeoutMs,
				DEFAULT_WEBFETCH_TIMEOUT_MS,
				"timeoutMs",
				1,
				120_000,
			);
			const maxChars = numericOption(
				options.maxChars,
				DEFAULT_MAX_OUTPUT_CHARS,
				"maxChars",
				1,
				DEFAULT_MAX_RESPONSE_BYTES,
			);
			const maxResponseBytes = numericOption(
				options.maxResponseBytes,
				DEFAULT_MAX_RESPONSE_BYTES,
				"maxResponseBytes",
				1,
				DEFAULT_MAX_RESPONSE_BYTES,
			);
			const maxRedirects = numericOption(
				options.maxRedirects,
				DEFAULT_MAX_REDIRECTS,
				"maxRedirects",
				0,
				20,
			);
			const maxRetries = numericOption(
				options.maxRetries,
				DEFAULT_MAX_RETRIES,
				"maxRetries",
				0,
				5,
			);
			timeout = requestSignal(options.signal, timeoutMs);
			throwIfAborted(timeout.signal);
			const downloaded = await download(
				url,
				options,
				dependencies,
				timeout.signal,
				{ timeoutMs, maxResponseBytes, maxRedirects, maxRetries },
			);
			const format = options.format ?? "markdown";
			return await createResult(
				url,
				downloaded,
				options,
				dependencies,
				format,
				maxChars,
				timeout.signal,
				startedAt,
			);
		} catch (error) {
			return failureResult(url, startedAt, error);
		} finally {
			timeout?.dispose();
		}
	};
}

async function createResult(
	originalUrl: string,
	downloaded: DownloadedResponse,
	options: StaticWebFetchOptions,
	dependencies: StaticWebFetchDependencies,
	format: StaticWebFetchFormat,
	maxChars: number,
	signal: AbortSignal,
	startedAt: number,
): Promise<StaticWebFetchSuccess> {
	const declaredType = normalizeContentType(downloaded.headers.get("content-type"));
	const signature = binarySignature(downloaded.body);
	if (
		signature === "binary" ||
		(signature !== "pdf" &&
			declaredType !== "application/pdf" &&
			looksBinary(downloaded.headers.get("content-type"), downloaded.body))
	) {
		throw new StaticFetchException("binary_content", "The response body is binary", {
			phase: "processing",
			finalUrl: downloaded.url,
			redirects: downloaded.redirects,
		});
	}
	const text =
		signature === "pdf"
			? ""
			: decodeResponseBody(downloaded.body, downloaded.headers.get("content-type"));
	const contentType =
		signature === "pdf"
			? "application/pdf"
			: sniffContentType(downloaded.headers.get("content-type"), text);
	if (downloaded.status < 200 || downloaded.status >= 300) {
		throw new StaticFetchException(
			"http_error",
			`Server returned HTTP ${downloaded.status}${downloaded.statusText ? ` ${downloaded.statusText}` : ""}`,
			{
				phase: "headers",
				statusCode: downloaded.status,
				finalUrl: downloaded.url,
				redirects: downloaded.redirects,
				retryable: RETRYABLE_STATUS.has(downloaded.status),
			},
		);
	}
	let extracted: ExtractedContent;
	if (contentType === "application/pdf") {
		extracted = await extractPdf(
			downloaded.body,
			downloaded.url,
			format,
			signal,
			dependencies.loadPdfParser,
		);
	} else if (!isTextualContentType(contentType)) {
		throw new StaticFetchException(
			"binary_content",
			`Unsupported binary response (${contentType || "unknown content type"})`,
			{ phase: "processing", finalUrl: downloaded.url, redirects: downloaded.redirects },
		);
	} else if (format === "raw") {
		extracted = { content: text };
	} else if (format === "html" && !isHtmlContentType(contentType)) {
		throw new StaticFetchException(
			"unexpected_content_type",
			`HTML output requires an HTML response, got ${contentType}`,
			{ phase: "processing", finalUrl: downloaded.url, redirects: downloaded.redirects },
		);
	} else if (isJsonContentType(contentType) || isLikelyJsonBody(text)) {
		let formatted: string;
		try {
			formatted = JSON.stringify(JSON.parse(text), null, 2);
		} catch {
			if (format === "json") {
				throw new StaticFetchException("parse_error", "The response was not valid JSON", {
					phase: "processing",
					finalUrl: downloaded.url,
					redirects: downloaded.redirects,
				});
			}
			formatted = text;
		}
		extracted = {
			content: format === "markdown" ? `\`\`\`json\n${formatted}\n\`\`\`` : formatted,
		};
	} else if (format === "json") {
		throw new StaticFetchException("parse_error", "The response was not JSON", {
			phase: "processing",
			finalUrl: downloaded.url,
			redirects: downloaded.redirects,
		});
	} else if (isHtmlContentType(contentType)) {
		const bot = detectBotBlock(text);
		if (bot.blocked) {
			throw new StaticFetchException("bot_detected", bot.message, {
				phase: "processing",
				finalUrl: downloaded.url,
				redirects: downloaded.redirects,
				retryable: bot.retryable,
			});
		}
		extracted = await extractHtml(text, downloaded.url, format, options, signal);
	} else if (contentType.includes("xml")) {
		extracted = {
			content:
				format === "text"
					? htmlToPlainText(text)
					: format === "markdown"
						? `\`\`\`xml\n${text}\n\`\`\``
						: text,
		};
	} else {
		extracted = { content: text };
	}

	throwIfAborted(signal);
	if (!extracted.content.trim()) {
		throw new StaticFetchException(
			"no_content",
			"No readable content was extracted; use a browser renderer for JavaScript-only pages",
			{ phase: "processing", finalUrl: downloaded.url, redirects: downloaded.redirects },
		);
	}
	const fullContent = extracted.content;
	const truncated = fullContent.length > maxChars;
	const content = truncated ? fullContent.slice(0, maxChars) : fullContent;
	let site = extracted.site ?? "";
	if (!site) {
		try {
			site = new URL(downloaded.url).hostname;
		} catch {
			// URL validation already ran; keep the empty fallback.
		}
	}
	const title = extracted.title ?? "";
	const wordCount =
		extracted.wordCount ??
		(fullContent.trim() ? fullContent.trim().split(/\s+/).filter(Boolean).length : 0);
	return {
		ok: true,
		kind: "content",
		url: redactUrl(originalUrl),
		finalUrl: redactUrl(downloaded.url),
		redirects: downloaded.redirects.map((redirect) => redactUrl(redirect)),
		statusCode: downloaded.status,
		statusText: downloaded.statusText,
		contentType,
		format,
		content,
		truncated,
		title,
		author: extracted.author ?? "",
		published: extracted.published ?? "",
		site,
		language: extracted.language ?? "",
		description: extracted.description ?? "",
		wordCount,
		fullContentChars: fullContent.length,
		outputChars: content.length,
		browser: options.browser ?? DEFAULT_WEBFETCH_BROWSER,
		os: options.os ?? DEFAULT_WEBFETCH_OS,
		downloadedBytes: downloaded.downloadedBytes,
		contentLength: downloaded.contentLength,
		elapsedMs: Date.now() - startedAt,
		browserEscalated: false,
		remoteFallbackUsed: false,
		persisted: false,
		proxyUsed: options.proxy !== undefined,
		targetPinning: options.proxy ? "proxy-dependent" : "local",
	};
}

const defaultFetcher = createStaticWebFetcher();

/**
 * Fetch and locally extract one HTTP(S) URL without browser escalation,
 * remote readers, tool registration, or persistent content storage.
 */
export function fetchPage(
	url: string,
	options?: StaticWebFetchOptions,
): Promise<StaticWebFetchResult> {
	return defaultFetcher(url, options);
}

/** Supported `pi-webaio/webfetch` shorthand. */
export { fetchPage as fetch };
