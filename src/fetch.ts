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
		msg.includes("ENOTFOUND") ||
		msg.includes("getaddrinfo")
	);
}

export function buildHeaders(): Record<string, string> {
	return {
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "gzip, deflate, br",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "none",
		"Sec-Fetch-User": "?1",
		"Upgrade-Insecure-Requests": "1",
		"Sec-Ch-Ua":
			'"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
		"Sec-Ch-Ua-Mobile": "?0",
		"Sec-Ch-Ua-Platform": '"Windows"',
	};
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

	constructor(
		private maxTokens: number,
		private refillRate: number,
		private refillIntervalMs: number = 1000,
	) {
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

export async function fetchWithPlaywright(
	url: string,
	pool?: FetchOpts["browserPool"],
): Promise<string | null> {
	if (pool) {
		let pooled: Awaited<
			ReturnType<NonNullable<FetchOpts["browserPool"]>["acquirePage"]>
		> | null = null;

		try {
			pooled = await pool.acquirePage();
			await pooled.page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: 15000,
			});
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
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 15000,
				});
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
	if (!response.body) return response.text();
	const contentLength = response.headers?.get("content-length");
	if (contentLength) {
		const len = parseInt(contentLength, 10);
		if (!isNaN(len) && len > MAX_RESPONSE_BYTES) {
			throw new Error(
				`Response exceeds ${MAX_RESPONSE_BYTES} byte limit (Content-Length: ${(len / 1024 / 1024).toFixed(1)}MB)`,
			);
		}
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let result = "";
	let bytesRead = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > MAX_RESPONSE_BYTES) {
				reader.cancel();
				throw new Error(
					`Response exceeds ${MAX_RESPONSE_BYTES} byte limit (${(MAX_RESPONSE_BYTES / 1024 / 1024).toFixed(1)}MB)`,
				);
			}
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();
		return result;
	} catch (err) {
		reader.cancel();
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
			const res = await wreqFetch(url, {
				redirect: "follow",
				headers: { ...buildHeaders(), ...options.headers },
				browser: (options.browser ?? DEFAULT_BROWSER) as BrowserProfile,
				os: (options.os ?? DEFAULT_OS) as EmulationOS,
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
			await sleep(RETRY_INITIAL_DELAY_MS * (attempt + 1));
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (!isRetryableNetworkError(err)) {
				throw err; // Non-retryable: fail fast
			}
			if (attempt < MAX_RETRIES) {
				await sleep(RETRY_INITIAL_DELAY_MS * (attempt + 1));
			}
		}
	}

	console.error(
		`[FETCH] All ${MAX_RETRIES + 1} attempts failed for ${url}: ${lastError?.message}`,
	);
	return null;
}

// ─── Smart fetch (bot protection fallback, secret scan) ────────────

export async function smartFetch(
	url: string,
	options: FetchOpts = {},
): Promise<{
	text: string;
	url: string;
	status: number;
	headers: { get(name: string): string | null };
} | null> {
	const rlHost = new URL(url).hostname;
	await getRateLimiter(rlHost).acquire();

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
		const pwHtml = await fetchWithPlaywright(url, options.browserPool);
		if (pwHtml) {
			return {
				text: pwHtml,
				url,
				status: 200,
				headers: { get: () => "text/html" } as {
					get(name: string): string | null;
					has?(name: string): boolean;
				},
			};
		}
		return null;
	}

	const text = await readResponseText(res);

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
		const headers = { ...buildHeaders(), ...options.headers };
		for (const fb of fallbackBrowsers) {
			const fbRes = await wreqFetch(url, {
				redirect: "follow",
				headers,
				browser: fb as BrowserProfile,
				os: (options.os ?? DEFAULT_OS) as EmulationOS,
				...(options.proxy ? { proxy: options.proxy } : {}),
			});
			if (fbRes?.ok) {
				const fbText = await readResponseText(fbRes);
				if (!detectBotBlock(fbText).blocked) {
					return {
						text: fbText,
						url: normalizeFetchedUrl(fbRes.url),
						status: fbRes.status,
						headers: fbRes.headers,
					};
				}
			}
		}
	}

	return {
		text,
		url: normalizeFetchedUrl(res.url),
		status: res.status,
		headers: res.headers,
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

	const arrayBuf = await res.arrayBuffer();
	return {
		buffer: Buffer.from(arrayBuf),
		url: normalizeFetchedUrl(res.url),
		status: res.status,
	};
}

// ─── Utility ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
