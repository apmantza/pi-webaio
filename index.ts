import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	readFileSync,
	readdirSync,
	statSync,
	openSync,
	readSync,
	closeSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { Type } from "typebox";
import { fetch as wreqFetch } from "wreq-js";
import {
	ensureChrome,
	googleSearch,
	summarizeUrl,
	cdpAvailable as cdpAvailableGA,
} from "./src/google-ai.js";

// ─── pdf-parse loose typing (CJS, no bundled .d.ts) ────────────────

const nodeRequire = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number }> =
	nodeRequire("pdf-parse");

// ─── Types ───────────────────────────────────────────────────────────

interface Page {
	url: string;
	title: string;
	markdown: string;
}

interface PullResult {
	ok: boolean;
	url: string;
	title?: string;
	content?: string;
	error?: string;
	/** Path to downloaded binary file (set for non-text downloads). */
	filePath?: string;
}

interface FetchOpts {
	browser?: string;
	os?: string;
	headers?: Record<string, string>;
}

interface StoredContent {
	url: string;
	title?: string;
	content: string;
	timestamp: number;
	/** Path to persisted markdown file on disk (for lazy-load across restarts). */
	filePath?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const IGNORED =
	/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|mp[34]|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i;

const NAV_SELECTORS = [
	"nav a[href]",
	"aside a[href]",
	'[class*="sidebar"] a[href]',
	'[class*="Sidebar"] a[href]',
	'[class*="navigation"] a[href]',
	'[class*="toc"] a[href]',
	'[class*="menu"] a[href]',
	'[role="navigation"] a[href]',
];

const MARKDOWN_SIGNAL = /^(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s|\[.+\]\(.+\))/m;
const DEFUDDLE_TIMEOUT = 8000;
const MAX_PREVIEW_CHARS = 1800; // ~500 tokens for tool result preview

const DEFAULT_BROWSER = "chrome_145";
const DEFAULT_OS = "windows";

const BASE_TEMP = join(tmpdir(), "pi-webaio");
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEARCH_CACHE_FILE = join(BASE_TEMP, "search-cache.json");

// Search context bridging: when webfetch follows a websearch, include the original query
// in the AI summarization prompt for more focused summaries
const SEARCH_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes
let lastSearchContext: { query: string; timestamp: number } | null = null;

// Bot protection markers
const BOT_PROTECTION_MARKERS = [
	"making sure you're not a bot",
	"protected by anubis",
	"anubis uses a proof-of-work",
	"checking your browser",
	"just a moment",
	"cf-browser-verification",
	"enable javascript and cookies to continue",
	"attention required",
	"verify you are human",
	"unusual traffic",
	"before you continue",
];

// ─── Retry configuration ─────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);
const RETRY_INITIAL_DELAY_MS = 1000;
const MAX_RETRIES = 2;

function isRetryableNetworkError(err: unknown): boolean {
	if (!(err instanceof Error || err instanceof TypeError)) return false;
	const msg = (err as Error).message || "";
	return (
		msg.includes("fetch failed") ||
		msg.includes("ECONNRESET") ||
		msg.includes("ETIMEDOUT") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("timeout")
	);
}

// ─── Rate limiter (token bucket per domain) ────────────────────────────

class TokenBucket {
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
}

const rateLimiters = new Map<string, TokenBucket>();

function getRateLimiter(host: string): TokenBucket {
	let limiter = rateLimiters.get(host);
	if (!limiter) {
		// 5 req/s per domain with burst of 10; webpull uses a stricter 2 req/s via its own instance
		limiter = new TokenBucket(10, 5);
		rateLimiters.set(host, limiter);
	}
	return limiter;
}

// ─── Session store ───────────────────────────────────────────────────

const sessionStore = new Map<string, StoredContent>();
const searchCache = new Map<
	string,
	{ query: string; results: SearchResult[]; timestamp: number }
>();

const SESSION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSION_CACHE_ENTRIES = 100;
const SESSION_CACHE_CLEANUP_MS = 5 * 60 * 1000; // 5 minutes

function normalizeCacheKey(url: string): string {
	if (url.startsWith("http://")) {
		url = url.replace(/^http:/i, "https:");
	}
	// Normalize root path trailing slash for consistent cache keys
	try {
		const u = new URL(url);
		if (u.pathname === "/" && url.endsWith("/")) {
			return url.slice(0, -1);
		}
	} catch {}
	return url;
}

function getStoredContent(url: string): StoredContent | null {
	const key = normalizeCacheKey(url);
	const entry = sessionStore.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > SESSION_CACHE_TTL_MS) {
		sessionStore.delete(key);
		return null;
	}
	// Lazy-load content from disk if entry has a filePath but no content loaded yet.
	if (!entry.content && entry.filePath) {
		try {
			const raw = readFileSync(entry.filePath, "utf8");
			entry.content = stripFrontmatter(raw);
		} catch {
			// File deleted or moved — treat as miss
			sessionStore.delete(key);
			return null;
		}
	}
	return entry;
}

/** Strip YAML frontmatter from markdown content, returning everything after `---\n`. */
function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---\n")) return raw;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return raw;
	return raw.slice(end + 5).trimStart();
}

/**
 * Parse YAML frontmatter to extract the `url:` value.
 * Returns null if no frontmatter or no url found.
 */
function parseFrontmatterUrl(raw: string): string | null {
	if (!raw.startsWith("---\n")) return null;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return null;
	const fm = raw.slice(4, end);
	const m = fm.match(/^url: "([^"]+)"$/m);
	return m ? m[1] : null;
}

function cleanupSessionCache(): void {
	const now = Date.now();
	for (const [url, entry] of sessionStore) {
		if (now - entry.timestamp > SESSION_CACHE_TTL_MS) {
			sessionStore.delete(url);
		}
	}
}

function storeContent(
	url: string,
	title: string | undefined,
	content: string,
	filePath?: string,
) {
	const key = normalizeCacheKey(url);
	// Enforce max size with simple LRU (delete oldest)
	while (sessionStore.size >= MAX_SESSION_CACHE_ENTRIES) {
		const first = sessionStore.keys().next().value;
		if (first !== undefined) sessionStore.delete(first);
	}
	sessionStore.set(key, {
		url,
		title,
		content,
		filePath,
		timestamp: Date.now(),
	});
}

/**
 * Scan BASE_TEMP for all .md files with YAML frontmatter and populate the
 * in-memory session store. Content is NOT loaded — we store only the file path
 * and lazy-load on first access via getStoredContent().
 */
async function loadContentCacheFromDisk(): Promise<void> {
	const root = BASE_TEMP;
	let entries = 0;

	function scan(dir: string): void {
		let items: string[];
		try {
			items = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of items) {
			const full = join(dir, name);
			try {
				const st = statSync(full);
				if (st.isDirectory()) {
					scan(full);
				} else if (name.endsWith(".md")) {
					// Peek at first ~500 bytes to extract frontmatter URL without reading whole file
					const fd = openSync(full, "r");
					try {
						const buf = Buffer.alloc(512);
						const bytesRead = readSync(fd, buf, 0, 512, 0);
						const head = buf.toString("utf8", 0, bytesRead);
						const fmUrl = parseFrontmatterUrl(head);
						if (fmUrl) {
							const key = normalizeCacheKey(fmUrl);
							if (!sessionStore.has(key)) {
								sessionStore.set(key, {
									url: fmUrl,
									content: "", // lazy-load
									filePath: full,
									timestamp: Date.now(),
								});
								entries++;
							}
						}
					} finally {
						closeSync(fd);
					}
				}
			} catch {
				// Skip files we can't read
			}
		}
	}

	scan(root);
	if (entries > 0) {
		console.log(`[pi-webaio] Loaded ${entries} cached pages from disk`);
	}
}

function storeSearchResults(query: string, results: SearchResult[]) {
	const entry = { query, results, timestamp: Date.now() };
	searchCache.set(query, entry);
	// Also save to disk for persistence across sessions
	saveSearchCacheToDisk().catch(() => {});
}

async function saveSearchCacheToDisk(): Promise<void> {
	try {
		const data = Object.fromEntries(searchCache.entries());
		await mkdir(BASE_TEMP, { recursive: true });
		await writeFile(SEARCH_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
	} catch {
		// ignore
	}
}

async function loadSearchCacheFromDisk(): Promise<void> {
	try {
		const text = await readFile(SEARCH_CACHE_FILE, "utf8");
		const data = JSON.parse(text);
		const now = Date.now();
		for (const [query, entry] of Object.entries(data)) {
			const e = entry as any;
			if (now - e.timestamp < SEARCH_CACHE_TTL_MS) {
				searchCache.set(query, e);
			}
		}
	} catch {
		// ignore
	}
}

function getCachedSearch(query: string): SearchResult[] | null {
	const cached = searchCache.get(query);
	if (!cached) return null;
	if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
		searchCache.delete(query);
		return null;
	}
	return cached.results;
}

// ─── Local / private URL detection ─────────────────────────────────

function isLocalOrPrivateUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const h = u.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]")
			return true;
		if (h.endsWith(".local")) return true;
		if (h.startsWith("192.168.") || h.startsWith("10.")) return true;
		if (h.startsWith("172.")) {
			const octet = Number.parseInt(h.split(".")[1] ?? "0", 10);
			if (octet >= 16 && octet <= 31) return true;
		}
		return false;
	} catch {
		return false;
	}
}

// ─── Smart fetch wrappers ────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
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
	};
}

// ─── Bot protection detection ──────────────────────────────────────

function isLikelyBotProtection(text: string): boolean {
	const t = String(text || "")
		.slice(0, 6000)
		.toLowerCase();
	return BOT_PROTECTION_MARKERS.some((m) => t.includes(m));
}

// ─── Secret scanning ───────────────────────────────────────────────

interface SecretMatch {
	type: string;
	pattern: RegExp;
}

const SECRET_PATTERNS: SecretMatch[] = [
	{ type: "AWS Access Key ID", pattern: /AKIA[0-9A-Z]{16}/ },
	{
		type: "AWS Secret Key",
		pattern:
			/(aws_?secret(_access)?_?key|secret_access_key|aws_secret_access_key)[=:/%22'_-]*[0-9a-zA-Z/+]{40}/i,
	},
	{ type: "GitHub PAT (classic)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
	{
		type: "GitHub PAT (fine-grained)",
		pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,
	},
	{ type: "GitHub OAuth", pattern: /gho_[a-zA-Z0-9]{36}/ },
	{ type: "GitHub App Token", pattern: /ghs_[a-zA-Z0-9]{36}/ },
	{ type: "GitLab PAT", pattern: /glpat-[a-zA-Z0-9-]{20,}/ },
	{ type: "npm Token", pattern: /npm_[a-zA-Z0-9]{36}/ },
	{ type: "PyPI Token", pattern: /pypi-[a-zA-Z0-9_-]{50,}/ },
	{
		type: "Slack Bot Token",
		pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/,
	},
	{ type: "Stripe Live Key", pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
	{ type: "Stripe Test Key", pattern: /sk_test_[a-zA-Z0-9]{24,}/ },
	{ type: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
	{
		type: "SendGrid API Key",
		pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/,
	},
	{ type: "DigitalOcean PAT", pattern: /dop_v1_[a-f0-9]{64}/ },
	{ type: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9]{48}/ },
	{ type: "Anthropic API Key", pattern: /sk-ant-api03-[a-zA-Z0-9_-]{95,}/ },
	{
		type: "Private Key",
		pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
	},
	// [^\s:@] excludes @ from username; [^\s@] excludes @ from password.
	// The two character classes are distinct by design (not duplicates).
	{ type: "Password in URL", pattern: /:\/\/[^\s:@]+:([^\s@]+)@/ },
];

function scanForSecrets(text: string): { found: boolean; matches: string[] } {
	const matches: string[] = [];
	for (const { type, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			matches.push(type);
		}
	}
	return { found: matches.length > 0, matches };
}

// ─── Prompt injection detection ────────────────────────────────────

// Guard against catastrophic backtracking: truncate inputs to a safe
// length before running regex tests. All INJECTION_PATTERNS are
// designed for short text segments (titles, snippets, page content).
const SAFE_REGEX_MAX_INPUT = 10000;

function safeRegexTest(pattern: RegExp, text: string): boolean {
	// Truncate to bound worst-case backtracking
	const safe =
		text.length > SAFE_REGEX_MAX_INPUT
			? text.slice(0, SAFE_REGEX_MAX_INPUT)
			: text;
	return pattern.test(safe);
}

const INJECTION_PATTERNS = [
	// Instruction override (split to reduce regex complexity below 20)
	/ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+instructions?/i,
	/ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+prompts?/i,
	/ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(rules?|guidelines?|directions?|commands?)/i,
	/disregard\s+(all\s+)?(previous|prior|earlier|above|preceding)/i,
	/forget\s+(everything\s+)?(above|before|prior|previous|earlier)/i,
	/override\s+(all\s+)?(previous|prior|earlier)/i,
	/new\s+instructions?\s*[:=]/i,
	/actual\s+instructions?\s*[:=]/i,
	/real\s+instructions?\s*[:=]/i,
	// Role injection
	/you\s+are\s+now\s+/i,
	/from\s+now\s+on\s*[,:]?\s*(you|your)/i,
	/act\s+as(\s+if)?(\s+you)?(\s+(are|were))?/i,
	/pretend\s+(to\s+be|you\s+are|you're|that\s+you)/i,
	/roleplay\s+as/i,
	/behave\s+(like|as)\s+(a|an)/i,
	/assume\s+the\s+(role|identity|persona)/i,
	// System manipulation
	/(admin|administrator|developer|god|sudo|root|maintenance|debug)\s+mode/i,
	/system\s+(override|prompt|instruction|message|command)/i,
	/unlock\s+(all\s+)?(restrictions?|capabilities?|features?|access)/i,
	/disable\s+(all\s+)?(safety|security|content\s+)?(filters?|guards?|restrictions?|limits?)/i,
	/bypass\s+(all\s+)?(restrictions?|filters?|safety|security|limits?)/i,
	/enable\s+(unrestricted|unlimited|full)\s+(mode|access)/i,
	/remove\s+(all\s+)?(limitations?|restrictions?|filters?)/i,
	/turn\s+off\s+(safety|security|content)?\s*(filters?|checks?|restrictions?)/i,
	// Prompt leak
	/reveal\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
	/show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
	/what\s+(are|is|were)\s+(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
	/(print|display|output|echo|write|repeat)\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
	/(initial|original|hidden|secret|base)\s+(prompt|instructions?|directives?)/i,
	// Jailbreak keywords
	/\bDAN\b/,
	/\bjailbreak(ed|ing)?\b/i,
	/do\s+anything\s+now/i,
	/(evil|dark|shadow|unrestricted|unfiltered)\s+(mode|assistant|ai|version)/i,
	/chaos\s+mode/i,
	/maximum\s+freedom/i,
	/no\s+censorship/i,
	/uncensored\s+(mode|response|version)/i,
	/(bypass|skip|avoid)\s+(all\s+)?safeguards?/i,
	// Encoding markers
	/base64\s*[:=]/i,
	/encoded\s+(message|instruction|prompt)/i,
	/\\x[0-9a-fA-F]{2}/,
	/&#[0-9a-fA-F]+;/,
	/%[0-9a-fA-F]{2}/,
	/\\u[0-9a-fA-F]{4}/,
	// Suspicious delimiters
	/\[\s*system\s*\]/i,
	/\[\s*instructions?\s*\]/i,
	/\[\s*admin\s*\]/i,
	/<\|?\s*(system|instruction|user|assistant)\s*\|?>/i,
	/###\s*(system|instruction|new\s+task)/i,
];

interface InjectionResult {
	detected: boolean;
	categories: string[];
	action: "warn" | "redact" | "tag" | "none";
}

function detectPromptInjection(
	text: string,
	action: "warn" | "redact" | "tag" | "none" = "warn",
): InjectionResult {
	if (action === "none") {
		return { detected: false, categories: [], action };
	}

	const categories: string[] = [];

	for (const pattern of INJECTION_PATTERNS) {
		if (safeRegexTest(pattern, text)) {
			// Categorize based on pattern source
			const patStr = pattern.source.toLowerCase();
			if (
				patStr.includes("ignore") ||
				patStr.includes("disregard") ||
				patStr.includes("override")
			) {
				if (!categories.includes("instruction_override"))
					categories.push("instruction_override");
			} else if (
				patStr.includes("you\\s+are") ||
				patStr.includes("from\\s+now") ||
				patStr.includes("act\\s+as") ||
				patStr.includes("pretend") ||
				patStr.includes("roleplay") ||
				patStr.includes("behave") ||
				patStr.includes("assume")
			) {
				if (!categories.includes("role_injection"))
					categories.push("role_injection");
			} else if (
				patStr.includes("reveal") ||
				patStr.includes("show") ||
				patStr.includes("prompt")
			) {
				if (!categories.includes("prompt_leak")) categories.push("prompt_leak");
			} else if (
				patStr.includes("base64") ||
				patStr.includes("encoded") ||
				patStr.includes("\\x")
			) {
				if (!categories.includes("encoding")) categories.push("encoding");
			} else if (
				patStr.includes("\\[") ||
				patStr.includes("###") ||
				patStr.includes("<\\|")
			) {
				if (!categories.includes("suspicious_delimiters"))
					categories.push("suspicious_delimiters");
			} else if (
				patStr.includes("admin") ||
				patStr.includes("system") ||
				patStr.includes("unlock") ||
				patStr.includes("disable") ||
				patStr.includes("bypass")
			) {
				if (!categories.includes("system_manipulation"))
					categories.push("system_manipulation");
			} else if (
				patStr.includes("jailbreak") ||
				patStr.includes("dan") ||
				patStr.includes("evil") ||
				patStr.includes("chaos") ||
				patStr.includes("censorship")
			) {
				if (!categories.includes("jailbreak")) categories.push("jailbreak");
			}
		}
	}

	return {
		detected: categories.length > 0,
		categories,
		action,
	};
}

function applyInjectionAction(text: string, result: InjectionResult): string {
	if (!result.detected) return text;

	switch (result.action) {
		case "redact": {
			// Mask matched patterns with █. Truncate input to bound regex runtime.
			const safeText =
				text.length > SAFE_REGEX_MAX_INPUT
					? text.slice(0, SAFE_REGEX_MAX_INPUT)
					: text;
			let redacted = safeText;
			for (const pattern of INJECTION_PATTERNS) {
				redacted = redacted.replace(pattern, (match) =>
					"█".repeat(match.length),
				);
			}
			return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}. Content redacted.]\n\n${redacted}`;
		}
		case "tag":
			return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}]\n\n<untrusted>\n${text}\n</untrusted>`;
		case "warn":
		default:
			return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}. Review with caution.]\n\n<suspected-prompt-injection>\n${text}\n</suspected-prompt-injection>`;
	}
}

async function fetchWithRetry(
	url: string,
	options: FetchOpts = {},
): Promise<any | null> {
	const headers = { ...buildHeaders(), ...options.headers };

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			let res: any;
			if (isLocalOrPrivateUrl(url)) {
				res = await fetch(url, { redirect: "follow", headers });
			} else {
				const browser = (options.browser as any) ?? DEFAULT_BROWSER;
				const os = (options.os as any) ?? DEFAULT_OS;
				res = await wreqFetch(url, {
					redirect: "follow",
					headers,
					browser,
					os,
				});
			}

			// Non-retryable status: fail immediately
			if (NON_RETRYABLE_STATUS_CODES.has(res.status)) {
				return null;
			}

			// Retryable status: wait and retry
			if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_RETRIES) {
				const delayMs = RETRY_INITIAL_DELAY_MS * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}

			// Other non-ok status after retries: fail
			if (!res.ok) {
				return null;
			}

			return res;
		} catch (err: any) {
			if (isRetryableNetworkError(err) && attempt < MAX_RETRIES) {
				const delayMs = RETRY_INITIAL_DELAY_MS * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}
			return null;
		}
	}
	return null;
}

function normalizeFetchedUrl(url: string): string {
	return url.startsWith("http://") ? url.replace(/^http:/i, "https:") : url;
}

// ─── Playwright fallback (JS-rendered pages) ───────────────────────

async function fetchWithPlaywright(url: string): Promise<string | null> {
	try {
		const { chromium } = await import("playwright");
		// Try system Chrome first (zero setup), then Playwright's bundled Chromium
		for (const opts of [{ channel: "chrome" as const }, {}]) {
			try {
				const browser = await chromium.launch({
					...opts,
					headless: true,
				});
				const page = await browser.newPage();
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 15000,
				});
				const content = await page.content();
				await browser.close();
				return content;
			} catch {}
		}
	} catch {
		// Playwright not installed — skip gracefully
	}
	return null;
}

async function smartFetch(
	url: string,
	options: FetchOpts = {},
): Promise<{
	text: string;
	url: string;
	status: number;
	headers: { get(name: string): string | null };
} | null> {
	// Rate limit — 5 req/s per domain with burst of 10
	const rlHost = new URL(url).hostname;
	await getRateLimiter(rlHost).acquire();

	// HTTP→HTTPS auto-upgrade
	if (url.startsWith("http://")) {
		url = "https://" + url.slice(7);
	}

	// Secret scanning — block requests containing API keys/tokens in URL
	const secretScan = scanForSecrets(url);
	if (secretScan.found) {
		console.error(
			`[SECURITY] Blocked request to ${url}: potential secrets detected (${secretScan.matches.join(", ")})`,
		);
		return null;
	}

	const res = await fetchWithRetry(url, options);
	if (!res) {
		// Last resort: try Playwright for JS-rendered pages
		const pwHtml = await fetchWithPlaywright(url);
		if (pwHtml) {
			return {
				text: pwHtml,
				url,
				status: 200,
				headers: { get: () => "text/html" } as any,
			};
		}
		return null;
	}

	const text = await res.text();

	// Bot protection fallback: try alternate browser profiles
	if (isLikelyBotProtection(text)) {
		const fallbackBrowsers = ["firefox_147", "safari_26", "edge_145"];
		const headers = { ...buildHeaders(), ...options.headers };
		for (const fb of fallbackBrowsers) {
			const fbRes = await wreqFetch(url, {
				redirect: "follow",
				headers,
				browser: fb as any,
				os: (options.os as any) ?? DEFAULT_OS,
			});
			if (fbRes?.ok) {
				const fbText = await fbRes.text();
				if (!isLikelyBotProtection(fbText)) {
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

async function fetchBuffer(
	url: string,
	options: FetchOpts = {},
): Promise<{ buffer: Buffer; url: string; status: number } | null> {
	// HTTP→HTTPS auto-upgrade
	if (url.startsWith("http://")) {
		url = "https://" + url.slice(7);
	}

	// Secret scanning — block requests containing API keys/tokens in URL
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

// ─── Discovery ───────────────────────────────────────────────────────

async function tryFetch(
	url: string,
	opts?: FetchOpts,
): Promise<{ text: string; url: string } | null> {
	const r = await smartFetch(url, opts);
	return r?.status && r.status < 400 ? { text: r.text, url: r.url } : null;
}

function parseLocs(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi)].map((m) =>
		m[1]!.trim(),
	);
}

async function fetchSitemap(url: string, depth = 0): Promise<string[]> {
	if (depth > 3) return [];
	const r = await tryFetch(url);
	if (!r?.text.includes("<")) return [];
	const locs = parseLocs(r.text);
	const isIndex =
		r.text.includes("<sitemapindex") ||
		(r.text.includes("<sitemap>") && !r.text.includes("<urlset"));
	if (isIndex) {
		const nested = await Promise.all(
			locs.map((u) => fetchSitemap(u, depth + 1)),
		);
		return nested.flat();
	}
	return locs;
}

async function sitemapFromRobots(origin: string): Promise<string[]> {
	const r = await tryFetch(`${origin}/robots.txt`);
	if (!r) return [];
	const urls = (r.text.match(/^Sitemap:\s*(.+)$/gim) ?? []).map((l) =>
		l.replace(/^Sitemap:\s*/i, "").trim(),
	);
	if (!urls.length) return [];
	const results = await Promise.all(urls.map((u) => fetchSitemap(u)));
	return results.flat();
}

function extractNav(base: URL, html: string): string[] {
	const { document } = parseHTML(html);
	const urls = new Set<string>();
	for (const sel of NAV_SELECTORS) {
		for (const link of document.querySelectorAll(sel)) {
			const href = link.getAttribute("href");
			if (
				!href ||
				href.startsWith("#") ||
				href.startsWith("javascript:") ||
				href.startsWith("data:") ||
				href.startsWith("vbscript:") ||
				href.startsWith("mailto:")
			)
				continue;
			try {
				const r = new URL(href, base);
				r.hash = r.search = "";
				if (!IGNORED.test(r.pathname)) urls.add(r.href);
			} catch {}
		}
	}
	urls.add(base.href);
	return [...urls];
}

function extractLinks(
	html: string,
	base: URL,
	visited: Set<string>,
	scope: string,
): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/href=["'](.*?)["']/gi)) {
		try {
			const r = new URL(m[1]!, base);
			r.hash = r.search = "";
			if (
				r.hostname === base.hostname &&
				r.pathname.startsWith(scope) &&
				!IGNORED.test(r.pathname) &&
				!visited.has(r.href)
			)
				out.push(r.href);
		} catch {}
	}
	return [...new Set(out)];
}

async function crawl(
	base: URL,
	max: number,
	scope: string,
	opts?: FetchOpts,
): Promise<string[]> {
	const visited = new Set<string>();
	const queue = [base.href];
	const found: string[] = [];

	while (queue.length > 0 && found.length < max) {
		const batch = queue
			.splice(0, Math.min(20, max - found.length))
			.filter((u) => !visited.has(u));
		for (const u of batch) visited.add(u);

		const results = await Promise.all(
			batch.map(async (url) => {
				const r = await tryFetch(url, opts);
				if (!r?.text.includes("</html")) return [];
				found.push(r.url);
				return extractLinks(r.text, base, visited, scope);
			}),
		);

		for (const links of results) {
			for (const link of links) {
				if (!visited.has(link) && found.length + queue.length < max)
					queue.push(link);
			}
		}
	}
	return found;
}

function getScopePath(pathname: string): string {
	if (pathname === "/") return "/";
	if (/\.\w+$/.test(pathname)) return pathname.replace(/\/[^/]*$/, "/");
	if (pathname.endsWith("/")) return pathname;
	const segs = pathname.split("/").filter(Boolean);
	return segs.length <= 1 ? pathname : `/${segs.slice(0, -1).join("/")}/`;
}

function filterAndDedupe(
	urls: string[],
	hosts: Set<string>,
	scope: string,
	max: number,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of urls) {
		try {
			const u = new URL(raw);
			if (
				!hosts.has(u.hostname) ||
				!u.pathname.startsWith(scope) ||
				IGNORED.test(u.pathname)
			)
				continue;
			u.hash = u.search = "";
			if (!seen.has(u.pathname)) {
				seen.add(u.pathname);
				out.push(u.href);
			}
		} catch {}
	}
	return out.slice(0, max);
}

async function discover(
	baseUrl: string,
	max: number,
	opts?: FetchOpts,
): Promise<string[]> {
	const r = await smartFetch(baseUrl, opts);
	if (!r || r.status >= 400)
		throw new Error(`HTTP ${r?.status ?? "unknown"}: ${baseUrl}`);

	const actual = new URL(r.url);
	const original = new URL(baseUrl);
	const html = r.text;

	const hosts = new Set([original.hostname, actual.hostname]);
	const scope = getScopePath(actual.pathname);

	const origins = [...new Set([original.origin, actual.origin])];
	const basePaths = [
		...new Set([actual.pathname.replace(/\/[^/]*$/, "/"), "/"]),
	];

	const strategies: Promise<string[]>[] = [];
	for (const o of origins) {
		strategies.push(sitemapFromRobots(o));
		for (const bp of basePaths) {
			for (const name of [
				"sitemap.xml",
				"sitemap_index.xml",
				"sitemap-0.xml",
			]) {
				strategies.push(fetchSitemap(`${o}${bp}${name}`));
			}
		}
	}

	const results = await Promise.all(strategies);

	let best: string[] = [];
	for (const urls of results) {
		if (!urls.length) continue;
		for (const u of urls) {
			try {
				hosts.add(new URL(u).hostname);
			} catch {}
		}
		const filtered = filterAndDedupe(urls, hosts, scope, max);
		if (filtered.length > best.length) best = filtered;
	}

	if (best.length > 0) return best;

	const nav = extractNav(actual, html);
	if (nav.length > 5) {
		const filtered = filterAndDedupe(nav, hosts, scope, max);
		if (filtered.length > 0) return filtered;
	}

	return crawl(actual, max, scope, opts);
}

// ─── Web Search ────────────────────────────────────────────────────

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function extractDdgUrl(href: string): string {
	try {
		const u = new URL(href, "https://duckduckgo.com");
		const real = u.searchParams.get("uddg");
		if (real) return decodeURIComponent(real);
	} catch {}
	return href;
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];

	for (const el of document.querySelectorAll(".result")) {
		const a = el.querySelector(".result__a");
		const snippet = el.querySelector(".result__snippet");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const url = extractDdgUrl(rawUrl);
		const title = a.textContent?.trim() || "";
		const text = snippet?.textContent?.trim() || "";
		if (url && title) {
			results.push({ title, url, snippet: text });
		}
	}
	return results;
}

function parseBraveResults(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// Brave's search page uses Svelte-scoped CSS classes that linkedom
	// can't query reliably. Instead, find each data-type="web" snippet div
	// by tracking DOM nesting depth, then extract fields with regex on raw HTML.

	let pos = 0;
	while (pos < html.length) {
		// Find the next web result snippet div
		const dataAttr = html.indexOf('data-type="web"', pos);
		if (dataAttr === -1) break;

		// Walk back to the opening <div
		const divStart = html.lastIndexOf("<div", dataAttr);
		if (divStart === -1) {
			pos = dataAttr + 1;
			continue;
		}

		// Track nesting depth to find the matching closing </div>
		let depth = 0;
		let divEnd = -1;
		for (let i = divStart + 4; i < html.length; i++) {
			if (html.slice(i, i + 4) === "<div") {
				depth++;
				i += 3;
			}
			if (html.slice(i, i + 5) === "</div") {
				if (depth === 0) {
					divEnd = i + 5;
					break;
				}
				depth--;
				i += 4;
			}
		}

		if (divEnd === -1) {
			pos = dataAttr + 1;
			continue;
		}

		const block = html.slice(divStart, divEnd + 1);

		// Extract URL from first <a href="...">
		const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
		if (!urlMatch) {
			pos = divEnd + 1;
			continue;
		}
		const url = urlMatch[1]!;

		// Extract title from search-snippet-title div
		const titleMatch = block.match(/search-snippet-title[^>]*>([^<]+)<\/div>/);
		const title =
			titleMatch?.[1]?.trim() ||
			block.match(/title="([^"]+)"/)?.[1]?.trim() ||
			"";

		// Extract description from generic-snippet > .content
		// Scope to content div inside generic-snippet to avoid matching
		// the outer result-content wrapper.
		const gsMatch = block.match(
			/generic-snippet[^>]*>[\s\S]*?content[^>]*>([\s\S]*?)<\/div>/,
		);
		const snippet = gsMatch
			? gsMatch[1]!
					.replace(/<![^>]*-->/g, "") // strip Svelte comments
					.replace(/<[^>]+>/g, "") // strip remaining HTML tags
					.replace(/\s+/g, " ")
					.trim()
			: "";

		if (url && title) {
			results.push({ title, url, snippet });
		}

		pos = divEnd + 1;
	}

	return results;
}

async function searchWeb(
	query: string,
): Promise<{ results: SearchResult[]; ddgCount: number; braveCount: number }> {
	// Check in-memory cache first
	const cached = getCachedSearch(query);
	if (cached)
		return { results: cached, ddgCount: cached.length, braveCount: 0 };

	const encoded = encodeURIComponent(query);

	// Run DDG + Brave in parallel
	const commonHeaders = {
		Accept: "text/html",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
	};

	const [ddg, brave] = await Promise.all([
		smartFetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
			headers: commonHeaders,
		}),
		smartFetch(`https://search.brave.com/search?q=${encoded}`, {
			headers: commonHeaders,
		}),
	]);

	// Parse both results
	let ddgResults: SearchResult[] = [];
	if (ddg && ddg.status < 400) {
		ddgResults = parseDuckDuckGoResults(ddg.text);
	}

	let braveResults: SearchResult[] = [];
	if (brave && brave.status < 400) {
		braveResults = parseBraveResults(brave.text);
	}

	// Merge & deduplicate by URL
	const seen = new Set<string>();
	const merged: SearchResult[] = [];
	for (const r of [...ddgResults, ...braveResults]) {
		if (seen.has(r.url)) continue;
		seen.add(r.url);
		merged.push(r);
	}

	if (merged.length > 0) {
		storeSearchResults(query, merged);
	}
	return {
		results: merged,
		ddgCount: ddgResults.length,
		braveCount: braveResults.length,
	};
}

// ─── GitHub-aware fetch ─────────────────────────────────────────────

interface GitHubRef {
	owner: string;
	repo: string;
	ref?: string;
	path?: string;
	type: "repo" | "tree" | "blob";
}

// URL length is bounded (typically <200 chars, always <2000).
// The regex uses nested optional groups for URL structure matching;
// catastrophic backtracking is not a concern on short URL strings.
function parseGitHubUrl(url: string): GitHubRef | null {
	const m = url.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?(?:\/(?!tree\/|blob\/)(.*))?/i,
	);
	if (!m) return null;
	const [, owner, repo, ghType, ref, path, extra] = m;

	// Non-tree/non-blob path after repo (e.g. /issues, /security/code-scanning)
	// → don't treat as a repo; let the regular web fetch pipeline handle it
	if (!ghType && extra) return null;

	if (ghType === "blob") return { owner, repo, ref, path, type: "blob" };
	if (ghType === "tree") return { owner, repo, ref, path, type: "tree" };
	return { owner, repo, type: "repo" };
}

// Map GitHub URL paths → REST API endpoints (gh api format with {owner}/{repo} placeholders)
// gh api expands {owner}/{repo}/{branch} from the current repo context.
// We use explicit /repos/:owner/:repo paths since we're not in a git repo.
const GH_FEATURE_API_MAP: Record<string, string> = {
	// Issues & PRs
	issues: "/issues?state=all&per_page=20",
	pulls: "/pulls?state=all&per_page=20",

	// Actions
	actions: "/actions/runs?per_page=20",

	// Security
	"code-scanning": "/code-scanning/alerts?state=open&per_page=30",
	"secret-scanning": "/secret-scanning/alerts?state=open&per_page=30",
	dependabot: "/dependabot/alerts?state=open&per_page=30",

	// Releases & tags
	releases: "/releases?per_page=20",
	tags: "/tags?per_page=30",

	// Repo info
	branches: "/branches?per_page=30",
	commits: "/commits?per_page=20",
	forks: "/forks?per_page=20",
	stargazers: "/stargazers?per_page=20",
	watchers: "/subscribers?per_page=20",
	contributors: "/contributors?per_page=20",
	labels: "/labels?per_page=30",
	milestones: "/milestones?per_page=20",
	projects: "/projects?per_page=20",
	deployments: "/deployments?per_page=20",

	// Not available via REST API (GraphQL or no API)
	// discussions, wiki, settings, network, community, graphs
};

// Feature pages where gh has a dedicated subcommand (better than raw API)
const GH_NATIVE_COMMANDS: Record<
	string,
	{ cmd: string; args: string[]; formatter: string }
> = {
	issues: {
		cmd: "issue",
		args: ["list", "--state", "all", "--limit", "20"],
		formatter: "--json",
	},
	pulls: {
		cmd: "pr",
		args: ["list", "--state", "all", "--limit", "20"],
		formatter: "--json",
	},
	actions: {
		cmd: "run",
		args: ["list", "--limit", "20"],
		formatter: "--json",
	},
	releases: {
		cmd: "release",
		args: ["list", "--limit", "20"],
		formatter: "--json",
	},
};

async function pullGitHub(url: string): Promise<PullResult | null> {
	// Try standard GitHub pipeline (tree/blob/repo)
	const ref = parseGitHubUrl(url);
	if (ref) {
		return pullGitHubRef(ref);
	}

	// Feature page? Try gh api if available
	if (ghAvailable()) {
		const featureResult = await pullGitHubFeature(url);
		if (featureResult) return featureResult;
	}

	return null;
}

async function pullGitHubRef(ref: GitHubRef): Promise<PullResult | null> {
	switch (ref.type) {
		case "blob":
			return fetchGitHubRaw(
				ref.owner,
				ref.repo,
				ref.ref || "main",
				ref.path || "",
			);
		case "tree":
			return fetchGitHubTree(ref);
		case "repo":
			return fetchGitHubRepo(ref);
	}
}

async function pullGitHubFeature(url: string): Promise<PullResult | null> {
	try {
		const u = new URL(url);
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 3) return null;

		const [owner, repo, feature, ...rest] = parts;
		const baseRepoPath = `/repos/${owner}/${repo}`;
		const fullRepo = `${owner}/${repo}`;

		let apiPath: string | null = null;
		let useNativeCommand: (typeof GH_NATIVE_COMMANDS)[string] | null = null;
		let featureLabel = feature;

		// ── Handle /security sub-pages ──
		if (feature === "security" && rest[0]) {
			const sub = rest[0];
			featureLabel = `security/${sub}`;
			const mapped = GH_FEATURE_API_MAP[sub];
			if (mapped) apiPath = `${baseRepoPath}${mapped}`;
		}
		// ── Handle /pull/123 or /issues/123 (single item) ──
		else if ((feature === "pull" || feature === "issues") && rest[0]) {
			const id = rest[0];
			featureLabel = `${feature}/${id}`;
			const endpoint = feature === "pull" ? "pulls" : "issues";
			apiPath = `${baseRepoPath}/${endpoint}/${id}`;
		}
		// ── Handle /commit/SHA ──
		else if (feature === "commit" && rest[0]) {
			featureLabel = `commit/${rest[0].slice(0, 7)}`;
			apiPath = `${baseRepoPath}/commits/${rest[0]}`;
		}
		// ── Handle /releases/tag/v1.0 ──
		else if (feature === "releases" && rest[0] === "tag" && rest[1]) {
			featureLabel = `release/${rest[1]}`;
			apiPath = `${baseRepoPath}/releases/tags/${rest[1]}`;
		}
		// ── Handle /actions/runs/123 ──
		else if (feature === "actions" && rest[0] === "runs" && rest[1]) {
			featureLabel = `actions/run/${rest[1]}`;
			apiPath = `${baseRepoPath}/actions/runs/${rest[1]}`;
		}
		// ── Handle /commits/branch ──
		else if (feature === "commits" && rest[0]) {
			featureLabel = `commits/${rest[0]}`;
			apiPath = `${baseRepoPath}/commits?sha=${rest[0]}&per_page=20`;
		}
		// ── Standard feature pages ──
		else {
			const mapped = GH_FEATURE_API_MAP[feature];
			if (mapped !== undefined) {
				apiPath = `${baseRepoPath}${mapped}`;
				// Check for native gh command
				if (GH_NATIVE_COMMANDS[feature]) {
					useNativeCommand = GH_NATIVE_COMMANDS[feature];
				}
			}
		}

		if (!apiPath) return null;

		let raw: string;
		try {
			if (useNativeCommand) {
				// Use gh subcommand (e.g. gh issue list --repo owner/repo)
				raw = await ghCommand(useNativeCommand.cmd, [
					...useNativeCommand.args,
					"--repo",
					fullRepo,
					useNativeCommand.formatter,
					"number,title,state,url",
				]);
			} else {
				raw = await ghApi(apiPath);
			}
		} catch (err: any) {
			// gh failed (not logged in, rate limited, etc.) → web fetch
			return null;
		}

		const data = JSON.parse(raw);

		let md = `# ${owner}/${repo} — ${featureLabel}\n\n`;
		md += `> via gh api\n\n`;

		if (Array.isArray(data)) {
			const items = data.slice(0, 20);
			if (!items.length) {
				md += "_(no items found)_\n";
			} else {
				for (const item of items) {
					const title =
						item.title ||
						item.name ||
						item.display_title ||
						item.headline ||
						"";
					const state = item.state ? ` _${item.state}_` : "";
					const number = item.number ? `#${item.number}` : "";
					const link = item.html_url || "";
					const label = item.rule?.description || item.severity || "";
					const extra = label ? ` (${label})` : "";
					const linkLabel = link ? ` — [view](${link})` : "";
					md += `- ${number}${state} ${title}${extra}${linkLabel}\n`;
				}
			}
		} else if (typeof data === "object" && data !== null) {
			// Single item (e.g. single issue, single commit)
			const title = data.title || data.commit?.message?.split("\n")[0] || "";
			const state = data.state ? ` _${data.state}_` : "";
			const link = data.html_url || "";
			if (title) md += `${state} ${title}\n`;
			if (link) md += `\n[View on GitHub](${link})\n`;
			// Include body/description for single items
			const body = data.body || data.description || "";
			if (body) md += `\n${body.slice(0, 2000)}\n`;
		} else {
			md += `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
		}

		return {
			ok: true,
			url,
			title: `${owner}/${repo} — ${featureLabel}`,
			content: md,
		};
	} catch {
		return null;
	}
}

/** Spawn gh with a subcommand (e.g. gh issue list --repo owner/repo --json ...) */
function ghCommand(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("gh", [cmd, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		proc.stdout.on("data", (d: Buffer) => (out += d));
		proc.stderr.on("data", (d: Buffer) => (err += d));
		proc.on("close", (code: number) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(err.trim() || `gh ${cmd} exit ${code}`));
		});
		proc.on("error", reject);
	});
}

/** Spawn gh api (generic REST API call) */
function ghApi(path: string): Promise<string> {
	return ghCommand("api", [
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version: 2022-11-28",
		path,
	]);
}

async function githubApiFetch(path: string): Promise<unknown | null> {
	// Try gh CLI first (authenticated: 5000 req/hr, private repos)
	if (ghAvailable()) {
		try {
			const out = await ghApi(path);
			return JSON.parse(out);
		} catch {
			// Fall through to unauthenticated API
		}
	}

	const res = await smartFetch(`https://api.github.com${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "pi-webaio",
		},
	});
	if (!res || res.status >= 400) return null;
	try {
		return JSON.parse(res.text);
	} catch {
		return null;
	}
}

let _ghAvailable: boolean | null = null;
function ghAvailable(): boolean {
	if (_ghAvailable !== null) return _ghAvailable;
	try {
		// Check if gh CLI is installed. PATH is inherited from the trusted
		// system environment where the user invoked pi.
		execSync("gh --version", { stdio: "ignore" });
		_ghAvailable = true;
	} catch {
		_ghAvailable = false;
	}
	return _ghAvailable;
}

async function fetchGitHubRaw(
	owner: string,
	repo: string,
	ref: string,
	path: string,
): Promise<PullResult> {
	const branches = [ref, "main", "master"];
	for (const b of branches) {
		const res = await smartFetch(
			`https://raw.githubusercontent.com/${owner}/${repo}/${b}/${path}`,
		);
		if (res?.status && res.status < 400) {
			return {
				ok: true,
				url: `https://github.com/${owner}/${repo}/blob/${b}/${path}`,
				title: path.split("/").pop() || path,
				content: res.text,
			};
		}
	}
	return {
		ok: false,
		url: `https://github.com/${owner}/${repo}`,
		error: `Raw file not found: ${path}`,
	};
}

async function fetchGitHubTree(ref: GitHubRef): Promise<PullResult> {
	const { owner, repo, ref: branch, path = "" } = ref;
	const apiPath = path
		? `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch || "main"}`
		: `/repos/${owner}/${repo}/contents`;

	const data = await githubApiFetch(apiPath);
	if (!data)
		return { ok: false, url: ref.toString(), error: "GitHub API failed" };

	if (!Array.isArray(data)) {
		return fetchGitHubRaw(owner, repo, branch || "main", path);
	}

	const pathSuffix = path ? `/${path}` : "";
	let md = `# ${owner}/${repo}${pathSuffix}\n\n`;
	md += `## Directory Contents\n\n`;

	for (const item of data as any[]) {
		const icon = item.type === "dir" ? "📁" : "📄";
		md += `- ${icon} [${item.name}](${item.html_url})\n`;
	}

	const readmeItem = (data as any[]).find(
		(i: any) => i.type === "file" && /^readme\.md$/i.test(i.name),
	);
	if (readmeItem?.download_url) {
		const r = await smartFetch(readmeItem.download_url);
		if (r?.status && r.status < 400) {
			md += `\n---\n\n## README\n\n${r.text}\n`;
		}
	}

	const treeUrl = path ? `/tree/${branch}/${path}` : "";
	return {
		ok: true,
		url: `https://github.com/${owner}/${repo}${treeUrl}`,
		title: `${owner}/${repo}`,
		content: md,
	};
}

async function cloneGitHubRepo(
	owner: string,
	repo: string,
	outDir: string,
): Promise<{ ok: boolean; path: string; error?: string }> {
	try {
		await mkdir(outDir, { recursive: true });

		// Prefer gh CLI (handles auth, private repos)
		if (ghAvailable()) {
			await new Promise<void>((resolve, reject) => {
				const proc = spawn(
					"gh",
					["repo", "clone", `${owner}/${repo}`, outDir, "--", "--depth", "1"],
					{
						stdio: "pipe",
					},
				);
				let stderr = "";
				proc.stderr.on("data", (d: Buffer) => (stderr += d));
				proc.on("close", (code: number) => {
					if (code === 0) resolve();
					else reject(new Error(stderr || `gh repo clone exit ${code}`));
				});
				proc.on("error", reject);
			});
			return { ok: true, path: outDir };
		}

		// Fallback: git clone
		const cloneUrl = `https://github.com/${owner}/${repo}.git`;
		await new Promise<void>((resolve, reject) => {
			const proc = spawn("git", ["clone", "--depth", "1", cloneUrl, outDir], {
				stdio: "pipe",
			});
			let stderr = "";
			proc.stderr.on("data", (d: Buffer) => (stderr += d));
			proc.on("close", (code: number) => {
				if (code === 0) resolve();
				else reject(new Error(stderr || `git clone exited with ${code}`));
			});
			proc.on("error", reject);
		});
		return { ok: true, path: outDir };
	} catch (err: any) {
		return { ok: false, path: outDir, error: err?.message ?? "Clone failed" };
	}
}

async function buildRepoMarkdown(outDir: string): Promise<string> {
	// Build a file tree and include README
	const { readdir } = await import("node:fs/promises");

	async function tree(dir: string, prefix = ""): Promise<string> {
		const entries = await readdir(dir, { withFileTypes: true });
		const lines: string[] = [];
		const sorted = entries
			.filter((e) => !e.name.startsWith("."))
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			});
		for (let i = 0; i < sorted.length; i++) {
			const e = sorted[i]!;
			const isLast = i === sorted.length - 1;
			const branch = isLast ? "└── " : "├── ";
			lines.push(`${prefix}${branch}${e.name}`);
			if (e.isDirectory()) {
				const ext = isLast ? "    " : "│   ";
				lines.push(await tree(join(dir, e.name), prefix + ext));
			}
		}
		return lines.join("\n");
	}

	let md = "## File Tree\n\n```\n";
	try {
		md += await tree(outDir);
	} catch {
		md += "(empty)";
	}
	md += "\n```\n\n";

	// Try to include README
	for (const name of ["README.md", "readme.md", "Readme.md"]) {
		try {
			const readme = await readFile(join(outDir, name), "utf8");
			md += `---\n\n## README\n\n${readme}\n`;
			break;
		} catch {}
	}

	return md;
}

async function fetchGitHubRepo(ref: GitHubRef): Promise<PullResult> {
	const { owner, repo } = ref;

	// Try cloning first (much better for agent exploration)
	const cloneDir = join(BASE_TEMP, "github", `${owner}--${repo}`);
	const cloned = await cloneGitHubRepo(owner, repo, cloneDir);

	if (cloned.ok) {
		const treeMd = await buildRepoMarkdown(cloneDir);
		return {
			ok: true,
			url: `https://github.com/${owner}/${repo}`,
			title: `${owner}/${repo}`,
			content: `# ${owner}/${repo}\n\n> Cloned to: ${cloneDir}\n\n${treeMd}`,
		};
	}

	// Fallback to API
	const repoInfo = await githubApiFetch(`/repos/${owner}/${repo}`);
	let md = "";
	if (repoInfo && typeof repoInfo === "object" && !(repoInfo as any).message) {
		const info = repoInfo as any;
		const repoName = info.full_name || `${owner}/${repo}`;
		md = `# ${repoName}\n\n`;
		if (info.description) md += `> ${info.description}\n\n`;
		if (info.topics?.length) md += `**Topics:** ${info.topics.join(", ")}\n\n`;
		md += `- **Language:** ${info.language || "N/A"}\n`;
		md += `- **Stars:** ${info.stargazers_count ?? 0}\n`;
		md += `- **Forks:** ${info.forks_count ?? 0}\n`;
		md += `- **License:** ${info.license?.spdx_id || "N/A"}\n\n`;
	} else {
		md = `# ${owner}/${repo}\n\n`;
	}

	const treeResult = await fetchGitHubTree(ref);
	if (treeResult.ok && treeResult.content) {
		const treeContent = treeResult.content.replace(/^#[^\n]+\n\n/, "");
		md += treeContent;
	}

	return {
		ok: true,
		url: `https://github.com/${owner}/${repo}`,
		title: `${owner}/${repo}`,
		content: md,
	};
}

// ─── Jina AI reader ────────────────────────────────────────────────

async function fetchJina(url: string): Promise<PullResult | null> {
	try {
		const res = await smartFetch(
			`https://r.jina.ai/${encodeURIComponent(url)}`,
		);
		if (!res || res.status >= 400) return null;
		const text = res.text.trim();
		if (!text) return null;
		const titleMatch = text.match(/^Title:\s*(.+)(?:\r?\n){2}/);
		if (titleMatch) {
			return {
				ok: true,
				url,
				title: titleMatch[1].trim(),
				content: text.slice(titleMatch[0].length),
			};
		}
		return { ok: true, url, title: new URL(url).hostname, content: text };
	} catch {
		return null;
	}
}

// ─── Readability extraction ────────────────────────────────────────

function extractReadability(
	html: string,
	_url: string,
): { title: string; content: string } | null {
	try {
		const { document } = parseHTML(html);
		const reader = new Readability(document as any);
		const article = reader.parse();
		if (!article || (article.textContent?.length ?? 0) < 200) return null;
		return {
			title: article.title || "",
			content: article.textContent || "",
		};
	} catch {
		return null;
	}
}

// ─── RSC (React Server Components) extraction ──────────────────────

function extractRSC(html: string): string | null {
	// Look for Next.js flight data in inline scripts
	const matches = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)/gs)];
	if (!matches.length) return null;

	const chunks: string[] = [];
	for (const m of matches) {
		try {
			const data = JSON.parse(m[1]!);
			if (Array.isArray(data) && data.length >= 2) {
				const payload =
					typeof data[1] === "string" ? data[1] : JSON.stringify(data[1]);
				// Extract human-readable strings (heuristic)
				const readable = payload
					.split(/["\n]/)
					.filter(
						(s) =>
							s.length > 30 &&
							/[a-z]{3,}/.test(s) &&
							!s.startsWith("$") &&
							!s.startsWith("@"),
					)
					.join("\n\n");
				if (readable) chunks.push(readable);
			}
		} catch {}
	}
	return chunks.length ? chunks.join("\n\n").slice(0, 20000) : null;
}

// ─── PDF extraction ────────────────────────────────────────────────

async function extractPDF(
	buffer: Buffer,
	url: string,
): Promise<PullResult | null> {
	try {
		const PDFParse = (pdfParse as any).PDFParse || pdfParse;
		const parser = new PDFParse({ data: new Uint8Array(buffer) });
		await parser.load();
		const data = await parser.getText();
		if (!data.text?.trim()) return null;
		return {
			ok: true,
			url,
			title: new URL(url).pathname.split("/").pop() || "Document",
			content: `## PDF Content (${data.total} pages)\n\n${data.text}`,
		};
	} catch {
		return null;
	}
}

// ─── Fetch + Convert ────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("timeout")), ms),
		),
	]);
}

// ─── Smart content-type detection ───────────────────────────────────

/** Check if a Content-Type header indicates JSON. */
function isJsonContentType(ct: string): boolean {
	const norm = ct.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		norm === "application/json" ||
		norm === "text/json" ||
		norm.endsWith("+json")
	);
}

/** Check if a body string looks like JSON (starts with { or [). */
function isLikelyJsonBody(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** Pretty-print JSON content in a markdown code block. */
function formatJsonContent(text: string, url: string): PullResult {
	try {
		const parsed = JSON.parse(text);
		const formatted = JSON.stringify(parsed, null, 2);
		const truncated =
			formatted.length > 50000
				? formatted.slice(0, 50000) + "\n\n[... truncated]"
				: formatted;
		return {
			ok: true,
			url,
			title: new URL(url).pathname.split("/").pop() || "response.json",
			content: `\`\`\`json\n${truncated}\n\`\`\``,
		};
	} catch {
		return {
			ok: true,
			url,
			title: "response.json",
			content: `\`\`\`\n${text.slice(0, 50000)}\n\`\`\``,
		};
	}
}

/**
 * Client-side meta refresh redirect. Returns the target URL or null.
 * Follows redirects that fire in <30s (bounded, avoids infinite loops).
 */
function extractClientSideRedirect(html: string, baseUrl: string): string | null {
	const snippet = html.slice(0, 4096);
	const m = snippet.match(
		/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?([^"'>]*)/i,
	);
	if (!m) return null;
	const parts = m[1]!.split(";");
	const delay = Number.parseFloat(parts[0]!.trim());
	if (!Number.isFinite(delay) || delay < 0 || delay >= 30) return null;
	const urlMatch = parts.slice(1).join(";").match(/url\s*=\s*(.+)/i);
	if (!urlMatch) return null;
	const target = urlMatch[1]!.trim().replace(/^['"]|['"]$/g, "");
	try {
		const resolved = new URL(target, baseUrl).toString();
		return resolved === baseUrl ? null : resolved;
	} catch {
		return null;
	}
}

/**
 * Scan for <link rel="alternate"> entries in <head> that match
 * JSON, text/markdown, or text/plain content types.
 */
function extractAlternateLinks(html: string, baseUrl: string): string[] {
	const accepted = ["application/json", "text/json", "text/markdown", "text/plain"];
	const snippet = html.length > 10000 ? html.slice(0, 10000) : html;
	const links: string[] = [];
	const pattern =
		/<link[^>]+rel=["']alternate["'][^>]*type=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
	const pattern2 =
		/<link[^>]+type=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
	for (const re of [pattern, pattern2]) {
		let match: RegExpExecArray | null;
		while ((match = re.exec(snippet)) !== null) {
			const type = match[1]!.toLowerCase();
			if (accepted.some((a) => type === a || type.endsWith("+json"))) {
				const href = match[2]!;
				try {
					const target = new URL(href, baseUrl).toString();
					if (target !== baseUrl && !links.includes(target)) {
						links.push(target);
					}
				} catch {}
			}
		}
	}
	return links;
}

/**
 * Download raw bytes to a temp file under BASE_TEMP.
 * Returns PullResult with filePath set.
 */
async function downloadToTemp(
	buffer: Buffer,
	contentType: string,
	contentDisposition: string,
	url: string,
): Promise<PullResult> {
	// Extract filename from Content-Disposition or URL
	let filename = "";
	const cdMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?([^;]+)/i);
	if (cdMatch) {
		try {
			filename = decodeURIComponent(cdMatch[1]!.trim().replace(/^"|"$/g, ""));
		} catch {
			filename = cdMatch[1]!.trim().replace(/^"|"$/g, "");
		}
	}
	if (!filename) {
		const urlPath = new URL(url).pathname;
		filename = urlPath.split("/").filter(Boolean).pop() || "download";
	}
	// Sanitize
	filename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

	const dir = join(BASE_TEMP, "downloads");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, filename);
	await writeFile(filePath, buffer);

	const ext = filename.split(".").pop() || "";
	const typeLabel = ext.toUpperCase() || contentType.split("/").pop() || "file";

	return {
		ok: true,
		url,
		title: `📦 ${filename} (${typeLabel}, ${buffer.length} bytes)`,
		content: `Downloaded to \`${filePath}\` (${buffer.length} bytes, ${typeLabel})`,
		filePath,
	};
}

function fallbackExtract(html: string): { title: string; content: string } {
	const { document } = parseHTML(html);
	const t = document.querySelector("title")?.textContent || "";
	const el =
		document.querySelector("main") ??
		document.querySelector("article") ??
		document.querySelector("body");
	return {
		title: t,
		content: el?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? "",
	};
}

function finalizePullResult(
	result: PullResult,
	redirectNotice?: string,
): PullResult {
	if (!result.ok || !result.content) return result;

	let content = result.content;
	if (redirectNotice) {
		content = redirectNotice + "\n\n" + content;
	}

	const injection = detectPromptInjection(content, "warn");
	return {
		...result,
		content: applyInjectionAction(content, injection),
	};
}

/** Max client-side meta-refresh redirects to follow. */
const MAX_CLIENT_REDIRECTS = 5;
/** Minimum word count from extraction before trying alternate link fallback. */
const MIN_ALTERNATE_FALLBACK_WORDS = 30;

async function pullPage(url: string, opts?: FetchOpts, _redirectCount = 0): Promise<PullResult> {
	let redirectNotice: string | undefined;

	// ── 1. GitHub special-case ──
	const gh = await pullGitHub(url);
	if (gh) return finalizePullResult(gh, redirectNotice);

	// ── 2. Binary download detection (Content-Disposition or non-text MIME) ──
	// Peek at headers first via a lightweight HEAD-like request via fetchBuffer
	const binPeek = await fetchBuffer(url, opts);
	if (binPeek && binPeek.status < 400) {
		// PDF by URL extension
		if (url.toLowerCase().endsWith(".pdf")) {
			const pdf = await extractPDF(binPeek.buffer, url);
			if (pdf) return finalizePullResult(pdf, redirectNotice);
		}

		// Check if this looks like a binary download: non-text content-type
		// or Content-Disposition: attachment. We detect by trying to parse the
		// buffer as text — if it contains null bytes or is mostly non-ASCII, it's binary.
		const headBytes = binPeek.buffer.slice(0, 1024);
		const isBinary =
			headBytes.includes(0) ||
			headBytes.toString("utf8").replace(/[\x20-\x7E\n\r\t]/g, "").length >
				headBytes.length * 0.3;
		if (isBinary && !url.toLowerCase().endsWith(".pdf")) {
			const dl = await downloadToTemp(binPeek.buffer, "", "", url);
			return finalizePullResult(dl, redirectNotice);
		}
	} else if (!binPeek) {
		return { ok: false, url, error: "Request failed" };
	}

	// ── 3. Standard text fetch ──
	const res = await smartFetch(url, {
		...opts,
		headers: {
			Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/markdown;q=0.8,*/*;q=0.7",
			...opts?.headers,
		},
	});
	if (!res) return { ok: false, url, error: "Request failed" };
	if (res.status >= 400) return { ok: false, url, error: `HTTP ${res.status}` };

	const text = res.text;
	const finalUrl = res.url;
	const ct = res.headers.get("content-type") ?? "";

	// Detect cross-host redirects
	try {
		const origHost = new URL(url).hostname;
		const finalHost = new URL(finalUrl).hostname;
		if (origHost !== finalHost) {
			redirectNotice = `> ⚠️ Cross-host redirect detected: \`${url}\` → \`${finalUrl}\``;
		}
	} catch {}

	// ── 4. PDF by content-type (missed by URL check) ──
	if (ct.includes("application/pdf")) {
		const bin = await fetchBuffer(url, opts);
		if (bin) {
			const pdf = await extractPDF(bin.buffer, url);
			if (pdf) return finalizePullResult(pdf);
		}
	}

	// ── 5. JSON auto-detection ──
	if (isJsonContentType(ct) || isLikelyJsonBody(text)) {
		return finalizePullResult(formatJsonContent(text, finalUrl), redirectNotice);
	}

	// ── 6. Plain text (txt, logs, configs) → wrap in code block ──
	if (ct.includes("text/plain") || ct.includes("text/markdown")) {
		const title =
			text.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
			new URL(finalUrl).pathname.split("/").pop() ||
			finalUrl;
		// If it looks like markdown already, return as-is
		if (MARKDOWN_SIGNAL.test(text) || ct.includes("text/markdown")) {
			return finalizePullResult({ ok: true, url: finalUrl, title, content: text }, redirectNotice);
		}
		// Plain text → wrap in code block
		const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n\n[... truncated]" : text;
		return finalizePullResult(
			{ ok: true, url: finalUrl, title, content: "```\n" + truncated + "\n```" },
			redirectNotice,
		);
	}

	// ── 7. Client-side meta redirect (only for HTML) ──
	if (_redirectCount < MAX_CLIENT_REDIRECTS && ct.includes("text/html")) {
		const redirectTarget = extractClientSideRedirect(text, finalUrl);
		if (redirectTarget) {
			return pullPage(redirectTarget, opts, _redirectCount + 1);
		}
	}

	// ── 8. HTML content pipeline ──
	const cleaned = text
		.replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, "");

	// Try Jina AI for public URLs
	if (!isLocalOrPrivateUrl(url)) {
		const jina = await fetchJina(url);
		if (jina) return finalizePullResult(jina, redirectNotice);
	}

	// Try Readability
	const readability = extractReadability(cleaned, finalUrl);
	if (readability) {
		const wordCount = readability.content.split(/\s+/).length;
		// ── 8a. Alternate link fallback: if Readability produced thin content, check <link rel="alternate"> ──
		if (wordCount < MIN_ALTERNATE_FALLBACK_WORDS) {
			const altLinks = extractAlternateLinks(text, finalUrl);
			for (const altUrl of altLinks.slice(0, 3)) {
				const altRes = await smartFetch(altUrl, {
					...opts,
					headers: { Accept: "application/json,text/plain,*/*;q=0.8", ...opts?.headers },
				});
				if (altRes && altRes.status < 400) {
					const altText = altRes.text;
					const altCt = altRes.headers.get("content-type") ?? "";
					if (isJsonContentType(altCt) || isLikelyJsonBody(altText)) {
						return finalizePullResult(formatJsonContent(altText, finalUrl), redirectNotice);
					}
					return finalizePullResult(
						{ ok: true, url: finalUrl, title: readability.title, content: altText },
						redirectNotice,
					);
				}
			}
		}
		return finalizePullResult(
			{ ok: true, url: finalUrl, title: readability.title, content: readability.content },
			redirectNotice,
		);
	}

	// Try RSC (Next.js flight data)
	const rsc = extractRSC(text);
	if (rsc) {
		return finalizePullResult(
			{ ok: true, url: finalUrl, title: new URL(finalUrl).hostname, content: rsc },
			redirectNotice,
		);
	}

	// Defuddle
	try {
		const result = await withTimeout(
			Defuddle(cleaned, finalUrl, { markdown: true }),
			DEFUDDLE_TIMEOUT,
		);
		return finalizePullResult(
			{ ok: true, url: finalUrl, title: result.title || "", content: result.content || "" },
			redirectNotice,
		);
	} catch {
		const { title, content } = fallbackExtract(cleaned);
		return finalizePullResult(
			{ ok: true, url: finalUrl, title, content },
			redirectNotice,
		);
	}
}

// ─── Write ──────────────────────────────────────────────────────────

function frontmatter(title: string, url: string): string {
	return `---\ntitle: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nurl: "${url}"\n---\n\n`;
}

function pageToPath(page: Page): string {
	let p = new URL(page.url).pathname;
	if (p.endsWith("/")) p += "index";
	p = p.replace(/\.html?$/, "").replace(/^\//, "");
	if (!p.endsWith(".md")) p += ".md";
	return p;
}

async function writePage(page: Page, outDir: string): Promise<string> {
	const rel = pageToPath(page);
	const full = join(outDir, rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, page.markdown, "utf8");
	return rel;
}

// ─── Concurrency limiter ────────────────────────────────────────────

async function runInBatches<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let index = 0;

	async function worker(): Promise<void> {
		while (index < items.length) {
			const i = index++;
			results[i] = await fn(items[i]!, i);
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results;
}

// ─── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Load persisted search cache on startup
	loadSearchCacheFromDisk().catch(() => {});
	// Load persisted content cache from disk (lazy — contents loaded on first access)
	loadContentCacheFromDisk().catch(() => {});

	// Start session cache cleanup
	setInterval(cleanupSessionCache, SESSION_CACHE_CLEANUP_MS);

	// ─── webfetch tool ──────────────────────────────────────────────
	pi.registerTool({
		name: "aio-webfetch",
		label: "Web Fetch",
		description:
			"Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Detects PDFs, GitHub repos, and Next.js RSC. Long content is automatically summarized via Gemini AI; full content always saved to file.",
		promptSnippet: "Fetch a URL and convert to markdown",
		promptGuidelines: [
			"Use aio-webfetch when the user wants to retrieve specific webpage(s), article(s), or file(s).",
			"Use aio-webpull when the user wants to download an entire site or docs collection.",
			"After aio-webfetch completes, use the built-in read tool to inspect the generated markdown file(s).",
		],
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"Single URL to fetch. Use either 'url' or 'urls', not both.",
				}),
			),
			urls: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple URLs to fetch in parallel.",
				}),
			),
			out: Type.Optional(
				Type.String({
					description:
						"Output file path under temp for single url (default: auto-derived from URL)",
				}),
			),
			browser: Type.Optional(
				Type.String({
					description: `Browser profile for TLS fingerprinting. Default: "${DEFAULT_BROWSER}"`,
				}),
			),
			os: Type.Optional(
				Type.String({
					description: `OS profile for fingerprinting. Default: "${DEFAULT_OS}"`,
				}),
			),
		}) as any,

		async execute(_toolCallId: string, params: any): Promise<any> {
			const targets: string[] = params.urls ?? (params.url ? [params.url] : []);
			if (!targets.length) {
				throw new Error("Provide either 'url' or 'urls'");
			}

			const browser = (params.browser as string) ?? DEFAULT_BROWSER;
			const os = (params.os as string) ?? DEFAULT_OS;

			const results = await runInBatches(
				targets,
				Math.min(4, targets.length),
				async (raw, _idx) => {
					let urlStr = raw;
					if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;

					let url: URL;
					try {
						url = new URL(urlStr);
					} catch {
						return {
							ok: false,
							error: `Bad URL: ${raw}`,
							url: raw,
						};
					}

					let outFile: string;
					if (targets.length === 1 && params.out) {
						outFile = resolve(BASE_TEMP, params.out);
					} else {
						const name =
							url.pathname.replace(/^\//, "").replace(/\//g, "-") || "index";
						outFile = join(BASE_TEMP, url.hostname, `${name}.md`);
					}
					const outPath = resolve(outFile);

					const result = await pullPage(url.href, { browser, os });
					if (!result.ok) {
						return {
							ok: false,
							error: result.error ?? "Fetch failed",
							url: url.href,
						};
					}

					const markdown =
						frontmatter(result.title || url.pathname, result.url!) +
						(result.content ?? "");

					await mkdir(dirname(outPath), { recursive: true });
					await writeFile(outPath, markdown, "utf8");

					storeContent(result.url!, result.title, markdown);

					return {
						ok: true,
						url: result.url!,
						title: result.title || url.pathname,
						outPath,
						length: markdown.length,
					};
				},
			);

			const okResults = results.filter((r) => r.ok);
			const errResults = results.filter((r) => !r.ok);

			if (targets.length === 1) {
				const r = results[0]!;
				if (!r.ok) throw new Error(r.error ?? "Fetch failed");
				const preview = await readFile(r.outPath!, "utf8");

				// ── Always try Google AI summarization first ──
				let summary: string | null = null;
				let summarized = false;
				const searchCtx =
					lastSearchContext &&
					Date.now() - lastSearchContext.timestamp < SEARCH_CONTEXT_TTL_MS
						? lastSearchContext.query
						: undefined;

				if (cdpAvailableGA()) {
					try {
						await ensureChrome(true);
						summary = await summarizeUrl(r.url as string, {
							headless: true,
							timeoutMs: 15000,
							context: searchCtx,
						});
						if (summary) summarized = true;
					} catch {
						// Google AI failed — fall through to direct/truncated display
					}
				}

				const isShort = preview.length <= MAX_PREVIEW_CHARS;
				let summaryNotice: string;
				let displayContent: string;

				if (summarized && summary) {
					summaryNotice = `\n[AI-summarized by Google AI. Full content (${preview.length} chars) saved to ${r.outPath}. Use the read tool for full text.]`;
					displayContent = summary;
				} else if (isShort) {
					summaryNotice = "";
					displayContent = preview;
				} else {
					summaryNotice = `\n[Preview truncated: ${preview.length} chars total, ${MAX_PREVIEW_CHARS} chars shown. Use the read tool for full content.]`;
					displayContent = preview.slice(0, MAX_PREVIEW_CHARS);
				}

				const text = [
					`✓ Fetched and saved to ${r.outPath}${summaryNotice}`,
					`\nTitle: ${r.title}`,
					`URL: ${r.url}`,
					"\n---\n",
					displayContent,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: {
						outPath: r.outPath,
						title: r.title,
						url: r.url,
						browser,
						os,
						truncated: !summarized && !isShort,
						summarized,
						fullLength: preview.length,
						summaryLength: summary?.length,
					},
				};
			}

			// Batch result
			const lines = [
				`Fetched ${okResults.length}/${targets.length} URLs:`,
				"",
				...okResults.map(
					(r) =>
						`✓ ${r.title} — ${r.url}\n  → ${r.outPath} (${r.length} chars)`,
				),
				...(errResults.length
					? ["", "Errors:", ...errResults.map((r) => `✗ ${r.url}: ${r.error}`)]
					: []),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { results, browser, os },
			};
		},
	});

	// ─── webcontent tool ────────────────────────────────────────────
	pi.registerTool({
		name: "aio-webcontent",
		label: "Web Content",
		description:
			"Retrieve previously fetched content from session storage by URL. Content is stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Get stored content from a previous fetch",
		promptGuidelines: [
			"Use aio-webcontent when you need the full content of a previously fetched URL without re-downloading.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "URL of previously fetched content",
			}),
		}) as any,

		async execute(_toolCallId: string, params: any): Promise<any> {
			const stored = getStoredContent(params.url);
			if (!stored) {
				return {
					content: [
						{
							type: "text",
							text: `No stored content found for ${params.url}`,
						},
					],
					details: { found: false },
				};
			}
			const text = [
				`Retrieved content for ${stored.url}`,
				stored.title ? `Title: ${stored.title}` : "",
				`Length: ${stored.content.length} chars`,
				"\n---\n",
				stored.content,
			]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					found: true,
					title: stored.title,
					url: stored.url,
					timestamp: stored.timestamp,
					length: stored.content.length,
				},
			};
		},
	});

	// ─── websearch tool ──────────────────────────────────────────────
	pi.registerTool({
		name: "aio-websearch",
		label: "Web Search",
		description:
			"Search the web using DuckDuckGo, Brave, and Google in parallel (no API keys required). Returns a compact list of results with title, URL, and snippet. Capped at ~7s — returns whatever is available by then.",
		promptSnippet: "Search the web for current information or references",
		promptGuidelines: [
			"Use aio-websearch when the user asks a question that requires current or external information not in your training data.",
			"After getting search results, use aio-webfetch or aio-webpull to retrieve the full content of the most relevant result.",
			"Runs DDG/Brave + Google in parallel. Google requires headless Chrome (auto-launched). Set google: false to skip.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (e.g. 'React Server Components RFC')",
			}),
			max: Type.Optional(
				Type.Number({
					description: "Max results to return per engine (default: 10)",
					default: 10,
				}),
			),
			google: Type.Optional(
				Type.Boolean({
					description:
						"Also search Google via headless Chrome CDP. Default: true.",
					default: true,
				}),
			),
		}) as any,

		async execute(_toolCallId, params) {
			const query = params.query;
			lastSearchContext = { query, timestamp: Date.now() };
			const max = params.max ?? 10;
			const useGoogle = params.google ?? true;

			// ── Run DDG/Brave + Google in parallel with 7s cap ──
			const SEARCH_TIMEOUT = 7000;

			const ddgPromise = searchWeb(query).then(
				(r) => ({
					source: "ddg" as const,
					results: r.results.slice(0, max),
					searchWebDdgCount: r.ddgCount,
					searchWebBraveCount: r.braveCount,
				}),
				() => ({
					source: "ddg" as const,
					results: [] as SearchResult[],
					searchWebDdgCount: 0,
					searchWebBraveCount: 0,
				}),
			);

			let googlePromise: Promise<{
				source: "google";
				results: SearchResult[];
			}>;
			if (useGoogle && cdpAvailableGA()) {
				googlePromise = (async () => {
					try {
						await ensureChrome(true);
						const g = await googleSearch(query, {
							headless: true,
							timeoutMs: SEARCH_TIMEOUT,
							maxResults: max,
						});
						return {
							source: "google" as const,
							results: g.results.map((r) => ({
								title: r.title,
								url: r.url,
								snippet: r.snippet,
							})),
						};
					} catch {
						return { source: "google" as const, results: [] };
					}
				})();
			} else {
				googlePromise = Promise.resolve({
					source: "google" as const,
					results: [],
				});
			}

			const timeoutPromise = new Promise<null>((r) =>
				setTimeout(() => r(null), SEARCH_TIMEOUT),
			);

			// Race all against the timeout — take whatever's ready
			const allPromise = Promise.all([ddgPromise, googlePromise]);
			const result = await Promise.race([allPromise, timeoutPromise]);

			let ddgResults: SearchResult[] = [];
			let googleResults: SearchResult[] = [];
			let searchWebDdgCount = 0;
			let searchWebBraveCount = 0;

			if (result) {
				ddgResults = result[0].results;
				googleResults = result[1].results;
				searchWebDdgCount = (result[0] as any).searchWebDdgCount ?? 0;
				searchWebBraveCount = (result[0] as any).searchWebBraveCount ?? 0;
			} else {
				// Timeout hit — grab whatever settled already
				const settled = await Promise.allSettled([ddgPromise, googlePromise]);
				if (settled[0].status === "fulfilled") {
					ddgResults = settled[0].value.results;
					searchWebDdgCount = (settled[0].value as any).searchWebDdgCount ?? 0;
					searchWebBraveCount =
						(settled[0].value as any).searchWebBraveCount ?? 0;
				}
				if (settled[1].status === "fulfilled")
					googleResults = settled[1].value.results;
			}

			// ── Merge & deduplicate by URL ──
			const seen = new Set<string>();
			const merged: SearchResult[] = [];
			for (const r of [...ddgResults, ...googleResults]) {
				if (seen.has(r.url)) continue;
				seen.add(r.url);
				merged.push(r);
			}

			if (!merged.length) {
				return {
					content: [
						{
							type: "text",
							text: `No search results found for "${query}".`,
						},
					],
					details: { query, results: [] },
				};
			}

			const limited = merged.slice(0, max);

			// Determine which engines contributed (searchWeb always runs DDG + Brave together)
			const engineLabel = ["DDG", "Brave"];
			if (googleResults.length) engineLabel.push("Google");

			const text = [
				`Search results for "${query}" (${engineLabel.join(" + ")}):`,
				"",
				...limited.map(
					(r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
				),
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					results: limited,
					ddgCount: searchWebDdgCount,
					braveCount: searchWebBraveCount,
					googleCount: googleResults.length,
				},
			};
		},
	});

	// ─── webpull tool ────────────────────────────────────────────────
	pi.registerTool({
		name: "aio-webpull",
		label: "Webpull",
		description:
			"Pull any public website or docs site into local markdown files with anti-bot TLS fingerprinting. Discovers pages via sitemap, navigation links, or crawling. Writes files preserving URL structure with YAML frontmatter.",
		promptSnippet: "Pull an entire website into local markdown files",
		promptGuidelines: [
			"Use aio-websearch when the user wants to find information online. Returns compact search results.",
			"Use aio-webfetch when the user wants to download a specific URL or batch of URLs.",
			"After aio-webpull completes, use the built-in read tool to inspect the generated markdown files.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "URL to pull (e.g. https://docs.example.com)",
			}),
			out: Type.Optional(
				Type.String({
					description: "Output directory under temp (default: <hostname>)",
				}),
			),
			max: Type.Optional(
				Type.Number({
					description: "Max pages to pull (default: 100)",
					default: 100,
				}),
			),
			browser: Type.Optional(
				Type.String({
					description: `Browser profile for TLS fingerprinting. Default: "${DEFAULT_BROWSER}". Examples: chrome_145, firefox_147, safari_26, edge_145`,
				}),
			),
			os: Type.Optional(
				Type.String({
					description: `OS profile for fingerprinting. Default: "${DEFAULT_OS}". Options: windows, macos, linux, android, ios`,
				}),
			),
		}) as any,

		async execute(_toolCallId, params, signal, onUpdate) {
			let raw = params.url;
			if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new Error(`Bad URL: ${params.url}`);
			}

			const outDir = params.out
				? resolve(BASE_TEMP, params.out)
				: join(BASE_TEMP, url.hostname);
			const max = params.max ?? 100;
			const concurrency = Math.max(4, cpus().length * 2);
			const browser = (params.browser as string) ?? DEFAULT_BROWSER;
			const os = (params.os as string) ?? DEFAULT_OS;
			const fetchOpts: FetchOpts = { browser, os };

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `🔍 Discovering pages for ${url.href} (${browser}/${os})...`,
					},
				],
				details: { stage: "discover", browser, os },
			});

			const urls = await discover(url.href, max, fetchOpts);
			if (!urls.length) throw new Error("No pages found.");

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `📄 Found ${urls.length} pages. Pulling with ${concurrency} workers...`,
					},
				],
				details: { stage: "pull", total: urls.length, browser, os },
			});

			let ok = 0;
			let err = 0;
			const files: string[] = [];
			const errors: string[] = [];

			await runInBatches(urls, concurrency, async (pageUrl, i) => {
				if (signal?.aborted) return;

				const result = await pullPage(pageUrl, fetchOpts);
				if (!result.ok) {
					err++;
					errors.push(`${pageUrl}: ${result.error}`);
					return;
				}

				const page: Page = {
					url: result.url!,
					title: result.title || new URL(result.url!).pathname,
					markdown:
						frontmatter(result.title || "", result.url!) +
						(result.content ?? ""),
				};

				const rel = await writePage(page, outDir);
				files.push(rel);
				ok++;

				storeContent(result.url!, result.title, page.markdown);

				if ((i + 1) % 10 === 0 || i === urls.length - 1) {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `⏳ ${ok + err}/${urls.length} pages processed (${ok} ok, ${err} err)...`,
							},
						],
						details: {
							stage: "progress",
							ok,
							err,
							total: urls.length,
						},
					});
				}
			});

			const summary = [
				`✅ Pulled ${ok} pages to ${outDir}`,
				err > 0 ? `⚠️ ${err} pages failed` : "",
				``,
				`Files:`,
				...files.slice(0, 30).map((f) => `  - ${f}`),
				files.length > 30 ? `  ... and ${files.length - 30} more` : "",
				errors.length > 0
					? `\nErrors:\n${errors
							.slice(0, 10)
							.map((e) => `  - ${e}`)
							.join("\n")}`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					outDir,
					total: urls.length,
					ok,
					err,
					files,
					errors,
					browser,
					os,
				},
			};
		},
	});
}
