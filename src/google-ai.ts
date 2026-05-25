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

// Resolve relative to the pi-webaio package root
// When this file is compiled/run as part of the extension, the CWD should
// be the package root. We also try to resolve via import.meta if available.
let PACKAGE_ROOT = "";
try {
	PACKAGE_ROOT = join(import.meta.dirname || "", "..");
} catch {
	PACKAGE_ROOT = process.cwd();
}

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

// ─── Chrome management ───────────────────────────────────────────────

/**

 * Ensure the CDP Chrome instance is running.
 * Spawns bin/launch.mjs which handles auto-launch, PID tracking, and idle cleanup.
 */
export function ensureChrome(headless = true): Promise<ChromeStatus> {
	return new Promise((resolve, reject) => {
		const launchBin = resolvePath("bin", "launch.mjs");
		if (!existsSync(launchBin)) {
			reject(
				new Error(
					"Chrome CDP launcher not found (bin/launch.mjs is missing). AI summarization and Google search are unavailable without the CDP infrastructure.",
				),
			);
			return;
		}

		const env: Record<string, string | undefined> = {
			...process.env,
			GREEDY_SEARCH_HEADLESS: headless ? "1" : "0",
			GREEDY_SEARCH_VISIBLE: headless ? undefined : "1",
		};
		// Remove undefined values
		Object.keys(env).forEach((k) => {
			if (env[k] === undefined) delete env[k];
		});

		const proc = spawn(process.execPath, [launchBin], {
			stdio: ["ignore", "pipe", "pipe"],
			env: env as Record<string, string>,
		});
		const output = collectProcessOutput(proc);

		const timer = setTimeout(() => {
			proc.kill();

			reject(new Error("Chrome launch timed out after 30s"));
		}, 30000);

		proc.on("close", (code: number) => {
			clearTimeout(timer);
			const combined = output.combined();

			if (code === 0) {
				// Parse status from output
				const ready = combined.includes("Ready");
				resolve({ running: true, ready });
			} else if (combined.includes("already running")) {
				resolve({ running: true, ready: true });
			} else {
				reject(
					new Error(
						`Chrome launch failed (exit ${code}): ${output.stderr() || output.stdout()}`,
					),
				);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Check if Chrome CDP is available without launching it.
 */
export function checkChromeRunning(): Promise<ChromeStatus> {
	return new Promise((resolve) => {
		const launchBin = resolvePath("bin", "launch.mjs");

		const proc = spawn(process.execPath, [launchBin, "--status"], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const output = collectProcessOutput(proc);

		proc.on("close", (code: number) => {
			const stdout = output.stdout();
			if (code === 0 && stdout.includes("Running")) {
				const pidMatch = stdout.match(/pid (\d+)/);

				resolve({
					running: true,
					ready: true,
					pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : undefined,
				});
			} else {
				resolve({ running: false, ready: false });
			}
		});

		proc.on("error", () => {
			resolve({ running: false, ready: false });
		});
	});
}

// ─── Google AI Search ────────────────────────────────────────────────

/**
 * Run a Google AI search query via CDP.
 * Automatically ensures Chrome is running before executing.
 */
export function googleAISearch(
	query: string,
	options: {
		short?: boolean;
		headless?: boolean;
		locale?: string;
		timeoutMs?: number;
	} = {},
): Promise<GoogleAIResult> {
	const { short = false, headless = true, locale, timeoutMs = 60000 } = options;

	return new Promise((resolve, reject) => {
		const extractorBin = resolvePath("extractors", "google-ai.mjs");

		if (!existsSync(extractorBin)) {
			reject(
				new Error(
					"Google AI extractor not found (extractors/google-ai.mjs is missing). AI summarization unavailable without this file.",
				),
			);
			return;
		}

		const args: string[] = [extractorBin, query];
		if (short) args.push("--short");
		if (locale) args.push("--locale", locale);

		// Set CDP_PROFILE_DIR so cdp.mjs targets the GreedySearch Chrome profile.
		// constants.mjs uses tmpdir(), so we set it to match what launch.mjs uses.
		const greedyProfileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;

		const env: Record<string, string> = {
			...process.env,
			CDP_PROFILE_DIR: greedyProfileDir,
			GREEDY_SEARCH_HEADLESS: headless ? "1" : "0",
		};

		const proc = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: env as Record<string, string>,
		});

		const output = collectProcessOutput(proc);

		const timer = setTimeout(() => {
			proc.kill();
			reject(
				new Error(`Google AI search timed out after ${timeoutMs / 1000}s`),
			);
		}, timeoutMs);

		proc.on("close", (code: number) => {
			clearTimeout(timer);
			const stdout = output.stdout();
			const stderr = output.stderr();

			if (code !== 0) {
				const errMsg =
					stderr.trim() || `google-ai.mjs exited with code ${code}`;
				reject(new Error(errMsg));
				return;
			}

			try {
				const result = JSON.parse(stdout.trim()) as GoogleAIResult;
				resolve(result);
			} catch {
				reject(
					new Error(`Invalid JSON from google-ai.mjs: ${stdout.slice(0, 200)}`),
				);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Run a plain Google search via CDP (traditional 10 blue links).
 * Locale-agnostic — uses textarea[name="q"] which works across all Google locales.
 * Complements DDG/Brave as a third search engine.
 */
export function googleSearch(
	query: string,
	options: {
		headless?: boolean;
		timeoutMs?: number;
		maxResults?: number;
	} = {},
): Promise<GoogleSearchOutput> {
	const { headless = true, timeoutMs = 45000, maxResults = 10 } = options;

	return new Promise((resolve, reject) => {
		const extractorBin = resolvePath("extractors", "google-search.mjs");

		if (!existsSync(extractorBin)) {
			reject(
				new Error(
					"Google search extractor not found (extractors/google-search.mjs is missing). Google search unavailable without this file.",
				),
			);
			return;
		}

		const greedyProfileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;

		const args: string[] = [extractorBin, query, "--max", String(maxResults)];

		const env: Record<string, string> = {
			...process.env,
			CDP_PROFILE_DIR: greedyProfileDir,
			GREEDY_SEARCH_HEADLESS: headless ? "1" : "0",
		};

		const proc = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: env as Record<string, string>,
		});

		const output = collectProcessOutput(proc);

		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`Google search timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		proc.on("close", (code: number) => {
			clearTimeout(timer);
			const stdout = output.stdout();
			const stderr = output.stderr();

			if (code !== 0) {
				const errMsg =
					stderr.trim() || `google-search.mjs exited with code ${code}`;
				reject(new Error(errMsg));
				return;
			}

			try {
				const result = JSON.parse(stdout.trim()) as GoogleSearchOutput;
				resolve(result);
			} catch {
				reject(
					new Error(
						`Invalid JSON from google-search.mjs: ${stdout.slice(0, 200)}`,
					),
				);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Summarize a URL's content using Google AI Mode via CDP.
 * Passes the URL directly to Google AI (udm=50) — no need to fetch first.
 * Used by webfetch to replace the 1800-char truncation with an AI summary.
 */
export function summarizeUrl(
	url: string,
	options: {
		headless?: boolean;
		timeoutMs?: number;
		/** The original search query that led to this URL — included for focused summarization */
		context?: string;
	} = {},
): Promise<string> {
	const { headless = true, timeoutMs = 15000, context } = options;

	return new Promise((resolve, reject) => {
		const extractorBin = resolvePath("extractors", "google-ai.mjs");

		if (!existsSync(extractorBin)) {
			reject(
				new Error(
					"Google AI extractor not found (extractors/google-ai.mjs is missing). AI summarization unavailable.",
				),
			);
			return;
		}

		const prompt = context
			? `The user searched for: "${context}". Give a concise summary of this page focusing on the user's search topic (use bullet points, ~500 tokens max): ${url}`
			: `Give a concise summary (~500 tokens max, use bullet points) of this page: ${url}`;

		const query = prompt;

		const greedyProfileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;

		const env: Record<string, string> = {
			...process.env,
			CDP_PROFILE_DIR: greedyProfileDir,
			GREEDY_SEARCH_HEADLESS: headless ? "1" : "0",
		};

		const proc = spawn(process.execPath, [extractorBin, query], {
			stdio: ["ignore", "pipe", "pipe"],
			env: env as Record<string, string>,
		});

		const output = collectProcessOutput(proc);

		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`Summarization timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		proc.on("close", (code: number) => {
			clearTimeout(timer);
			const stdout = output.stdout();
			const stderr = output.stderr();

			if (code !== 0) {
				const errMsg =
					stderr.trim() || `google-ai.mjs exited with code ${code}`;
				reject(new Error(errMsg));
				return;
			}

			try {
				const result = JSON.parse(stdout.trim()) as { answer: string };
				resolve(result.answer || "");
			} catch {
				reject(
					new Error(`Invalid JSON from google-ai.mjs: ${stdout.slice(0, 200)}`),
				);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Synthesize web search results using Google AI.
 * Takes existing search result snippets and feeds them to Google AI
 * for a unified summary with source attribution.
 */
export function synthesizeWithGoogleAI(
	query: string,
	// We just re-run the search through Google AI — it handles synthesis natively
	// by combining its own knowledge with the search context
	options: {
		headless?: boolean;
		timeoutMs?: number;
	} = {},
): Promise<GoogleAIResult> {
	// Google AI Mode (udm=50) already provides synthesized answers
	// with source attribution, so we can just use it directly
	return googleAISearch(query, {
		headless: options.headless,
		timeoutMs: options.timeoutMs,
	});
}

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
