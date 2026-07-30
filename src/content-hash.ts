// ─── Content hashing (F6: content-hash dedup + diff-mode) ──────────
//
// A tiny, dependency-free helper for hashing fetched content so that
// unchanged content can be detected and skipped. Inspired by
// cframe1337/pi-source-drafts' FNV-1a `hashContent`/`findByHash` dedup,
// but using Node's built-in SHA-256 for collision resistance. The same
// helper backs both the in-memory session cache (src/session-store.ts)
// and the persistent result store (src/storage.ts) so hashes compare
// across layers.

import { createHash } from "node:crypto";

/** Number of leading hex chars used for the short, display form. */
export const SHORT_HASH_LENGTH = 12;

/**
 * Compute the full SHA-256 hex digest of `content` (UTF-8).
 * Deterministic and stable across processes/platforms.
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Short, human-friendly prefix of a full hash for display/telemetry
 * (e.g. "unchanged since ab12cd34ef56"). Accepts a full hash or raw
 * content; pass `isFullHash: true` when you already have a digest.
 */
export function shortHash(
	hash: string,
	length: number = SHORT_HASH_LENGTH,
): string {
	return hash.slice(0, length);
}

/**
 * Convenience: the short display hash for a piece of content.
 */
export function contentHashShort(
	content: string,
	length: number = SHORT_HASH_LENGTH,
): string {
	return shortHash(hashContent(content), length);
}

/**
 * True when `content` matches a previously recorded hash. Returns false
 * when there is no prior hash to compare against (first sighting).
 */
export function contentUnchanged(
	content: string,
	previousHash: string | undefined,
): boolean {
	if (!previousHash) return false;
	return hashContent(content) === previousHash;
}

/**
 * True when two recorded hashes are identical. Tolerates a short
 * (truncated) `previousHash` by comparing only its length, so a digest
 * stored in truncated form still matches a freshly computed full hash.
 */
export function hashesEqual(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const n = Math.min(a.length, b.length);
	if (n === 0) return false;
	return a.slice(0, n) === b.slice(0, n);
}
