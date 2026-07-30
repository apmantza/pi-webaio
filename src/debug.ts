/**
 * Central debug logger gated on `PI_WEBAIO_DEBUG`.
 *
 * Historically `PI_WEBAIO_DEBUG` was checked ad hoc in only `content.ts` and
 * `paywall.ts` (observability audit P8), so the two most common complaints —
 * "why was this search engine missing?" and "why did this fetch take the
 * browser path?" — left no trace even with debugging on. This helper gives
 * every subsystem one consistent, cheap, namespaced trace channel:
 *
 *   debug("search", "brave cooled down until", until);
 *   // → [pi-webaio:search] brave cooled down until <…>   (only when PI_WEBAIO_DEBUG=1)
 *
 * The flag is read lazily on each call so tests can toggle `process.env`
 * without re-importing, and the enabled check short-circuits before any
 * argument formatting cost when off. Output goes to stderr (console.error) so
 * it never pollutes stdout — which the MCP stdio server uses for JSON-RPC.
 */

/** Whether debug tracing is active (`PI_WEBAIO_DEBUG=1`). */
export function debugEnabled(): boolean {
	return process.env.PI_WEBAIO_DEBUG === "1";
}

/**
 * Emit a namespaced debug line to stderr, but only when `PI_WEBAIO_DEBUG=1`.
 * `scope` is a short subsystem tag (e.g. "search", "strategy", "browser-pool").
 * No-op when disabled.
 */
export function debug(scope: string, ...args: unknown[]): void {
	if (!debugEnabled()) return;
	console.error(`[pi-webaio:${scope}]`, ...args);
}
