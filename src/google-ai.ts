/**
 * google-ai.ts — TypeScript wrapper for CDP-based Google search
 *
 * Spawns the CDP infrastructure (bin/cdp.mjs, bin/launch.mjs) and
 * the Google extractors (extractors/google-ai.mjs, extractors/google-search.mjs)
 * as child processes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Paths ───────────────────────────────────────────────────────────

// Resolve relative to the pi-webaio package root.
// Source runs from src/google-ai.ts, while the published extension runs from
// dist/src/google-ai.js. The CDP helpers are shipped at the package root
// (bin/, extractors/), not under dist/, so probe both possible roots.
function hasCdpAssets(root: string): boolean {
	return (
		existsSync(join(root, "bin", "launch.mjs")) &&
		existsSync(join(root, "extractors", "google-search.mjs"))
	);
}

function resolvePackageRoot(): string {
	try {
		const here = import.meta.dirname || "";
		const candidates = [join(here, ".."), join(here, "..", "..")];
		const found = candidates.find(hasCdpAssets);
		if (found) return found;
	} catch {
		// Fall back below.
	}
	return process.cwd();
}

const PACKAGE_ROOT = resolvePackageRoot();

function resolvePath(...segments: string[]): string {
	return join(PACKAGE_ROOT, ...segments);
}

// ─── Types ───────────────────────────────────────────────────────────

export interface GoogleAIResult {
	query: string;
	url: string;
	answer: string;
	sources: Array<{ title: string; url: string }>;
}

export interface GoogleSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface GoogleSearchOutput {
	query: string;
	url: string;
	results: GoogleSearchResult[];
}

export interface ChromeStatus {
	running: boolean;
	pid?: number;
	ready: boolean;
}

function collectProcessOutput(proc: ReturnType<typeof spawn>): {
	stdout: () => string;
	stderr: () => string;
	combined: () => string;
} {
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	proc.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
	proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
	const stdout = () => Buffer.concat(stdoutChunks).toString("utf8");
	const stderr = () => Buffer.concat(stderrChunks).toString("utf8");
	return { stdout, stderr, combined: () => stdout() + stderr() };
}

const MAX_GOOGLE_CHILD_PROCESSES = 2;
let activeGoogleChildProcesses = 0;
const googleChildWaiters: Array<() => void> = [];
let chromeLaunchPromise: Promise<ChromeStatus> | null = null;

async function acquireGoogleChildSlot(): Promise<() => void> {
	if (activeGoogleChildProcesses >= MAX_GOOGLE_CHILD_PROCESSES) {
		await new Promise<void>((resolve) => googleChildWaiters.push(resolve));
	}
	activeGoogleChildProcesses++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeGoogleChildProcesses--;
		googleChildWaiters.shift()?.();
	};
}

async function runNodeChild(
	args: string[],
	options: {
		env?: Record<string, string>;
		timeoutMs?: number;
		timeoutMessage?: string;
	} = {},
): Promise<{ code: number; stdout: string; stderr: string; combined: string }> {
	const release = await acquireGoogleChildSlot();
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			...(options.env ? { env: options.env } : {}),
		});
		const output = collectProcessOutput(proc);
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		function finish(fn: () => void): void {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			release();
			fn();
		}

		if (options.timeoutMs) {
			timer = setTimeout(() => {
				proc.kill();
				finish(() =>
					reject(
						new Error(
							options.timeoutMessage ??
								`Child process timed out after ${options.timeoutMs! / 1000}s`,
						),
					),
				);
			}, options.timeoutMs);
		}

		proc.on("close", (code) => {
			const stdout = output.stdout();
			const stderr = output.stderr();
			finish(() =>
				resolve({
					code: code ?? -1,
					stdout,
					stderr,
					combined: stdout + stderr,
				}),
			);
		});
		proc.on("error", (err) => finish(() => reject(err)));
	});
}

// ─── Headless resolution ─────────────────────────────────────────────

/**
 * Determine whether Chrome should run headless.
 * Respects the GREEDY_SEARCH_VISIBLE environment variable and DISPLAY
 * auto-detection before falling back to the caller's preference.
 *
 * DISPLAY detection requires both the env var to match a local display
 * (`:N` or `:N.M`) AND the X11 socket at /tmp/.X11-unix/X<N> to exist.
 * The env var alone can be stale — exporting DISPLAY=:0 in a shell
 * profile persists after the X session ends, so without the socket
 * check we would launch non-headless against a dead display and
 * silently break Google search.
 */
function shouldUseHeadless(explicit?: boolean): boolean {
	if (explicit !== undefined) return explicit;
	if (process.env.GREEDY_SEARCH_VISIBLE === "1") return false;
	const display = process.env.DISPLAY;
	if (display) {
		const match = display.match(/^:(\d+)(?:\.\d+)?$/);
		if (match && existsSync(`/tmp/.X11-unix/X${match[1]}`)) {
			return false;
		}
	}
	return true;
}

// ─── Chrome management ───────────────────────────────────────────────

/**
 * Ensure the CDP Chrome instance is running.
 * Spawns bin/launch.mjs which handles auto-launch, PID tracking, and idle cleanup.
 */
export async function ensureChrome(headless?: boolean): Promise<ChromeStatus> {
	const useHeadless = shouldUseHeadless(headless);
	if (chromeLaunchPromise) return chromeLaunchPromise;

	chromeLaunchPromise = (async () => {
		const launchBin = resolvePath("bin", "launch.mjs");
		if (!existsSync(launchBin)) {
			throw new Error(
				"Chrome CDP launcher not found (bin/launch.mjs is missing). AI summarization and Google search are unavailable without the CDP infrastructure.",
			);
		}

		const env: Record<string, string | undefined> = {
			...process.env,
			GREEDY_SEARCH_HEADLESS: useHeadless ? "1" : "0",
			GREEDY_SEARCH_VISIBLE: useHeadless ? undefined : "1",
		};
		Object.keys(env).forEach((k) => {
			if (env[k] === undefined) delete env[k];
		});

		const result = await runNodeChild([launchBin], {
			env: env as Record<string, string>,
			timeoutMs: 30000,
			timeoutMessage: "Chrome launch timed out after 30s",
		});

		if (result.code === 0) {
			return { running: true, ready: result.combined.includes("Ready") };
		}
		if (result.combined.includes("already running")) {
			return { running: true, ready: true };
		}
		throw new Error(
			`Chrome launch failed (exit ${result.code}): ${result.stderr || result.stdout}`,
		);
	})();

	try {
		return await chromeLaunchPromise;
	} finally {
		chromeLaunchPromise = null;
	}
}

/**
 * Check if Chrome CDP is available without launching it.
 */
export async function checkChromeRunning(): Promise<ChromeStatus> {
	const launchBin = resolvePath("bin", "launch.mjs");
	try {
		const result = await runNodeChild([launchBin, "--status"], {
			timeoutMs: 10000,
			timeoutMessage: "Chrome status check timed out after 10s",
		});
		if (result.code === 0 && result.stdout.includes("Running")) {
			const pidMatch = result.stdout.match(/pid (\d+)/);
			return {
				running: true,
				ready: true,
				pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : undefined,
			};
		}
	} catch {
		// status checks should never throw to callers
	}
	return { running: false, ready: false };
}

// ─── Google AI Search ────────────────────────────────────────────────

/**
 * Run a Google AI search query via CDP.
 * Automatically ensures Chrome is running before executing.
 */
export async function googleAISearch(
	query: string,
	options: {
		short?: boolean;
		headless?: boolean;
		locale?: string;
		timeoutMs?: number;
	} = {},
): Promise<GoogleAIResult> {
	const { short = false, headless, locale, timeoutMs = 60000 } = options;
	const useHeadless = shouldUseHeadless(headless);
	const extractorBin = resolvePath("extractors", "google-ai.mjs");

	if (!existsSync(extractorBin)) {
		throw new Error(
			"Google AI extractor not found (extractors/google-ai.mjs is missing). AI summarization unavailable without this file.",
		);
	}

	const args: string[] = [extractorBin, query];
	if (short) args.push("--short");
	if (locale) args.push("--locale", locale);

	const greedyProfileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
	const result = await runNodeChild(args, {
		env: {
			...process.env,
			CDP_PROFILE_DIR: greedyProfileDir,
			GREEDY_SEARCH_HEADLESS: useHeadless ? "1" : "0",
		} as Record<string, string>,
		timeoutMs,
		timeoutMessage: `Google AI search timed out after ${timeoutMs / 1000}s`,
	});

	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() || `google-ai.mjs exited with code ${result.code}`,
		);
	}

	try {
		return JSON.parse(result.stdout.trim()) as GoogleAIResult;
	} catch {
		throw new Error(
			`Invalid JSON from google-ai.mjs: ${result.stdout.slice(0, 200)}`,
		);
	}
}

/**
 * Run a plain Google search via CDP (traditional 10 blue links).
 * Locale-agnostic — uses textarea[name="q"] which works across all Google locales.

 * Complements DDG/Brave as a third search engine.
 */
export async function googleSearch(
	query: string,
	options: {
		headless?: boolean;
		timeoutMs?: number;
		maxResults?: number;
	} = {},
): Promise<GoogleSearchOutput> {
	const { headless, timeoutMs = 45000, maxResults = 10 } = options;
	const useHeadless = shouldUseHeadless(headless);
	const extractorBin = resolvePath("extractors", "google-search.mjs");

	if (!existsSync(extractorBin)) {
		throw new Error(
			"Google search extractor not found (extractors/google-search.mjs is missing). Google search unavailable without this file.",
		);
	}

	const greedyProfileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
	const result = await runNodeChild(
		[extractorBin, query, "--max", String(maxResults)],
		{
			env: {
				...process.env,
				CDP_PROFILE_DIR: greedyProfileDir,
				GREEDY_SEARCH_HEADLESS: useHeadless ? "1" : "0",
			} as Record<string, string>,
			timeoutMs,
			timeoutMessage: `Google search timed out after ${timeoutMs / 1000}s`,
		},
	);

	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() ||
				`google-search.mjs exited with code ${result.code}`,
		);
	}

	try {
		return JSON.parse(result.stdout.trim()) as GoogleSearchOutput;
	} catch {
		throw new Error(
			`Invalid JSON from google-search.mjs: ${result.stdout.slice(0, 200)}`,
		);
	}
}

/**
 * Summarize a URL's content using Google AI Mode via CDP.
 * Passes the URL directly to Google AI (udm=50) — no need to fetch first.

 * Used by webfetch to replace the 1800-char truncation with an AI summary.
 */
export async function summarizeUrl(
	url: string,
	options: {
		headless?: boolean;
		timeoutMs?: number;
		/** The original search query that led to this URL — included for focused summarization */

		context?: string;
	} = {},
): Promise<string> {
	const { headless, timeoutMs = 15000, context } = options;
	const useHeadless = shouldUseHeadless(headless);
	const extractorBin = resolvePath("extractors", "google-ai.mjs");

	if (!existsSync(extractorBin)) {
		throw new Error(
			"Google AI extractor not found (extractors/google-ai.mjs is missing). AI summarization unavailable.",
		);
	}

	const query = context
		? `The user searched for: "${context}". Give a concise summary of this page focusing on the user's search topic (use bullet points, ~500 tokens max): ${url}`
		: `Give a concise summary (~500 tokens max, use bullet points) of this page: ${url}`;

	const greedyProfileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
	const result = await runNodeChild([extractorBin, query], {
		env: {
			...process.env,
			CDP_PROFILE_DIR: greedyProfileDir,
			GREEDY_SEARCH_HEADLESS: useHeadless ? "1" : "0",
		} as Record<string, string>,
		timeoutMs,
		timeoutMessage: `Summarization timed out after ${timeoutMs / 1000}s`,
	});

	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() || `google-ai.mjs exited with code ${result.code}`,
		);
	}

	try {
		const parsed = JSON.parse(result.stdout.trim()) as { answer: string };
		return parsed.answer || "";
	} catch {
		throw new Error(
			`Invalid JSON from google-ai.mjs: ${result.stdout.slice(0, 200)}`,
		);
	}
}

/**
 * Synthesize web search results using Google AI.
 * Takes existing search result snippets and feeds them to Google AI
 * for a unified summary with source attribution.
 */

// ─── CDP Availability Check ──────────────────────────────────────────

/**
 * Check if the CDP infrastructure is available (files exist).
 */
export function cdpAvailable(): boolean {
	return (
		existsSync(resolvePath("bin", "cdp.mjs")) &&
		existsSync(resolvePath("bin", "launch.mjs")) &&
		existsSync(resolvePath("extractors", "google-ai.mjs")) &&
		existsSync(resolvePath("extractors", "google-search.mjs")) &&
		existsSync(resolvePath("extractors", "common.mjs")) &&
		existsSync(resolvePath("extractors", "consent.mjs")) &&
		existsSync(resolvePath("extractors", "selectors.mjs"))
	);
}
