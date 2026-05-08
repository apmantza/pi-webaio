/**
 * GitHub REST API client — zero CLI dependencies.
 *
 * Auth priority:
 *   1. GITHUB_TOKEN env var (CI standard)
 *   2. GH_TOKEN env var (alternative name)
 *   3. `gh auth token` (devs who already ran `gh auth login`)
 *   4. Unauthenticated (60 req/hr, public repos only — enough for most fetches)
 *
 * Never throws on missing auth. Degrades gracefully to unauthenticated access.
 */

import { spawnSync } from "node:child_process";

const API_BASE = "https://api.github.com";

let _cachedToken: string | null | undefined; // undefined = not checked yet

function resolveGhBinary(): string | null {
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const out = spawnSync(cmd, ["gh"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (out.error || out.status !== 0) return null;
		return out.stdout.trim().split("\n")[0] || null;
	} catch {
		return null;
	}
}

async function getToken(): Promise<string | undefined> {
	if (_cachedToken !== undefined) return _cachedToken ?? undefined;

	// 1. Env var (CI standard)
	if (process.env.GITHUB_TOKEN) {
		_cachedToken = process.env.GITHUB_TOKEN;
		return _cachedToken;
	}
	if (process.env.GH_TOKEN) {
		_cachedToken = process.env.GH_TOKEN;
		return _cachedToken;
	}

	// 2. `gh auth token` (devs who already logged in)
	const ghPath = resolveGhBinary();
	if (ghPath) {
		try {
			const out = spawnSync(ghPath, ["auth", "token"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (out.status === 0 && out.stdout.trim()) {
				_cachedToken = out.stdout.trim();
				return _cachedToken;
			}
		} catch {
			// gh not logged in
		}
	}

	// 3. Unauthenticated — works for public repos (60 req/hr)
	_cachedToken = null;
	return undefined;
}

// ─── Retry config ──────────────────────────────────────────────────

const RETRYABLE_API_STATUSES = new Set([429, 500, 502, 503, 504]);
const API_RETRY_INITIAL_MS = 1000;
const MAX_API_RETRIES = 2;

/**
 * Call the GitHub REST API with exponential backoff for 429/5xx/network errors.
 * Returns parsed JSON. Works with or without auth (unauthenticated = 60 req/hr).
 *
 * @param path — API path like "/repos/owner/repo/issues?state=all"
 * @returns Parsed JSON response
 */
export async function ghFetch<T = unknown>(path: string): Promise<T> {
	const token = await getToken();
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "pi-webaio",
	};
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}

	const url = `${API_BASE}${path}`;

	for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
		try {
			const res = await fetch(url, {
				headers,
				redirect: "follow",
			});

			if (res.ok) {
				if (res.status === 204) return {} as T;
				return res.json() as Promise<T>;
			}

			// 429: check Retry-After header for server-specified backoff
			if (res.status === 429) {
				const retryAfter = res.headers.get("Retry-After");
				const delayMs = retryAfter
					? Number.parseInt(retryAfter, 10) * 1000
					: API_RETRY_INITIAL_MS * 2 ** attempt;
				if (attempt < MAX_API_RETRIES) {
					await new Promise((r) => setTimeout(r, delayMs));
					continue;
				}
			}

			// Other retryable statuses (5xx)
			if (RETRYABLE_API_STATUSES.has(res.status) && attempt < MAX_API_RETRIES) {
				const delayMs = API_RETRY_INITIAL_MS * 2 ** attempt;
				// Drain body before retry to free connection
				await res.text().catch(() => {});
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}

			// Non-retryable — fail immediately
			const text = await res.text().catch(() => "");
			throw new Error(`GitHub API ${res.status}: ${text.slice(0, 500)}`);
		} catch (err: unknown) {
			// Network errors (fetch failed, ECONNRESET, etc.) are retryable
			if (attempt < MAX_API_RETRIES && isRetryableNetworkError(err)) {
				const delayMs = API_RETRY_INITIAL_MS * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}
			throw err;
		}
	}

	// Should never reach here (last attempt throws above)
	throw new Error("GitHub API: max retries exceeded");
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
		msg.includes("ENOTFOUND")
	);
}

/**
 * Check whether we have GitHub API access (auth token available).
 * Use as a cheap check before trying authenticated operations.
 * Unlike the old `ghAvailable()`, this checks for a token, not the `gh` binary.
 */
export async function githubAuthenticated(): Promise<boolean> {
	const token = await getToken();
	return token !== undefined;
}

/**
 * Resolve the GitHub auth token (env var → gh auth token → none).
 * Cached after first call. Exported for cloneGitHubRepo to inject into clone URLs.
 */
export { getToken as getGithubToken };
