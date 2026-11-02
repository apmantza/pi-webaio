// ─── Canonical host-normalisation rule ─────────────────────────────────
//
// A leaf module on purpose. `stripWww` originally lived in `src/search.ts`, but
// `search.ts` imports `goggles.ts`, so having `goggles.ts` import the rule back
// would have been a cycle. The same shape as `src/http-text.ts` and
// `src/client-redirect.ts`: pipeline-independent helpers live in a leaf so the
// consumers cannot drift. See issue #167.
//
// This is a MATCHING rule, not a display rule: it exists so two hostnames that
// mean the same site compare equal. It is deliberately not used to rewrite what
// the user sees.

/**
 * Lower-case a hostname and drop a leading `www.` label.
 *
 * Case folding belongs here rather than at each call site: several callers take
 * a hostname straight out of `new URL(...)` and one previously spelled the rule
 * as `.hostname.toLowerCase().replace(/^www\./, "")`. Repeating the
 * pre-normalisation six times is exactly the drift hazard this seam removes.
 *
 * Only a leading label is stripped — `a.www.example.com` and `notwww.example.com`
 * are untouched.
 */
export function stripWww(domain: string): string {
	return domain.toLowerCase().replace(/^www\./, "");
}
