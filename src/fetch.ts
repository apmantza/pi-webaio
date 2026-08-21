// ─── Network fetching ──────────────────────────────────────────────
// Extracted from index.ts. Rate-limited fetching with retries,
// bot protection fallback, JS rendering fallback, and SSRF checks.

import { fetch as wreqFetch, getProfiles as wreqGetProfiles } from "wreq-js";
import type { BrowserProfile, EmulationOS } from "wreq-js";
import { isIP } from "node:net";
// The stealth script is the single shared module also used by the CDP-based
// search extractors (extractors/common.mjs). It's imported via the
// "#stealth-script" subpath defined in package.json "imports", which Node and
// tsc (NodeNext) resolve relative to the nearest package.json — i.e. the
// package root — so the specifier is correct whether this module runs as the
// TypeScript source (tests, pi git-install) or as compiled dist/src/fetch.js,
// which sit at different depths relative to extractors/.
import { STEALTH_SCRIPT } from "#stealth-script";
import { detectBotBlock, detectLoginRedirect } from "./bot-detection.ts";
import { BrowserPool } from "./browser-pool.ts";
import {
	fastSsrfBlock,
	scanForSecrets,
	ssrfVerdictToFetchError,
	validateUrlForSsrf,
} from "./security.ts";
import type { FetchOpts } from "./types.ts";
import {
	getStartingStrategy,
	recordDomainSuccess,
	recordDomainFailure,
} from "./strategy-memory.ts";
import {
	cookieCacheKey,
	cookiesToHeader,
	getCachedCookies,
	hasClearCookieSignal,
	invalidateCachedCookies,
	setCachedCookies,
	type CachedCookie,
} from "./cookie-cache.ts";
import { debug } from "./debug.ts";

// ─── Constants ─────────────────────────────────────────────────────

export const DEFAULT_BROWSER = "chrome_145";
export const DEFAULT_OS = "windows";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB — streaming cap
/** Whole-request timeout handed to wreq (connect + headers + body). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Ceiling on the streaming body read, independent of wreq's timeout. */
const DEFAULT_BODY_READ_MS = 60_000;
/** Total budget for one Playwright fallback when no caller timeout is given. */
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 30_000;
/** Maximum time spent waiting for the initial DOM navigation. */
const DEFAULT_PLAYWRIGHT_NAVIGATION_TIMEOUT_MS = 15_000;
/** Maximum time spent waiting for a self-resolving bot challenge. */
const DEFAULT_PLAYWRIGHT_BOT_WAIT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

// ─── Helpers ───────────────────────────────────────────────────────

export function normalizeFetchedUrl(url: string): string {
	return url.startsWith("http://") ? url.replace(/^http:/i, "https:") : url;
}

export interface PlaywrightTimeouts {
	remainingMs: number;
	navigationTimeoutMs: number;
	botWaitTimeoutMs: number;
}

/**
 * Derive bounded Playwright phase budgets from the caller's timeout. The
 * helper is pure so timeout behavior can be regression-tested without a
 * browser. Callers recalculate it after navigation, making the bot wait share
 * the same overall budget instead of adding another full timeout.
 */
export function getPlaywrightTimeouts(
	requestTimeoutMs?: number,
	elapsedMs = 0,
): PlaywrightTimeouts {
	const total =
		Number.isFinite(requestTimeoutMs) && (requestTimeoutMs ?? 0) >= 0
			? (requestTimeoutMs as number)
			: DEFAULT_PLAYWRIGHT_TIMEOUT_MS;
	const remainingMs = Math.max(0, total - Math.max(0, elapsedMs));
	return {
		remainingMs,
		navigationTimeoutMs: Math.min(
			DEFAULT_PLAYWRIGHT_NAVIGATION_TIMEOUT_MS,
			remainingMs,
		),
		botWaitTimeoutMs: Math.min(
			DEFAULT_PLAYWRIGHT_BOT_WAIT_TIMEOUT_MS,
			remainingMs,
		),
	};
}

// ─── Bot-block fallback ladder (observability audit P7) ─────────────
//
// When the plain fetch is bot-blocked, smartFetch tries three alternate wreq
// browser profiles and then Playwright. Historically each failed profile was
// swallowed and a total failure returned null with no record of the per-profile
// outcomes, so the caller produced a generic bot-block error and the user
// couldn't judge whether `bypass: true` or a different profile would help.
// These helpers accumulate + render that ladder; the builder is pure so it is
// offline-testable.

export interface BotBlockAttempt {
	/** Profile/layer label, e.g. "plain", "firefox_147", "playwright". */
	profile: string;
	/** HTTP status seen for this attempt, when one was received. */
	status?: number;
	/** Short failure token (e.g. "blocked", "timeout") when no clean status. */
	error?: string;
}

/**
 * Build a compact one-line summary of a bot-block fallback ladder, e.g.
 * `plain=blocked, firefox_147=403, safari_26=timeout, playwright=blocked`.
 * A status wins over an error token; with neither, the attempt reads "blocked".
 */
export function summarizeBotBlockLadder(attempts: BotBlockAttempt[]): string {
	if (attempts.length === 0) return "no fallback attempts recorded";
	return attempts
		.map((a) => {
			const outcome = a.status == null ? (a.error ?? "blocked") : String(a.status);
			return `${a.profile}=${outcome}`;
		})
		.join(", ");
}

/** Collapse an unknown attempt failure into a short, single-line token. */
function describeLadderError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return "timeout";
	const first = msg.split("\n")[0].trim();
	if (!first) return "error";
	return first.length > 60 ? first.slice(0, 57) + "..." : first;
}

export function isRetryableNetworkError(err: unknown): boolean {
	if (!(err instanceof Error || err instanceof TypeError)) return false;
	const msg = ((err as Error).message || "").toLowerCase();
	return (
		msg.includes("fetch failed") ||
		msg.includes("econnreset") ||
		msg.includes("etimedout") ||
		msg.includes("econnrefused") ||
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("enotfound") ||
		msg.includes("getaddrinfo") ||
		// wreq-js native (Rust/reqwest) transport errors — the binding reports
		// these in reqwest / os-error format rather than Node's ECONNRESET-style
		// strings, so a connection reset would otherwise fail fast with no retry
		// and its throw would bypass smartFetch's browser rung.
		msg.includes("error sending request") ||
		msg.includes("forcibly closed") ||
		msg.includes("connection reset")
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

class TokenBucket {
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
				const wait = Math.ceil((deficit / this.refillRate) * this.refillIntervalMs);
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

function getRateLimiter(host: string): TokenBucket {
	let limiter = rateLimiters.get(host);
	if (!limiter) {
		limiter = new TokenBucket(10, 5);
		rateLimiters.set(host, limiter);
	}
	return limiter;
}

// ─── Playwright fallback (JS-rendered pages) ───────────────────────

let _pwWarned = false;

/**
 * Build Chromium `--host-resolver-rules` launch args that pin `hostname` to
 * the first validated IP, so the headless browser dials the exact address
 * that passed SSRF validation (closing the re-resolve TOCTOU on the
 * Playwright fallback path). Returns [] when there is nothing to pin (IP
 * literal host, or no validated IPs). The companion primitive for
 * socket-level fetchers is {@link createPinnedLookup}.
 */
export function buildHostResolverRules(
	hostname: string,
	pinnedIps: string[],
): string[] {
	if (isIP(hostname) || pinnedIps.length === 0) return [];
	return [`--host-resolver-rules=MAP ${hostname} ${pinnedIps[0]}`];
}

// ─── Stealth patches for Playwright fallback ───────────────────────
// Inject the shared stealth script before page scripts run, to mask headless
// automation signals. STEALTH_SCRIPT is imported statically at the top of this
// module (see the "#stealth-script" note there); a resolution failure would
// surface loudly at module load rather than silently disabling stealth.
export async function applyStealth(page: any) {
	try {
		if (STEALTH_SCRIPT) await page.addInitScript(STEALTH_SCRIPT);
	} catch {
		/* best-effort: never let stealth injection break a fetch */
	}
}

/**
 * Harvest cookies from a rendered Playwright page and (a) inject them into
 * the current wreq-js session, if any, so the rest of *this* fetch call
 * benefits, and (b) persist them into the cross-call per-origin cookie
 * cache (see cookie-cache.ts) keyed by `cacheKey`, so a *later* fetch call
 * to the same origin can skip straight to a cheap request instead of
 * relaunching the browser. Harvesting for (b) does not require a
 * wreqSession — only that the page exposes a browser context.
 */
async function injectCookiesFromPlaywright(
	page: any,
	url: string,
	wreqSession?: any,
	cacheKey?: string | null,
) {
	if (!page.context) return;
	try {
		const cookies = await page.context().cookies([url]);
		if (wreqSession) {
			for (const c of cookies) {
				try {
					wreqSession.setCookie(c.name, c.value, url);
				} catch {
					/* ignore individual cookie injection failures */
				}
			}
		}
		if (cacheKey && Array.isArray(cookies) && cookies.length > 0) {
			setCachedCookies(
				cacheKey,
				cookies.map((c: any) => ({
					name: c.name,
					value: c.value,
					domain: c.domain,
					path: c.path,
				})) as CachedCookie[],
			);
		}
	} catch {
		/* best-effort */
	}
}

// ─── Bot-protection wait loop ──────────────────────────────────────

export interface BotWaitOpts {
	timeoutMs?: number;
	pollMs?: number;
}

/**
 * After a Playwright `goto`, poll `page.content()` until the bot-protection
 * challenge clears or the timeout expires. Returns the post-clearance HTML.
 *
 * On a clean render (no challenge) returns immediately with zero added
 * latency. On timeout returns the last HTML seen — never throws.
 */
export async function waitForBotProtectionToClear(
	page: { content(): Promise<string> },
	{ timeoutMs = 15000, pollMs = 500 }: BotWaitOpts = {},
): Promise<string> {
	let html = await page.content();
	let block = detectBotBlock(html);
	// Only challenges the browser can resolve on its own are worth waiting
	// for — a captcha (retryable: false) will never clear by polling.
	if (!block.blocked || !block.retryable) return html;

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pollMs));
		html = await page.content();
		block = detectBotBlock(html);
		if (!block.blocked || !block.retryable) return html;
	}
	return html;
}

/**
 * Install a per-request SSRF guard on a Playwright page. Intercepts EVERY
 * request the page makes — the initial navigation, each redirect hop, and
 * all subresources (img/script/xhr) — and aborts any whose URL fails the
 * synchronous {@link fastSsrfBlock} check (literal private/metadata IPs,
 * blocked metadata hostnames, `.local`, private prefixes, dangerous ports).
 *
 * This closes the redirect gap in the browser fallback: `page.goto` follows
 * redirects internally and `--host-resolver-rules` only pins the INITIAL
 * host, so without this guard a public page could 302 the headless browser
 * into `http://169.254.169.254/` or `http://localhost/`. Best-effort: any
 * error registering the route degrades to the pre-existing behavior rather
 * than failing the fetch.
 */
function installSsrfRedirectGuard(page: any): void {
	try {
		const routePromise = page.route("**/*", (route: any) => {
			let reqUrl = "";
			try {
				reqUrl = route.request().url();
			} catch {
				reqUrl = "";
			}
			const verdict = fastSsrfBlock(reqUrl);
			if (verdict.dangerous) {
				return route.abort("blockedbyclient");
			}
			return route.continue();
		});
		// page.route returns a promise in modern Playwright; swallow errors.
		Promise.resolve(routePromise).catch(() => {});
	} catch {
		/* best-effort — never fail the fetch over guard registration */
	}
}

export async function fetchWithPlaywright(
	url: string,
	pool?: FetchOpts["browserPool"],
	wreqSession?: any,
	/**
	 * Per-origin cookie cache key (see cookie-cache.ts). When provided,
	 * cookies harvested from the render are persisted here so a later,
	 * separate fetch call to the same origin (+ proxy + browser profile)
	 * can skip straight to a cheap request instead of relaunching
	 * Playwright.
	 */
	cookieCacheKeyForOrigin?: string | null,
	/**
	 * Optional out-param populated with the browser's HTTP response status
	 * (`page.goto()` → `response.status()`, or 0 when there was no response).
	 * Lets the caller distinguish a soft-block 404 that a real browser receives
	 * as 200 (see smartFetch's Rung 1c) from a genuine 404 — which also 404s in
	 * the browser. Existing callers leave this unset.
	 */
	statusOut?: { status: number },
	/** Caller-supplied whole-fallback budget; defaults to 30 seconds. */
	requestTimeoutMs?: number,
): Promise<string | null> {
	// SSRF guard: block requests to private IPs / loopback / cloud
	// metadata endpoints. fetchWithRetry does this; fetchWithPlaywright
	// was missing the check, so a malicious URL could pivot through
	// the headless browser to internal networks.
	//
	// H1: use validateUrlForSsrf (not just the boolean) so we also get the
	// validated IPs, which we pin into the per-request browser launch below
	// via --host-resolver-rules. Fail-closed: any guard error => throw.
	const ssrf = await validateUrlForSsrf(url);
	if (ssrf.dangerous) {
		throw ssrfVerdictToFetchError(url, ssrf);
	}
	let pinnedHost = "";
	try {
		pinnedHost = new URL(url).hostname.toLowerCase();
	} catch {
		/* leave empty — pinning is best-effort */
	}
	const fallbackStartedAt = Date.now();
	const phaseTimeouts = () =>
		getPlaywrightTimeouts(requestTimeoutMs, Date.now() - fallbackStartedAt);
	const requireTime = (): PlaywrightTimeouts => {
		const timeouts = phaseTimeouts();
		if (timeouts.remainingMs <= 0) {
			throw new Error("Playwright timeout exceeded");
		}
		return timeouts;
	};
	const pinnedLaunchArgs = buildHostResolverRules(pinnedHost, ssrf.pinnedIps);
	if (pool) {
		// (redirect guard installed per-page below, after acquirePage)
		let pooled: Awaited<
			ReturnType<NonNullable<FetchOpts["browserPool"]>["acquirePage"]>
		> | null = null;

		try {
			pooled = await pool.acquirePage();
			installSsrfRedirectGuard(pooled.page);
			await applyStealth(pooled.page);
			const navTimeouts = requireTime();
			const nav = await pooled.page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: navTimeouts.navigationTimeoutMs,
			});
			if (statusOut) statusOut.status = nav?.status?.() ?? 0;
			const html = await waitForBotProtectionToClear(pooled.page, {
				timeoutMs: requireTime().botWaitTimeoutMs,
			});
			await injectCookiesFromPlaywright(
				pooled.page,
				url,
				wreqSession,
				cookieCacheKeyForOrigin,
			);
			return html;
		} catch {
			/* fall through to per-request browser below */
		} finally {
			pooled?.release();
		}
	}

	// Do not start a second browser after the pooled attempt has consumed the
	// caller's budget. This keeps a timed-out pooled navigation from doubling
	// the requested timeout with a second launch/render attempt.
	if (phaseTimeouts().remainingMs <= 0) return null;

	try {
		const { chromium } = await import("playwright");
		for (const opts of [{ channel: "chrome" as const }, {}]) {
			let browser: any = null;
			try {
				requireTime();
				browser = await chromium.launch({
					...opts,
					headless: true,
					// Pin the validated IP (H1). Only the per-request launch
					// is pinnable — the pooled path above is launched by the
					// pool and cannot take per-page args.
					...(pinnedLaunchArgs.length ? { args: pinnedLaunchArgs } : {}),
				});
				const page = await browser.newPage();
				installSsrfRedirectGuard(page);
				await applyStealth(page);
				const navTimeouts = requireTime();
				const nav = await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: navTimeouts.navigationTimeoutMs,
				});
				if (statusOut) statusOut.status = nav?.status?.() ?? 0;
				const html = await waitForBotProtectionToClear(page, {
					timeoutMs: requireTime().botWaitTimeoutMs,
				});
				await injectCookiesFromPlaywright(
					page,
					url,
					wreqSession,
					cookieCacheKeyForOrigin,
				);
				return html;
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

// ─── Shared process-level browser pool (perf audit P2) ─────────────
//
// Every browser escalation in smartFetch — the remembered-"browser" fast-path,
// the Rung-2 fallback, the Rung-1c soft-block-404 escalation, and the
// bot-block fallback — used to call fetchWithPlaywright WITHOUT a pool unless
// the caller passed one. Only aio-webpull passed a BrowserPool, so every
// single escalated aio-webfetch paid a full launch+render+close (~808ms
// measured) each time. A shared, lazily-created process-level pool lets single
// fetches reuse a warm browser (~64ms measured) — ~740ms saved per escalation.
//
// SSRF tradeoff (option b — documented): the per-request launch path pins the
// validated IP via Chromium --host-resolver-rules (buildHostResolverRules),
// which a pooled launch cannot do (launch args are per-browser, not per-page).
// The pooled render is still protected by the two controls that actually gate
// the request, both of which run regardless of pooling:
//   1. validateUrlForSsrf() — the fail-closed pre-flight check at the top of
//      fetchWithPlaywright, which validates ALL resolved IPs incl. the
//      absolute cloud-metadata floor and throws on any abnormal condition; and
//   2. installSsrfRedirectGuard() — installed per-page in the pooled branch,
//      re-validating every redirect hop + subresource via fastSsrfBlock().
// The --host-resolver-rules pinning is defense-in-depth on top of the already
// fail-closed pre-flight check (it only closes a re-resolve TOCTOU window), so
// pooling the render does not regress the SSRF guarantee. As a further safety
// net, fetchWithPlaywright's pooled branch falls through to a PINNED
// per-request launch if the pooled render throws.
//
// The pool is lazy: getSharedBrowserPool() constructs the BrowserPool object
// but launches NO browser until the first acquirePage(). Disable the shared
// pool with PI_WEBAIO_SHARED_BROWSER_POOL=0. An explicit options.browserPool
// always wins over the shared pool.

let _sharedPool: BrowserPool | null = null;

/**
 * Return the process-level shared BrowserPool, creating it lazily on first
 * call. Identity is stable across calls. Constructing the pool does NOT launch
 * a browser — that happens on the first acquirePage().
 */
export function getSharedBrowserPool(): BrowserPool {
	if (!_sharedPool) {
		// A single shared browser is plenty for single-fetch escalations; the
		// pool recycles it after maxPagesPerBrowser navigations.
		_sharedPool = new BrowserPool({ maxBrowsers: 1 });
	}
	return _sharedPool;
}

/**
 * Resolve the pool a fetch should render through: an explicit
 * options.browserPool wins; otherwise the shared process-level pool, unless
 * disabled via PI_WEBAIO_SHARED_BROWSER_POOL=0 (in which case undefined →
 * fetchWithPlaywright uses its per-request pinned launch).
 */
function resolveBrowserPool(options: FetchOpts): FetchOpts["browserPool"] {
	if (options.browserPool) return options.browserPool;
	if (process.env.PI_WEBAIO_SHARED_BROWSER_POOL === "0") return undefined;
	return getSharedBrowserPool();
}

/**
 * Cleanup hook: drain the shared pool (close its browsers) so a long-lived
 * host process doesn't leak browser instances. Safe to call repeatedly; resets
 * the singleton so the next escalation lazily creates a fresh pool.
 */
export async function closeSharedBrowserPool(): Promise<void> {
	const pool = _sharedPool;
	_sharedPool = null;
	if (pool) await pool.drain();
}

// Best-effort cleanup on process exit. exit handlers are synchronous so the
// async drain() can only be fired-and-forgotten here — closeSharedBrowserPool()
// is the reliable hook for callers that can await it.
process.once("exit", () => {
	if (_sharedPool) _sharedPool.drain().catch(() => {});
});

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
			declaredLen === null
				? `${(bytesRead / 1024 / 1024).toFixed(1)}MB received`
				: `Content-Length: ${(declaredLen / 1024 / 1024).toFixed(1)}MB`
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
			typeof Buffer === "undefined"
				? new TextEncoder().encode(t).length
				: Buffer.byteLength(t, "utf8");
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

// H1 — DNS-pinning limitation (primary fetcher):
// wreq-js (the primary fetcher) is a native Rust/NAPI binding. Its
// RequestInit / CreateTransportOptions / CreateSessionOptions expose NO
// dispatcher / agent / connect / `lookup` hook — DNS resolution and TCP
// connect happen entirely inside the native layer. We therefore cannot
// inject createPinnedLookup() into this path, so a small re-resolve TOCTOU
// window remains between the pre-flight validateUrlForSsrf() check below and
// wreq's own connect. Mitigations in place: (a) the pre-flight check is
// fail-closed and validates ALL resolved IPs incl. the absolute cloud-
// metadata floor; (b) the Playwright fallback path IS pinned via
// --host-resolver-rules (see fetchWithPlaywright / buildHostResolverRules)
// AND installs a per-request SSRF route guard (installSsrfRedirectGuard)
// that re-validates every redirect hop and subresource via fastSsrfBlock().
// KNOWN LIMITATION: wreq-js follows redirects internally (`redirect: "follow"`)
// with no redirect hook, so a server-side 30x from a public URL to a
// private/metadata address on THIS rung is not re-validated hop-by-hop — the
// initial dial is still protected by the pre-flight check + metadata floor.
// If wreq-js ever exposes a connect or redirect hook, wire
// createPinnedLookup(validation.pinnedIps) and per-hop fastSsrfBlock() here.
async function fetchWithRetry(
	url: string,
	options: FetchOpts = {},
): Promise<any> {
	// SSRF check — block local/private URLs. Throw a phase-aware FetchError
	// (code=blocked_ssrf, phase=validation for genuine hazards; code=dns_error
	// when the guard failed closed on an unresolvable host — a DNS problem,
	// not an SSRF block) so the block surfaces precisely instead of degrading
	// to the generic unknown/downloading fallback when the worker classifies
	// the thrown error.
	const ssrf = await validateUrlForSsrf(url);
	if (ssrf.dangerous) {
		throw ssrfVerdictToFetchError(url, ssrf);
	}

	let lastError: Error | null = null;
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? MAX_RETRIES));

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

			if (
				res.ok ||
				!RETRYABLE_STATUS_CODES.has(res.status) ||
				attempt >= maxRetries
			) {
				return res;
			}

			lastError = new Error(`HTTP ${res.status}`);
			await sleep(jitteredDelay(RETRY_INITIAL_DELAY_MS, attempt));
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (!isRetryableNetworkError(err)) {
				throw err; // Non-retryable: fail fast
			}
			if (attempt < maxRetries) {
				await sleep(jitteredDelay(RETRY_INITIAL_DELAY_MS, attempt));
			}
		}
	}

	console.error(
		`[FETCH] All ${maxRetries + 1} attempts failed for ${url}: ${lastError?.message}`,
	);
	return null;
}

// ─── Smart fetch (bot protection fallback, secret scan) ────────────

/**
 * Decide whether a browser render resolved a soft-block 404. The wreq rung
 * returned `wreqStatus` (a 404 from a TLS-fingerprinted request); the browser
 * rung then returned `browserStatus` with `hasHtml`. Only a 2xx browser render
 * counts as a resolution — a genuine 404 also 404s in the browser, so it must
 * NOT be treated as success (the caller falls through and fails fast).
 */
export function isSoftBlock404Resolved(
	wreqStatus: number,
	browserStatus: number,
	hasHtml: boolean,
): boolean {
	return (
		wreqStatus === 404 && hasHtml && browserStatus >= 200 && browserStatus < 300
	);
}

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

/**
 * Consult the per-origin cookie cache (cookie-cache.ts) and, if warm
 * cookies exist for this origin + proxy + browser profile, try the cheap
 * TLS-fingerprint tier with those cookies injected *before* the caller
 * escalates to a headless browser. This is what lets a crawl reuse a
 * cookie harvested by an earlier Playwright render — across separate
 * `smartFetch` calls, even ones that remember a "browser" strategy for
 * this domain — instead of relaunching Playwright every time.
 *
 * Returns null (never throws) when there's no cache entry, the warmed
 * request still looks blocked/redirected, or anything goes wrong — in
 * all those cases the caller falls through to its normal ladder.
 */
async function tryCookieWarmedFetch(
	url: string,
	domain: string,
	cacheKey: string | null,
	options: FetchOpts,
	startedAt: number,
): Promise<SmartFetchResult | null> {
	if (!cacheKey) return null;
	const cached = getCachedCookies(cacheKey);
	if (!cached || cached.length === 0) return null;

	const headers: Record<string, string> = { ...options.headers };
	if (options.wreqSession) {
		for (const c of cached) {
			try {
				options.wreqSession.setCookie(c.name, c.value, url);
			} catch {
				/* ignore individual cookie injection failures */
			}
		}
	} else {
		headers["Cookie"] = headers["Cookie"]
			? `${headers["Cookie"]}; ${cookiesToHeader(cached)}`
			: cookiesToHeader(cached);
	}

	let res: any;
	try {
		res = await fetchWithRetry(url, { ...options, headers });
	} catch {
		return null;
	}
	if (!res || !res.ok) return null;

	let text: string;
	let bytesRead: number;
	let declaredLen: number | null;
	try {
		const result = await readResponseTextWithProgress(res, options.timeoutMs);
		text = result.text;
		bytesRead = result.bytesRead;
		declaredLen = result.contentLength;
	} catch {
		return null;
	}

	const loginRedirect = detectLoginRedirect(
		url,
		normalizeFetchedUrl(res.url),
		text,
	);
	if (loginRedirect) {
		// The cached cookies clearly no longer establish a valid session.
		invalidateCachedCookies(cacheKey);
		return null;
	}
	if (detectBotBlock(text).blocked) {
		// Cookies alone weren't enough (stale/insufficient) — leave the
		// cache as-is (a concurrent warm render may still be valid) and
		// let the normal ladder run.
		return null;
	}
	if (hasClearCookieSignal(res.headers?.get?.("set-cookie"))) {
		invalidateCachedCookies(cacheKey);
	}

	recordDomainSuccess(domain, "wreq");
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

	const domain = parsedUrl.hostname;
	const rememberedStrategy = getStartingStrategy(domain);
	const disableFallbacks = options.disableFallbacks === true;
	const cookieKey = cookieCacheKey(
		url,
		options.proxy,
		options.browser ?? DEFAULT_BROWSER,
	);

	// Resolve the render pool once for every browser escalation below: an
	// explicit options.browserPool wins, else the shared process-level pool
	// (perf P2) — so single fetches reuse a warm browser instead of
	// launch-close per request. See the shared-pool note above for the SSRF
	// tradeoff this relies on. Search-engine probes disable fallbacks so their
	// deadline is a real upper bound and no browser job is left running after
	// aio-websearch returns.
	const browserPool = disableFallbacks ? undefined : resolveBrowserPool(options);

	// ── Cookie-cache warm-path: reuse cookies from an earlier headless
	// render of this same origin (+ proxy + browser profile) to try the
	// cheap tier before escalating to a browser — even when memory says
	// the last successful strategy here was "browser". Cheap no-op when
	// there's no cache entry.
	if (!disableFallbacks) {
		const warmed = await tryCookieWarmedFetch(
			url,
			domain,
			cookieKey,
			options,
			startedAt,
		);
		if (warmed) return warmed;
	}

	// ── Rung 2 fast-path: skip straight to browser if memory says so ──
	// Only when we have a remembered "browser" strategy and are not re-probing.
	if (!disableFallbacks && rememberedStrategy === "browser") {
		const pwHtml = await fetchWithPlaywright(
			url,
			browserPool,
			options.wreqSession,
			cookieKey,
			undefined,
			options.timeoutMs,
		);
		if (pwHtml) {
			recordDomainSuccess(domain, "browser");
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
		// Browser failed — fall through to normal ladder
		recordDomainFailure(domain, "browser");
	}

	// ── Rung 1: wreq plain/TLS fetch ──────────────────────────────────
	// Skip this rung only when memory says "wreq" (bot-fallback profiles)
	// or "browser", unless we are in a re-probe pass (rememberedStrategy===null
	// after TTL/reprobeNext reset).
	const skipPlain = rememberedStrategy === "wreq";

	let res: any = null;
	if (!skipPlain) {
		res = await fetchWithRetry(url, options);
	}

	if (!res) {
		if (disableFallbacks) return null;
		// ── Rung 1b: wreq with alternate browser profiles (bot-fallback) ──
		if (!skipPlain) {
			// Only reach here if fetchWithRetry returned null (hard network fail);
			// record as plain failure before trying browser.
			recordDomainFailure(domain, "plain");
		}

		// ── Rung 2: Playwright browser fallback ───────────────────────────
		const pwHtml = await fetchWithPlaywright(
			url,
			browserPool,
			options.wreqSession,
			cookieKey,
			undefined,
			options.timeoutMs,
		);
		if (pwHtml) {
			recordDomainSuccess(domain, "browser");
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

	// ── Rung 1c: soft-block 404 → browser escalation ─────────────────
	// Some edges (Vercel / Next.js — e.g. react.dev) return a bare HTTP 404 to
	// TLS-fingerprinted requests that a real browser receives as 200.
	// fetchWithRetry treats 404 as non-retryable and hands the response back, so
	// the `!res` browser rung above never fires and the 404 would surface as a
	// terminal http_error. Escalate once to the browser and accept only a 2xx
	// render: a genuine 404 also 404s in the browser, so isSoftBlock404Resolved()
	// stays false and we fall through to return the original 404 (fail-fast
	// preserved). Opt out with PI_WEBAIO_404_BROWSER_ESCALATION=0.
	if (
		!disableFallbacks &&
		res.status === 404 &&
		process.env.PI_WEBAIO_404_BROWSER_ESCALATION !== "0"
	) {
		recordDomainFailure(domain, "plain");
		const statusOut = { status: 0 };
		const pwHtml = await fetchWithPlaywright(
			url,
			browserPool,
			options.wreqSession,
			cookieKey,
			statusOut,
			options.timeoutMs,
		);
		const resolved = isSoftBlock404Resolved(
			res.status,
			statusOut.status,
			!!pwHtml,
		);
		if (resolved && pwHtml) {
			recordDomainSuccess(domain, "browser");
			return {
				text: pwHtml,
				url,
				status: statusOut.status,
				headers: { get: () => "text/html" } as {
					get(name: string): string | null;
					has?(name: string): boolean;
				},
				downloadedBytes: pwHtml.length,
				contentLength: pwHtml.length,
				elapsedMs: Date.now() - startedAt,
			};
		}
		// Browser also 404'd (or Playwright is unavailable) — genuine 404;
		// fall through to read and return the original wreq response below.
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
		invalidateCachedCookies(cookieKey);
		return null;
	}
	if (hasClearCookieSignal(res.headers?.get?.("set-cookie"))) {
		invalidateCachedCookies(cookieKey);
	}

	if (detectBotBlock(text).blocked) {
		// Record plain fetch as blocked before trying alternate wreq profiles.
		// Search-engine probes disable fallback ladders so a bot/verification page
		// is treated as that engine's empty/error result instead of launching
		// detached alternate-profile/browser work after the response budget.
		recordDomainFailure(domain, "plain");
		if (disableFallbacks) {
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

		// Accumulate every attempt so a total failure can report the full ladder
		// instead of a generic bot-block error (P7).
		const ladderAttempts: BotBlockAttempt[] = [
			{ profile: "plain", error: "blocked" },
		];
		const fallbackBrowsers = ["firefox_147", "safari_26", "edge_145"];
		const headers = {
			...buildHeaders(undefined, options.os),
			...options.headers,
		};
		for (const fb of fallbackBrowsers) {
			const fetchFn = options.wreqSession
				? (u: string, init: any) => options.wreqSession.fetch(u, init)
				: wreqFetch;
			let fbRes: any;
			try {
				fbRes = await fetchFn(url, {
					redirect: "follow",
					headers,
					browser: fb as BrowserProfile,
					os: (options.os ?? DEFAULT_OS) as EmulationOS,
					timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					...(options.proxy ? { proxy: options.proxy } : {}),
				});
			} catch (err) {
				// Network-level failure (timeout, reset, …) — record and try next.
				ladderAttempts.push({ profile: fb, error: describeLadderError(err) });
				continue;
			}
			if (fbRes?.ok) {
				try {
					const fbData = await readResponseTextWithProgress(
						fbRes,
						options.timeoutMs,
					);
					if (!detectBotBlock(fbData.text).blocked) {
						recordDomainSuccess(domain, "wreq");
						return {
							text: fbData.text,
							url: normalizeFetchedUrl(fbRes.url),
							status: fbRes.status,
							headers: fbRes.headers,
							downloadedBytes: fbData.bytesRead,
							contentLength: fbData.contentLength,
							elapsedMs: Date.now() - startedAt,
						};
					}
					// 200 but still a challenge page — record the soft block.
					ladderAttempts.push({
						profile: fb,
						status: fbRes.status,
						error: "blocked",
					});
				} catch (err) {
					ladderAttempts.push({ profile: fb, error: describeLadderError(err) });
				}
			} else {
				// Non-OK HTTP (403/429/…) — record the status and try next profile.
				ladderAttempts.push({ profile: fb, status: fbRes?.status });
			}
		}

		// All wreq profiles blocked; record wreq failure and try playwright
		recordDomainFailure(domain, "wreq");
		const pwStatusOut = { status: 0 };
		const pwHtml = await fetchWithPlaywright(
			url,
			browserPool,
			options.wreqSession,
			cookieKey,
			pwStatusOut,
			options.timeoutMs,
		);
		if (pwHtml) {
			recordDomainSuccess(domain, "browser");
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
		ladderAttempts.push({
			profile: "playwright",
			...(pwStatusOut.status
				? { status: pwStatusOut.status }
				: { error: "blocked" }),
		});

		// Total failure: surface the full ladder so the user can judge whether
		// `bypass: true` or a different profile would help. Keep returning null
		// (control flow unchanged) — the caller still produces the bot-block error.
		const ladderSummary = summarizeBotBlockLadder(ladderAttempts);
		debug("fetch", `bot-block ladder exhausted for ${domain}: ${ladderSummary}`);
		console.error(
			`[pi-webaio] bot-block ladder exhausted for ${domain}: ${ladderSummary}`,
		);
		return null;
	}

	// Plain wreq fetch succeeded without bot-block
	recordDomainSuccess(domain, skipPlain ? "wreq" : "plain");

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
