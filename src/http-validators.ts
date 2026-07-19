// ─── HTTP revalidation validators ──────────────────────────────────
// Stores ETag / Last-Modified response headers with cached entries and
// exposes helpers for building conditional-request headers and processing
// 304 Not Modified responses.
//
// Only the plain/wreq rungs use this; browser (Playwright) fetches bypass
// revalidation because they don't expose raw HTTP headers.

import {
	sessionStore,
	normalizeCacheKey,
	SESSION_CACHE_TTL_MS,
} from "./session-store.ts";
import type { StoredContent } from "./types.ts";

// ─── Types ─────────────────────────────────────────────────────────

export interface HttpValidators {
	etag?: string;
	lastModified?: string;
}

// ─── Attach validators to a cached entry ───────────────────────────

/**
 * Persist ETag / Last-Modified alongside a cached entry so future
 * fetches can send conditional requests and handle 304 cheaply.
 */
export function attachValidators(url: string, validators: HttpValidators): void {
	const key = normalizeCacheKey(url);
	const entry = sessionStore.get(key);
	if (!entry) return;
	if (validators.etag !== undefined) entry.etag = validators.etag;
	if (validators.lastModified !== undefined)
		entry.lastModified = validators.lastModified;
}

// ─── Extract validators from a fetch response ──────────────────────

/**
 * Pull ETag and Last-Modified from a response-header object.
 * Returns an empty object when neither header is present.
 */
export function extractValidators(
	headers: { get(name: string): string | null } | null | undefined,
): HttpValidators {
	if (!headers) return {};
	const etag = headers.get("etag") ?? undefined;
	const lastModified = headers.get("last-modified") ?? undefined;
	return { etag, lastModified };
}

// ─── Build conditional-request headers ────────────────────────────

/**
 * Given a cached entry, return the conditional-request headers to
 * attach to a re-fetch. Returns an empty object when no validators
 * are stored (i.e. behave like a plain fresh fetch).
 */
export function buildConditionalHeaders(
	entry: StoredContent,
): Record<string, string> {
	const h: Record<string, string> = {};
	if (entry.etag) h["If-None-Match"] = entry.etag;
	if (entry.lastModified) h["If-Modified-Since"] = entry.lastModified;
	return h;
}

// ─── Check whether the session-cache entry has expired ────────────

/**
 * True when the entry exists and its TTL has elapsed (i.e. we should
 * attempt revalidation rather than serving it straight from cache).
 */
export function isExpiredEntry(entry: StoredContent): boolean {
	return Date.now() - entry.timestamp > SESSION_CACHE_TTL_MS;
}

// ─── Refresh an entry's TTL on 304 ────────────────────────────────

/**
 * Called when the server responds 304 Not Modified. Refreshes the
 * timestamp so the cached content is served for another full TTL, and
 * optionally updates the validators if the server sent new ones (rare
 * but allowed by RFC 7232 §4.1).
 */
export function refreshEntryOnNotModified(
	url: string,
	newValidators?: HttpValidators,
): void {
	const key = normalizeCacheKey(url);
	const entry = sessionStore.get(key);
	if (!entry) return;
	entry.timestamp = Date.now();
	if (newValidators?.etag !== undefined) entry.etag = newValidators.etag;
	if (newValidators?.lastModified !== undefined)
		entry.lastModified = newValidators.lastModified;
}

// ─── Check whether a cached entry has HTTP validators ─────────────

export function hasValidators(entry: StoredContent): boolean {
	return !!(entry.etag || entry.lastModified);
}

// ─── Side-channel validator capture ───────────────────────────────
// content.ts cannot easily thread validators through its many return
// paths. Instead it calls `captureResponseValidators` right after its
// internal smartFetch call, and webfetch.ts drains the map via
// `drainCapturedValidators` after pullPageEnhanced returns.
//
// The map is keyed by the (normalized) final URL of the response.
// Only one entry per URL is kept; concurrent fetches for different
// URLs are isolated by key.

const _capturedValidators = new Map<string, HttpValidators>();

/**
 * Record ETag / Last-Modified from a live response object.
 * Called by the fetch pipeline (content.ts) immediately after
 * receiving a successful HTTP response.
 */
export function captureResponseValidators(
	finalUrl: string,
	headers: { get(name: string): string | null } | null | undefined,
): void {
	const validators = extractValidators(headers);
	if (validators.etag || validators.lastModified) {
		_capturedValidators.set(finalUrl, validators);
	}
}

/**
 * Return and clear any validators captured for a URL.
 * Called by webfetch.ts after pullPageEnhanced() returns.
 */
export function drainCapturedValidators(
	finalUrl: string,
): HttpValidators | null {
	const v = _capturedValidators.get(finalUrl);
	if (v) {
		_capturedValidators.delete(finalUrl);
		return v;
	}
	return null;
}
