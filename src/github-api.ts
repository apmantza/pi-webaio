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

import { spawn, spawnSync } from "node:child_process";
import {
	DEFAULT_TIMEOUT_MS,
	isRetryableNetworkError,
	readResponseTextWithProgress,
} from "./fetch.ts";

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

// `gh` child-process output/time bounds — `gh run view --log` can emit many
// MB and a hung `gh` invocation must not hang the process forever.
const EXEC_GH_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const EXEC_GH_TIMEOUT_MS = 60_000;

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
				signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
			});

			if (res.ok) {
				if (res.status === 204) return {} as T;
				// Stream-read with a byte cap — a hung/huge response body must
				// not be buffered unbounded via res.json().
				const { text } = await readResponseTextWithProgress(res);
				return JSON.parse(text) as T;
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
				// Drain body before retry to free connection (capped read —
				// a hung/huge error body must not block forever)
				await readResponseTextWithProgress(res).catch(() => {});
				await new Promise((r) => setTimeout(r, delayMs));
				continue;
			}

			// Non-retryable — fail immediately
			const text = await readResponseTextWithProgress(res)
				.then((r) => r.text)
				.catch(() => "");
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

/**
 * Resolve the GitHub auth token (env var → gh auth token → none).
 * Cached after first call. Exported for cloneGitHubRepo to inject into clone URLs.
 */
export { getToken as getGithubToken };

// ─── gh CLI helpers (v0.4.1) ─────────────────────────────────────

/**
 * Check whether gh CLI fallback is enabled. Opt-in via env var to avoid
 * unexpected child-process spawning on systems where gh is not installed.
 * Default: ON if gh is on PATH (most devs have it).
 */
function ghFallbackEnabled(): boolean {
	if (process.env.PI_WEBAIO_GH_FALLBACK === "0") return false;
	return resolveGhBinary() !== null;
}

/**
 * Run `gh <args>` and capture stdout. Rejects on non-zero exit.
 * Uses async execFile so it doesn't block the event loop.
 */
function execGh(
	args: string[],
	opts: { stdin?: string } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const ghPath = resolveGhBinary();
		if (!ghPath) {
			reject(new Error("gh CLI not found"));
			return;
		}
		const proc = spawn(ghPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let settled = false;

		const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill();
			reject(new Error(`gh ${args[0]} timed out after ${EXEC_GH_TIMEOUT_MS}ms`));
		}, EXEC_GH_TIMEOUT_MS);

		proc.stdout.on("data", (d: Buffer) => {
			if (settled) return;
			stdoutBytes += d.length;
			if (stdoutBytes > EXEC_GH_MAX_BYTES) {
				settled = true;
				clearTimeout(timer);
				proc.kill();
				reject(
					new Error(`gh ${args[0]} output exceeded ${EXEC_GH_MAX_BYTES} byte limit`),
				);
				return;
			}
			stdout += d;
		});
		proc.stderr.on("data", (d: Buffer) => (stderr += d));
		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		proc.on("close", (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else
				reject(new Error(`gh ${args[0]} exited ${code}: ${stderr.slice(0, 500)}`));
		});
		if (opts.stdin) {
			proc.stdin.write(opts.stdin);
			proc.stdin.end();
		}
	});
}

/**
 * Call `gh api <path>` and parse JSON. Uses the user's existing gh auth
 * (which is 5000 req/hr vs 60/hr unauthenticated) and follows 302 redirects
 * with credentials (essential for /actions/jobs/{id}/logs which redirects
 * to an S3 archive zip).
 *
 * @param path — API path like "/repos/owner/repo/actions/runs/123"
 * @param opts.raw — return raw bytes (for zip downloads)
 */
export async function ghApiCall<T = unknown>(
	path: string,
	opts: { raw?: boolean } = {},
): Promise<T> {
	if (!ghFallbackEnabled()) {
		throw new Error("gh CLI fallback disabled or gh not installed");
	}
	const args = ["api", path];
	if (opts.raw) {
		// Don't parse JSON; return raw stdout
		const out = await execGh(args);
		// SAFETY: The raw-output branch intentionally returns caller-selected bytes as T.
		return out as unknown as T;
	}
	// `--jq .` returns parsed JSON on success
	const out = await execGh([...args, "--jq", "."]);
	if (!out.trim()) return {} as T;
	try {
		return JSON.parse(out) as T;
	} catch {
		// Fall back to raw return (gh may have errored to stdout)
		// SAFETY: The generic API intentionally preserves non-JSON gh output for its caller.
		return out as unknown as T;
	}
}

/**
 * Fetch a workflow run's logs via the gh CLI. Returns plain text containing
 * all job logs (or a specific job's log). Handles the 302→S3 zip redirect
 * and zip extraction internally — no extra deps needed.
 *
 * @param owner — repo owner
 * @param repo — repo name
 * @param runId — workflow run ID
 * @param jobId — optional specific job ID; if omitted, returns all jobs' logs
 * @returns Plain text log content, or null on failure
 */
export async function ghRunLogs(
	owner: string,
	repo: string,
	runId: string | number,
	jobId?: string | number,
): Promise<string | null> {
	if (!ghFallbackEnabled()) return null;
	const args = [
		"run",
		"view",
		String(runId),
		"--repo",
		`${owner}/${repo}`,
		"--log",
	];
	if (jobId !== undefined) {
		args.push("--job", String(jobId));
	}
	try {
		return await execGh(args);
	} catch {
		return null;
	}
}

/**
 * Fallback wrapper for ghFetch. Tries the direct API first; on persistent
 * failure (4xx after auth, 5xx after retry) tries the gh CLI as a last
 * resort. Useful when:
 *   - The user has higher rate limits via `gh auth login` but no token set
 *   - The endpoint requires auth we don't have (e.g. private repos)
 *   - The endpoint returns 302 redirects we can't follow with auth
 */
export async function ghFetchWithFallback<T = unknown>(
	path: string,
): Promise<T> {
	try {
		return await ghFetch<T>(path);
	} catch (err: any) {
		// Don't fall back for 404 (not found) — gh will return the same
		const msg = err?.message ?? "";
		const is4xx = /GitHub API 4\d\d/.test(msg);
		if (is4xx && !msg.includes("404") && !msg.includes("403")) {
			// Auth/permission/rate issues — try gh CLI
			try {
				return await ghApiCall<T>(path);
			} catch {
				throw err; // Give up, throw original
			}
		}
		throw err;
	}
}
