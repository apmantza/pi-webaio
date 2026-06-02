// ─── Paywall bypass ────────────────────────────────────────────────
// Implements the Bypass Paywalls Clean (BPC) strategy catalog. For each
// domain we know about, picks the cheapest trick that gets past the
// paywall: bot UA, referer, archive.org Wayback, or a Playwright run
// that aborts the paywall vendor's JS.
//
// References:
//   - BPC extension:        https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean
//   - bpc-fetch (Python):   https://github.com/Sophomoresty/bpc-fetch
//
// All public functions are pure / side-effect free except for the
// network-touching helpers (tryBotUAFetch, tryArchiveOrgFetch,
// tryArchivePhFetch). Detection and strategy resolution are pure and
// cheap — safe to call on every page load.

import { fetch as wreqFetch } from "wreq-js";
import { fetchWithPlaywright, buildHeaders } from "./fetch.ts";
import { PAYWALL_SITES, PAYWALL_GROUPS } from "./paywall-sites.ts";

// ─── Types ─────────────────────────────────────────────────────────

export type BypassStrategyType =
	| "ua:googlebot" // Spoof Googlebot UA — most common, ~85 sites
	| "ua:bingbot" // Spoof bingbot UA
	| "ua:facebookbot" // Spoof facebookexternalhit UA
	| "ua:custom" // Custom UA string per-site
	| "referer:google" // Google search referer header
	| "block_js" // Playwright with paywall JS blocked — ~425 sites
	| "archive" // Fetch from archive.org / archive.is — ~274 sites
	| "cookies" // Strip tracking cookies — ~138 sites
	| "archive_first" // Try archive before primary (cached versions)
	| "auto"; // Pick the cheapest strategy at runtime

export interface PaywallStrategy {
	/** Ordered list of strategies to attempt. */
	steps: BypassStrategyType[];
	/** Patterns Playwright should abort (e.g. ["piano.io", "*.tinypass.com"]). */
	blockScripts?: string[];
	/** DOM CSS to apply after page load (hide paywall divs, set overflow). */
	domOverride?: boolean;
	/** Custom UA string (only for "ua:custom"). */
	useragentCustom?: string;
	/** Whether to allow cookies (false = send Cookie: header empty). */
	allowCookies?: boolean;
	/** Cookies to drop by name (tracking cookies). */
	dropCookies?: string[];
	/** Path → custom strategy override (e.g. subdomain rules). */
	overrides?: Record<string, Partial<PaywallStrategy>>;
}

export interface PaywallDetection {
	/** Did the content look paywalled? */
	paywalled: boolean;
	/** Confidence 0..1. */
	confidence: number;
	/** Which marker strings matched. */
	matchedMarkers: string[];
	/** Best guess at the paywall vendor. */
	vendor?:
		| "piano"
		| "tinypass"
		| "poool"
		| "zephr"
		| "pelcro"
		| "sophi"
		| "generic";
	/** Whether the content has *some* article text but was truncated. */
	truncated?: boolean;
}

// ─── Bot UAs (from bpc-fetch strategy.py) ──────────────────────────

export const UA_GOOGLEBOT =
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
export const UA_BINGBOT =
	"Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
export const UA_FACEBOOKBOT =
	"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
export const UA_INSPECTIONTOOL =
	"Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0)";

// ─── Paywall marker detection ──────────────────────────────────────
// Subset of bpc-fetch's _is_paywalled() — phrases that appear in the
// page body when a paywall gate is up. All lowercased.

export const PAYWALL_MARKERS: Array<{
	text: string;
	weight: number;
	vendor?: PaywallDetection["vendor"];
}> = [
	// Generic paywall prompts (high confidence)
	{ text: "subscribe to continue reading", weight: 0.9 },
	{ text: "log in or create an account to continue", weight: 0.9 },
	{ text: "sign in to continue", weight: 0.7 },
	{ text: "create a free account to continue", weight: 0.9 },
	{ text: "this article is for subscribers", weight: 0.95 },
	{ text: "to read the full story", weight: 0.6 },
	{ text: "register for free to continue reading", weight: 0.9 },
	{ text: "already a subscriber? sign in", weight: 0.8 },
	{ text: "want to read more?", weight: 0.5 },
	{ text: "unlock this article", weight: 0.9 },
	{ text: "premium content", weight: 0.4 }, // low weight — appears in legit pages too
	{ text: "members only", weight: 0.6 },
	{ text: "subscribe to read", weight: 0.7 },
	{ text: "to continue reading, please subscribe", weight: 0.9 },
	{ text: "you have reached your limit of free articles", weight: 0.85 },
	{ text: "enjoying our latest content?", weight: 0.6 },
	{ text: "access the most recent journalism", weight: 0.6 },
	{ text: "explore the latest features & opinion", weight: 0.5 },

	// Vendor-specific markers (very high confidence)
	{ text: "piano.io", weight: 0.95, vendor: "piano" },
	{ text: "tinypass.com", weight: 0.95, vendor: "tinypass" },
	{ text: "poool.fr", weight: 0.95, vendor: "poool" },
	{ text: "zephr.com", weight: 0.95, vendor: "zephr" },
	{ text: "pelcro.com", weight: 0.95, vendor: "pelcro" },
	{ text: "sophi.io", weight: 0.9, vendor: "sophi" },
	{ text: "cxense.com", weight: 0.85, vendor: "sophi" },
];

// ─── Paywall detection ─────────────────────────────────────────────

const PAYWALL_SAMPLE_SIZE = 16000; // first 16KB is enough — markers are near top

export function detectPaywall(text: string): PaywallDetection {
	if (!text) {
		return { paywalled: false, confidence: 0, matchedMarkers: [] };
	}

	const sample = text.slice(0, PAYWALL_SAMPLE_SIZE).toLowerCase();

	// Truncation detection: if the article ends with a "..." or short
	// paragraph after <article>, it's likely a soft paywall that
	// returns the first ~2 paragraphs.
	const truncated = detectTruncation(text);

	const matchedMarkers: string[] = [];
	let totalWeight = 0;
	let vendor: PaywallDetection["vendor"] | undefined;
	let confidence = 0;

	for (const marker of PAYWALL_MARKERS) {
		if (sample.includes(marker.text)) {
			matchedMarkers.push(marker.text);
			totalWeight += marker.weight;
			if (marker.vendor && !vendor) vendor = marker.vendor;
		}
	}

	// A vendor-specific marker (e.g. "piano.io") is a hard signal
	// even in very short content — the script tag alone is enough.
	// General text markers (e.g. "subscribe to continue reading")
	// still need enough content to be meaningful.
	const hasContent = text.length >= 200 || !!vendor;

	if (totalWeight === 0 && !truncated) {
		return { paywalled: false, confidence: 0, matchedMarkers: [] };
	}
	if (!hasContent) {
		return { paywalled: false, confidence, matchedMarkers };
	}

	// Two or more markers, or a single vendor-specific marker, is
	// very strong evidence. Truncation alone is weak evidence.
	confidence = Math.min(totalWeight, 1.0);
	if (truncated && totalWeight < 0.3) confidence += 0.25;
	if (vendor) confidence = Math.max(confidence, 0.8);

	return {
		paywalled: confidence >= 0.45,
		confidence,
		matchedMarkers,
		vendor,
		truncated,
	};
}

function detectTruncation(text: string): boolean {
	// Strong signal: the HTML ends with a paywall curtain element.
	const tail = text.slice(-2000).toLowerCase();
	if (
		tail.includes("</article>") &&
		(tail.includes("paywall") ||
			tail.includes("subscribe") ||
			tail.includes("sign in") ||
			tail.includes("register"))
	) {
		return true;
	}
	// Weak signal: no closing </body> or </html> but lots of content.
	// (e.g. server returned a JSON paywall response but with a long
	// body of repeated text)
	return false;
}

// ─── Strategy lookup ───────────────────────────────────────────────

const GROUP_CACHE = new Map<string, PaywallStrategy | null>();

/**
 * Resolve a URL to its paywall strategy, if any. Returns null if the
 * domain is not in the catalog (caller should fall back to "auto").
 */
export function findStrategy(url: string): PaywallStrategy | null {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return null;
	}

	// Check direct cache
	if (GROUP_CACHE.has(hostname)) return GROUP_CACHE.get(hostname)!;

	// Direct hit
	const direct = PAYWALL_SITES[hostname];
	if (direct) {
		GROUP_CACHE.set(hostname, direct);
		return direct;
	}

	// Group member: many newspaper groups share a single strategy
	// across all their regional domains.
	for (const [suffix, strategy] of Object.entries(
		PAYWALL_GROUPS as Record<string, PaywallStrategy>,
	)) {
		if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
			GROUP_CACHE.set(hostname, strategy);
			return strategy;
		}
	}

	// No strategy known — use generic
	const generic = GENERIC_STRATEGY;
	GROUP_CACHE.set(hostname, generic);
	return generic;
}

/**
 * Check if a URL has a SPECIFIC paywall strategy (curated or group
 * member). Returns false for sites that would only get the GENERIC_STRATEGY
 * fallback. Used to gate the 403/401 bypass trigger so we don't try to
 * bypass non-paywall 403s (e.g. blocked by CDN, geo-restriction, etc.).
 * Handles mobile subdomains (m.example.com, mobile.example.com, etc.) by
 * matching the base domain in PAYWALL_SITES.
 */
export function isKnownPaywallSite(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return false;
	}
	if (PAYWALL_SITES[hostname]) return true;
	// Match mobile subdomains (m.example.com, mobile.example.com, etc.)
	for (const site of Object.keys(PAYWALL_SITES)) {
		if (hostname === site || hostname.endsWith(`.${site}`)) return true;
	}
	for (const suffix of Object.keys(PAYWALL_GROUPS as Record<string, unknown>)) {
		if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

/**
 * Known paywall vendor script hosts. Aborted in Playwright when a
 * site uses `block_js` strategy. Declared before GENERIC_STRATEGY so
 * the constant can be referenced at module init time.
 */
export const KNOWN_PAYWALL_VENDORS: string[] = [
	"piano.io",
	"*.piano.io",
	"tinypass.com",
	"*.tinypass.com",
	"poool.fr",
	"*.poool.fr",
	"zephr.com",
	"*.zephr.com",
	"pelcro.com",
	"*.pelcro.com",
	"sophi.io",
	"*.sophi.io",
	"cxense.com",
	"*.cxense.com",
	"temptation",
	"px.ads.linkedin.com",
	"shop.nfl.com", // paywall-ish
	"paywall.quantcast.com",
	"*.ampproject.org/v0/amp-access-*.js",
	"*.ampproject.org/v0/amp-subscriptions-*.js",
	"*.cloudflare.com/cdn-cgi/challenge-platform/", // CF paywall overlay
];

/** Default fallback for unknown domains. */
export const GENERIC_STRATEGY: PaywallStrategy = {
	steps: ["archive", "ua:googlebot", "block_js"],
	blockScripts: KNOWN_PAYWALL_VENDORS,
	domOverride: true,
};

// ─── DOM override script (run after page load) ────────────────────

/**
 * Injected via page.evaluate() after the page renders. Hides paywall
 * divs, restores body scrolling, and unlocks truncated article
 * containers.
 */
export const DOM_OVERRIDE_SCRIPT = `
(function() {
  // Hide paywall overlay/gate elements
  var hideSelectors = [
    '[class*="paywall"]',
    '[id*="paywall"]',
    '[class*="Paywall"]',
    '[class*="piano"]',
    '[id*="piano"]',
    '[class*="Piano"]',
    '[class*="gate-"]',
    '[class*="-gate"]',
    '[class*="regwall"]',
    '[class*="reg-wall"]',
    '[class*="registration-wall"]',
    '[class*="subscription-wall"]',
    '[class*="subwall"]',
    '[class*="hardwall"]',
    '[class*="truncated"]',
    '[class*="locked"]',
    '[data-paywall]',
    '[data-testid*="paywall"]',
    'div[class*="overlay"][style*="fixed"]',
    '.tp-modal',
    '.tp-backdrop',
    '.piano-modal',
    '.poool-widget',
    '.zephr-paywall',
    '.qc-cmp2-main',
  ];
  hideSelectors.forEach(function(sel) {
    document.querySelectorAll(sel).forEach(function(el) {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    });
  });

  // Restore scrolling
  document.documentElement.style.overflow = 'auto';
  document.body.style.overflow = 'auto';

  // Unlock article containers (some sites cap height/overflow on the
  // <article> element to hide the rest of the content)
  var unlockSelectors = ['article', '[data-article]', '.article-body',
    '[itemprop="articleBody"]', 'main', '[role="main"]', '.story-body',
    '.post-content', '.entry-content'];
  unlockSelectors.forEach(function(sel) {
    document.querySelectorAll(sel).forEach(function(el) {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('-webkit-mask-image', 'none', 'important');
      el.style.setProperty('mask-image', 'none', 'important');
    });
  });

  // Remove any blur/gradient masks
  var blurSelectors = ['[class*="fade"]', '[class*="gradient"]', '[class*="mask"]'];
  blurSelectors.forEach(function(sel) {
    document.querySelectorAll(sel).forEach(function(el) {
      el.style.setProperty('-webkit-mask-image', 'none', 'important');
      el.style.setProperty('mask-image', 'none', 'important');
      el.style.setProperty('background', 'transparent', 'important');
    });
  });
})();
`;

// ─── Bot UA fetch ──────────────────────────────────────────────────

export interface BypassFetchResult {
	ok: boolean;
	status: number;
	text: string;
	finalUrl: string;
	strategy: BypassStrategyType;
	paywall?: PaywallDetection;
	error?: string;
}

/**
 * Fetch a URL with a search-engine bot UA. Many news sites render
 * full content to Googlebot/Bingbot/Facebook crawler to ensure
 * articles get indexed.
 */
export async function tryBotUAFetch(
	url: string,
	strategy: BypassStrategyType,
	opts: {
		browser?: string;
		os?: string;
		proxy?: string;
		wreqSession?: any;
	},
): Promise<BypassFetchResult | null> {
	const ua = botUAFor(strategy);
	if (!ua) return null;

	try {
		const headers: Record<string, string> = {
			"User-Agent": ua,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		};
		// Googlebot and Bingbot don't send Sec-Ch-Ua
		const fetchFn = opts.wreqSession
			? (u: string, init: any) => opts.wreqSession.fetch(u, init)
			: wreqFetch;

		const res = await fetchFn(url, {
			redirect: "follow",
			headers,
			browser: (opts.browser ?? "chrome_145") as any,
			os: (opts.os ?? "windows") as any,
			...(opts.proxy ? { proxy: opts.proxy } : {}),
		});
		if (!res?.ok) return null;

		const text = await res.text();
		const finalUrl = res.url ?? url;
		const paywall = detectPaywall(text);

		return {
			ok: !paywall.paywalled || paywall.confidence < 0.5,
			status: res.status,
			text,
			finalUrl,
			strategy,
			paywall,
		};
	} catch (err) {
		return {
			ok: false,
			status: 0,
			text: "",
			finalUrl: url,
			strategy,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function botUAFor(strategy: BypassStrategyType): string | null {
	switch (strategy) {
		case "ua:googlebot":
			return UA_GOOGLEBOT;
		case "ua:bingbot":
			return UA_BINGBOT;
		case "ua:facebookbot":
			return UA_FACEBOOKBOT;
		case "ua:custom":
			return null; // caller must supply
		default:
			return null;
	}
}

// ─── Archive.org Wayback fetch ─────────────────────────────────────

const WAYBACK_TIMEOUT_MS = 15000;

/**
 * Fetch a URL from the Wayback Machine. The "2/" prefix returns the
 * original (un-Wayback-toolbar-ed) version. Returns null if the URL
 * isn't archived.
 */
export async function tryArchiveOrgFetch(
	url: string,
	_opts: { proxy?: string } = {},
): Promise<BypassFetchResult | null> {
	const archiveUrl = `https://web.archive.org/web/2/${url}`;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), WAYBACK_TIMEOUT_MS);
		const res = await fetch(archiveUrl, {
			redirect: "follow",
			signal: ctrl.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
			},
		});
		clearTimeout(timer);
		if (!res.ok) return null;

		const text = await res.text();
		// Wayback sometimes returns its own 404 page
		if (text.includes("Wayback Machine has not archived")) return null;

		const finalUrl = res.url ?? archiveUrl;
		const paywall = detectPaywall(text);

		return {
			ok: true,
			status: 200,
			text,
			finalUrl,
			strategy: "archive",
			paywall,
		};
	} catch (err) {
		return null;
	}
}

// ─── Archive.ph (archive.is) fetch ─────────────────────────────────

const ARCHIVE_PH_TIMEOUT_MS = 15000;

/**
 * Fetch a URL from archive.ph (archive.is). Returns null if the URL
 * isn't archived. Useful as a fallback when Wayback doesn't have a
 * copy.
 */
export async function tryArchivePhFetch(
	url: string,
): Promise<BypassFetchResult | null> {
	const archiveUrl = `https://archive.ph/newest/${url}`;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), ARCHIVE_PH_TIMEOUT_MS);
		// archive.ph returns a 302 to the timestamped URL. The fetch
		// will follow it automatically.
		const res = await fetch(archiveUrl, {
			redirect: "follow",
			signal: ctrl.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
			},
		});
		clearTimeout(timer);
		if (!res.ok) return null;

		const text = await res.text();
		// archive.ph wraps the content — strip its chrome if present
		const cleaned = stripArchivePhChrome(text);

		return {
			ok: true,
			status: 200,
			text: cleaned,
			finalUrl: res.url ?? archiveUrl,
			strategy: "archive",
			paywall: detectPaywall(cleaned),
		};
	} catch {
		return null;
	}
}

function stripArchivePhChrome(html: string): string {
	// archive.ph wraps the archived page in an <iframe id="replay">. If
	// present, we don't have the real content — return as-is (caller
	// will detect no article markers and fall through).
	if (html.includes('id="replay"') || html.includes('id="rmobile"')) {
		// Try to extract title from the archive page itself
		return html;
	}
	return html;
}

// ─── Browser with JS script blocking ───────────────────────────────

/**
 * Fetch a URL in a real headless browser, aborting paywall vendor
 * scripts. After page load, applies DOM override (hide paywall
 * divs, restore overflow).
 */
export async function tryBlockJSFetch(
	url: string,
	strategy: PaywallStrategy,
	opts: {
		browserPool?: any;
		proxy?: string;
	},
): Promise<BypassFetchResult | null> {
	const blockPatterns = strategy.blockScripts ?? KNOWN_PAYWALL_VENDORS;
	const html = await fetchWithBypass(
		url,
		blockPatterns,
		strategy.domOverride !== false,
		opts.browserPool,
	);
	if (!html) return null;

	const paywall = detectPaywall(html);
	return {
		ok: true,
		status: 200,
		text: html,
		finalUrl: url,
		strategy: "block_js",
		paywall,
	};
}

/**
 * Lower-level: fetch a URL via Playwright with the given block
 * patterns and optional DOM override. Exposed for direct use.
 */
export async function fetchWithBypass(
	url: string,
	blockPatterns: string[],
	domOverride: boolean,
	browserPool?: any,
): Promise<string | null> {
	// We can't use the existing fetchWithPlaywright because it doesn't
	// support route aborts. Inline a small wrapper here.
	try {
		const playwright = await import("playwright").catch(() => null);
		if (!playwright) {
			return fetchWithPlaywright(url, browserPool);
		}
		const { chromium } = playwright;

		const launchOptions: any = { headless: true };
		if (process.platform === "linux" && process.env.DISPLAY) {
			launchOptions.headless = false;
		}

		let browser: any = null;
		try {
			if (browserPool?.acquirePage) {
				const pooled = await browserPool.acquirePage();
				browser = pooled.page.context().browser();
				try {
					return await runBypassPage(
						pooled.page,
						url,
						blockPatterns,
						domOverride,
					);
				} finally {
					pooled.release();
				}
			} else {
				for (const opts of [{ channel: "chrome" as const }, {}]) {
					try {
						browser = await chromium.launch({ ...opts, ...launchOptions });
						const page = await browser.newPage();
						return await runBypassPage(page, url, blockPatterns, domOverride);
					} catch (err) {
						// best-effort: try next launch option
						try {
							await browser?.close();
						} catch {
							// browser may not have launched — ignore
						}
						// surface only unexpected errors
						if (process.env.PI_WEBAIO_DEBUG) {
							console.warn(`[bypass] launch failed: ${(err as Error).message}`);
						}
					}
				}
			}
		} finally {
			if (browser && !browserPool?.acquirePage) {
				await browser.close().catch(() => {});
			}
		}
		return null;
	} catch {
		return fetchWithPlaywright(url, browserPool);
	}
}

async function runBypassPage(
	page: any,
	url: string,
	blockPatterns: string[],
	domOverride: boolean,
): Promise<string> {
	// Build route handlers. Playwright's route() supports glob and
	// string URLs; we just need to match on the substring.
	for (const pattern of blockPatterns) {
		try {
			await page.route(
				`**${pattern.startsWith("*") ? pattern.slice(1) : `*${pattern}`}`,
				(route: any) => route.abort(),
			);
		} catch {
			/* some patterns may not be valid route URLs — skip */
		}
	}

	const resp = await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: 20000,
	});
	const respStatus = resp?.status?.() ?? 0;
	if (process.env.PI_WEBAIO_DEBUG && respStatus >= 400) {
		console.warn(`[bypass] HTTP ${respStatus} for ${url}`);
	}

	// Wait for article-like content to appear
	try {
		await page.waitForSelector("article, [data-article], .article-body", {
			timeout: 5000,
		});
	} catch {
		/* not all pages have these — continue */
	}

	// Give scripts a moment to run (and fail silently because we
	// aborted their URLs)
	await page.waitForTimeout(1500);

	if (domOverride) {
		try {
			await page.evaluate(DOM_OVERRIDE_SCRIPT);
		} catch {
			/* ignore */
		}
		// Give the page a moment to re-render after our CSS changes
		await page.waitForTimeout(300);
	}

	return await page.content();
}

// ─── Master orchestrator ───────────────────────────────────────────

export interface BypassOptions {
	browser?: string;
	os?: string;
	proxy?: string;
	wreqSession?: any;
	browserPool?: any;
	/** Skip browser mode (useful for low-resource environments). */
	skipBrowser?: boolean;
	/** Only try these strategies (overrides site-specific). */
	strategies?: BypassStrategyType[];
	/** Max time to spend on bypass attempts (ms). */
	timeoutMs?: number;
	/** Status callback. */
	onProgress?: (msg: string) => void;
}

/**
 * Try a chain of bypass strategies for a URL. Returns the first
 * successful result, or null if all strategies fail.
 */
export async function bypassUrl(
	url: string,
	opts: BypassOptions = {},
): Promise<BypassFetchResult | null> {
	const start = Date.now();
	const checkTimeout = () =>
		opts.timeoutMs && Date.now() - start > opts.timeoutMs;

	const strategy = findStrategy(url);
	const steps = opts.strategies ??
		strategy?.steps ?? ["ua:googlebot", "archive", "block_js"];

	opts.onProgress?.(
		`[bypass] ${new URL(url).hostname} → strategy: ${steps.join(" → ")}`,
	);

	for (const step of steps) {
		if (checkTimeout()) {
			opts.onProgress?.(`[bypass] timeout after ${opts.timeoutMs}ms`);
			return null;
		}

		opts.onProgress?.(`[bypass] trying ${step}…`);

		let result: BypassFetchResult | null = null;

		switch (step) {
			case "ua:googlebot":
			case "ua:bingbot":
			case "ua:facebookbot":
				result = await tryBotUAFetch(url, step, opts);
				break;
			case "ua:custom":
				if (strategy?.useragentCustom) {
					result = await tryCustomUAFetch(url, strategy.useragentCustom, opts);
				}
				break;
			case "referer:google":
				result = await tryGoogleRefererFetch(url, opts);
				break;
			case "block_js":
				if (!opts.skipBrowser) {
					result = await tryBlockJSFetch(
						url,
						strategy ?? GENERIC_STRATEGY,
						opts,
					);
				}
				break;
			case "archive":
				result = await tryArchiveOrgFetch(url, opts);
				if (!result) result = await tryArchivePhFetch(url);
				break;
			case "archive_first":
				result = await tryArchiveOrgFetch(url, opts);
				if (!result) result = await tryArchivePhFetch(url);
				break;
			case "cookies":
				result = await tryNoCookiesFetch(url, strategy?.dropCookies, opts);
				break;
			case "auto":
				// Should not appear in steps; if it does, skip
				continue;
		}

		if (result?.ok) {
			opts.onProgress?.(
				`[bypass] success via ${step} (${result.text.length} chars, ${result.paywall?.confidence ? `${Math.round(result.paywall.confidence * 100)}% paywall detected` : "clean"})`,
			);
			return result;
		}
	}

	opts.onProgress?.(`[bypass] all strategies failed for ${url}`);
	return null;
}

// ─── Aux bypass strategies ─────────────────────────────────────────

async function tryCustomUAFetch(
	url: string,
	ua: string,
	opts: BypassOptions,
): Promise<BypassFetchResult | null> {
	try {
		const fetchFn = opts.wreqSession
			? (u: string, init: any) => opts.wreqSession.fetch(u, init)
			: wreqFetch;
		const res = await fetchFn(url, {
			redirect: "follow",
			headers: {
				"User-Agent": ua,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
			browser: (opts.browser ?? "chrome_145") as any,
			os: (opts.os ?? "windows") as any,
			...(opts.proxy ? { proxy: opts.proxy } : {}),
		});
		if (!res?.ok) return null;
		const text = await res.text();
		const paywall = detectPaywall(text);
		return {
			ok: !paywall.paywalled,
			status: res.status,
			text,
			finalUrl: res.url ?? url,
			strategy: "ua:custom",
			paywall,
		};
	} catch {
		return null;
	}
}

async function tryGoogleRefererFetch(
	url: string,
	opts: BypassOptions,
): Promise<BypassFetchResult | null> {
	try {
		const headers = {
			...buildHeaders(opts.browser, opts.os),
			Referer: "https://www.google.com/",
		};
		const fetchFn = opts.wreqSession
			? (u: string, init: any) => opts.wreqSession.fetch(u, init)
			: wreqFetch;
		const res = await fetchFn(url, {
			redirect: "follow",
			headers,
			browser: (opts.browser ?? "chrome_145") as any,
			os: (opts.os ?? "windows") as any,
			...(opts.proxy ? { proxy: opts.proxy } : {}),
		});
		if (!res?.ok) return null;
		const text = await res.text();
		const paywall = detectPaywall(text);
		return {
			ok: !paywall.paywalled,
			status: res.status,
			text,
			finalUrl: res.url ?? url,
			strategy: "referer:google",
			paywall,
		};
	} catch {
		return null;
	}
}

async function tryNoCookiesFetch(
	url: string,
	_dropCookies: string[] | undefined,
	opts: BypassOptions,
): Promise<BypassFetchResult | null> {
	try {
		const headers: Record<string, string> = {
			...buildHeaders(opts.browser, opts.os),
			Cookie: "", // tell the server we accept no cookies
		};
		const fetchFn = opts.wreqSession
			? (u: string, init: any) => opts.wreqSession.fetch(u, init)
			: wreqFetch;
		const res = await fetchFn(url, {
			redirect: "follow",
			headers,
			browser: (opts.browser ?? "chrome_145") as any,
			os: (opts.os ?? "windows") as any,
			...(opts.proxy ? { proxy: opts.proxy } : {}),
		});
		if (!res?.ok) return null;
		const text = await res.text();
		const paywall = detectPaywall(text);
		return {
			ok: !paywall.paywalled,
			status: res.status,
			text,
			finalUrl: res.url ?? url,
			strategy: "cookies",
			paywall,
		};
	} catch {
		return null;
	}
}

// ─── Strip paywall text from extracted markdown ────────────────────

const PAID_CONTENT_MARKERS = [
	"Subscribe to read ",
	"Subscribe to continue reading",
	"Log in or create an account to continue",
	"Sign in to continue",
	"Create a free account to continue",
	"This article is for subscribers",
	"To read the full story",
	"Register for free to continue reading",
	"Already a subscriber? Sign in",
	"Want to read more?",
	"Unlock this article",
	"You have reached your limit of free articles",
	"Enjoying our latest content?",
	"Access the most recent journalism",
	"Explore the latest features & opinion",
	"Get full access",
	"Continue reading with a subscription",
	"This content is for subscribers",
	"Read the full article",
	"Show less",
	"Show more",
	"[Paywall]",
	"[Subscribe to read]",
];

/**
 * Removes trailing paywall text and dead-end "subscribe" blocks from
 * extracted markdown. Operates on the article body, not the URL.
 */
export function stripPaywallText(markdown: string): string {
	if (!markdown) return markdown;

	let out = markdown;

	// Find all marker positions and their occurrences. We cut at the
	// EARLIEST marker when:
	//   (a) it's in the bottom half of the document, OR
	//   (b) there are 2+ markers (multi-marker = high confidence)
	// This is more aggressive than a pure "last third" cut because
	// many paywalls inject a "Subscribe to continue reading" line
	// mid-article as a tease — cutting at that point is correct.
	const positions: Array<{ idx: number; marker: string }> = [];
	let totalMatches = 0;

	for (const marker of PAID_CONTENT_MARKERS) {
		let searchFrom = 0;
		while (true) {
			const idx = out.indexOf(marker, searchFrom);
			if (idx === -1) break;
			// Only consider markers that appear after at least 30 chars
			// of content — this preserves any "Subscribe" word that might
			// appear in the title without paying the cost of a position
			// heuristic for every short text.
			if (idx > 30) {
				positions.push({ idx, marker });
				totalMatches++;
			}
			searchFrom = idx + marker.length;
		}
	}

	if (positions.length > 0) {
		// Sort by position
		positions.sort((a, b) => a.idx - b.idx);
		const earliest = positions[0]!.idx;
		const relativePos = earliest / out.length;

		// Cut conditions, in order of strength:
		//   1. Multiple matches anywhere — strong paywall signal
		//   2. Marker in the bottom 40% of content — typical
		//      paywall curtain at end of article
		//   3. Short content (< 500 chars) with any marker — the
		//      position heuristic is noisy for short snippets, so
		//      we trust the marker more
		if (
			totalMatches >= 2 ||
			relativePos > 0.4 ||
			(out.length < 500 && totalMatches >= 1)
		) {
			out = out.slice(0, earliest).trimEnd();
		}
	}

	// Drop trailing incomplete sentence (paywall cuts mid-paragraph)
	const lastPunct = Math.max(
		out.lastIndexOf(". "),
		out.lastIndexOf(".\n"),
		out.lastIndexOf("! "),
		out.lastIndexOf("? "),
	);
	if (lastPunct > out.length * 0.5 && lastPunct < out.length - 50) {
		// Check if the text after lastPunct is just a "subscribe" tail
		const tail = out.slice(lastPunct + 1).trim();
		if (
			tail.length < 200 &&
			/^(\s*[A-Z][a-z]+( [a-z]+){0,8})?\.?\s*$/.test(tail)
		) {
			out = out.slice(0, lastPunct + 1).trimEnd();
		}
	}

	// Drop trailing "or" / "Sign in" / "Subscribe" lines
	for (const tail of [
		"\nor\n",
		"\nor",
		"\nSign in",
		"\nLog in",
		"\nSubscribe",
		"\nRegister",
		"\nAlready a subscriber?",
	]) {
		if (out.endsWith(tail)) {
			out = out.slice(0, -tail.length).trimEnd();
		}
	}

	return out;
}
