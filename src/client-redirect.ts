// ─── Client-side redirect detection ───────────────────────────────
//
// Dependency-free by design. Both the full extraction pipeline
// (content.ts) and the static fetch entrypoint (webfetch-api.ts) need to
// honour <meta http-equiv="refresh"> and literal `location` assignments,
// and the static entrypoint must not import content.ts — that module
// pulls in the browser, search, Jina, and storage layers the static
// boundary forbids. Sharing the leaf keeps the two paths from drifting
// (dedup, jscpd); previously each carried a verbatim copy.
//
// No imports: this module must stay loadable from any entrypoint.

/** Maximum characters of HTML inspected for a client-side redirect. */
const REDIRECT_SNIPPET_CHARS = 4096;

/** Longest meta-refresh delay (seconds) we are willing to follow. */
const MAX_REFRESH_DELAY_SECONDS = 30;

/**
 * Find a client-side redirect target in an HTML document, or null when
 * there is none.
 *
 * Handles two shapes:
 *  1. `<meta http-equiv="refresh" content="0; url=...">` with a delay
 *     under {@link MAX_REFRESH_DELAY_SECONDS}.
 *  2. A tiny HTML shell that redirects with JavaScript — some static
 *     sites do this (for example `/release-notes/overview` on the
 *     TypeScript docs site). Only *literal* `location` assignments and
 *     `location.replace()` / `location.assign()` calls are accepted;
 *     arbitrary page JavaScript is never evaluated.
 *
 * Targets that resolve back to `baseUrl`, carry control characters, or
 * use a non-HTTP(S) protocol are rejected, so a caller can follow the
 * returned URL without re-checking those properties.
 */
export function extractClientSideRedirect(
	html: string,
	baseUrl: string,
): string | null {
	const snippet = html.slice(0, REDIRECT_SNIPPET_CHARS);
	const resolveTarget = (rawTarget: string): string | null => {
		const target = rawTarget.trim().replace(/^['"]|['"]$/g, "");
		if (!target || /[\u0000-\u001f\u007f]/.test(target)) return null;
		try {
			const resolvedUrl = new URL(target, baseUrl);
			if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:")
				return null;
			const resolved = resolvedUrl.toString();
			return resolved === baseUrl ? null : resolved;
		} catch {
			return null;
		}
	};

	const meta = snippet.match(
		/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?([^"'>]*)/i,
	);
	if (meta) {
		const parts = meta[1]!.split(";");
		const delay = Number.parseFloat(parts[0]!.trim());
		if (
			Number.isFinite(delay) &&
			delay >= 0 &&
			delay < MAX_REFRESH_DELAY_SECONDS
		) {
			const urlMatch = parts
				.slice(1)
				.join(";")
				.match(/url\s*=\s*(.+)/i);
			if (urlMatch) {
				const resolved = resolveTarget(urlMatch[1]!);
				if (resolved) return resolved;
			}
		}
	}

	// Some static sites emit a tiny HTML shell that redirects with JavaScript
	// instead of a meta tag (for example, `/release-notes/overview` on the
	// TypeScript docs site). Inspect script bodies only and accept literal
	// location assignments/calls; do not evaluate arbitrary page JavaScript.
	//
	// Both tag patterns tolerate junk between the tag name and `>` (`<script >`,
	// `</script >`, `</script\t\n foo="bar">`). HTML parsers ignore attributes on
	// end tags, so a bare `<\/script>` silently misses those variants
	// (CodeQL js/bad-tag-filter).
	for (const match of snippet.matchAll(
		/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi,
	)) {
		const script = match[1] ?? "";
		const assignment = script.match(
			/^\s*(?:window\.|document\.)?location(?:\.href)?\s*=\s*(["'])(.*?)\1\s*;?\s*$/i,
		);
		const call = script.match(
			/^\s*(?:window\.|document\.)?location\.(?:replace|assign)\(\s*(["'])(.*?)\1\s*\)\s*;?\s*$/i,
		);
		const resolved = resolveTarget(assignment?.[2] ?? call?.[2] ?? "");
		if (resolved) return resolved;
	}
	return null;
}
