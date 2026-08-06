/**
 * google-ai.ts — TypeScript wrapper for CDP-based Google search
 *
 * Spawns the CDP infrastructure (bin/cdp.mjs, bin/launch.mjs) and
 * the Google extractors (extractors/google-ai.mjs, extractors/google-search.mjs)
 * as child processes.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { debug } from "./debug.ts";
import { redactSecrets } from "./redact.ts";

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

type BrokerAttemptPhase =
	| "startup"
	| "connect"
	| "register"
	| "search"
	| "navigation"
	| "extraction"
	| "reset"
	| "release";

type BrokerAttemptFallbackOutcome =
	| "not_attempted"
	| "skipped"
	| "succeeded"
	| "failed";

interface BrokerAttemptEnvelope {
	schema: "pi-webaio.broker-attempt";
	version: 1;
	/** Opaque per-attempt identifier; never a broker or CDP identifier. */
	requestId: string;
	provider: "google-search";
	queryHash: string;
	queryLength: number;
	outcome: "success" | "failure";
	phase: BrokerAttemptPhase;
	durationMs: number;
	remainingBudgetMs: number;
	brokerTimings?: BrokerSearchTimings;
	sanitizedError?: { code?: string; message: string };
	fallbackOutcome: BrokerAttemptFallbackOutcome;
	fallbackReason?:
		| "aborted"
		| "deadline"
		| "no_budget"
		| "broker_failure"
		| "cleanup_failed"
		| "not_applicable";
	cleanupOutcome?: "succeeded" | "failed" | "skipped_shared" | "not_attempted";
	cleanupError?: { code?: string; message: string };
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
let brokerDeferredProcess: ReturnType<typeof spawn> | null = null;
const brokerClientUsers = new Map<BrokerClient, number>();
let brokerLifecycleTail: Promise<void> = Promise.resolve();
let brokerGenerationUnavailable = false;
let brokerTeardownPending = false;
const retiredBrokerClients = new Set<BrokerClient>();
const BROKER_CLEANUP_TIMEOUT_MS = 250;
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

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown })?.code;
	return typeof code === "string" && code.length > 0 ? code : undefined;
}

function brokerPhaseForError(
	error: unknown,
	lastPhase: BrokerAttemptPhase,
): BrokerAttemptPhase {
	const code = errorCode(error)?.toLowerCase();
	if (code?.includes("register")) return "register";
	if (code?.includes("navigation") || code === "navigate_failed")
		return "navigation";
	if (code?.includes("extract")) return "extraction";
	if (code?.includes("reset")) return "reset";
	if (code?.includes("release") || code?.includes("lease")) return "release";
	// Transport errors are not intrinsically connect-phase errors. A closed
	// connection during search belongs to search, while the same error during
	// startup belongs to startup. Keep the phase observed at the call site.
	return lastPhase;
}

function sanitizeBrokerError(
	error: unknown,
	query: string,
): { code?: string; message: string } {
	const rawCode = errorCode(error);
	const code =
		rawCode && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : undefined;
	let message = String((error as { message?: unknown })?.message || error);
	// Apply both the repository redactor and the strict envelope boundary before
	// the legacy structural masks. In particular, do not turn
	// `Authorization: Bearer <value>` into a partially masked string that leaves
	// a short credential remainder behind.
	message = sanitizeBrokerEnvelopeText(message, query);
	if (query) message = message.split(query).join("[redacted-query]");
	message = message
		.replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
		.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[redacted-id]")
		.replace(/\b[0-9a-f]{24,}\b/gi, "[redacted-id]")
		.replace(
			/\b(target(?:Id)?|session(?:Id)?|client(?:Id)?|tab|capabilit(?:y|ies)|cookie|credential|token|password|secret|authorization)\s*(?:[=:]|\s)\s*[^,;\s]+/gi,
			"$1=[redacted]",
		)
		.slice(0, 240);
	return code ? { code, message } : { message };
}

// The general redactor deliberately has minimum-length/entropy guards to avoid
// damaging normal documents. An envelope is different: it is a small, closed
// diagnostic boundary, so every credential-shaped value and every broker ID
// label must be removed even when the value is one character long.
const BROKER_AUTH_VALUE_RE =
	/\b(?:authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[^\s,;\"'}\]]+/gi;
const BROKER_JWT_RE =
	/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BROKER_ID_WITH_VALUE_RE =
	/\b(?:target\s*id|session\s*id|client\s*id|targetid|sessionid|clientid|target|session|client)\s*\"?\s*(?:[:=]|\s)\s*\"?[^,;\s}\"']+/gi;
const BROKER_ID_LABEL_RE =
	/\b(?:target\s*id|session\s*id|client\s*id|targetid|sessionid|clientid)\b/gi;

function sanitizeBrokerEnvelopeText(text: string, query: string): string {
	let safe = redactSecrets(text);
	if (query) {
		// The first replacement handles ordinary error strings; the second handles
		// a query that was JSON-escaped by a newly-added envelope field.
		safe = safe.split(query).join("[redacted-query]");
		const escapedQuery = JSON.stringify(query);
		if (escapedQuery) safe = safe.split(escapedQuery.slice(1, -1)).join("[redacted-query]");
	}
	safe = safe
		.replace(BROKER_AUTH_VALUE_RE, "[redacted-authorization]")
		.replace(BROKER_JWT_RE, "[redacted-jwt]")
		.replace(BROKER_ID_WITH_VALUE_RE, "[redacted-id]")
		.replace(BROKER_ID_LABEL_RE, "[redacted-id-label]");
	return safe;
}

function safeBrokerTimings(value: unknown): BrokerSearchTimings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const names = ["targetSetupMs", "navigationMs", "extractionMs", "resetMs"] as const;
	const timings = {} as BrokerSearchTimings;
	for (const name of names) {
		const number = source[name];
		if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
			return undefined;
		timings[name] = Math.min(number, 86_400_000);
	}
	return timings;
}

function emitBrokerAttemptEnvelope(
	envelope: BrokerAttemptEnvelope,
	query: string,
): void {
	// Redact the final serialized envelope too. This is the last boundary before
	// diagnostics leave the process, so a newly-added field cannot bypass the
	// sensitive-value masking in sanitizeBrokerError().
	try {
		debug("broker", sanitizeBrokerEnvelopeText(JSON.stringify(envelope), query));
	} catch {
		// A diagnostic must never affect the provider result.
	}
}

function isBrokerCancellation(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || errorCode(error) === "request_fenced";
}

function assertBrokerBudget(options: {
	deadlineAt: number;
	signal?: AbortSignal;
}): void {
	if (options.signal?.aborted)
		throw Object.assign(new Error("Request was cancelled"), {
			code: "request_fenced",
		});
	if (options.deadlineAt <= Date.now())
		throw Object.assign(new Error("Request deadline expired"), {
			code: "connect_timeout",
		});
}

/** Serialize broker acquisition and teardown, while leases protect active users. */
function withBrokerLifecycle<T>(operation: () => Promise<T>): Promise<T> {
	const run = brokerLifecycleTail.then(operation);
	brokerLifecycleTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function retainBrokerClient(client: BrokerClient): void {
	brokerClientUsers.set(client, (brokerClientUsers.get(client) ?? 0) + 1);
}

function releaseBrokerClient(client: BrokerClient): number {
	const remaining = Math.max((brokerClientUsers.get(client) ?? 1) - 1, 0);
	if (remaining === 0) brokerClientUsers.delete(client);
	else brokerClientUsers.set(client, remaining);
	return remaining;
}

async function awaitWithinBudget<T>(
	operation: Promise<T> | (() => Promise<T>),
	options: { deadlineAt?: number; signal?: AbortSignal },
): Promise<T> {
	// A thunk is essential for broker operations: constructing a promise can
	// start ensure/connect/search before this helper has a chance to fence it.
	if (options.signal?.aborted)
		throw Object.assign(new Error("Request was cancelled"), {
			code: "request_fenced",
		});
	if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())
		throw Object.assign(new Error("Request deadline expired"), {
			code: "connect_timeout",
		});
	const promise =
		typeof operation === "function" ? operation() : operation;
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

type BrokerResources = {
	client: BrokerClient | null;
	processHandle: ReturnType<typeof spawn> | null;
};

function detachBrokerResources(expectedClient?: BrokerClient): BrokerResources | null {
	if (expectedClient && brokerClient !== expectedClient) return null;
	const resources = {
		client: brokerClient,
		processHandle: brokerProcess ?? brokerDeferredProcess,
	};
	brokerClient = null;
	brokerProcess = null;
	brokerDeferredProcess = null;
	brokerGenerationUnavailable = true;
	brokerTeardownPending = false;
	return resources;
}

async function teardownBrokerResources(resources: BrokerResources): Promise<void> {
	let closeError: unknown;
	try {
		resources.client?.close();
	} catch (error) {
		closeError = error;
	}
	const processHandle = resources.processHandle;
	if (processHandle && processHandle.exitCode === null) {
		try {
			processHandle.stdin?.end();
		} catch (error) {
			closeError ??= error;
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
					closeError ??= error;
				}
				finish();
			}, 1_000);
			processHandle.once("exit", finish);
			processHandle.once("error", finish);
		});
	}
	if (closeError) throw closeError;
}

async function runBoundedCleanup(
	operation: () => Promise<void> | void,
): Promise<void> {
	const cleanupPromise = Promise.resolve().then(operation);
	// A custom cleanup hook is test/integration surface and may never settle.
	// Attach a sink to its eventual rejection, then release the lifecycle queue
	// at a hard bound so a later broker generation can still be acquired.
	cleanupPromise.catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			cleanupPromise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
						Object.assign(new Error("Broker cleanup timed out"), {
							code: "cleanup_timeout",
							}),
					),
					BROKER_CLEANUP_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function handleBrokerProcessEvent(
	ownedProcess: ReturnType<typeof spawn>,
): Promise<void> {
	if (brokerProcess !== ownedProcess) return;
	// Do not close the singleton while another request owns a lease. The
	// generation is unavailable immediately, preventing new users from joining;
	// teardown is serialized after the last active user releases it.
	brokerProcess = null;
	brokerGenerationUnavailable = true;
	if (brokerClient && (brokerClientUsers.get(brokerClient) ?? 0) > 0) {
		retiredBrokerClients.add(brokerClient);
		brokerTeardownPending = true;
		return;
	}
	const resources = detachBrokerResources();
	if (resources) {
		try {
			await teardownBrokerResources(resources);
		} catch (error) {
			debug("broker", "process-event cleanup failed", sanitizeBrokerError(error, ""));
		}
	}
}

/**
 * Narrow injectable equivalent of the child-process error/exit path. Tests use
 * it to drive the same lease-aware coordinator without depending on OS process
 * scheduling; production handlers call handleBrokerProcessEvent() directly.
 */
export async function notifyGoogleBrokerProcessEventForTests(
	client: BrokerClient,
): Promise<void> {
	await withBrokerLifecycle(async () => {
		brokerGenerationUnavailable = true;
		if ((brokerClientUsers.get(client) ?? 0) > 0) {
			retiredBrokerClients.add(client);
			brokerTeardownPending = true;
			return;
		}
		await teardownBrokerResources({ client, processHandle: null });
	});
}

async function ensureGoogleBroker(
	profileDir: string,
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<BrokerClient> {
	if (
		brokerClient &&
		brokerClient.connected !== false &&
		!brokerGenerationUnavailable
	)
		return brokerClient;
	if (
		brokerGenerationUnavailable &&
		brokerTeardownPending &&
		[...brokerClientUsers.values()].some((count) => count > 0)
	)
		throw Object.assign(new Error("Broker generation unavailable"), {
			code: "connection_closed",
		});
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
				// A process event may have fenced this connection while connect() was
				// in flight. Never publish a client from an unavailable generation.
				if (brokerGenerationUnavailable) {
					try {
						connected.close();
					} catch {
						// The connection is already unusable.
					}
					throw Object.assign(new Error("Broker generation unavailable"), {
						code: "connection_closed",
					});
				}
				brokerClient = connected;
				brokerGenerationUnavailable = false;
				return connected;
			} catch (error) {
				lastError = error;
			}
			if (!brokerProcess || brokerProcess.exitCode !== null) {
				brokerGenerationUnavailable = false;
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
					void withBrokerLifecycle(() => handleBrokerProcessEvent(ownedProcess)).catch(
						() => undefined,
					);
				});
				ownedProcess.once("exit", () => {
					void withBrokerLifecycle(() => handleBrokerProcessEvent(ownedProcess)).catch(
						() => undefined,
					);
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

async function releaseBrokerLease(client: BrokerClient): Promise<void> {
	await withBrokerLifecycle(async () => {
		const remaining = releaseBrokerClient(client);
		if (remaining === 0 && retiredBrokerClients.delete(client)) {
			const deferredProcess = brokerDeferredProcess;
			brokerDeferredProcess = null;
			try {
				await teardownBrokerResources({ client, processHandle: deferredProcess });
			} catch (error) {
				debug("broker", "deferred cleanup failed", sanitizeBrokerError(error, ""));
			}
		}
		if (
			remaining === 0 &&
			brokerTeardownPending &&
			brokerClient === client
		) {
			const resources = detachBrokerResources(client);
			if (resources) {
				try {
					await teardownBrokerResources(resources);
				} catch (error) {
					debug("broker", "deferred cleanup failed", sanitizeBrokerError(error, ""));
				}
			}
		}
	});
}

export async function closeGoogleBroker(
	expectedClient?: BrokerClient,
): Promise<void> {
	return withBrokerLifecycle(async () => {
		if (expectedClient && brokerClient !== expectedClient) return;
		if (brokerClient && (brokerClientUsers.get(brokerClient) ?? 0) > 0) {
			retiredBrokerClients.add(brokerClient);
			brokerDeferredProcess = brokerProcess;
			brokerProcess = null;
			brokerGenerationUnavailable = true;
			brokerTeardownPending = true;
			return;
		}
		const resources = detachBrokerResources(expectedClient);
		if (!resources) return;
		await teardownBrokerResources(resources);
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
	/** Cleanup/quarantine the broker before an isolated legacy attempt. */
	cleanupBroker?: (client?: BrokerClient) => Promise<void> | void;
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
	const defaultCleanup = async (ownedClient?: BrokerClient) => {
		// No client means this attempt never acquired the singleton. In
		// particular, a failed connect must not tear down a broker another request
		// acquired concurrently.
		if (ownedClient) await closeGoogleBroker(ownedClient);
	};
	const cleanup = dependencies.cleanupBroker ?? defaultCleanup;
	const requestId = randomUUID();
	const queryHash = createHash("sha256").update(query).digest("hex");
	const attemptStartedAt = Date.now();
	let phase: BrokerAttemptPhase = "startup";
	let client: BrokerClient | undefined;
	let retainedClient = false;
	let cleanupOutcome: BrokerAttemptEnvelope["cleanupOutcome"];
	let cleanupError: unknown;

	const makeEnvelope = (
		outcome: BrokerAttemptEnvelope["outcome"],
		fallbackOutcome: BrokerAttemptFallbackOutcome,
		fallbackReason?: BrokerAttemptEnvelope["fallbackReason"],
		error?: unknown,
		result?: GoogleSearchOutput,
	): BrokerAttemptEnvelope => ({
		schema: "pi-webaio.broker-attempt",
		version: 1,
		requestId,
		provider: "google-search",
		queryHash,
		queryLength: query.length,
		outcome,
		phase: outcome === "failure" ? brokerPhaseForError(error, phase) : phase,
		durationMs: Math.max(Date.now() - attemptStartedAt, 0),
		remainingBudgetMs: Math.max(deadlineAt - Date.now(), 0),
		...(safeBrokerTimings(result?.timings)
			? { brokerTimings: safeBrokerTimings(result?.timings) }
			: {}),
		...(error ? { sanitizedError: sanitizeBrokerError(error, query) } : {}),
		fallbackOutcome,
		...(fallbackReason ? { fallbackReason } : {}),
		...(cleanupOutcome ? { cleanupOutcome } : {}),
		...(cleanupError
			? { cleanupError: sanitizeBrokerError(cleanupError, query) }
			: {}),
	});

	const emitFailure = (
		error: unknown,
		fallbackOutcome: BrokerAttemptFallbackOutcome,
		fallbackReason?: BrokerAttemptEnvelope["fallbackReason"],
	) =>
		emitBrokerAttemptEnvelope(
			makeEnvelope("failure", fallbackOutcome, fallbackReason, error),
			query,
		);

	try {
		await awaitWithinBudget(
			() =>
				ensure(options.headless, {
					deadlineAt,
					signal: options.signal,
				}),
			{ deadlineAt, signal: options.signal },
		);
		phase = "connect";
		const connectedClient = await awaitWithinBudget(
			() =>
				withBrokerLifecycle(async () => {
					assertBrokerBudget({ deadlineAt, signal: options.signal });
					const acquired = await connect({
						profileDir,
						deadlineAt,
						signal: options.signal,
					});
					retainBrokerClient(acquired);
					client = acquired;
					retainedClient = true;
					return acquired;
				}),
			{ deadlineAt, signal: options.signal },
		);
		phase = "search";
		const result = await awaitWithinBudget(
			() =>
				connectedClient.search(query, {
					maxResults: options.maxResults,
					signal: options.signal,
					deadlineAt,
				}),
			{ deadlineAt, signal: options.signal },
		);
		emitBrokerAttemptEnvelope(
			makeEnvelope("success", "not_attempted", undefined, undefined, result),
			query,
		);
		if (retainedClient && client) {
			await releaseBrokerLease(client);
			retainedClient = false;
		}
		return result;
	} catch (error) {
		const cleanupPromise = withBrokerLifecycle(async () => {
			let cleanupResources: BrokerResources | null = null;
			if (retainedClient && client) {
				retainedClient = false;
				const remaining = releaseBrokerClient(client);
				if (remaining > 0) {
					cleanupOutcome = "skipped_shared";
					return;
				}
			// Quarantine before invoking an arbitrary cleanup hook. A timed-out
			// hook must not leave a client eligible for a later acquisition.
			if (brokerClient === client) cleanupResources = detachBrokerResources(client);
			else if (retiredBrokerClients.delete(client)) {
				const deferredProcess = brokerDeferredProcess;
				brokerDeferredProcess = null;
				cleanupResources = { client, processHandle: deferredProcess };
			}
			}
			if (!client && cleanup === defaultCleanup) {
				cleanupOutcome = "not_attempted";
				return;
			}
			if (cleanup === defaultCleanup && client && !cleanupResources)
				// The injectable connect seam does not populate the production
				// singleton, but the acquired client still needs deterministic close.
				cleanupResources = { client, processHandle: null };
			try {
				await runBoundedCleanup(() =>
					cleanup === defaultCleanup && cleanupResources
						? teardownBrokerResources(cleanupResources)
						: cleanup(client),
				);
				cleanupOutcome = "succeeded";
			} catch (cleanupFailure) {
				cleanupOutcome = "failed";
				cleanupError = cleanupFailure;
			}
		});
		cleanupPromise.catch(() => undefined);

		const aborted = isBrokerCancellation(error, options.signal);
		const expired = Date.now() >= deadlineAt;
		if (aborted || expired || !brokerFallbackHasTime(deadlineAt)) {
			try {
				// Cleanup has its own hard bound, independent of the already-fired
				// request fence, so the lifecycle tail always settles and diagnostics
				// include failures/timeouts for abort/deadline paths too.
				await cleanupPromise;
			} catch (cleanupWaitError) {
				cleanupOutcome = "failed";
				cleanupError = cleanupWaitError;
			}
			emitFailure(
				error,
				"skipped",
				cleanupOutcome === "failed"
					? "cleanup_failed"
					: aborted
						? "aborted"
						: expired
						? "deadline"
						: "no_budget",
			);
			throw error;
		}

		try {
			await awaitWithinBudget(cleanupPromise, {
				deadlineAt,
				signal: options.signal,
			});
		} catch (cleanupWaitError) {
			cleanupOutcome = "failed";
			cleanupError = cleanupWaitError;
			const cleanupAborted = isBrokerCancellation(
				cleanupWaitError,
				options.signal,
			);
			const cleanupExpired = Date.now() >= deadlineAt;
			emitFailure(
				error,
				"skipped",
				cleanupAborted
					? "aborted"
					: cleanupExpired
						? "deadline"
						: "cleanup_failed",
			);
			throw error;
		}
		if (cleanupOutcome === "failed") {
			emitFailure(error, "skipped", "cleanup_failed");
			throw error;
		}
		if (isBrokerCancellation(error, options.signal)) {
			emitFailure(error, "skipped", "aborted");
			throw error;
		}
		if (Date.now() >= deadlineAt || !brokerFallbackHasTime(deadlineAt)) {
			emitFailure(
				error,
				"skipped",
				Date.now() >= deadlineAt ? "deadline" : "no_budget",
			);
			throw error;
		}

		try {
			const legacyResult = await awaitWithinBudget(
				() =>
					legacySearch(query, {
						...options,
						timeoutMs: Math.max(deadlineAt - Date.now(), 1),
						deadlineAt,
					}),
				{ deadlineAt, signal: options.signal },
			);
			emitFailure(error, "succeeded", "broker_failure");
			return legacyResult;
		} catch (legacyError) {
			const legacyAborted = isBrokerCancellation(
				legacyError,
				options.signal,
			);
			const legacyExpired = Date.now() >= deadlineAt;
			if (legacyAborted || legacyExpired) {
				emitFailure(
					error,
					"skipped",
					legacyAborted ? "aborted" : "deadline",
				);
			} else {
				emitFailure(error, "failed", "broker_failure");
			}
			throw legacyError;
		}
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
