import { spawn, spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
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
import { isIP } from "node:net";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { Type } from "typebox";
import { fetch as wreqFetch, getProfiles as wreqGetProfiles } from "wreq-js";
import {
	ensureChrome,
	googleSearch,
	summarizeUrl,
	cdpAvailable as cdpAvailableGA,
} from "./src/google-ai.js";
import { detectBotBlock, detectLoginRedirect } from "./src/bot-detection.js";
import { extractDataIslands } from "./src/data-islands.js";
import { storeResult, getResult, listResults } from "./src/storage.js";
import { compileContextPackage } from "./src/context-package.js";
import {
	runVerticalExtractor,
	findVerticalExtractor,
} from "./src/verticals/registry.js";
import { compressHtml } from "./src/html-compress.js";
import { estimateTokens } from "./src/token-count.js";
import {
	extractInteractables,
	formatInteractablesSection,
} from "./src/interactive-elements.js";
import { pruneMarkdown } from "./src/prune-markdown.js";
import { ghFetch, getGithubToken } from "./src/github-api.js";

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

interface FetchErrorInfo {
	/** Human-readable error description. */
	message: string;
	/** Machine-readable error code for programmatic handling. */
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
	/** Phase of the fetch lifecycle where the error occurred. */
	phase?: "validation" | "connecting" | "waiting" | "loading" | "processing";
	/** Whether retrying the request may help. */
	retryable?: boolean;
	/** HTTP status code, if applicable. */
	statusCode?: number;
}

interface PullResult {
	ok: boolean;
	url: string;
	title?: string;
	content?: string;
	error?: string;
	errorInfo?: FetchErrorInfo;
	/** Path to downloaded binary file (set for non-text downloads). */
	filePath?: string;
	/** Rich metadata extracted from the page */
	author?: string;
	published?: string;
	site?: string;
	language?: string;
	description?: string;
	wordCount?: number;
	/** Raw HTML before extraction */
	rawHtml?: string;
}

type ScrapeMode = "fast" | "fingerprint" | "browser" | "auto";

interface FetchOpts {
	browser?: string;
	os?: string;
	headers?: Record<string, string>;
	proxy?: string;
	mode?: ScrapeMode;
	interactive?: boolean;
	pruneTokens?: number;
}

/** Elements to remove before extraction — navigation, scaffolding, embeds. */
const NOISE_SELECTORS = [
	"nav",
	"footer",
	"header",
	"svg",
	"canvas",
	"iframe",
	"form",
	"[aria-hidden='true']",
	"[hidden]",
	"[role='navigation']",
	"[role='banner']",
	"[role='contentinfo']",
].join(",");

/**
 * Cookie consent / CMP banner selectors — strips known consent UI before
 * extraction. Covers major CMPs (OneTrust, Cookiebot, Didomi, Quantcast,
 * Usercentrics, TrustArc, Klaro, Sourcepoint, CookieYes) plus generic
 * patterns (class/id heuristics for cookie-banner, gdpr, consent, etc.).
 *
 * Removing these server-side improves extraction quality for EU-facing sites
 * that overlay heavy consent UI on otherwise clean content.
 */
const CONSENT_SELECTORS = [
	// ── OneTrust ──
	"#onetrust-banner-sdk",
	"#onetrust-consent-sdk",
	".onetrust-pc-dark-filter",
	".onetrust-banner-container",
	// ── Cookiebot ──
	"#CybotCookiebotDialog",
	".CybotCookiebotDialog",
	"#CybotCookiebotDialogBackground",
	// ── Didomi ──
	"#didomi-host",
	"#didomi-notice",
	".didomi-notice",
	// ── Quantcast Choice ──
	".qc-cmp2-ui-root",
	".qc-cmp2-container",
	".qc-cmp2-panel-container",
	// ── Usercentrics (including shadow DOM host) ──
	"#usercentrics-root",
	".uc-ui-container",
	// ── TrustArc ──
	"#truste-consent-modal",
	"#truste-consent-track",
	".trustarc-banner",
	"#truste-consent-heading",
	// ── Klaro ──
	".klaro",
	// ── Sourcepoint ──
	"#sp-root",
	"#sp-frame-root",
	".sp-root",
	// ── CookieYes / Borzy ──
	"#cookie-law-info-bar",
	".cky-consent-container",
	"#cookie-law-info",
	// ── Osano ──
	"#osano-cm-dialog",
	".osano-cm-dialog",
	"#osano-cm-window",
	".osano-cm-window",
	// ── CookieFirst ──
	"#cookie-first",
	// ── Adobe Privacy Message Center ──
	"#adobe-font-manager",
	"#adobe-privacy-message-center",
	// ── SmartNews ──
	"#smartconsent-modal",
	"#smartconsent-root",
	// ── CookieHub ──
	"#chv-banner",
	"#chv-module",
	// ── TermsFeed ──
	"#tc-warning",
	// ── Cookie Consent (osano-style) ──
	"#cookie-preferences",
	"#cookie-policy",
	// ── Generic cookie-banner patterns (class-based) ──
	"[class*='cookie-banner']",
	"[class*='cookie-consent']",
	"[class*='cookie-notice']",
	"[class*='cookieBar']",
	"[class*='cookieConsent']",
	"[class*='CookieBanner']",
	"[class*='CookieConsent']",
	"[class*='CookieNotice']",
	"[class*='cookie-bar']",
	"[class*='CookieBar']",
	// ── Generic gdpr/consent patterns (class-based) ──
	"[class*='gdpr-banner']",
	"[class*='gdpr-consent']",
	"[class*='GdprBanner']",
	"[class*='consent-banner']",
	"[class*='consent-modal']",
	"[class*='consent-dialog']",
	"[class*='consentBar']",
	"[class*='ConsentBanner']",
	"[class*='ConsentModal']",
	// ── Generic privacy patterns (class-based) ──
	"[class*='privacy-banner']",
	"[class*='privacy-notice']",
	"[class*='PrivacyBanner']",
	// ── Generic cookie/consent patterns (id-based) ──
	"[id*='cookie-banner']",
	"[id*='cookie-consent']",
	"[id*='cookie-notice']",
	"[id*='cookieBar']",
	"[id*='CookieBanner']",
	"[id*='CookieConsent']",
	"[id*='gdpr-banner']",
	"[id*='consent-banner']",
	"[id*='consent-dialog']",
	"[id*='consent-modal']",
	// ── ARIA role="dialog" with cookie/consent label ──
	"[role='dialog']",
	// ── Bottom-fixed overlays (common banner pattern) ──
	"[data-cookieconsent]",
	"[data-cmp]",
].join(",");

/** Combined selectors for pre-cleaning: structural noise + consent banners. */
const ALL_NOISE_SELECTORS = `${NOISE_SELECTORS},${CONSENT_SELECTORS}`;

/**
 * Pre-clean HTML with linkedom: remove noise elements (nav, footer, header, etc.)
 * and cookie consent banners before feeding into Readability or Defuddle.
 * Significantly improves extraction quality by stripping scaffolding that looks
 * like content to heuristics.
 */
function preCleanHtml(html: string): string {
	try {
		const { document } = parseHTML(html);
		document.querySelectorAll(ALL_NOISE_SELECTORS).forEach((el) => el.remove());
		return document.documentElement.outerHTML;
	} catch {
		return html; // fallback: passthrough on parse failure
	}
}

/**
 * Normalize whitespace: collapse runs of spaces (but preserve newlines),
 * strip carriage returns, collapse 3+ newlines to 2.
 */
function cleanText(value: string): string {
	return value
		.replace(/\r/g, "")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Resolve a command to its absolute path using which/where.
 * Caches results so PATH is only read once at first use.
 */
const _resolvedBinaries = new Map<string, string | null>();
function resolveBinary(name: string): string | null {
	const cached = _resolvedBinaries.get(name);
	if (cached !== undefined) return cached;
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const out = spawnSync(cmd, [name], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (out.error || out.status !== 0) {
			_resolvedBinaries.set(name, null);
			return null;
		}
		const resolved = out.stdout.trim().split("\n")[0] || null;
		_resolvedBinaries.set(name, resolved);
		return resolved;
	} catch {
		_resolvedBinaries.set(name, null);
		return null;
	}
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
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB — streaming cap to prevent memory exhaustion

const DEFAULT_BROWSER = "chrome_145";
const DEFAULT_OS = "windows";

/**
 * Discover the latest Chrome TLS profile available from wreq-js.
 * Falls back to DEFAULT_BROWSER if wreq-js profiles are unavailable.
 */
let _latestChrome: string | null = null;
function getLatestChromeProfile(): string {
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

/**
 * Strip Defuddle extractor footer comments from markdown content.
 * Removes everything after the last `---` divider when it's followed by
 * a ## Comments or similar extractor metadata section.
 */
function stripDefuddleComments(content: string): string {
	return content.replace(/\n---\n+## Comments[\s\S]*$/i, "").trimEnd();
}

const BASE_TEMP = join(tmpdir(), "pi-webaio");
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEARCH_CACHE_FILE = join(BASE_TEMP, "search-cache.json");

// Search context bridging: when webfetch follows a websearch, include the original query
// in the AI summarization prompt for more focused summaries
const SEARCH_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SEARCH_CONTEXT_KEY = "__webaio_search_context__";

function getSearchContext(): { query: string } | null {
	const entry = sessionStore.get(SEARCH_CONTEXT_KEY);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > SEARCH_CONTEXT_TTL_MS) {
		sessionStore.delete(SEARCH_CONTEXT_KEY);
		return null;
	}
	try {
		return JSON.parse(entry.content);
	} catch {
		return null;
	}
}

function setSearchContext(query: string): void {
	// Use delete + set to move to end (LRU-friendly)
	sessionStore.delete(SEARCH_CONTEXT_KEY);
	sessionStore.set(SEARCH_CONTEXT_KEY, {
		url: SEARCH_CONTEXT_KEY,
		title: "search context",
		content: JSON.stringify({ query }),
		timestamp: Date.now(),
	});
}

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
		msg.includes("timeout") ||
		msg.includes("ENOTFOUND") ||
		msg.includes("getaddrinfo")
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
	} catch {
		/* ignore */
	}
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
	metadata?: {
		author?: string;
		published?: string;
		site?: string;
		language?: string;
		wordCount?: number;
	},
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
		...(metadata
			? {
					author: metadata.author,
					published: metadata.published,
					site: metadata.site,
					language: metadata.language,
					wordCount: metadata.wordCount,
				}
			: {}),
	});
}

/**
 * Scan BASE_TEMP for all .md files with YAML frontmatter and populate the
 * in-memory session store. Content is NOT loaded — we store only the file path
 * and lazy-load on first access via getStoredContent().
 */
function loadContentCacheFromDisk(): void {
	const root = BASE_TEMP;

	function scan(dir: string): number {
		let items: string[];
		try {
			items = readdirSync(dir);
		} catch {
			return 0;
		}
		let entries = 0;
		for (const name of items) {
			const full = join(dir, name);
			try {
				const st = statSync(full);
				if (st.isDirectory()) {
					entries += scan(full);
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
		return entries;
	}

	// Defer to next event loop tick so we don't block session startup.
	setImmediate(() => {
		scan(root);
	});
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

/** Blocked metadata/magic hostnames — cloud provider instance metadata endpoints. */
const BLOCKED_HOSTS = new Set([
	"localhost",
	"ip6-localhost",
	"0.0.0.0",
	"metadata.google.internal",
	"169.254.169.254",
]);

/**
 * Validate an IP is in a private/internal/loopback range.
 * Covers all RFC 1918, RFC 6598 (CGN), RFC 3927 (link-local),
 * loopback (127.x, ::1), unique local IPv6 (fc00::/7, fd00::/8),
 * and link-local IPv6 (fe80::/10).
 */
function isPrivateIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return isPrivateIPv4(ip);
	if (version === 6) return isPrivateIPv6(ip);
	return true; // unparseable = treat as dangerous
}

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map((x) => Number(x));
	if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return true;
	const [a, b] = parts as [number, number];
	return (
		a === 10 || // RFC 1918
		a === 127 || // loopback
		(a === 172 && b >= 16 && b <= 31) || // RFC 1918
		(a === 192 && b === 168) || // RFC 1918
		(a === 169 && b === 254) || // link-local
		(a === 100 && b >= 64 && b <= 127) || // CGN (RFC 6598)
		a === 0 // "this" network
	);
}

function isPrivateIPv6(ip: string): boolean {
	const n = ip.toLowerCase();
	// Loopback, unspecified
	if (n === "::1" || n === "::") return true;
	// Unique local (fc00::/7, fd00::/8) and link-local (fe80::/10)
	if (n.startsWith("fc") || n.startsWith("fd") || n.startsWith("fe80"))
		return true;

	// ::ffff:x.x.x.x IPv4-mapped — extract embedded v4 and check it
	const v4Mapped = n.match(/^::ffff:([\d.]+)$/);
	if (v4Mapped) return isPrivateIPv4(v4Mapped[1]!);

	// ::/96 IPv4-compatible (deprecated but still supported)
	const v4Compat = n.match(/^::([\d.]+)$/);
	if (v4Compat) return isPrivateIPv4(v4Compat[1]!);

	// 6to4 (2002::/16) — embedded IPv4 in bytes 2-5 of the hex groups.
	// 2002:VVXX:YYZZ:: → extract VV.XX.YY.ZZ as an IPv4 address.
	const sixTo4 = n.match(
		/^2002:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})/i,
	);
	if (sixTo4) {
		const v4 = [
			parseInt(sixTo4[1]!, 16),
			parseInt(sixTo4[2]!, 16),
			parseInt(sixTo4[3]!, 16),
			parseInt(sixTo4[4]!, 16),
		].join(".");
		return isPrivateIPv4(v4);
	}

	// Teredo (2001:0::/32) — client v4 XOR'd with 0xff in last 32 bits.
	// 2001:0000:XXXX:XXXX:XXXX:XXXX:VVXX:YYZZ → XOR VV.XX.YY.ZZ with 255.
	const teredo = n.match(
		/^2001:0(?:000)?:.*?:([0-9a-f]{2})([0-9a-f]{2}):([0-9a-f]{2})([0-9a-f]{2})$/i,
	);
	if (teredo) {
		const v4 = [
			parseInt(teredo[1]!, 16) ^ 0xff,
			parseInt(teredo[2]!, 16) ^ 0xff,
			parseInt(teredo[3]!, 16) ^ 0xff,
			parseInt(teredo[4]!, 16) ^ 0xff,
		].join(".");
		return isPrivateIPv4(v4);
	}

	return false;
}

/**
 * Deep SSRF check: resolves DNS and validates ALL returned IPs
 * against private/loopback/link-local ranges. Also blocks known
 * metadata endpoints and cloud magic hostnames.
 */
async function isDangerousUrl(url: string): Promise<boolean> {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();

		// Quick block: known dangerous hostnames
		if (BLOCKED_HOSTS.has(host)) return true;

		// Quick block: literal IP in private range
		const cleanedIp = host.replace(/^\[|\]$/g, "");
		if (isIP(cleanedIp)) {
			return isPrivateIp(cleanedIp);
		}

		// Quick block: .local and obvious private prefixes (fast path)
		if (host.endsWith(".local")) return true;
		if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
		if (host.startsWith("172.")) {
			const octet = Number.parseInt(host.split(".")[1] ?? "0", 10);
			if (octet >= 16 && octet <= 31) return true;
		}

		// Deep check: resolve DNS and validate every IP
		try {
			const records = await dnsLookup(host, { all: true, verbatim: true });
			for (const record of records) {
				if (isPrivateIp(record.address)) return true;
			}
		} catch {
			// DNS failure — treat as potentially dangerous
			return true;
		}

		return false;
	} catch {
		return true; // unparseable URL = dangerous
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
	/from\s+now\s+on[\s,:]*(you|your)/i, // nosonar: simplified char class avoids nested quantifier backtracking
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
	/turn\s+off\s+(?:(?:safety|security|content)\s+)?(filters?|checks?|restrictions?)/i, // nosonar: moved \s+ into optional group to avoid backtracking
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
			const isLocal = await isDangerousUrl(url);
			if (isLocal) {
				res = await fetch(url, { redirect: "manual", headers });
			} else {
				const browser = (options.browser as any) ?? getLatestChromeProfile();
				const os = (options.os as any) ?? DEFAULT_OS;
				res = await wreqFetch(url, {
					redirect: "manual",
					headers,
					browser,
					os,
					...(options.proxy ? { proxy: options.proxy } : {}),
				});
			}

			// Follow redirects manually, re-validating SSRF on every hop.
			// Without this, a public host can 302 to an internal IP and
			// bypass the initial URL guard.
			const MAX_REDIRECT_HOPS = 5;
			for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
				if (res.status < 300 || res.status >= 400) break;
				const location = res.headers.get("location");
				if (!location) break;
				// Discard redirect body to free connection
				try {
					res.body?.cancel?.();
				} catch {
					/* ignore */
				}
				let nextRaw: string;
				try {
					nextRaw = new URL(location, url).href;
				} catch {
					return null; // invalid redirect target
				}
				// Reject redirects to dangerous hosts
				if (await isDangerousUrl(nextRaw)) return null;
				url = nextRaw;
				if (isLocal) {
					res = await fetch(url, { redirect: "manual", headers });
				} else {
					res = await wreqFetch(url, {
						redirect: "manual",
						headers,
						browser: (options.browser as any) ?? getLatestChromeProfile(),
						os: (options.os as any) ?? DEFAULT_OS,
						...(options.proxy ? { proxy: options.proxy } : {}),
					});
				}
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

let _pwWarned = false;

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
			} catch {
				/* ignore */
			}
		}
	} catch {
		// Playwright not installed — emit one-time warning
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

/**
 * Stream-read a response body with a byte budget cap.
 * Prevents memory exhaustion from unexpectedly large responses.
 * Cancels the reader when the cap is exceeded.
 */
async function readResponseText(response: any): Promise<string> {
	if (!response.body) return response.text();
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

	const text = await readResponseText(res);

	// Login-redirect detection: treat auth-wall redirects as blocked
	const loginRedirect = detectLoginRedirect(
		url,
		normalizeFetchedUrl(res.url),
		text,
	);
	if (loginRedirect) {
		console.error(`[BLOCKED] Login redirect detected: ${loginRedirect}`);
		return null;
	}

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
				...(options.proxy ? { proxy: options.proxy } : {}),
			});
			if (fbRes?.ok) {
				const fbText = await readResponseText(fbRes);
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
	return [...xml.matchAll(/<loc>([^<]*)<\/loc>/gi)].map((m) => m[1]!.trim());
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
	const urls = (r.text.match(/^Sitemap:\s*([^\n]{1,2000})$/gim) ?? []).map(
		(l: string) => l.replace(/^Sitemap:\s*/i, "").trim(),
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
			} catch {
				/* ignore */
			}
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
		} catch {
			/* ignore */
		}
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
		} catch {
			/* ignore */
		}
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
			} catch {
				/* ignore */
			}
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

// ─── Engine health tracking ────────────────────────────────────────
// Enhanced per-session health tracking for search engines.
// Tracks successes, failures, consecutive failures, latency, and cooldown.

interface EngineHealthRecord {
	successes: number;
	failures: number;
	consecutiveFailures: number;
	lastFailureReason?: string;
	lastLatencyMs?: number;
	totalLatencyMs: number;
	samples: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	coolDownUntil?: number;
}

const ENGINE_HEALTH_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown after threshold
const ENGINE_FAILURE_THRESHOLD = 2; // consecutive failures before cooldown

const sessionEngineHealth = new Map<string, EngineHealthRecord>();

function getOrCreateEngineHealth(engine: string): EngineHealthRecord {
	const existing = sessionEngineHealth.get(engine);
	if (existing) return existing;

	const created: EngineHealthRecord = {
		successes: 0,
		failures: 0,
		consecutiveFailures: 0,
		totalLatencyMs: 0,
		samples: 0,
	};
	sessionEngineHealth.set(engine, created);
	return created;
}

function recordEngineSuccess(engine: string, latencyMs: number): void {
	const record = getOrCreateEngineHealth(engine);
	record.successes += 1;
	record.consecutiveFailures = 0;
	record.coolDownUntil = undefined;
	record.lastSuccessAt = Date.now();
	record.lastLatencyMs = latencyMs;
	record.totalLatencyMs += latencyMs;
	record.samples += 1;
}

function recordEngineFailure(engine: string, reason: string): void {
	const record = getOrCreateEngineHealth(engine);
	record.failures += 1;
	record.consecutiveFailures += 1;
	record.lastFailureAt = Date.now();
	record.lastFailureReason = reason;

	if (record.consecutiveFailures >= ENGINE_FAILURE_THRESHOLD) {
		record.coolDownUntil = Date.now() + ENGINE_HEALTH_COOLDOWN_MS;
	}
}

function isEngineAvailable(engine: string): boolean {
	const record = sessionEngineHealth.get(engine);
	if (!record?.coolDownUntil) return true;
	if (Date.now() >= record.coolDownUntil) {
		record.coolDownUntil = undefined;
		record.consecutiveFailures = 0;
		return true;
	}
	return record.consecutiveFailures >= ENGINE_FAILURE_THRESHOLD;
}

// Backward-compatible aliases (delegate to new health system)
function isProviderAvailable(provider: string): boolean {
	return isEngineAvailable(provider);
}

function recordProviderCooldown(
	provider: string,
	reason: string,
	ttlMs: number,
): void {
	const record = getOrCreateEngineHealth(provider);
	record.failures += 1;
	record.consecutiveFailures += 1;
	record.lastFailureAt = Date.now();
	record.lastFailureReason = reason;
	record.coolDownUntil = Date.now() + ttlMs;
}

function recordProviderNetworkFailure(provider: string, msg: string): void {
	const lower = msg.toLowerCase();
	const isConnFailure =
		lower.includes("econnrefused") ||
		lower.includes("ehostunreach") ||
		lower.includes("enetunreach") ||
		lower.includes("connection refused") ||
		lower.includes("connection reset") ||
		lower.includes("fetch failed") ||
		lower.includes("enotfound") ||
		lower.includes("getaddrinfo");
	recordProviderCooldown(
		provider,
		msg,
		isConnFailure ? 2 * 60 * 1000 : 10 * 60 * 1000,
	);
}

function isQuotaError(status: number, body: string): boolean {
	return (
		status === 429 ||
		status === 402 ||
		status === 403 ||
		status === 1015 ||
		/rate limit|quota|credits|limit reached|monthly limit/i.test(body)
	);
}

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
	} catch {
		/* ignore */
	}
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

function parseYahooResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];

	for (const el of document.querySelectorAll(
		"#web li, ol.searchCenterMiddle li",
	)) {
		const a = el.querySelector("a");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const title = a.textContent?.trim() || "";
		if (!title || !rawUrl) continue;

		// Resolve Yahoo redirect URLs
		let url: string | undefined;
		try {
			const u = new URL(rawUrl, "https://search.yahoo.com");
			const ru = u.searchParams.get("RU") || u.searchParams.get("ru");
			if (ru) {
				url = decodeURIComponent(ru);
			} else if (u.hostname === "r.search.yahoo.com") {
				const match = u.pathname.match(/\/RU=([^/]+)\//);
				if (match?.[1]) url = decodeURIComponent(match[1]);
			} else {
				url = rawUrl;
			}
		} catch {
			url = rawUrl;
		}

		if (!url || !/^https?:/i.test(url)) continue;
		if (
			url.includes("search.yahoo.com") ||
			url.includes("video.search.yahoo.com") ||
			url.includes("r.search.yahoo.com")
		)
			continue;

		const snippet = el.querySelector(".compText, p")?.textContent?.trim() || "";
		results.push({ title, url, snippet });
	}
	return results;
}

function parseBingResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];

	for (const el of document.querySelectorAll("li.b_algo")) {
		const a = el.querySelector("h2 a");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const title = a.textContent?.trim() || "";
		if (!title || !rawUrl) continue;

		// Resolve Bing redirect URLs
		let url: string | undefined;
		try {
			const u = new URL(rawUrl, "https://www.bing.com");
			if (u.pathname.startsWith("/ck/a") && u.searchParams.has("u")) {
				const encoded = u.searchParams.get("u")!;
				// Bing uses base64-ish encoding prefixed with "a1"
				const normalized = encoded.startsWith("a1")
					? encoded.slice(2)
					: encoded;
				const decoded = Buffer.from(normalized, "base64").toString("utf8");
				url = /^https?:/i.test(decoded) ? decoded : undefined;
			} else {
				url = rawUrl;
			}
		} catch {
			url = rawUrl;
		}

		if (!url || !/^https?:/i.test(url)) continue;
		if (url.includes("bing.com")) continue;

		const snippet = el.querySelector(".b_caption p")?.textContent?.trim() || "";
		results.push({ title, url, snippet });
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
					.replace(/<![^>]*-->/g, "") // strip Svelte comments first
					.replace(/<|>/g, "") // strip all angle brackets (single-char match satisfies CodeQL S5852)
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

async function searchWeb(query: string): Promise<{
	results: SearchResult[];
	ddgCount: number;
	braveCount: number;
	yahooCount: number;
	bingCount: number;
}> {
	// Check in-memory cache first
	const cached = getCachedSearch(query);
	if (cached)
		return {
			results: cached,
			ddgCount: cached.length,
			braveCount: 0,
			yahooCount: 0,
			bingCount: 0,
		};

	const encoded = encodeURIComponent(query);

	// Run all 4 engines in parallel (skip cooldown'd providers)
	const commonHeaders = {
		Accept: "text/html",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
	};

	const engines = [
		{
			id: "ddg" as const,
			url: `https://html.duckduckgo.com/html/?q=${encoded}`,
			parser: parseDuckDuckGoResults,
		},
		{
			id: "brave" as const,
			url: `https://search.brave.com/search?q=${encoded}`,
			parser: parseBraveResults,
		},
		{
			id: "yahoo" as const,
			url: `https://search.yahoo.com/search?p=${encoded}&region=us&lang=en`,
			parser: parseYahooResults,
		},
		{
			id: "bing" as const,
			url: `https://www.bing.com/search?q=${encoded}`,
			parser: parseBingResults,
		},
	];

	const promises = engines.map((engine) => {
		if (!isEngineAvailable(engine.id)) {
			return Promise.resolve({
				id: engine.id,
				res: null as any,
				latencyMs: 0,
			});
		}
		const start = Date.now();
		return smartFetch(engine.url, { headers: commonHeaders })
			.then((res) => ({
				id: engine.id,
				res,
				latencyMs: Date.now() - start,
			}))
			.catch((err) => {
				recordEngineFailure(engine.id, String(err));
				return {
					id: engine.id,
					res: null as any,
					latencyMs: Date.now() - start,
				};
			});
	});

	const settled = await Promise.all(promises);

	const counts = { ddg: 0, brave: 0, yahoo: 0, bing: 0 };
	const engineResults = new Map<string, EngineSource[]>();

	for (const s of settled) {
		const engine = engines.find((e) => e.id === s.id);
		if (!engine || !s.res || s.res.status >= 400) {
			if (s.res && isQuotaError(s.res.status, s.res.text)) {
				recordEngineFailure(s.id, `HTTP ${s.res.status}`);
			}
			continue;
		}

		const parsed = engine.parser(s.res.text);
		if (parsed.length > 0) {
			recordEngineSuccess(s.id, s.latencyMs);
		} else {
			recordEngineFailure(s.id, "no results parsed");
		}
		counts[s.id] = parsed.length;

		for (const r of parsed) {
			const list = engineResults.get(r.url) || [];
			list.push({
				result: r,
				engine: s.id,
				weight: ENGINE_WEIGHTS[s.id] || 1,
			});
			engineResults.set(r.url, list);
		}
	}

	const scored = scoreAndRankResults(engineResults);
	const merged = scored.map((s) => s.result);

	if (merged.length > 0) {
		storeSearchResults(query, merged);
	}
	return {
		results: merged,
		ddgCount: counts.ddg,
		braveCount: counts.brave,
		yahooCount: counts.yahoo,
		bingCount: counts.bing,
	};
}

// ─── Cross-engine result scoring ───────────────────────────────────

const ENGINE_WEIGHTS: Record<string, number> = {
	google: 5,
	bing: 3,
	ddg: 2,
	brave: 2,
	yahoo: 1,
};

interface EngineSource {
	result: SearchResult;
	engine: string;
	weight: number;
}

function scoreAndRankResults(
	buckets: Map<string, EngineSource[]>,
): { result: SearchResult; score: number; sources: string[] }[] {
	const scored: { result: SearchResult; score: number; sources: string[] }[] =
		[];
	for (const [url, entries] of buckets) {
		const sources = entries.map((e) => e.engine);
		const weightSum = entries.reduce((sum, e) => sum + e.weight, 0);
		const consensusBonus = Math.max(0, sources.length - 1) * 2;
		const score = weightSum + consensusBonus;

		// Pick metadata from the highest-weight engine
		entries.sort((a, b) => b.weight - a.weight);
		const best = entries[0].result;

		scored.push({ result: { ...best, url }, score, sources });
	}

	scored.sort((a, b) => b.score - a.score);
	return scored;
}

function buildResultBuckets(
	results: SearchResult[],
	engine: string,
): Map<string, EngineSource[]> {
	const buckets = new Map<string, EngineSource[]>();
	const weight = ENGINE_WEIGHTS[engine] || 1;
	for (const r of results) {
		const list = buckets.get(r.url) || [];
		list.push({ result: r, engine, weight });
		buckets.set(r.url, list);
	}
	return buckets;
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

// ─── SonarCloud API handler ─────────────────────────────────

/**
 * Parse a sonarcloud.io URL and return the project key and page type.
 * Returns null for non-SonarCloud URLs.
 */
function parseSonarCloudUrl(
	url: string,
): { projectKey: string; page: string } | null {
	try {
		const u = new URL(url);
		if (u.hostname !== "sonarcloud.io") return null;
		const projectKey =
			u.searchParams.get("id") || u.searchParams.get("project");
		if (!projectKey) return null;
		const match = u.pathname.match(/\/project\/([^/?#]+)/);
		const page = match?.[1] || "overview";
		return { projectKey, page };
	} catch {
		return null;
	}
}

/**
 * Map a SonarCloud page type to its API endpoint path (without host prefix).
 * Forwards relevant query parameters from the original web UI URL to the API.
 */
function sonarCloudApiPath(
	page: string,
	projectKey: string,
	params: URLSearchParams,
): string | null {
	// Query params from the original URL that map to API params
	const forwarded = new URLSearchParams();
	for (const key of [
		"impactSoftwareQualities",
		"impactSeverities",
		"issueStatuses",
		"severities",
		"types",
		"tags",
		"resolved",
		"rules",
		"languages",
		"scopes",
		"owaspTop10",
		"sansTop25",
		"cwe",
		"sonarsourceSecurity",
		"statuses",
		"securityCategories",
	]) {
		const val = params.get(key);
		if (val) forwarded.set(key, val);
	}

	switch (page) {
		case "security_hotspots":
			forwarded.set("projectKey", projectKey);
			if (!forwarded.has("ps")) forwarded.set("ps", "50");
			return `/api/hotspots/search?${forwarded.toString()}`;
		case "issues":
			forwarded.set("componentKeys", projectKey);
			if (!forwarded.has("ps")) forwarded.set("ps", "50");
			if (!forwarded.has("issueStatuses"))
				forwarded.set("issueStatuses", "OPEN,CONFIRMED");
			return `/api/issues/search?${forwarded.toString()}`;
		case "overview":
			return `/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=security_hotspots_reviewed,issues,coverage,duplicated_lines_density,alert_status,quality_gate_details,bugs,vulnerabilities,code_smells,security_rating,security_review_rating,reliability_rating,sqale_rating,sqale_index,ncloc`;
		case "activity":
			return `/api/project_analyses/search?project=${encodeURIComponent(projectKey)}&ps=20`;
		default:
			return null;
	}
}

/**
 * Fetch data from the SonarCloud API and format as markdown.
 */
async function pullSonarCloud(url: string): Promise<PullResult | null> {
	const parsed = parseSonarCloudUrl(url);
	if (!parsed) return null;

	const apiPath = sonarCloudApiPath(
		parsed.page,
		parsed.projectKey,
		new URL(url).searchParams,
	);
	if (!apiPath) return null;

	try {
		const apiUrl = `https://sonarcloud.io${apiPath}`;
		const res = await fetch(apiUrl, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return null;
		const data = await res.json();

		let md = `# ${parsed.projectKey} — ${parsed.page}\n\n`;
		md += `> via SonarCloud API\n\n`;

		switch (parsed.page) {
			case "security_hotspots": {
				const hotspots: any[] = data.hotspots || [];
				if (!hotspots.length) {
					md += "_(no security hotspots found)_\n";
				} else {
					// Group by category
					const byCategory = new Map<string, any[]>();
					for (const h of hotspots) {
						const cat = h.securityCategory || "other";
						if (!byCategory.has(cat)) byCategory.set(cat, []);
						byCategory.get(cat)!.push(h);
					}

					md += `**${hotspots.length} Security Hotspots** (${data.paging?.total ?? hotspots.length} total)\n\n`;

					for (const [cat, items] of byCategory) {
						const sevMap: Record<string, number> = {};
						for (const item of items) {
							const sev = item.vulnerabilityProbability || "unknown";
							sevMap[sev] = (sevMap[sev] || 0) + 1;
						}
						const sevBreakdown = Object.entries(sevMap)
							.map(([k, v]) => `${k}: ${v}`)
							.join("; ");
						md += `### ${cat} (${sevBreakdown})\n\n`;

						for (const item of items.slice(0, 20)) {
							const file = item.component?.split(":").pop() || "?";
							const line = item.line ? `:${item.line}` : "";
							const status =
								item.status === "TO_REVIEW"
									? "🟡"
									: item.status === "FIXED"
										? "✅"
										: item.status === "SAFE"
											? "🟢"
											: "🔴";
							const rule = item.rule?.description || "";
							md += `${status} \`${file}${line}\` — ${item.message}${rule ? ` _(${rule})_` : ""}\n`;
						}
						md += "\n";
					}
				}
				break;
			}

			case "issues": {
				const issues: any[] = data.issues || [];
				if (!issues.length) {
					md += "_(no issues found)_\n";
				} else {
					md += `**${issues.length} Issues** (${data.paging?.total ?? issues.length} total)\n\n`;
					for (const issue of issues.slice(0, 30)) {
						const sev = issue.severity || "";
						const type = issue.type || "";
						const file = issue.component?.split(":").pop() || "?";
						const line = issue.line ? `:${issue.line}` : "";
						const msg = issue.message || "";
						md += `- [${sev}] [${type}] \`${file}${line}\` — ${msg}\n`;
					}
				}
				break;
			}

			case "overview": {
				const measures: any[] = data.component?.measures || data.measures || [];
				if (!measures.length) {
					md += "_(no measures found)_\n";
				} else {
					md += "| Metric | Value |\n|--------|-------|\n";
					for (const m of measures) {
						const val =
							m.value !== undefined ? m.value : m.period?.value || "—";
						md += `| ${m.metric} | ${val} |\n`;
					}
				}
				break;
			}

			case "activity": {
				const analyses: any[] = data.analyses || [];
				if (!analyses.length) {
					md += "_(no activity found)_\n";
				} else {
					for (const a of analyses.slice(0, 20)) {
						const date = a.date
							? new Date(a.date).toISOString().slice(0, 10)
							: "?";
						const events = (a.events || [])
							.map((e: any) => e.name || e.category || "?")
							.join(", ");
						md += `- ${date}: ${a.projectVersion || "?"}${events ? ` (${events})` : ""}\n`;
					}
				}
				break;
			}

			default:
				md += `Raw API response:\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 5000)}\n\`\`\`\n`;
		}

		return {
			ok: true,
			url,
			title: `${parsed.projectKey} — ${parsed.page}`,
			content: md,
		};
	} catch {
		return null;
	}
}

/** Parse a raw.githubusercontent.com URL into owner/repo/branch/path. */
function parseRawGitHubUrl(
	url: string,
): { owner: string; repo: string; branch: string; path: string } | null {
	const m = url.match(
		/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/i,
	);
	if (!m) return null;
	return { owner: m[1]!, repo: m[2]!, branch: m[3]!, path: m[4]! };
}

async function pullGitHub(url: string): Promise<PullResult | null> {
	// Try standard GitHub pipeline (tree/blob/repo)
	const ref = parseGitHubUrl(url);
	if (ref) {
		return pullGitHubRef(ref);
	}

	// Feature page? Try GitHub API (works unauthenticated for public repos)
	const featureResult = await pullGitHubFeature(url);
	if (featureResult) return featureResult;

	// raw.githubusercontent.com URLs — route directly to raw file fetch
	const rawRef = parseRawGitHubUrl(url);
	if (rawRef) {
		const { owner, repo, branch, path } = rawRef;
		// fetchGitHubRaw expects a GitHubRef-like object, but we can call smartFetch directly
		const res = await smartFetch(url);
		if (res?.status && res.status < 400) {
			return {
				ok: true,
				url,
				title: path.split("/").pop() || path,
				content: "> via GitHub\n\n" + res.text,
			};
		}
		// Fallback: try normal fetch pipeline — will include source
		const fallback = await fetchGitHubRaw(owner, repo, branch, path);
		if (fallback.ok) {
			fallback.content = "> via GitHub\n\n" + (fallback.content ?? "");
			return fallback;
		}
	}

	return null;
}

async function pullGitHubRef(ref: GitHubRef): Promise<PullResult | null> {
	let result: PullResult | null = null;
	switch (ref.type) {
		case "blob":
			result = await fetchGitHubRaw(
				ref.owner,
				ref.repo,
				ref.ref || "main",
				ref.path || "",
			);
			break;
		case "tree":
			result = await fetchGitHubTree(ref);
			break;
		case "repo":
			result = await fetchGitHubRepo(ref);
			break;
	}
	// Add source marker so webfetch's AI summarization knows to skip
	if (result?.ok && result.content) {
		result.content = "> via GitHub\n\n" + result.content;
	}
	return result;
}

async function pullGitHubFeature(url: string): Promise<PullResult | null> {
	try {
		const u = new URL(url);
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 3) return null;

		const [owner, repo, feature, ...rest] = parts;
		const baseRepoPath = `/repos/${owner}/${repo}`;

		let apiPath: string | null = null;
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
			}
		}

		if (!apiPath) return null;

		let data: any;
		try {
			data = await ghFetch(apiPath);
		} catch (_err) {
			return null;
		}

		// Unwrap paginated workflow_runs wrapper for actions list
		if (data?.workflow_runs && Array.isArray(data.workflow_runs)) {
			data = data.workflow_runs;
		}

		let md = `# ${owner}/${repo} — ${featureLabel}\n\n`;
		md += `> via GitHub API\n\n`;

		// Special handling for individual CI runs — fetch job details
		if (
			feature === "actions" &&
			rest[0] === "runs" &&
			rest[1] &&
			data &&
			!Array.isArray(data)
		) {
			const run = data;
			const runId = rest[1];
			const highlightJobId = rest[2] === "job" && rest[3] ? rest[3] : null;

			const statusIcon =
				run.conclusion === "success"
					? "✅"
					: run.conclusion === "failure"
						? "❌"
						: run.conclusion === "cancelled"
							? "⏹️"
							: run.status === "in_progress"
								? "🔄"
								: "⏳";
			md += `${statusIcon} **${run.display_title || run.name}** (#${run.run_number})\n`;
			md += `- **Status:** ${run.status} / ${run.conclusion || "pending"}\n`;
			md += `- **Branch:** ${run.head_branch} (${run.head_sha?.slice(0, 7)})\n`;
			md += `- **Trigger:** ${run.event} by ${run.actor?.login || "unknown"}\n`;
			if (run.pull_requests?.length) {
				md += `- **PRs:** ${run.pull_requests.map((p: any) => `#${p.number}`).join(", ")}\n`;
			}
			md += `\n[View on GitHub](${run.html_url})\n`;

			// Fetch jobs
			try {
				const jobsData = (await ghFetch(
					`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=20`,
				)) as any;
				let jobs = jobsData?.jobs || [];

				// If a specific job ID is in the URL, fetch it individually and show first
				if (highlightJobId) {
					try {
						const singleJob = await ghFetch(
							`/repos/${owner}/${repo}/actions/jobs/${highlightJobId}`,
						);
						if (singleJob && !(singleJob as any).message) {
							// Replace or add this job at the top
							jobs = jobs.filter((j: any) => j.id !== (singleJob as any).id);
							jobs.unshift(singleJob);
						}
					} catch {
						/* best effort */
					}
				}

				if (jobs.length) {
					md += `\n## Jobs (${jobs.length})\n\n`;
					for (const job of jobs) {
						const isHighlighted =
							highlightJobId && String(job.id) === highlightJobId;
						const jIcon =
							job.conclusion === "success"
								? "✅"
								: job.conclusion === "failure"
									? "❌"
									: job.conclusion === "cancelled"
										? "⏹️"
										: job.status === "in_progress"
											? "🔄"
											: "⏳";
						md += `### ${jIcon} ${isHighlighted ? "👉 " : ""}${job.name}\n\n`;
						md += `- **Status:** ${job.status} / ${job.conclusion || "pending"}\n`;
						if (job.completed_at)
							md += `- **Completed:** ${job.completed_at}\n`;

						// If highlighting a specific job, fetch its log
						if (
							isHighlighted &&
							job.status === "completed" &&
							job.conclusion === "failure"
						) {
							try {
								const logRes = await fetch(job.logs_url || `${job.url}/logs`, {
									headers: { Accept: "text/plain", "User-Agent": "pi-webaio" },
								});
								if (
									logRes.ok &&
									logRes.headers.get("content-type")?.includes("text/plain")
								) {
									const logText = await logRes.text();
									// Extract lines that look like errors or the last 50 lines
									const lines = logText.split("\n");
									const errorLines = lines.filter((l) =>
										/error|fail|Error|FAIL/i.test(l),
									);
									const tail = lines.slice(-50);
									const logExcerpt =
										errorLines.length > 0
											? errorLines.slice(-15).join("\n")
											: tail.join("\n");
									md += `\n<details>\n<summary>📋 Failed job log excerpt</summary>\n\n\`\`\`\n${logExcerpt.slice(0, 3000)}\n\`\`\`\n</details>\n\n`;
								}
							} catch {
								/* best effort */
							}
						}

						if (job.steps?.length) {
							md += `\n| Step | Status |\n|------|--------|\n`;
							for (const step of job.steps) {
								const sIcon =
									step.conclusion === "success"
										? "✅"
										: step.conclusion === "failure"
											? "❌"
											: step.conclusion === "cancelled"
												? "⏹️"
												: step.conclusion === "skipped"
													? "⏭️"
													: "⏳";
								md += `| ${sIcon} ${step.name} | ${step.conclusion || step.status} |\n`;
							}
							md += `\n`;
						}
						if (job.html_url) md += `[View job logs](${job.html_url})\n\n`;
					}
				}
			} catch {
				md += `\n_(job details unavailable)_\n`;
			}

			return {
				ok: true,
				url,
				title: `${owner}/${repo} — ${featureLabel}`,
				content: md,
			};
		}

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

async function githubApiFetch(path: string): Promise<unknown | null> {
	try {
		return await ghFetch(path);
	} catch {
		return null;
	}
}

async function fetchGitHubRaw(
	owner: string,
	repo: string,
	ref: string,
	path: string,
): Promise<PullResult> {
	// Collect branches to try: caller-provided ref, then main, then master.
	// If ref is a commit SHA (40 hex chars), query the API for the default branch
	// so we don't waste 3 failed requests.
	const tried = new Set<string>();
	const branches: string[] = [ref];
	tried.add(ref);

	for (const b of ["main", "master"]) {
		if (!tried.has(b)) {
			branches.push(b);
			tried.add(b);
		}
	}

	// If ref looks like a SHA (40 hex chars), query the repo's default branch
	if (/^[0-9a-f]{40}$/i.test(ref)) {
		try {
			const repoInfo = (await ghFetch(`/repos/${owner}/${repo}`)) as any;
			const defaultBranch = repoInfo?.default_branch;
			if (defaultBranch && !tried.has(defaultBranch)) {
				branches.splice(1, 0, defaultBranch); // try right after the SHA
				tried.add(defaultBranch);
			}
		} catch {
			// API unavailable — continue with current list
		}
	}

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
		const ghPath = resolveBinary("gh");
		if (ghPath) {
			await new Promise<void>((resolve, reject) => {
				const proc = spawn(
					ghPath,
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

		// Fallback: git clone. If GITHUB_TOKEN is available, inject it for private repos.
		let cloneUrl = `https://github.com/${owner}/${repo}.git`;
		const token = await getGithubToken();
		if (token) {
			cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
		}
		const gitPath = resolveBinary("git") || "git";
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(gitPath, ["clone", "--depth", "1", cloneUrl, outDir], {
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

// ─── Architecture detection (inspired by repocrunch) ───────────────

/** File-pattern signals for CI/CD platforms. */
const CI_PATTERNS: [RegExp, string][] = [
	[/^\.github\/workflows\//, "GitHub Actions"],
	[/^\.gitlab-ci\.yml$/, "GitLab CI"],
	[/^Jenkinsfile$/, "Jenkins"],
	[/^\.circleci\//, "CircleCI"],
	[/^\.travis\.yml$/, "Travis CI"],
	[/^azure-pipelines\.yml$/, "Azure Pipelines"],
	[/^bitbucket-pipelines\.yml$/, "Bitbucket Pipelines"],
];

/** File-pattern signals for test frameworks. */
const TEST_PATTERNS: [RegExp, string][] = [
	[/^jest\.config\./, "Jest"],
	[/^vitest\.config\./, "Vitest"],
	[/^playwright\.config\./, "Playwright"],
	[/^cypress\.config\./, "Cypress"],
	[/^(.*\/)?conftest\.py$/, "pytest"],
	[/^pytest\.ini$/, "pytest"],
	[/^\.mocharc\./, "Mocha"],
	[/^karma\.conf\./, "Karma"],
];

/** File-pattern signals for monorepo tooling. */
const MONOREPO_PATTERNS: [RegExp, string][] = [
	[/^lerna\.json$/, "Lerna"],
	[/^nx\.json$/, "Nx"],
	[/^turbo\.json$/, "Turborepo"],
	[/^pnpm-workspace\.yaml$/, "pnpm workspaces"],
	[/^rush\.json$/, "Rush"],
];

/** Lock-file → package manager mapping. */
const LOCKFILE_MAP: Record<string, string> = {
	"package-lock.json": "npm",
	"yarn.lock": "yarn",
	"pnpm-lock.yaml": "pnpm",
	"bun.lockb": "bun",
	"uv.lock": "uv",
	"poetry.lock": "poetry",
	"Pipfile.lock": "pipenv",
	"Cargo.lock": "cargo",
	"Gemfile.lock": "bundler",
};

function matched(patterns: [RegExp, string][], paths: string[]): string[] {
	const found = new Set<string>();
	for (const p of paths) {
		for (const [re, label] of patterns) {
			if (re.test(p)) found.add(label);
		}
	}
	return [...found];
}

/** Analyze a list of relative file paths and return an architecture summary. */
function detectArchitectureSignals(paths: string[]): string {
	const lines: string[] = [];

	// Docker
	if (
		paths.some((p) =>
			/^(Dockerfile|docker-compose\.(yml|yaml)|\.dockerignore)$/.test(p),
		)
	)
		lines.push("- 🐳 **Docker:** yes");

	// CI/CD
	const ciCd = matched(CI_PATTERNS, paths);
	if (ciCd.length) lines.push(`- 🔄 **CI/CD:** ${ciCd.join(", ")}`);

	// Tests
	const tests = matched(TEST_PATTERNS, paths);
	const hasTestDir = paths.some(
		(p) =>
			p.startsWith("__tests__/") ||
			p.startsWith("tests/") ||
			p.startsWith("test/") ||
			p.startsWith("spec/"),
	);
	if (hasTestDir && !tests.length) tests.push("(test dir present)");
	if (tests.length) lines.push(`- 🧪 **Tests:** ${tests.join(", ")}`);

	// Monorepo tooling
	const monorepo = matched(MONOREPO_PATTERNS, paths);
	// Also detect multiple package.json in subdirectories (classic monorepo signal)
	const pkgJsons = paths.filter((p) => p.endsWith("/package.json"));
	if (pkgJsons.length > 1 && !monorepo.length) monorepo.push("multi-package");
	if (monorepo.length) lines.push(`- 📦 **Monorepo:** ${monorepo.join(", ")}`);

	// Package manager (from lockfiles)
	const pms = new Set<string>();
	for (const [file, pm] of Object.entries(LOCKFILE_MAP)) {
		if (paths.some((p) => p === file || p.endsWith(`/${file}`))) pms.add(pm);
	}
	if (pms.size) lines.push(`- 📋 **Package managers:** ${[...pms].join(", ")}`);

	// Security
	const secSignals: string[] = [];
	if (paths.some((p) => p === "SECURITY.md")) secSignals.push("SECURITY.md");
	if (paths.some((p) => p === ".env")) secSignals.push("⚠ .env committed");
	if (
		paths.some(
			(p) => p === ".github/dependabot.yml" || p === ".github/dependabot.yaml",
		)
	)
		secSignals.push("Dependabot");
	if (secSignals.length)
		lines.push(`- 🔒 **Security:** ${secSignals.join(", ")}`);

	if (!lines.length) return "";
	return `\n## Architecture\n\n${lines.join("\n")}\n`;
}

async function buildRepoMarkdown(outDir: string): Promise<string> {
	// Build a file tree and include README
	const { readdir } = await import("node:fs/promises");
	const allPaths: string[] = [];

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

	// First pass: collect all file paths
	async function collectPaths(dir: string, rel: string): Promise<void> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const e of entries) {
				const relPath = rel ? `${rel}/${e.name}` : e.name;
				allPaths.push(relPath);
				if (e.isDirectory()) {
					await collectPaths(join(dir, e.name), relPath);
				}
			}
		} catch {
			/* ignore */
		}
	}

	await collectPaths(outDir, "");

	let md = "## File Tree\n\n```\n";
	try {
		md += await tree(outDir);
	} catch {
		md += "(empty)";
	}
	md += "\n```\n";

	// Architecture detection from file tree
	const arch = detectArchitectureSignals(allPaths);
	if (arch) md += arch;

	md += "\n";

	// Try to include README
	for (const name of ["README.md", "readme.md", "Readme.md"]) {
		try {
			const readme = await readFile(join(outDir, name), "utf8");
			md += `---\n\n## README\n\n${readme}\n`;
			break;
		} catch {
			/* ignore */
		}
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
		// Parse Jina's "Title: ...\n\ncontent" format without regex backtracking
		const titleLine = text.startsWith("Title:")
			? text.slice(6).split("\n")[0].trim()
			: null;
		const contentStart = titleLine !== null ? text.indexOf("\n\n", 6) : -1;
		if (titleLine && contentStart !== -1) {
			return {
				ok: true,
				url,
				title: titleLine,
				content: text.slice(contentStart + 2),
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
		} catch {
			/* ignore */
		}
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
function extractClientSideRedirect(
	html: string,
	baseUrl: string,
): string | null {
	const snippet = html.slice(0, 4096);
	const m = snippet.match(
		/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?([^"'>]*)/i,
	);
	if (!m) return null;
	const parts = m[1]!.split(";");
	const delay = Number.parseFloat(parts[0]!.trim());
	if (!Number.isFinite(delay) || delay < 0 || delay >= 30) return null;
	const urlMatch = parts
		.slice(1)
		.join(";")
		.match(/url\s*=\s*(.+)/i);
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
	const accepted = [
		"application/json",
		"text/json",
		"text/markdown",
		"text/plain",
	];
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
				} catch {
					/* ignore */
				}
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
		content: cleanText(el?.textContent ?? ""),
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

	// Wrap in explicit trust boundary markers — pi-search pattern
	content = `[UNTRUSTED WEB CONTENT START]\n${content}\n[UNTRUSTED WEB CONTENT END]`;

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

/**
 * Try alternate link fallback: when extraction produces thin content, scan
 * the original HTML for <link rel="alternate" type="application/json"> (or
 * text/markdown, text/plain) and re-fetch the alternate URL.
 */
async function tryAlternateLinks(
	rawHtml: string,
	baseUrl: string,
	opts: FetchOpts | undefined,
): Promise<PullResult | null> {
	const altLinks = extractAlternateLinks(rawHtml, baseUrl);
	for (const altUrl of altLinks.slice(0, 3)) {
		const altRes = await smartFetch(altUrl, {
			...opts,
			headers: {
				Accept: "application/json,text/plain,*/*;q=0.8",
				...opts?.headers,
			},
		});
		if (altRes && altRes.status < 400) {
			const altText = altRes.text;
			const altCt = altRes.headers.get("content-type") ?? "";
			if (isJsonContentType(altCt) || isLikelyJsonBody(altText)) {
				return formatJsonContent(altText, baseUrl);
			}
			return {
				ok: true,
				url: baseUrl,
				title: "",
				content: altText,
			};
		}
	}
	return null;
}

/** Estimate word count by splitting on whitespace. */
function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Run the HTML content extraction pipeline (steps 4-8 of pullPage).
 * Shared by both the normal fetch path and the browser-mode htmlOverride path.
 */
async function runHtmlPipeline(
	text: string,
	finalUrl: string,
	url: string,
	_opts: FetchOpts | undefined,
	redirectNotice: string | undefined,
): Promise<PullResult> {
	// Steps 4-6 (PDF/JSON/plain-text dispatch) are handled by pullPage before calling us.
	// We assume the caller has already determined this is HTML content.

	// ── 7. Client-side meta redirect (safety net for edge cases) ──
	if (text.includes("http-equiv")) {
		const redirectTarget = extractClientSideRedirect(text, finalUrl);
		if (redirectTarget) {
			return pullPage(redirectTarget, _opts, 1, undefined);
		}
	}

	// ── 8. HTML content pipeline ──
	// Pre-clean: remove noise elements, strip script/style tags. Then compress HTML.
	let cleaned = preCleanHtml(text);
	cleaned = compressHtml(cleaned);
	const rawHtml = text;

	// Try Jina AI for public URLs
	if (!(await isDangerousUrl(url))) {
		const jina = await fetchJina(url);
		if (jina) {
			// If Jina produced thin content, try alternate links before returning
			if (wordCount(jina.content || "") < MIN_ALTERNATE_FALLBACK_WORDS) {
				const alt = await tryAlternateLinks(text, finalUrl, _opts);
				if (alt) return finalizePullResult(alt, redirectNotice);
			}
			return finalizePullResult(jina, redirectNotice);
		}
	}

	// Try Readability
	const readability = extractReadability(cleaned, finalUrl);
	if (readability) {
		// Heuristic: if Readability output is <1% of original HTML (>10KB),
		// it likely picked the wrong container (e.g. a footer on a JS-only page).
		// Fall through to Defuddle instead of returning garbage.
		if (
			text.length > 10000 &&
			readability.content.length < 0.01 * text.length
		) {
			// skip — readability failed, try next extractor
		} else {
			// If Readability produced thin content, try alternate links
			if (wordCount(readability.content) < MIN_ALTERNATE_FALLBACK_WORDS) {
				const alt = await tryAlternateLinks(text, finalUrl, _opts);
				if (alt) return finalizePullResult(alt, redirectNotice);
			}
			return finalizePullResult(
				{
					ok: true,
					url: finalUrl,
					title: readability.title,
					content: readability.content,
					rawHtml,
				},
				redirectNotice,
			);
		}
	}

	// Try RSC (Next.js flight data)
	const rscContent = extractRSC(text);
	if (rscContent) {
		return finalizePullResult(
			{
				ok: true,
				url: finalUrl,
				title: new URL(finalUrl).hostname,
				content: rscContent,
			},
			redirectNotice,
		);
	}

	// Defuddle
	try {
		const result = await withTimeout(
			Defuddle(cleaned, finalUrl, { markdown: true }),
			DEFUDDLE_TIMEOUT,
		);
		let defContent = result.content || "";
		// Strip Defuddle extractor footer comments
		defContent = stripDefuddleComments(defContent);
		defContent = cleanText(defContent);
		// If Defuddle produced thin content, try alternate links
		if (wordCount(defContent) < MIN_ALTERNATE_FALLBACK_WORDS) {
			const alt = await tryAlternateLinks(text, finalUrl, _opts);
			if (alt) return finalizePullResult(alt, redirectNotice);
		}
		return finalizePullResult(
			{
				ok: true,
				url: finalUrl,
				title: result.title || "",
				content: defContent,
				author: result.author || undefined,
				published: result.published || undefined,
				site: result.site || undefined,
				language: result.language || undefined,
				wordCount: result.wordCount || undefined,
			},
			redirectNotice,
		);
	} catch {
		const { title, content } = fallbackExtract(cleaned);
		// Last resort: if even the fallback is thin, try alternate links
		if (wordCount(content) < MIN_ALTERNATE_FALLBACK_WORDS) {
			const alt = await tryAlternateLinks(text, finalUrl, _opts);
			if (alt) return finalizePullResult(alt, redirectNotice);
		}
		return finalizePullResult(
			{ ok: true, url: finalUrl, title, content, rawHtml },
			redirectNotice,
		);
	}
}

async function pullPage(
	url: string,
	opts?: FetchOpts,
	_redirectCount = 0,
	htmlOverride?: string,
): Promise<PullResult> {
	let redirectNotice: string | undefined;

	// ── 0. HTML override path (used by browser mode / Playwright fallback) ──
	if (htmlOverride !== undefined) {
		const text = htmlOverride;
		const finalUrl = url;

		// ── 7. Client-side meta redirect (only for HTML) ──
		if (_redirectCount < MAX_CLIENT_REDIRECTS) {
			const redirectTarget = extractClientSideRedirect(text, finalUrl);
			if (redirectTarget) {
				return pullPage(redirectTarget, opts, _redirectCount + 1, undefined);
			}
		}

		// ── 8. HTML content pipeline ──
		return runHtmlPipeline(text, finalUrl, url, opts, redirectNotice);
	}

	// ── 1. Special-cases (GitHub, SonarCloud) ──
	const gh = await pullGitHub(url);
	if (gh) return finalizePullResult(gh, redirectNotice);

	const sc = await pullSonarCloud(url);
	if (sc) return finalizePullResult(sc, redirectNotice);

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
		const headBytes = binPeek.buffer.subarray(0, 1024);
		const isBinary =
			headBytes.includes(0) ||
			headBytes.toString("utf8").replace(/[\x20-\x7E\n\r\t]/g, "").length >
				headBytes.length * 0.3;
		if (isBinary && !url.toLowerCase().endsWith(".pdf")) {
			const dl = await downloadToTemp(binPeek.buffer, "", "", url);
			return finalizePullResult(dl, redirectNotice);
		}
	} else if (!binPeek) {
		return {
			ok: false,
			url,
			error: "Request failed",
			errorInfo: {
				message: "Request failed",
				code: "network_error",
				phase: "connecting",
				retryable: true,
			},
		};
	}

	// ── 3. Standard text fetch ──
	let res = await smartFetch(url, {
		...opts,
		headers: {
			Accept:
				"text/html,application/xhtml+xml,application/json;q=0.9,text/markdown;q=0.8,*/*;q=0.7",
			...opts?.headers,
		},
	});
	if (!res)
		return {
			ok: false,
			url,
			error: "Request failed",
			errorInfo: {
				message: "Request failed",
				code: "network_error",
				phase: "loading",
				retryable: true,
			},
		};
	if (res.status >= 400) {
		// Cloudflare challenge detection: retry with alternate UA before giving up.
		// CF challenges return 403 with distinctive markers in the first ~4KB.
		const isCf403 =
			res.status === 403 &&
			(res.headers.get("cf-mitigated") === "challenge" ||
				/just a moment|cf-chl-bypass/i.test(res.text.slice(0, 4096)));
		if (isCf403) {
			const cfRes = await smartFetch(url, {
				...opts,
				headers: {
					Accept:
						"text/html,application/xhtml+xml,application/json;q=0.9,text/markdown;q=0.8,*/*;q=0.7",
					"User-Agent":
						"Mozilla/5.0 (compatible; OpenCode/1.0; +https://opencode.ai)",
					...opts?.headers,
				},
			});
			if (cfRes && cfRes.status < 400) {
				// Cloudflare bypassed — resume normal pipeline with the successful response
				res = cfRes;
			}
		}
		return {
			ok: false,
			url,
			error: `HTTP ${res.status}`,
			errorInfo: {
				message: `Server responded with HTTP ${res.status}`,
				code: "http_error",
				phase: "loading",
				retryable: res.status >= 500 || res.status === 429,
				statusCode: res.status,
			},
		};
	}

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
	} catch {
		/* ignore */
	}

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
		return finalizePullResult(
			formatJsonContent(text, finalUrl),
			redirectNotice,
		);
	}

	// ── 6. Plain text (txt, logs, configs) → wrap in code block ──
	if (ct.includes("text/plain") || ct.includes("text/markdown")) {
		const title =
			text.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
			new URL(finalUrl).pathname.split("/").pop() ||
			finalUrl;
		// If it looks like markdown already, return as-is
		if (MARKDOWN_SIGNAL.test(text) || ct.includes("text/markdown")) {
			return finalizePullResult(
				{ ok: true, url: finalUrl, title, content: text },
				redirectNotice,
			);
		}
		// Plain text → wrap in code block
		const truncated =
			text.length > 50000 ? text.slice(0, 50000) + "\n\n[... truncated]" : text;
		return finalizePullResult(
			{
				ok: true,
				url: finalUrl,
				title,
				content: "```\n" + truncated + "\n```",
			},
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
	return runHtmlPipeline(text, finalUrl, url, opts, redirectNotice);
}

// ─── Enhanced pull page with verticals, data islands, bot detection, modes ───

async function pullPageEnhanced(
	url: string,
	opts?: FetchOpts,
	_redirectCount = 0,
): Promise<PullResult> {
	const mode = opts?.mode ?? "auto";

	// ── 0. Vertical extractors (API-first for known sites) ──
	const vertical = await runVerticalExtractor(
		url,
		async (u) => {
			const r = await smartFetch(u, {
				...opts,
				headers: { Accept: "application/json", ...opts?.headers },
			});
			if (!r || r.status >= 400) return null;
			try {
				return JSON.parse(r.text);
			} catch {
				return null;
			}
		},
		async (u) => {
			const r = await smartFetch(u, opts);
			if (!r || r.status >= 400) return null;
			return r.text;
		},
		async (u) => {
			const r = await smartFetch(u, opts);
			if (!r || r.status >= 400) return null;
			return r.text;
		},
	);
	if (vertical) {
		return finalizePullResult({
			ok: true,
			url,
			title: vertical.title,
			content: `> via ${findVerticalExtractor(url) ?? "vertical extractor"}\n\n${vertical.content}`,
		});
	}

	// ── 1. Fast path (default / auto) ──
	if (mode === "fast" || mode === "auto" || mode === "fingerprint") {
		const result = await pullPage(url, opts, _redirectCount);

		// Structured bot-block detection
		if (result.ok && result.content) {
			const botCheck = detectBotBlock(result.content);
			if (botCheck.blocked) {
				// If blocked and mode is auto, try escalation
				if (mode === "auto" && botCheck.retryable) {
					// Try fingerprint mode first (alternate browser profiles)
					const fallbackBrowsers = ["firefox_147", "safari_26", "edge_145"];
					for (const fb of fallbackBrowsers) {
						const fbResult = await pullPage(
							url,
							{ ...opts, browser: fb },
							_redirectCount,
						);
						if (fbResult.ok && fbResult.content) {
							const fbBotCheck = detectBotBlock(fbResult.content);
							if (!fbBotCheck.blocked) {
								return fbResult;
							}
						}
					}
					// Last resort: browser mode with Playwright
					const pwHtml = await fetchWithPlaywright(url);
					if (pwHtml) {
						const pwResult = await pullPage(url, opts, _redirectCount, pwHtml);
						if (pwResult.ok && pwResult.content) {
							const pwBotCheck = detectBotBlock(pwResult.content);
							if (!pwBotCheck.blocked) {
								return pwResult;
							}
						}
					}
				}
				// Return structured blocked result
				return {
					ok: false,
					url,
					error: `[BLOCKED] ${botCheck.message} (type: ${botCheck.blockerType}, confidence: ${Math.round(botCheck.confidence * 100)}%)`,
					errorInfo: {
						message: botCheck.message,
						code: "blocked",
						phase: "loading",
						retryable: botCheck.retryable,
					},
				};
			}

			// SPA data-island recovery (try before returning thin content)
			if (result.content.length < 5000) {
				const islands = extractDataIslands(result.content);
				if (islands.found && islands.markdown) {
					return finalizePullResult({
						...result,
						content: `> Data islands recovered from: ${islands.islands.map((i) => i.source).join(", ")}\n\n${islands.markdown}`,
					});
				}
			}
		}

		return result;
	}

	// ── 2. Browser mode (Playwright) ──
	if (mode === "browser") {
		const pwHtml = await fetchWithPlaywright(url);
		if (pwHtml) {
			// Feed Playwright HTML through the normal pipeline
			return pullPage(url, opts, _redirectCount, pwHtml);
		}
		return {
			ok: false,
			url,
			error:
				"Browser mode failed: Playwright not available or page load failed",
			errorInfo: {
				message: "Playwright browser rendering failed",
				code: "processing_error",
				phase: "loading",
				retryable: false,
			},
		};
	}

	// Fallback
	return pullPage(url, opts, _redirectCount);
}

// ─── Write ──────────────────────────────────────────────────────────

function frontmatter(
	title: string,
	url: string,
	metadata?: {
		author?: string;
		published?: string;
		site?: string;
		language?: string;
		wordCount?: number;
	},
): string {
	let fm = `---\ntitle: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nurl: "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	if (metadata?.author)
		fm += `\nauthor: "${metadata.author.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	if (metadata?.published) fm += `\npublished: "${metadata.published}"`;
	if (metadata?.site)
		fm += `\nsite: "${metadata.site.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	if (metadata?.language) fm += `\nlanguage: "${metadata.language}"`;
	if (metadata?.wordCount) fm += `\nword_count: ${metadata.wordCount}`;
	fm += "\n---\n\n";
	return fm;
}

function pageToPath(page: Page): string {
	let p = new URL(page.url).pathname;
	if (p.endsWith("/")) p += "index";
	p = p.replace(/\.html?$/, "").replace(/^\//, "");
	if (!p.endsWith(".md")) p += ".md";
	return p;
}

// ─── Link Rewriting ─────────────────────────────────────────────────

/** Normalize a URL to the same stem used by pageToPath for matching. */
function urlStem(url: string): string {
	try {
		const u = new URL(url);
		let p = u.origin + u.pathname;
		if (p.endsWith("/")) p += "index";
		p = p.replace(/\.html?$/, "");
		return p;
	} catch {
		return url;
	}
}

/** Rewrite absolute links between pulled pages to relative .md paths. */
function rewriteLinks(
	markdown: string,
	pageUrlToPath: Map<string, string>,
	currentPath: string,
): string {
	// Build a lookup keyed by normalized URL stem
	const stemToPath = new Map<string, string>();
	for (const [url, path] of pageUrlToPath) {
		stemToPath.set(urlStem(url), path);
	}

	return markdown.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, text, url) => {
		// Skip anchor-only, mailto, javascript, data links
		if (/^(#|mailto:|javascript:|data:)/.test(url)) return match;

		const key = urlStem(url);
		const target = stemToPath.get(key);

		if (target && target !== currentPath) {
			const fromDir = dirname(currentPath);
			let relPath = relative(fromDir, target).replace(/\\/g, "/");
			if (!relPath.startsWith(".")) relPath = "./" + relPath;

			// Preserve fragment from the original link
			try {
				const hash = new URL(url, "http://x").hash;
				if (hash) relPath += hash;
			} catch {
				/* ignore */
			}

			return `[${text}](${relPath})`;
		}

		return match;
	});
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
	loadContentCacheFromDisk();

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
			mode: Type.Optional(
				Type.String({
					description: `Scrape mode: "auto" (default), "fast", "fingerprint", or "browser". Auto escalates from fast → fingerprint → browser when bot protection is detected.`,
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
			proxy: Type.Optional(
				Type.String({
					description:
						"Proxy URL (e.g. http://user:pass@host:port or socks5://host:port)",
				}),
			),
			cacheTtlSeconds: Type.Optional(
				Type.Number({
					description: "Opt-in cache TTL in seconds. Omit for fresh fetches.",
				}),
			),
			compile: Type.Optional(
				Type.Boolean({
					description: "Compile batch results into a single context package.",
				}),
			),
			prune: Type.Optional(
				Type.Number({
					description: "Prune markdown to token budget (e.g. 3000).",
				}),
			),
			interactive: Type.Optional(
				Type.Boolean({
					description: "Extract interactive elements as numbered refs.",
				}),
			),
			start_index: Type.Optional(
				Type.Number({
					description:
						"Return content starting from this character index (0-based). Use with max_length for pagination.",
				}),
			),
			max_length: Type.Optional(
				Type.Number({
					description:
						"Maximum characters to return (default: unlimited). Use with start_index for pagination.",
				}),
			),
		}) as any,

		async execute(_toolCallId: string, params: any): Promise<any> {
			const targets: string[] = params.urls ?? (params.url ? [params.url] : []);
			if (!targets.length) {
				throw new Error("Provide either 'url' or 'urls'");
			}

			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const proxy = params.proxy as string | undefined;

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

					const mode = (params.mode as ScrapeMode) ?? "auto";
					const interactive = params.interactive === true;
					const pruneTokens = params.prune as number | undefined;
					const startIndex = params.start_index as number | undefined;
					const maxLength = params.max_length as number | undefined;
					const result = await pullPageEnhanced(url.href, {
						browser,
						os,
						proxy,
						mode,
					});
					if (!result.ok) {
						return {
							ok: false,
							error: result.error ?? "Fetch failed",
							url: url.href,
						};
					}

					// Post-processing: interactive extraction + pagination + token pruning
					let contentBody = result.content ?? "";

					if (interactive && result.rawHtml) {
						const interactables = extractInteractables(result.rawHtml);
						const actionsSection = formatInteractablesSection(interactables);
						if (actionsSection) {
							contentBody = actionsSection + "\n" + contentBody;
						}
					}

					const totalChars = contentBody.length;

					// Apply pagination (start_index + max_length) before pruning
					if (startIndex !== undefined || maxLength !== undefined) {
						const si = startIndex ?? 0;
						const ml =
							maxLength !== undefined && maxLength > 0
								? maxLength
								: totalChars - si;
						const end = Math.min(si + ml, totalChars);
						if (si < totalChars) {
							contentBody = contentBody.slice(si, end);
							contentBody += `\n\n_(chars ${si + 1}-${end} of ${totalChars} total)_`;
						} else {
							contentBody = `_(start_index ${si} exceeds content length ${totalChars})_`;
						}
					}

					const tokenCount = estimateTokens(contentBody);

					if (pruneTokens && pruneTokens > 0 && tokenCount > pruneTokens) {
						const pruned = pruneMarkdown(contentBody, pruneTokens);
						contentBody = pruned.content;
					}

					const markdown =
						frontmatter(result.title || url.pathname, result.url!, {
							author: result.author,
							published: result.published,
							site: result.site,
							language: result.language,
							wordCount: result.wordCount,
						}) + contentBody;

					await mkdir(dirname(outPath), { recursive: true });
					await writeFile(outPath, markdown, "utf8");

					storeContent(result.url!, result.title, markdown, undefined, {
						author: result.author,
						published: result.published,
						site: result.site,
						language: result.language,
						wordCount: result.wordCount,
					});

					const responseId = await storeResult(
						result.url!,
						markdown,
						"webfetch",
						{
							title: result.title || url.pathname,
							ttlSeconds: params.cacheTtlSeconds,
						},
					);

					return {
						ok: true,
						url: result.url!,
						title: result.title || url.pathname,
						outPath,
						length: markdown.length,
						responseId,
					};
				},
			);

			const okResults = results.filter((r) => r.ok);
			const errResults = results.filter((r) => !r.ok);

			if (targets.length === 1) {
				const r = results[0]!;
				if (!r.ok) throw new Error(r.error ?? "Fetch failed");
				const preview = await readFile(r.outPath!, "utf8");

				// ── Google AI summarization (skip for API-sourced content) ──
				let summary: string | null = null;
				let summarized = false;
				// Skip AI summarization for:
				//   1. Any GitHub URL (github.com, raw.githubusercontent.com, gist.github.com)
				//      — catches cases where pullGitHub returns ok:false and content has no marker
				//   2. Any content with "> via " prefix (GitHub, SonarCloud, and ALL vertical extractors)
				//      — catches YouTube, npm, PyPI, Reddit, HN, arXiv, docs sites
				//   3. Legacy explicit markers (backward compat)
				const ghHostnames = [
					"github.com",
					"raw.githubusercontent.com",
					"gist.github.com",
				];
				const isGitHubUrl = ghHostnames.some((h) => r.url?.includes(h));
				// "? via " prefix is set by all pipeline interceptors: GitHub ("? via GitHub"),
				// SonarCloud ("? via SonarCloud API"), and all vertical extractors ("? via youtube", etc.)
				const skipSummary = isGitHubUrl || preview.includes("> via ");

				const searchCtx = getSearchContext()?.query;

				if (!skipSummary && cdpAvailableGA()) {
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
					`Response ID: ${(r as any).responseId}`,
					"\n---\n",
					displayContent,
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: {
						outPath: r.outPath,
						title: r.title,
						url: r.url,
						responseId: (r as any).responseId,
						browser,
						os,
						proxy,
						truncated: !summarized && !isShort,
						summarized,
						fullLength: preview.length,
						summaryLength: summary?.length,
					},
				};
			}

			// Compile context package if requested
			let packagePath: string | undefined;
			if (params.compile && okResults.length > 0) {
				const pages = await Promise.all(
					okResults.map(async (r) => {
						const content = await readFile(r.outPath!, "utf8");
						return {
							url: r.url,
							title: r.title || r.url,
							content,
							relPath: r.outPath!.replace(BASE_TEMP, "").replace(/^\\/, ""),
						};
					}),
				);
				const pkg = await compileContextPackage(
					pages,
					join(BASE_TEMP, "packages"),
					{
						packageName: `webfetch-${Date.now()}`,
					},
				);
				packagePath = pkg.packagePath;
			}

			// Batch result
			const lines = [
				`Fetched ${okResults.length}/${targets.length} URLs:`,
				packagePath ? `\n📦 Compiled package: ${packagePath}` : "",
				"",
				...okResults.map(
					(r) =>
						`✓ ${r.title} — ${r.url}\n  → ${r.outPath} (${r.length} chars)${(r as any).responseId ? `\n  ID: ${(r as any).responseId}` : ""}`,
				),
				...(errResults.length
					? ["", "Errors:", ...errResults.map((r) => `✗ ${r.url}: ${r.error}`)]
					: []),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { results, browser, os, packagePath },
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

	// ─── webresult tool ──────────────────────────────────────────────
	pi.registerTool({
		name: "aio-webresult",
		label: "Get Stored Result",
		description:
			"Retrieve a previously fetched web scrape result by response ID. Results are stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Retrieve a stored web scrape by response ID",
		promptGuidelines: [
			"Use aio-webresult when you need to retrieve a previously fetched result by its response ID.",
			"Response IDs are shown after every successful aio-webfetch call.",
			"Use aio-webcontent to retrieve content by URL instead of by ID.",
		],
		parameters: Type.Object({
			id: Type.String({
				description: "Response ID from a previous webfetch call",
			}),
		}) as any,

		async execute(_toolCallId: string, params: any): Promise<any> {
			const stored = await getResult(params.id);
			if (!stored) {
				// Try listing to give the user context
				const recent = (await listResults()).slice(0, 5);
				return {
					content: [
						{
							type: "text",
							text: `No result found for ID: ${params.id}\n\nRecent results:\n${recent.map((r) => `  - ${r.id}: ${r.url} (${r.source})`).join("\n") || "  (none)"}`,
						},
					],
				};
			}
			const text = [
				`Retrieved result ${stored.id}`,
				`URL: ${stored.url}`,
				`Tool: ${stored.source}`,
				`Length: ${stored.content.length} chars`,
				"\n---\n",
				stored.content.length > 50000
					? stored.content.slice(0, 50000) + "\n\n[... truncated]"
					: stored.content,
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					id: stored.id,
					url: stored.url,
					tool: stored.source,
					timestamp: stored.createdAt,
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
			"Search the web using DuckDuckGo, Brave, Yahoo, Bing, and Google in parallel (no API keys required). Returns a compact list of results with title, URL, and snippet. Capped at ~7s — returns whatever is available by then.",
		promptSnippet: "Search the web for current information or references",
		promptGuidelines: [
			"Use aio-websearch when the user asks a question that requires current or external information not in your training data.",
			"After getting search results, use aio-webfetch or aio-webpull to retrieve the full content of the most relevant result.",
			"Runs DDG/Brave/Yahoo/Bing + Google in parallel. Google requires headless Chrome (auto-launched). Set google: false to skip.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (e.g. 'React Server Components RFC')",
			}),
			max: Type.Optional(
				Type.Number({
					description:
						"Max results to request from each engine (default: 15). Up to 25 returned after dedup across all engines.",
					default: 15,
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
			setSearchContext(query);
			const max = params.max ?? 15;
			const useGoogle = params.google ?? true;

			// ── Run 4 HTTP engines + Google CDP in parallel with 7s cap ──
			const SEARCH_TIMEOUT = 7000;

			const httpPromise = searchWeb(query).then(
				(r) => ({
					source: "http" as const,
					results: r.results.slice(0, max),
					httpCounts: {
						ddg: r.ddgCount,
						brave: r.braveCount,
						yahoo: r.yahooCount,
						bing: r.bingCount,
					},
				}),
				() => ({
					source: "http" as const,
					results: [] as SearchResult[],
					httpCounts: { ddg: 0, brave: 0, yahoo: 0, bing: 0 },
				}),
			);

			let googlePromise: Promise<{
				source: "google";
				results: SearchResult[];
			}>;
			if (useGoogle && cdpAvailableGA() && isProviderAvailable("google")) {
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
					} catch (err) {
						recordProviderNetworkFailure("google", String(err));
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
			const allPromise = Promise.all([httpPromise, googlePromise]);
			const result = await Promise.race([allPromise, timeoutPromise]);

			let httpResults: SearchResult[] = [];
			let googleResults: SearchResult[] = [];
			let httpCounts = { ddg: 0, brave: 0, yahoo: 0, bing: 0 };

			if (result) {
				httpResults = result[0].results;
				googleResults = result[1].results;
				httpCounts = (result[0] as any).httpCounts ?? httpCounts;
			} else {
				// Timeout hit — grab whatever settled already
				const settled = await Promise.allSettled([httpPromise, googlePromise]);
				if (settled[0].status === "fulfilled") {
					httpResults = settled[0].value.results;
					httpCounts = (settled[0].value as any).httpCounts ?? httpCounts;
				}
				if (settled[1].status === "fulfilled")
					googleResults = settled[1].value.results;
			}

			// ── Merge, score, and rank by engine consensus + authority ──
			const buckets = buildResultBuckets(httpResults, "http");
			// Re-bucket Google results under their own engine name for scoring
			for (const r of googleResults) {
				const list = buckets.get(r.url) || [];
				list.push({
					result: r,
					engine: "google",
					weight: ENGINE_WEIGHTS.google,
				});
				buckets.set(r.url, list);
			}

			const scored = scoreAndRankResults(buckets);
			const merged = scored.map((s) => s.result);

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

			const MAX_TOTAL = 25;
			const limited = merged.slice(0, MAX_TOTAL);

			// Determine which engines contributed
			const engineLabel: string[] = [];
			if (httpCounts.ddg) engineLabel.push("DDG");
			if (httpCounts.brave) engineLabel.push("Brave");
			if (httpCounts.yahoo) engineLabel.push("Yahoo");
			if (httpCounts.bing) engineLabel.push("Bing");
			if (googleResults.length) engineLabel.push("Google");
			if (!engineLabel.length) engineLabel.push("HTTP");

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
					...httpCounts,
					googleCount: googleResults.length,
				},
			};
		},
	});

	// ─── webmap tool ─────────────────────────────────────────────────
	pi.registerTool({
		name: "aio-webmap",
		label: "Web Map",
		description:
			"Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, llms.txt, and crawling without fetching content. Returns structured URLs grouped by source.",
		promptSnippet: "Discover pages on a website without fetching content",
		promptGuidelines: [
			"Use aio-webmap to discover all pages on a site before a full pull.",
			"Returns URLs grouped by discovery source: sitemaps, robots.txt, navigation, llms.txt, crawl.",
			"Use aio-webpull to actually fetch and convert the discovered pages.",
		],
		parameters: Type.Object({
			url: Type.String({
				description:
					"URL to discover pages for (e.g. https://docs.example.com)",
			}),
			max: Type.Optional(
				Type.Number({
					description: "Max URLs to discover (default: 100)",
					default: 100,
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

		async execute(_toolCallId, params) {
			let raw = params.url;
			if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new Error(`Bad URL: ${params.url}`);
			}

			const max = params.max ?? 100;
			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const fetchOpts: FetchOpts = { browser, os };

			// Discover pages (same pipeline as webpull, just returns URLs)
			const urls = await discover(url.href, max, fetchOpts);

			// Also try llms.txt (LLM-friendly index)
			let llmsUrls: string[] = [];
			try {
				const llmsRes = await smartFetch(`${url.origin}/llms.txt`, fetchOpts);
				if (llmsRes && llmsRes.status < 400) {
					llmsUrls = llmsRes.text
						.split(/\n/)
						.filter((l) => /^https?:\/\//i.test(l.trim()))
						.map((l) => l.trim());
				}
			} catch {
				/* ignore */
			}

			const text = [
				`🌐 Site map for ${url.href}`,
				`\nDiscovered ${urls.length} pages via sitemaps/robots/nav/crawl.`,
				llmsUrls.length > 0
					? `\nFound ${llmsUrls.length} entries in llms.txt`
					: "",
				"\n\nFirst 50 pages:",
				...urls.slice(0, 50).map((u, i) => `${i + 1}. ${u}`),
				urls.length > 50 ? `\n... and ${urls.length - 50} more` : "",
				llmsUrls.length > 0
					? `\n\nllms.txt entries:\n${llmsUrls.map((u) => `  - ${u}`).join("\n")}`
					: "",
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					url: url.href,
					totalUrls: urls.length,
					urls,
					llmsUrls,
					browser,
					os,
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
			mode: Type.Optional(
				Type.String({
					description: `Scrape mode: "auto" (default), "fast", "fingerprint", or "browser". Auto escalates when bot protection is detected.`,
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
			proxy: Type.Optional(
				Type.String({
					description:
						"Proxy URL (e.g. http://user:pass@host:port or socks5://host:port)",
				}),
			),
			compile: Type.Optional(
				Type.Boolean({
					description:
						"Compile pulled pages into a single context package after completion.",
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
			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const proxy = params.proxy as string | undefined;
			const mode = (params.mode as ScrapeMode) ?? "auto";
			const compile = (params.compile as boolean) ?? false;
			const fetchOpts: FetchOpts = { browser, os, proxy, mode };

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
			const pageUrlToPath = new Map<string, string>();

			await runInBatches(urls, concurrency, async (pageUrl, _i) => {
				if (signal?.aborted) return;

				const result = await pullPageEnhanced(pageUrl, fetchOpts);
				if (!result.ok) {
					err++;
					errors.push(`${pageUrl}: ${result.error}`);
					return;
				}

				const page: Page = {
					url: result.url!,
					title: result.title || new URL(result.url!).pathname,
					markdown:
						frontmatter(result.title || "", result.url!, {
							author: result.author,
							published: result.published,
							site: result.site,
							language: result.language,
							wordCount: result.wordCount,
						}) + (result.content ?? ""),
				};

				const rel = await writePage(page, outDir);
				files.push(rel);
				pageUrlToPath.set(page.url, rel);
				ok++;

				storeContent(result.url!, result.title, page.markdown, undefined, {
					author: result.author,
					published: result.published,
					site: result.site,
					language: result.language,
					wordCount: result.wordCount,
				});

				// Stream each page as it completes so the agent can inspect pages while pull continues
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `⏳ ${ok + err}/${urls.length} pages processed — pulled ${result.title || page.url} → ${rel}`,
						},
					],
					details: {
						stage: "stream",
						ok,
						err,
						total: urls.length,
						file: rel,
						title: result.title,
						url: result.url,
						wordCount: result.wordCount,
					},
				});
			});

			// Rewrite absolute links between pulled pages to relative .md paths
			if (pageUrlToPath.size > 1) {
				let rewrites = 0;
				for (const rel of files) {
					const full = join(outDir, rel);
					try {
						const md = await readFile(full, "utf8");
						const rewritten = rewriteLinks(md, pageUrlToPath, rel);
						if (rewritten !== md) {
							await writeFile(full, rewritten, "utf8");
							rewrites++;
						}
					} catch {
						/* best effort — don't break the pull for link rewriting */
					}
				}
				if (rewrites > 0) {
					onUpdate?.({
						content: [
							{ type: "text", text: `🔗 Rewrote links in ${rewrites} files` },
						],
						details: { stage: "rewrite", filesRewritten: rewrites },
					});
				}
			}

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

			// Compile context package if requested
			let packagePath: string | undefined;
			if (compile && ok > 0) {
				try {
					const pages = await Promise.all(
						files.map(async (rel) => {
							const filePath = join(outDir, rel);
							try {
								const content = await readFile(filePath, "utf8");
								return { url: rel, title: rel, content, relPath: rel };
							} catch {
								return null;
							}
						}),
					);
					const validPages = pages.filter((p) => p !== null);
					if (validPages.length > 0) {
						const pkg = await compileContextPackage(
							validPages,
							join(outDir, "..", "packages"),
							{
								packageName: `${url.hostname}-${Date.now()}`,
							},
						);
						packagePath = pkg.packagePath;
					}
				} catch {
					// best effort
				}
			}

			return {
				content: [
					{
						type: "text",
						text:
							summary +
							(packagePath
								? `
📦 Compiled package: ${packagePath}`
								: ""),
					},
				],
				details: {
					outDir,
					total: urls.length,
					ok,
					err,
					files,
					errors,
					browser,
					os,
					proxy,
					packagePath,
				},
			};
		},
	});
}
