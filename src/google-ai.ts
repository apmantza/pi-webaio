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
import { pathToFileURL } from "node:url";

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

/**
 * Broker-owned search phase instrumentation (milliseconds). Additive and
 * only present on the broker path — the legacy path never reports timings.
 */
export interface BrokerSearchTimings {
	targetSetupMs: number;
	navigationMs: number;
	extractionMs: number;
	resetMs: number;
}

export interface GoogleSearchOutput {
	query: string;
	url: string;
	results: GoogleSearchResult[];
	/** Broker search-phase timings; absent on the legacy path. */
	timings?: BrokerSearchTimings;
}

export interface ChromeStatus {
	running: boolean;
	pid?: number;
	ready: boolean;
}

type BrokerClient = {
	connected?: boolean;
	search(
		query: string,
		options?: {
			maxResults?: number;
			signal?: AbortSignal;
			deadlineAt?: number;
		},
	): Promise<GoogleSearchOutput>;
	close(): void;
};

type BrokerModule = {
	connectGoogleCdpBroker(options: {
		profileDir: string;
		socketPath?: string;
		deadlineAt?: number;
		signal?: AbortSignal;
	}): Promise<BrokerClient>;
	brokerPaths(profileDir?: string): { socketPath: string };
};

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
let brokerClient: BrokerClient | null = null;
let brokerClientPromise: Promise<BrokerClient> | null = null;
let brokerProcess: ReturnType<typeof spawn> | null = null;
const BROKER_MIN_FALLBACK_BUDGET_MS = 1_000;

function brokerEnabled(): boolean {
	return process.env.PI_WEBAIO_CDP_BROKER === "1";
}

export function isBrokerInfrastructureError(error: unknown): boolean {
	const code = (error as { code?: unknown })?.code;
	return (
		typeof code === "string" &&
		new Set([
			"connect_failed",
			"connect_timeout",
			"connection_closed",
			"client_closed",
			"broker_error",
			"cdp_disconnected",
			"cdp_unavailable",
			"cdp_required",
			"cdp_profile_mismatch",
			"register_failed",
		]).has(code)
	);
}

export function brokerFallbackHasTime(deadlineAt: number | undefined): boolean {
	return (
		deadlineAt === undefined ||
		deadlineAt - Date.now() > BROKER_MIN_FALLBACK_BUDGET_MS
	);
}

async function awaitWithinBudget<T>(
	promise: Promise<T>,
	options: { deadlineAt?: number; signal?: AbortSignal },
): Promise<T> {
	if (options.deadlineAt === undefined && !options.signal) return promise;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error, value?: T) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(value as T);
		};
		const abort = () =>
			finish(
				Object.assign(new Error("Request was cancelled"), {
					code: "request_fenced",
				}),
			);
		if (options.signal?.aborted) return abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.deadlineAt !== undefined) {
			if (options.deadlineAt <= Date.now())
				return finish(
					Object.assign(new Error("Request deadline expired"), {
						code: "connect_timeout",
					}),
				);
			timer = setTimeout(
				() =>
					finish(
						Object.assign(new Error("Request deadline expired"), {
							code: "connect_timeout",
						}),
					),
				options.deadlineAt - Date.now(),
			);
		}
		promise.then(
			(value) => finish(undefined, value),
			(error) => finish(error),
		);
	});
}

async function loadBrokerModule(): Promise<BrokerModule> {
	const moduleUrl = pathToFileURL(
		resolvePath("extractors", "google-cdp-broker-client.mjs"),
	).href;
	return (await import(moduleUrl)) as unknown as BrokerModule;
}

async function ensureGoogleBroker(
	profileDir: string,
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<BrokerClient> {
	if (brokerClient && brokerClient.connected !== false) return brokerClient;
	if (brokerClientPromise) return brokerClientPromise;
	brokerClientPromise = (async () => {
		const module = await loadBrokerModule();
		const brokerBin = resolvePath("bin", "google-cdp-broker.mjs");
		const paths = module.brokerPaths(profileDir);
		const connect = () =>
			module.connectGoogleCdpBroker({
				profileDir,
				socketPath: paths.socketPath,
				deadlineAt,
				signal,
			});
		let lastError: unknown;
		for (;;) {
			if (signal?.aborted)
				throw Object.assign(new Error("Broker request was cancelled"), {
					code: "request_fenced",
				});
			if (Date.now() >= deadlineAt)
				throw Object.assign(new Error("Broker startup deadline expired"), {
					code: "connect_timeout",
				});
			try {
				const connected = await connect();
				brokerClient = connected;
				return connected;
			} catch (error) {
				lastError = error;
			}
			if (!brokerProcess || brokerProcess.exitCode !== null) {
				brokerProcess = spawn(
					process.execPath,
					[
						brokerBin,
						"--profile",
						profileDir,
						"--connect-cdp",
						"--cdp-port",
						"9222",
						"--parent-stdin",
					],
					{ stdio: ["pipe", "ignore", "ignore"] },
				);
				const ownedProcess = brokerProcess;
				ownedProcess.once("error", () => {
					if (brokerProcess === ownedProcess) {
						brokerProcess = null;
						brokerClient?.close();
						brokerClient = null;
					}
				});
				ownedProcess.once("exit", () => {
					if (brokerProcess === ownedProcess) {
						brokerProcess = null;
						brokerClient?.close();
						brokerClient = null;
					}
				});
			}
			await new Promise<void>((resolve) =>
				setTimeout(resolve, Math.min(40, Math.max(deadlineAt - Date.now(), 1))),
			);
			if (Date.now() >= deadlineAt && lastError) throw lastError;
		}
	})();
	try {
		return await brokerClientPromise;
	} finally {
		brokerClientPromise = null;
	}
}

export async function closeGoogleBroker(): Promise<void> {
	const client = brokerClient;
	const processHandle = brokerProcess;
	brokerClient = null;
	brokerProcess = null;
	client?.close();
	if (!processHandle || processHandle.exitCode !== null) return;
	try {
		processHandle.stdin?.end();
	} catch (error) {
		void error;
	}
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			try {
				processHandle.kill();
			} catch (error) {
				void error;
			}
			finish();
		}, 1_000);
		processHandle.once("exit", finish);
		processHandle.once("error", finish);
	});
}

async function acquireGoogleChildSlot(
	options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<() => void> {
	if (activeGoogleChildProcesses >= MAX_GOOGLE_CHILD_PROCESSES) {
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				const index = googleChildWaiters.indexOf(waiter);
				if (index >= 0) googleChildWaiters.splice(index, 1);
				if (timer) clearTimeout(timer);
				reject(
					Object.assign(new Error("Child process request was cancelled"), {
						code: "request_fenced",
					}),
				);
			};
			googleChildWaiters.push(waiter);
			if (options.deadlineAt !== undefined)
				timer = setTimeout(
					() => {
						const index = googleChildWaiters.indexOf(waiter);
						if (index >= 0) googleChildWaiters.splice(index, 1);
						reject(
							Object.assign(new Error("Child process deadline expired"), {
								code: "connect_timeout",
							}),
						);
					},
					Math.max(options.deadlineAt - Date.now(), 1),
				);
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});
	}
	if (options.signal?.aborted)
		throw Object.assign(new Error("Child process request was cancelled"), {
			code: "request_fenced",
		});
	if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())
		throw Object.assign(new Error("Child process deadline expired"), {
			code: "connect_timeout",
		});
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
		signal?: AbortSignal;
		deadlineAt?: number;
	} = {},
): Promise<{ code: number; stdout: string; stderr: string; combined: string }> {
	const deadlineAt =
		options.deadlineAt ??
		(options.timeoutMs ? Date.now() + options.timeoutMs : undefined);
	const release = await acquireGoogleChildSlot({
		signal: options.signal,
		deadlineAt,
	});
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
			options.signal?.removeEventListener("abort", abort);
			release();
			fn();
		}

		const abort = () => {
			proc.kill();
			finish(() => {
				const error = new Error("Child process request was cancelled");
				(error as Error & { code?: string }).code = "request_fenced";
				reject(error);
			});
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		if (deadlineAt !== undefined) {
			timer = setTimeout(
				() => {
					proc.kill();
					finish(() =>
						reject(
							new Error(
								options.timeoutMessage ??
									`Child process timed out after ${Math.max(deadlineAt - Date.now(), 0) / 1000}s`,
							),
						),
					);
				},
				Math.max(deadlineAt - Date.now(), 1),
			);
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
export async function ensureChrome(
	headless?: boolean,
	options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<ChromeStatus> {
	const useHeadless = shouldUseHeadless(headless);
	if (chromeLaunchPromise)
		return awaitWithinBudget(chromeLaunchPromise, options);

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
			deadlineAt: options.deadlineAt,
			signal: options.signal,
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
		return await awaitWithinBudget(chromeLaunchPromise, options);
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
export interface GoogleSearchOptions {
	headless?: boolean;
	timeoutMs?: number;
	maxResults?: number;
	signal?: AbortSignal;
	deadlineAt?: number;
}

async function runLegacyGoogleSearch(
	query: string,
	options: GoogleSearchOptions = {},
): Promise<GoogleSearchOutput> {
	const {
		headless,
		timeoutMs = 45000,
		maxResults = 10,
		signal,
		deadlineAt,
	} = options;
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
			deadlineAt,
			signal,
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

export interface GoogleSearchDependencies {
	ensureChrome?: (
		headless?: boolean,
		options?: { signal?: AbortSignal; deadlineAt?: number },
	) => Promise<ChromeStatus>;
	connectBroker?: (options: {
		profileDir: string;
		deadlineAt: number;
		signal?: AbortSignal;
	}) => Promise<BrokerClient>;
	legacySearch?: (
		query: string,
		options: GoogleSearchOptions,
	) => Promise<GoogleSearchOutput>;
}

/** Injectable seam used by offline tests; production callers use googleSearch. */
export async function googleSearchWithDependencies(
	query: string,
	options: GoogleSearchOptions = {},
	dependencies: GoogleSearchDependencies = {},
): Promise<GoogleSearchOutput> {
	const timeoutMs = options.timeoutMs ?? 45000;
	const deadlineAt = options.deadlineAt ?? Date.now() + timeoutMs;
	const legacySearch = dependencies.legacySearch ?? runLegacyGoogleSearch;
	if (!brokerEnabled()) return legacySearch(query, options);

	const profileDir = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
	const ensure = dependencies.ensureChrome ?? ensureChrome;
	const connect =
		dependencies.connectBroker ??
		((brokerOptions) =>
			ensureGoogleBroker(
				brokerOptions.profileDir,
				brokerOptions.deadlineAt,
				brokerOptions.signal,
			));
	let searchStarted = false;
	try {
		await ensure(options.headless, {
			deadlineAt,
			signal: options.signal,
		});
		if (!brokerFallbackHasTime(deadlineAt))
			throw Object.assign(new Error("Broker startup deadline expired"), {
				code: "connect_timeout",
			});
		const client = await connect({
			profileDir,
			deadlineAt,
			signal: options.signal,
		});
		searchStarted = true;
		// The broker envelope is additive: when the broker reports phase
		// `timings` they flow through to the caller unchanged. The legacy
		// branch above never produces a `timings` field.
		return await client.search(query, {
			maxResults: options.maxResults,
			signal: options.signal,
			deadlineAt,
		});
	} catch (error) {
		const canFallback =
			!options.signal?.aborted &&
			(!searchStarted || isBrokerInfrastructureError(error)) &&
			brokerFallbackHasTime(deadlineAt);
		if (!canFallback) throw error;
		return legacySearch(query, {
			...options,
			timeoutMs: Math.max(deadlineAt - Date.now(), 1),
			deadlineAt,
		});
	}
}

export function googleSearch(
	query: string,
	options: GoogleSearchOptions = {},
): Promise<GoogleSearchOutput> {
	return googleSearchWithDependencies(query, options);
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
