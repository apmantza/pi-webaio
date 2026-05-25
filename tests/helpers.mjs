/**
 * Test-only helpers for unit tests.
 *
 * These are pure utility functions that either:
 *   a) Are not part of the production codebase (test-only mocks), or
 *   b) Mirror production functions but exist here to avoid exporting
 *      internal implementation details from src/ modules.
 *
 * Production functions should be imported directly from src/ modules.
 * Only put test-only utilities here.
 */

import { parseHTML } from "linkedom";

// ─── Consent banner stripping (for testing) ─────────────────────────
// Mirrors CONSENT_SELECTORS in src/content.ts. Not exported from there
// because stripping is done via preCleanHtml() in production.

const CONSENT_SELECTORS = [
	// OneTrust
	"#onetrust-banner-sdk",
	"#onetrust-consent-sdk",
	".onetrust-pc-dark-filter",
	".onetrust-banner-container",
	// Cookiebot
	"#CybotCookiebotDialog",
	".CybotCookiebotDialog",
	"#CybotCookiebotDialogBackground",
	// Didomi
	"#didomi-host",
	"#didomi-notice",
	".didomi-notice",
	// Quantcast
	".qc-cmp2-ui-root",
	".qc-cmp2-container",
	".qc-cmp2-panel-container",
	// Usercentrics
	"#usercentrics-root",
	".uc-ui-container",
	// TrustArc
	"#truste-consent-modal",
	"#truste-consent-track",
	".trustarc-banner",
	"#truste-consent-heading",
	// Klaro
	".klaro",
	// Sourcepoint
	"#sp-root",
	"#sp-frame-root",
	".sp-root",
	// CookieYes / Borzy
	"#cookie-law-info-bar",
	".cky-consent-container",
	"#cookie-law-info",
	// Osano
	"#osano-cm-dialog",
	".osano-cm-dialog",
	"#osano-cm-window",
	".osano-cm-window",
	// CookieFirst
	"#cookie-first",
	// Adobe
	"#adobe-font-manager",
	"#adobe-privacy-message-center",
	// SmartConsent
	"#smartconsent-modal",
	"#smartconsent-root",
	// CookieHub
	"#chv-banner",
	"#chv-module",
	// TermsFeed
	"#tc-warning",
	// Generic cookie-consent (class-based)
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
	// Generic gdpr/consent (class-based)
	"[class*='gdpr-banner']",
	"[class*='gdpr-consent']",
	"[class*='GdprBanner']",
	"[class*='consent-banner']",
	"[class*='consent-modal']",
	"[class*='consent-dialog']",
	"[class*='consentBar']",
	"[class*='ConsentBanner']",
	"[class*='ConsentModal']",
	// Generic privacy (class-based)
	"[class*='privacy-banner']",
	"[class*='privacy-notice']",
	"[class*='PrivacyBanner']",
	// Generic cookie-consent (id-based)
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
	// ARIA
	"[role='dialog']",
	// Data attributes
	"[data-cookieconsent]",
	"[data-cmp]",
];

export function stripConsentBanners(html) {
	try {
		const { document } = parseHTML(html);
		// CONSENT_SELECTORS is stored as array for readability; join for querySelectorAll
		document
			.querySelectorAll(CONSENT_SELECTORS.join(","))
			.forEach((el) => el.remove());
		return (
			document.body?.innerHTML || document.documentElement?.outerHTML || ""
		);
	} catch {
		return html;
	}
}

// ─── In-memory session cache (test mock) ────────────────────────────

import { normalizeCacheKey } from "../src/session-store.ts";

// ─── URL/local check (simple, no DNS) ──────────────────────────────
// Production uses isDangerousUrl() with DNS resolution.
// For unit tests, a synchronous hostname check is sufficient.

export function isLocalOrPrivateUrl(url) {
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

export function createSessionCache({
	ttlMs = 30 * 60 * 1000,
	maxEntries = 100,
} = {}) {
	const store = new Map();

	function getStoredContent(url) {
		const key = normalizeCacheKey(url);
		const entry = store.get(key);
		if (!entry) return null;
		if (Date.now() - entry.timestamp > ttlMs) {
			store.delete(key);
			return null;
		}
		return entry;
	}

	function storeContent(url, title, content) {
		const key = normalizeCacheKey(url);
		while (store.size >= maxEntries) {
			const first = store.keys().next().value;
			if (first !== undefined) store.delete(first);
		}
		store.set(key, { url, title, content, timestamp: Date.now() });
	}

	function cleanupSessionCache() {
		const now = Date.now();
		for (const [url, entry] of store) {
			if (now - entry.timestamp > ttlMs) {
				store.delete(url);
			}
		}
	}

	return { store, getStoredContent, storeContent, cleanupSessionCache };
}
