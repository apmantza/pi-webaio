// ─── Network fetching ──────────────────────────────────────────────
// Extracted from index.ts. Rate-limited fetching with retries,
// bot protection fallback, JS rendering fallback, and SSRF checks.

import { fetch as wreqFetch, getProfiles as wreqGetProfiles } from "wreq-js";
import type { BrowserProfile, EmulationOS } from "wreq-js";
import { detectBotBlock, detectLoginRedirect } from "./bot-detection.ts";
import { isDangerousUrl, scanForSecrets } from "./security.ts";
import type { FetchOpts } from "./types.ts";

// ─── Constants ─────────────────────────────────────────────────────

export const DEFAULT_BROWSER = "chrome_145";
export const DEFAULT_OS = "windows";

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB — streaming cap
/** Whole-request timeout handed to wreq (connect + headers + body). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Ceiling on the streaming body read, independent of wreq's timeout. */
export const DEFAULT_BODY_READ_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

// ─── Helpers ───────────────────────────────────────────────────────

export function normalizeFetchedUrl(url: string): string {
	return url.startsWith("http://") ? url.replace(/^http:/i, "https:") : url;
}

export function isRetryableNetworkError(err: unknown): boolean {
	if (!(err instanceof Error || err instanceof TypeError)) return false;
	const msg = (err as Error).message || "";
	return (
		msg.includes("fetch failed") ||
		msg.includes("ECONNRESET") ||
		msg.includes("ETIMEDOUT") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("ENOTFOUND") ||
		msg.includes("getaddrinfo")
	);
}

const OS_PLATFORM: Record<string, string> = {
	windows: "Windows",
	macos: "macOS",
	linux: "Linux",
	android: "Android",
	ios: "iOS",
};

export function buildHeaders(
	browser?: string,
	os?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "gzip, deflate, br",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "none",
		"Sec-Fetch-User": "?1",
		"Upgrade-Insecure-Requests": "1",
		"Sec-Ch-Ua-Mobile": "?0",
		"Sec-Ch-Ua-Platform": `"${OS_PLATFORM[os ?? DEFAULT_OS] ?? "Windows"}"`,
	};

	const version = (browser ?? DEFAULT_BROWSER).split("_").pop() || "145";
	if (!browser || browser.startsWith("chrome_")) {
		headers["Sec-Ch-Ua"] =
			`"Not_A Brand";v="8", "Chromium";v="${version}", "Google Chrome";v="${version}"`;
	} else if (browser.startsWith("edge_")) {
		headers["Sec-Ch-Ua"] =
			`"Not_A Brand";v="8", "Chromium";v="${version}", "Microsoft Edge";v="${version}"`;
	}
	// Firefox / Safari do not send Sec-Ch-Ua — omit it

	return headers;
}

// ─── Chrome profile discovery ──────────────────────────────────────

let _latestChrome: string | null = null;

export function getLatestChromeProfile(): string {
	if (!_latestChrome) {
		try {
			const profiles = wreqGetProfiles();
			const chromes = profiles.filter((p: string) => p.startsWith("chrome_"));
			if (chromes.length > 0) {
				chromes.sort((a: string, b: string) => {
					const an = parseInt(a.split("_").pop() || "0", 10);
					const bn = parseInt(b.split("_").pop() || "0", 10);
					return an - bn;
				});
				_latestChrome = chromes[chromes.length - 1];
			}
		} catch {
			// wreq-js not ready yet
		}
	}
	return _latestChrome ?? DEFAULT_BROWSER;
}

// ─── Token bucket rate limiter ─────────────────────────────────────

export class TokenBucket {
	private tokens: number;
	private lastRefill: number;
	/** Simple lock to prevent concurrent acquire() corruption */
	private lockPromise: Promise<void> = Promise.resolve();
	// Note: not using TypeScript parameter properties (constructor(private
	// maxTokens: number)) here because Node 24's native --strip-types
	// (used by the test runner) doesn't support them. Explicit fields +
	// constructor assignments are equally type-safe and strip-types-clean.
	private readonly maxTokens: number;
	private readonly refillRate: number;
	private readonly refillIntervalMs: number;

	constructor(
		maxTokens: number,
		refillRate: number,
		refillIntervalMs: number = 1000,
	) {
		this.maxTokens = maxTokens;
		this.refillRate = refillRate;
		this.refillIntervalMs = refillIntervalMs;
		this.tokens = maxTokens;
		this.lastRefill = Date.now();
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = now - this.lastRefill;
		const newTokens =
			Math.floor(elapsed / this.refillIntervalMs) * this.refillRate;
		if (newTokens > 0) {
			this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
			this.lastRefill = now;
		}
	}

	async acquire(): Promise<void> {
		// Acquire lock to prevent concurrent refill + decrement races
		let releaseLock: () => void;
		const lockAcquired = new Promise<void>((r) => (releaseLock = r));
		const previousLock = this.lockPromise;
		this.lockPromise = previousLock.then(() => lockAcquired);
		await previousLock;

		try {
			this.refill();
			if (this.tokens < 1) {
				const deficit = 1 - this.tokens;
				const wait = Math.ceil(
					(deficit / this.refillRate) * this.refillIntervalMs,
				);
				await new Promise((r) => setTimeout(r, wait));
				this.refill();
			}
			this.tokens--;
		} finally {
			releaseLock!();
		}
	}

	reset(): void {
		this.tokens = this.maxTokens;
		this.lastRefill = Date.now();
	}
}

const rateLimiters = new Map<string, TokenBucket>();

export function getRateLimiter(host: string): TokenBucket {
	let limiter = rateLimiters.get(host);
	if (!limiter) {
		limiter = new TokenBucket(10, 5);
		rateLimiters.set(host, limiter);
	}
	return limiter;
}

// ─── Playwright fallback (JS-rendered pages) ───────────────────────

let _pwWarned = false;

// ─── Essential stealth patches for Playwright fallback ─────────────
// Injected before page scripts run to mask headless automation signals.
const PLAYWRIGHT_STEALTH_SCRIPT = `
(function() {
  try { delete window.__REBROWSER_RUNTIME_ENABLE; } catch(_) {}
  try { delete window.__REBROWSER_DEVTOOLS; } catch(_) {}
  try { delete window.__nightmare; } catch(_) {}
  try { delete window.__phantom; } catch(_) {}
  try { delete window.callPhantom; } catch(_) {}
  try { delete window._phantom; } catch(_) {}

  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      var p = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      p.length = 3;
      return p;
    },
  });
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      var m = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null },
      ];
      m.item = function(i) { return m[i] || null; };
      m.namedItem = function(name) { return m.find(function(x) { return x.type === name; }) || null; };
      return m;
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {}, connect: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {} } },
      loadTimes: () => ({}),
      csi: () => ({}),
    };
  }

  try {
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    };
  } catch(_) {}
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

  try {
    if (!window.outerWidth)  Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth  || 1920, configurable: true });
    if (!window.outerHeight) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight || 1080, configurable: true });
  } catch(_) {}

  try {
    if (!screen.colorDepth) Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
    if (!screen.pixelDepth) Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
  } catch(_) {}
})();
`;

export async function applyStealth(page: any) {
	try {
		await page.addInitScript(PLAYWRIGHT_STEALTH_SCRIPT);
	} catch {
		/* best-effort */
	}
}

async function injectCookiesFromPlaywright(
	page: any,
	url: string,
	wreqSession?: any,
) {
	if (!wreqSession || !page.context) return;
	try {
		const cookies = await page.context().cookies([url]);
		for (const c of cookies) {
			try {
				wreqSession.setCookie(c.name, c.value, url);
			} catch {
				/* ignore individual cookie injection failures */
			}
		}
	} catch {
		/* best-effort */
	}
}

export async function fetchWithPlaywright(
	url: string,
	pool?: FetchOpts["browserPool"],
	wreqSession?: any,
): Promise<string | null> {
	// SSRF guard: block requests to private IPs / loopback / cloud
	// metadata endpoints. fetchWithRetry does this; fetchWithPlaywright
	// was missing the check, so a malicious URL could pivot through
	// the headless browser to internal networks.
	if (await isDangerousUrl(url)) {
		throw new Error(`Blocked unsafe URL: ${url}`);
	}
	if (pool) {
		let pooled: Awaited<
			ReturnType<NonNullable<FetchOpts["browserPool"]>["acquirePage"]>
		> | null = null;

		try {
			pooled = await pool.acquirePage();
			await applyStealth(pooled.page);
			await pooled.page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: 15000,
			});
			await injectCookiesFromPlaywright(pooled.page, url, wreqSession);
			return await pooled.page.content();
		} catch {
			/* fall through to per-request browser below */
		} finally {
			pooled?.release();
		}
	}

	try {
		const { chromium } = await import("playwright");
		for (const opts of [{ channel: "chrome" as const }, {}]) {
			let browser: any = null;
			try {
				browser = await chromium.launch({
					...opts,
					headless: true,
				});
				const page = await browser.newPage();
				await applyStealth(page);
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 15000,
				});
				await injectCookiesFromPlaywright(page, url, wreqSession);
				return await page.content();
			} catch {
				/* try next launch option */
			} finally {
				await browser?.close().catch(() => {});
			}
		}
	} catch {
		if (!_pwWarned) {
			console.warn(
				"[pi-webaio] Playwright not found — JS-rendered page fallback is unavailable. " +
					"Install it with: npm install playwright (optional dependency for " +
					"rendering JavaScript-heavy pages that wreq-js cannot handle)",
			);
			_pwWarned = true;
		}
	}
	return null;
}

// ─── Response body reader (byte-budget capped) ─────────────────────

export async function readResponseText(response: any): Promise<string> {
	const { text } = await readResponseTextWithProgress(response);
	return text;
}

/**
 * Stream the response body to a string, returning the actual bytes read
 * and the server-declared `Content-Length` (or null if unknown). Throws
 * if the response exceeds {@link MAX_RESPONSE_BYTES} — the error includes
 * the bytes read so the caller can build a rich FetchError.
 */
/**
 * Throw an "ERR_RESPONSE_TOO_LARGE" error annotated with progress so the
 * caller's `classifyError` can produce a rich FetchError.
 */
function throwResponseTooLarge(
	bytesRead: number,
	declaredLen: number | null,
	limit: number,
): never {
	const err: any = new Error(
		`Response exceeds ${limit} byte limit (${
			declaredLen !== null
				? `Content-Length: ${(declaredLen / 1024 / 1024).toFixed(1)}MB`
				: `${(bytesRead / 1024 / 1024).toFixed(1)}MB received`
		})`,
	);
	err.code = "ERR_RESPONSE_TOO_LARGE";
	err.bytesRead = bytesRead;
	err.contentLength = declaredLen;
	throw err;
}

/**
 * Cancel a stream reader without leaving a floating rejected promise.
 * Per the WHATWG Streams spec, `cancel()` on an errored stream returns a
 * promise rejected with the stream's stored error — an unhandled
 * rejection there crashes the whole host process (Node's default
 * `--unhandled-rejections=throw`). A sync try/catch does NOT catch an
 * async rejection, so this must explicitly attach a no-op `.catch`.
 */
function safeCancel(reader: { cancel: () => unknown }): void {
	try {
		const p = reader.cancel() as Promise<unknown> | undefined;
		if (p && typeof (p as any).catch === "function") {
			(p as Promise<unknown>).catch(() => {});
		}
	} catch {
		/* ignore */
	}
}

/**
 * Race a single `reader.read()` against an absolute deadline. Shared by
 * the text and buffer streaming paths so both get the same timeout
 * behavior without duplicating the race/cleanup logic. On timeout, the
 * reader is cancelled (via {@link safeCancel}) and an ETIMEDOUT error is
 * thrown whose message includes "timed out". The setTimeout is always
 * cleared in `finally` so no timer is left dangling.
 */
async function readChunkWithDeadline(
	reader: { read: () => Promise<any>; cancel: () => unknown },
	deadlineAt: number,
	startAt: number,
	bytesReadSoFar: number,
): Promise<any> {
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) {
		safeCancel(reader);
		const elapsed = Date.now() - startAt;
		const err: any = new Error(
			`Body read timed out after ${elapsed}ms (${bytesReadSoFar} bytes read)`,
		);
		err.code = "ETIMEDOUT";
		throw err;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					safeCancel(reader);
					const elapsed = Date.now() - startAt;
					const err: any = new Error(
						`Body read timed out after ${elapsed}ms (${bytesReadSoFar} bytes read)`,
					);
					err.code = "ETIMEDOUT";
					reject(err);
				}, remaining);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function readResponseTextWithProgress(
	response: any,
	timeoutMs: number = DEFAULT_BODY_READ_MS,
): Promise<{
	text: string;
	bytesRead: number;
	contentLength: number | null;
}> {
	if (!response.body) {
		const t = await response.text();
		// Use byte length, not char length, so the size shown in the
		// TUI and used by `suggestRetryTimeoutMs` is accurate for
		// multi-byte UTF-8 (CJK, emoji).
		const byteLength =
			typeof Buffer !== "undefined"
				? Buffer.byteLength(t, "utf8")
				: new TextEncoder().encode(t).length;
		return { text: t, bytesRead: byteLength, contentLength: null };
	}
	const contentLengthHeader = response.headers?.get("content-length");
	let declaredLen: number | null = null;
	if (contentLengthHeader) {
		const parsed = parseInt(contentLengthHeader, 10);
		if (!isNaN(parsed) && parsed > 0) declaredLen = parsed;
	}
	if (declaredLen !== null && declaredLen > MAX_RESPONSE_BYTES) {
		throwResponseTooLarge(0, declaredLen, MAX_RESPONSE_BYTES);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let result = "";
	let bytesRead = 0;
	const startAt = Date.now();
	const deadlineAt = startAt + timeoutMs;
	try {
		while (true) {
			const { done, value } = await readChunkWithDeadline(
				reader,
				deadlineAt,
				startAt,
				bytesRead,
			);
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > MAX_RESPONSE_BYTES) {
				safeCancel(reader);
				throwResponseTooLarge(bytesRead, declaredLen, MAX_RESPONSE_BYTES);
			}
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();
		return { text: result, bytesRead, contentLength: declaredLen };
	} catch (err) {
		safeCancel(reader);
		// Annotate with progress so callers can build a FetchError
		if (err && typeof err === "object" && !(err as any).bytesRead) {
			(err as any).bytesRead = bytesRead;
			(err as any).contentLength = declaredLen;
		}
		throw err;
	}
}

// ─── Core fetch with retry ─────────────────────────────────────────

export async function fetchWithRetry(
	url: string,
	options: FetchOpts = {},
): Promise<any> {
	// SSRF check — block local/private URLs
	if (await isDangerousUrl(url)) {
		throw new Error(
			`[SECURITY] Blocked request to private/internal URL: ${url}`,
		);
	}

	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const fetchFn = options.wreqSession
				? (u: string, init: any) => options.wreqSession.fetch(u, init)
				: wreqFetch;
			const res = await fetchFn(url, {
				redirect: "follow",
				headers: {
					...buildHeaders(options.browser, options.os),
					...options.headers,
				},
				browser: (options.browser ?? DEFAULT_BROWSER) as BrowserProfile,
				os: (options.os ?? DEFAULT_OS) as EmulationOS,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				...(options.proxy ? { proxy: options.proxy } : {}),
			});

			if (!res) {
				throw new Error("fetch failed — no response");
			}

			// Non-retryable status: fail fast
			if (NON_RETRYABLE_STATUS_CODES.has(res.status)) {
				return res; // let caller handle
			}

			if (res.ok || !RETRYABLE_STATUS_CODES.has(res.status)) {
				return res;
			}

			lastError = new Error(`HTTP ${res.status}`);
			await sleep(jitteredDelay(RETRY_INITIAL_DELAY_MS, attempt));
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (!isRetryableNetworkError(err)) {
				throw err; // Non-retryable: fail fast
			}
			if (attempt < MAX_RETRIES) {
				await sleep(jitteredDelay(RETRY_INITIAL_DELAY_MS, attempt));
			}
		}
	}

	console.error(
		`[FETCH] All ${MAX_RETRIES + 1} attempts failed for ${url}: ${lastError?.message}`,
	);
	return null;
}

// ─── Smart fetch (bot protection fallback, secret scan) ────────────

export type SmartFetchResult = {
	text: string;
	url: string;
	status: number;
	headers: { get(name: string): string | null };
	/** Bytes actually read from the body. */
	downloadedBytes: number;
	/** Server-declared `Content-Length`, or null if unknown. */
	contentLength: number | null;
	/** Total wall time of the fetch, including retries and fallbacks. */
	elapsedMs: number;
};

export async function smartFetch(
	url: string,
	options: FetchOpts = {},
): Promise<SmartFetchResult | null> {
	const startedAt = Date.now();
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return null;
	}
	await getRateLimiter(parsedUrl.hostname).acquire();

	if (url.startsWith("http://")) {
		url = "https://" + url.slice(7);
	}

	const secretScan = scanForSecrets(url);
	if (secretScan.found) {
		console.error(
			`[SECURITY] Blocked request to ${url}: potential secrets detected (${secretScan.matches.join(", ")})`,
		);
		return null;
	}

	const res = await fetchWithRetry(url, options);
	if (!res) {
		const pwHtml = await fetchWithPlaywright(
			url,
			options.browserPool,
			options.wreqSession,
		);
		if (pwHtml) {
			return {
				text: pwHtml,
				url,
				status: 200,
				headers: { get: () => "text/html" } as {
					get(name: string): string | null;
					has?(name: string): boolean;
				},
				downloadedBytes: pwHtml.length,
				contentLength: pwHtml.length,
				elapsedMs: Date.now() - startedAt,
			};
		}
		return null;
	}

	let text: string;
	let bytesRead: number;
	let declaredLen: number | null;
	try {
		const result = await readResponseTextWithProgress(res, options.timeoutMs);
		text = result.text;
		bytesRead = result.bytesRead;
		declaredLen = result.contentLength;
	} catch (err) {
		// Bubble the underlying error enriched with progress so callers
		// can build a FetchError with downloadedBytes/contentLength.
		// readResponseTextWithProgress already attaches bytesRead +
		// contentLength to its errors; we just add elapsedMs.
		const enriched: any = err instanceof Error ? err : new Error(String(err));
		if (typeof enriched === "object") {
			if (enriched.elapsedMs === undefined) {
				enriched.elapsedMs = Date.now() - startedAt;
			}
		}
		throw enriched;
	}

	const loginRedirect = detectLoginRedirect(
		url,
		normalizeFetchedUrl(res.url),
		text,
	);
	if (loginRedirect) {
		console.error(`[BLOCKED] Login redirect detected: ${loginRedirect}`);
		return null;
	}

	if (detectBotBlock(text).blocked) {
		const fallbackBrowsers = ["firefox_147", "safari_26", "edge_145"];
		const headers = {
			...buildHeaders(undefined, options.os),
			...options.headers,
		};
		for (const fb of fallbackBrowsers) {
			const fetchFn = options.wreqSession
				? (u: string, init: any) => options.wreqSession.fetch(u, init)
				: wreqFetch;
			const fbRes = await fetchFn(url, {
				redirect: "follow",
				headers,
				browser: fb as BrowserProfile,
				os: (options.os ?? DEFAULT_OS) as EmulationOS,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				...(options.proxy ? { proxy: options.proxy } : {}),
			});
			if (fbRes?.ok) {
				try {
					const fb = await readResponseTextWithProgress(
						fbRes,
						options.timeoutMs,
					);
					if (!detectBotBlock(fb.text).blocked) {
						return {
							text: fb.text,
							url: normalizeFetchedUrl(fbRes.url),
							status: fbRes.status,
							headers: fbRes.headers,
							downloadedBytes: fb.bytesRead,
							contentLength: fb.contentLength,
							elapsedMs: Date.now() - startedAt,
						};
					}
				} catch {
					/* swallow — try next profile */
				}
			}
		}
	}

	return {
		text,
		url: normalizeFetchedUrl(res.url),
		status: res.status,
		headers: res.headers,
		downloadedBytes: bytesRead,
		contentLength: declaredLen,
		elapsedMs: Date.now() - startedAt,
	};
}

// ─── Binary fetch ──────────────────────────────────────────────────

export async function fetchBuffer(
	url: string,
	options: FetchOpts = {},
): Promise<{ buffer: Buffer; url: string; status: number } | null> {
	if (url.startsWith("http://")) {
		url = "https://" + url.slice(7);
	}

	const secretScan = scanForSecrets(url);
	if (secretScan.found) {
		console.error(
			`[SECURITY] Blocked request to ${url}: potential secrets detected (${secretScan.matches.join(", ")})`,
		);
		return null;
	}

	const res = await fetchWithRetry(url, options);
	if (!res) return null;

	const contentLengthHeader = res.headers?.get?.("content-length");
	let declaredLen: number | null = null;
	if (contentLengthHeader) {
		const parsed = parseInt(contentLengthHeader, 10);
		if (!isNaN(parsed) && parsed > 0) declaredLen = parsed;
	}
	if (declaredLen !== null && declaredLen > MAX_RESPONSE_BYTES) {
		console.error(
			`[FETCH] Response for ${url} exceeds ${MAX_RESPONSE_BYTES} byte limit ` +
				`(Content-Length: ${(declaredLen / 1024 / 1024).toFixed(1)}MB)`,
		);
		return null;
	}

	if (res.body) {
		const reader = res.body.getReader();
		const timeoutMs = options.timeoutMs ?? DEFAULT_BODY_READ_MS;
		const startAt = Date.now();
		const deadlineAt = startAt + timeoutMs;
		const chunks: Uint8Array[] = [];
		let bytesRead = 0;
		try {
			while (true) {
				const { done, value } = await readChunkWithDeadline(
					reader,
					deadlineAt,
					startAt,
					bytesRead,
				);
				if (done) break;
				bytesRead += value.byteLength;
				if (bytesRead > MAX_RESPONSE_BYTES) {
					safeCancel(reader);
					throwResponseTooLarge(bytesRead, declaredLen, MAX_RESPONSE_BYTES);
				}
				chunks.push(value);
			}
			return {
				buffer: Buffer.concat(chunks),
				url: normalizeFetchedUrl(res.url),
				status: res.status,
			};
		} catch (err) {
			safeCancel(reader);
			throw err;
		}
	}

	const arrayBuf = await res.arrayBuffer();
	return {
		buffer: Buffer.from(arrayBuf),
		url: normalizeFetchedUrl(res.url),
		status: res.status,
	};
}

// ─── Utility ───────────────────────────────────────────────────────

function jitteredDelay(baseMs: number, attempt: number): number {
	const delay = baseMs * (attempt + 1);
	const variance = delay * 0.4;
	return Math.max(
		50,
		Math.round(delay + (Math.random() * variance * 2 - variance)),
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
