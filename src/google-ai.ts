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
import { join, resolve as resolvePathname } from "node:path";
import { pathToFileURL } from "node:url";
import { debug } from "./debug.ts";
import {
	redactBrokerEnvelopeFields,
	redactSecrets,
	scrubBrokerEnvelopeValue,
} from "./redact.ts";

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

type BrokerProcess = ReturnType<typeof spawn>;
type BrokerStartupGeneration = {
	promise: Promise<BrokerClient>;
	controller: AbortController;
	waiters: number;
	cancelled: boolean;
	settled: boolean;
	processHandle: BrokerProcess | null;
};
export type BrokerProcessFactory = typeof spawn;

type BrokerState = {
	profileKey: string;
	brokerClient: BrokerClient | null;
	brokerClientPromise: Promise<BrokerClient> | null;
	brokerStartupGeneration: BrokerStartupGeneration | null;
	brokerProcess: BrokerProcess | null;
	brokerDeferredProcess: BrokerProcess | null;
	brokerDeferredProcessExit: { processHandle: BrokerProcess; promise: Promise<void> } | null;
	brokerClientUsers: Map<BrokerClient, number>;
	brokerGenerationUnavailable: boolean;
	brokerTeardownPending: boolean;
	brokerPublicationPending: BrokerClient | null;
	retiredBrokerClients: Set<BrokerClient>;
	brokerKilledProcesses: WeakSet<object>;
	closePromise: Promise<void> | null;
	closePromiseHasExpectedClient: boolean;
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
const brokerStates = new Map<string, BrokerState>();
const brokerClientStates = new Map<BrokerClient, BrokerState>();
let brokerLifecycleTail: Promise<void> = Promise.resolve();
// A late connector may be observed by several cancelled waiters. Closing is a
// client-level action, not a request-level action.
const brokerClientCloseStarted = new WeakSet<object>();

function normalizeBrokerProfile(profileDir: string): string {
	const normalized = resolvePathname(profileDir).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function brokerStateForProfile(profileDir: string): BrokerState {
	const profileKey = normalizeBrokerProfile(profileDir);
	let state = brokerStates.get(profileKey);
	if (!state) {
		state = {
			profileKey,
			brokerClient: null,
			brokerClientPromise: null,
			brokerStartupGeneration: null,
			brokerProcess: null,
			brokerDeferredProcess: null,
			brokerDeferredProcessExit: null,
			brokerClientUsers: new Map(),
			brokerGenerationUnavailable: false,
			brokerTeardownPending: false,
			brokerPublicationPending: null,
			retiredBrokerClients: new Set(),
			brokerKilledProcesses: new WeakSet(),
			closePromise: null,
			closePromiseHasExpectedClient: false,
		};
		brokerStates.set(profileKey, state);
	}
	return state;
}

function brokerStateForClient(client: BrokerClient): BrokerState | undefined {
	return brokerClientStates.get(client);
}

function closeBrokerClientOnce(client: BrokerClient): void {
	if (brokerClientCloseStarted.has(client)) return;
	brokerClientCloseStarted.add(client);
	client.close();
}
const BROKER_CLEANUP_TIMEOUT_MS = 250;
const BROKER_STARTUP_TIMEOUT_MS = 30_000;
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
			"cleanup_timeout",
			"broker_process_pending",
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
	/\b(?:(?:authorization\s*(?:[:=]\s*)?(?:bearer|basic|token))|(?:bearer|basic))\s+[^\s,;\"'}\]]+/gi;
const BROKER_JWT_RE =
	/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BROKER_ID_WITH_VALUE_RE =
	/\b(?:target\s*id|session\s*id|client\s*id|targetid|sessionid|clientid|target|session|client)\s*\"?\s*(?:[:=]|\s)\s*\"?[^,;\s}\"']+/gi;
const BROKER_ID_LABEL_RE =
	/\b(?:target\s*id|session\s*id|client\s*id|targetid|sessionid|clientid)\b/gi;

function sanitizeBrokerEnvelopeText(text: string, query: string): string {
	let safe = redactBrokerEnvelopeFields(redactSecrets(text));
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
	_query: string,
): void {
	// Build and sanitize the diagnostic as structured values before serialization.
	// Never replace arbitrary query text in the serialized JSON: a query such as
	// "schema" or "requestId" must not rewrite envelope keys.
	try {
		debug("broker", JSON.stringify(scrubBrokerEnvelopeValue(envelope, undefined, true)));
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

function retainBrokerClient(state: BrokerState, client: BrokerClient): void {
	state.brokerClientUsers.set(client, (state.brokerClientUsers.get(client) ?? 0) + 1);
	brokerClientStates.set(client, state);
}

function releaseBrokerClient(state: BrokerState, client: BrokerClient): number {
	const remaining = Math.max((state.brokerClientUsers.get(client) ?? 1) - 1, 0);
	if (remaining === 0) state.brokerClientUsers.delete(client);
	else state.brokerClientUsers.set(client, remaining);
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
	state: BrokerState;
	client: BrokerClient | null;
	processHandle: BrokerProcess | null;
};

function processHasExited(processHandle: BrokerProcess): boolean {
	return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

function forgetDeferredProcess(state: BrokerState, processHandle: BrokerProcess): void {
	if (state.brokerDeferredProcess !== processHandle) return;
	state.brokerDeferredProcess = null;
	state.brokerDeferredProcessExit = null;
	if (!state.brokerClient && !state.brokerProcess) state.brokerTeardownPending = false;
}

/** Retain a child handle until its exit event, even after a forced kill. */
function retainDeferredProcess(state: BrokerState, processHandle: BrokerProcess): void {
	if (processHasExited(processHandle)) {
		forgetDeferredProcess(state, processHandle);
		return;
	}
	if (state.brokerDeferredProcess === processHandle) return;
	// There must never be two generations in flight for one profile. Different
	// profiles have independent children and are intentionally not blocked here.
	if (state.brokerDeferredProcess && state.brokerDeferredProcess !== processHandle) return;
	state.brokerDeferredProcess = processHandle;
	state.brokerTeardownPending = true;
	const promise = new Promise<void>((resolve) => {
		const onExit = () => {
			if (!processHasExited(processHandle)) return;
			processHandle.removeListener("close", onExit);
			forgetDeferredProcess(state, processHandle);
			resolve();
		};
		processHandle.once("exit", onExit);
		processHandle.once("close", onExit);
	});
	state.brokerDeferredProcessExit = { processHandle, promise };
}

async function waitForDeferredProcess(state: BrokerState, deadlineAt: number): Promise<void> {
	const pending = state.brokerDeferredProcessExit;
	if (!pending) return;
	const remaining = Math.max(deadlineAt - Date.now(), 1);
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			pending.promise,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve();
				}, remaining);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	if (timedOut && state.brokerDeferredProcess === pending.processHandle) {
		throw Object.assign(new Error("Previous broker process has not exited"), {
			code: "broker_process_pending",
		});
	}
}

function detachBrokerResources(
	state: BrokerState,
	expectedClient?: BrokerClient,
): BrokerResources | null {
	if (expectedClient && state.brokerClient !== expectedClient) return null;
	const resources: BrokerResources = {
		state,
		client: state.brokerClient,
		processHandle: state.brokerProcess ?? state.brokerDeferredProcess,
	};
	state.brokerClient = null;
	state.brokerProcess = null;
	if (resources.client) brokerClientStates.delete(resources.client);
	if (state.brokerPublicationPending === resources.client) state.brokerPublicationPending = null;
	state.brokerGenerationUnavailable = true;
	state.brokerTeardownPending = Boolean(resources.processHandle || resources.client);
	if (resources.processHandle) retainDeferredProcess(state, resources.processHandle);
	return resources;
}

function terminateBrokerProcess(state: BrokerState, processHandle: BrokerProcess): void {
	if (processHasExited(processHandle)) return;
	retainDeferredProcess(state, processHandle);
	try {
		processHandle.stdin?.end();
	} catch {
		// The kill below is still attempted when stdin is already closed.
	}
	if (processHasExited(processHandle) || state.brokerKilledProcesses.has(processHandle)) return;
	state.brokerKilledProcesses.add(processHandle);
	try {
		processHandle.kill();
	} catch {
		// The deferred exit observer remains the quarantine release mechanism.
	}
}

async function teardownBrokerResources(resources: BrokerResources): Promise<void> {
	let closeError: unknown;
	try {
		if (resources.client) closeBrokerClientOnce(resources.client);
	} catch (error) {
		closeError = error;
	}
	const processHandle = resources.processHandle;
	if (processHandle && !processHasExited(processHandle)) {
		const state = resources.state;
		retainDeferredProcess(state, processHandle);
		try {
			processHandle.stdin?.end();
		} catch (error) {
			closeError ??= error;
		}
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		const exited = await Promise.race([
			state.brokerDeferredProcessExit?.processHandle === processHandle
				? state.brokerDeferredProcessExit.promise.then(() => true)
				: Promise.resolve(processHasExited(processHandle)),
			new Promise<boolean>((resolve) => {
				cleanupTimer = setTimeout(
					() => resolve(processHasExited(processHandle)),
					BROKER_CLEANUP_TIMEOUT_MS,
				);
			}),
		]);
		if (cleanupTimer) clearTimeout(cleanupTimer);
		if (!exited && !processHasExited(processHandle)) {
			if (!state.brokerKilledProcesses.has(processHandle)) {
				state.brokerKilledProcesses.add(processHandle);
				try {
					processHandle.kill();
				} catch (error) {
					closeError ??= error;
				}
			}
			// Do not wait indefinitely after the hard bound. The deferred handle and
			// its exit promise remain installed, so replacement acquisition cannot
			// overlap this still-live child.
			closeError ??= Object.assign(new Error("Broker cleanup timed out"), {
				code: "cleanup_timeout",
			});
		}
	}
	if (closeError) throw closeError;
}

async function runBoundedCleanup(
	operation: () => Promise<void> | void,
): Promise<void> {
	const cleanupPromise = Promise.resolve().then(operation);
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
	state: BrokerState,
	ownedProcess: BrokerProcess,
	childCreated: boolean,
): Promise<void> {
	if (state.brokerProcess !== ownedProcess) return;
	state.brokerProcess = null;
	state.brokerGenerationUnavailable = true;
	// A spawn error/close before the spawn event means no child exists to fence.
	if (!childCreated) {
		state.brokerTeardownPending = Boolean(state.brokerClient);
		return;
	}
	retainDeferredProcess(state, ownedProcess);
	if (state.brokerClient && (state.brokerClientUsers.get(state.brokerClient) ?? 0) > 0) {
		state.retiredBrokerClients.add(state.brokerClient);
		state.brokerTeardownPending = true;
		return;
	}
	const resources = detachBrokerResources(state);
	if (resources) {
		try { await teardownBrokerResources(resources); }
		catch (error) { debug("broker", "process-event cleanup failed", sanitizeBrokerError(error, "")); }
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
		const state = brokerStateForClient(client);
		if (!state) {
			closeBrokerClientOnce(client);
			return;
		}
		state.brokerGenerationUnavailable = true;
		if ((state.brokerClientUsers.get(client) ?? 0) > 0) {
			state.retiredBrokerClients.add(client);
			state.brokerTeardownPending = true;
			return;
		}
		await teardownBrokerResources({ state, client, processHandle: null });
	});
}

function brokerStartupCancellationError(): Error & { code: string } {
	return Object.assign(new Error("Broker startup was cancelled"), {
		code: "request_fenced",
	});
}

function cancelBrokerStartupGeneration(state: BrokerState, generation: BrokerStartupGeneration): void {
	if (generation.cancelled) return;
	generation.cancelled = true;
	generation.controller.abort();
	if (state.brokerStartupGeneration === generation) {
		state.brokerStartupGeneration = null;
		state.brokerClientPromise = null;
		state.brokerGenerationUnavailable = true;
	}
	const processHandle = generation.processHandle;
	if (processHandle && state.brokerProcess === processHandle) {
		state.brokerProcess = null;
		state.brokerGenerationUnavailable = true;
		terminateBrokerProcess(state, processHandle);
	}
}

async function waitForBrokerStartup(
	state: BrokerState,
	generation: BrokerStartupGeneration,
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<BrokerClient> {
	generation.waiters++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		generation.waiters = Math.max(generation.waiters - 1, 0);
		// Once startup has settled, the published client is owned by the
		// adoption/lease path, not by this transient startup waiter. Cancelling
		// here would fence a successful generation before its caller can retain
		// the lease.
		if (generation.waiters === 0 && !generation.cancelled && !generation.settled)
			cancelBrokerStartupGeneration(state, generation);
	};
	try {
		return await awaitWithinBudget(generation.promise, { deadlineAt, signal });
	} finally {
		release();
	}
}

async function ensureGoogleBroker(
	profileDir: string,
	deadlineAt: number,
	processFactory: BrokerProcessFactory = spawn,
	signal?: AbortSignal,
): Promise<BrokerClient> {
	const state = brokerStateForProfile(profileDir);
	if (state.brokerClient?.connected === false) {
		const disconnected = state.brokerClient;
		state.brokerClient = null;
		brokerClientStates.delete(disconnected);
		state.brokerGenerationUnavailable = true;
		if ((state.brokerClientUsers.get(disconnected) ?? 0) === 0) {
			try { await teardownBrokerResources({ state, client: disconnected, processHandle: null }); }
			catch (error) { debug("broker", "disconnected client cleanup failed", sanitizeBrokerError(error, "")); }
		} else {
			state.retiredBrokerClients.add(disconnected);
			state.brokerTeardownPending = true;
		}
	}
	if (
		state.brokerClient &&
		state.brokerClient.connected !== false &&
		!state.brokerGenerationUnavailable
	)
		return state.brokerClient;
	if (
		state.brokerGenerationUnavailable &&
		state.brokerTeardownPending &&
		[...state.brokerClientUsers.values()].some((count) => count > 0)
	)
		throw Object.assign(new Error("Broker generation unavailable"), {
			code: "connection_closed",
		});
	if (state.brokerDeferredProcess) {
		await waitForDeferredProcess(state, deadlineAt);
		if (state.brokerDeferredProcess)
			throw Object.assign(new Error("Previous broker process has not exited"), {
				code: "broker_process_pending",
			});
	}
	if (state.brokerStartupGeneration)
		return waitForBrokerStartup(state, state.brokerStartupGeneration, deadlineAt, signal);

	const startupDeadlineAt = Math.max(
		deadlineAt,
		Date.now() + BROKER_STARTUP_TIMEOUT_MS,
	);
	const generation: BrokerStartupGeneration = {
		promise: Promise.resolve(undefined as unknown as BrokerClient),
		controller: new AbortController(),
		waiters: 0,
		cancelled: false,
		settled: false,
		processHandle: null,
	};
	state.brokerStartupGeneration = generation;
	const startup = (async () => {
		let lastError: unknown;
		try {
			const module = await loadBrokerModule();
			const brokerBin = resolvePath("bin", "google-cdp-broker.mjs");
			const paths = module.brokerPaths(profileDir);
			const connect = () =>
				module.connectGoogleCdpBroker({
					profileDir,
					socketPath: paths.socketPath,
					deadlineAt: startupDeadlineAt,
					signal: generation.controller.signal,
				});
			for (;;) {
				if (generation.cancelled)
					throw brokerStartupCancellationError();
				if (Date.now() >= startupDeadlineAt)
					throw Object.assign(new Error("Broker startup deadline expired"), {
						code: "connect_timeout",
					});
				try {
					const connected = await connect();
					if (
						generation.cancelled ||
						state.brokerStartupGeneration !== generation ||
						state.brokerGenerationUnavailable
					) {
						try { connected.close(); } catch { /* stale connector */ }
						throw Object.assign(new Error("Broker generation unavailable"), {
							code: "connection_closed",
						});
					}
					lastError = undefined;
					state.brokerClient = connected;
					brokerClientStates.set(connected, state);
					state.brokerPublicationPending = connected;
					state.brokerGenerationUnavailable = false;
					setTimeout(() => {
						if (state.brokerPublicationPending !== connected) return;
						void withBrokerLifecycle(async () => {
							if (
								state.brokerPublicationPending !== connected ||
								state.brokerClient !== connected ||
								(state.brokerClientUsers.get(connected) ?? 0) > 0
							) return;
							state.brokerPublicationPending = null;
							const resources = detachBrokerResources(state, connected);
							if (!resources) return;
							try { await teardownBrokerResources(resources); }
							catch (error) {
								debug("broker", "unadopted startup cleanup failed", sanitizeBrokerError(error, ""));
							}
						}).catch(() => undefined);
					}, 0);
					return connected;
				} catch (error) {
					lastError = error;
				}
				if (generation.cancelled) throw brokerStartupCancellationError();
				if (state.brokerDeferredProcess) {
					await waitForDeferredProcess(state, startupDeadlineAt);
					if (state.brokerDeferredProcess)
						throw Object.assign(new Error("Previous broker process has not exited"), {
							code: "broker_process_pending",
						});
				}
				if (!state.brokerProcess || processHasExited(state.brokerProcess)) {
					if (generation.cancelled) throw brokerStartupCancellationError();
					state.brokerProcess = processFactory(
						process.execPath,
						[brokerBin, "--profile", profileDir, "--connect-cdp", "--cdp-port", "9222", "--parent-stdin"],
						{ stdio: ["pipe", "ignore", "ignore"] },
					);
					generation.processHandle = state.brokerProcess;
					state.brokerGenerationUnavailable = false;
					const ownedProcess = state.brokerProcess;
					let childCreated = false;
					ownedProcess.once("spawn", () => { childCreated = true; });
					const processEvent = (kind: "error" | "close" | "exit") => {
						void withBrokerLifecycle(() => handleBrokerProcessEvent(state, ownedProcess, childCreated || kind === "exit")).catch(() => undefined);
					};
					ownedProcess.once("error", () => processEvent("error"));
					ownedProcess.once("close", () => processEvent("close"));
					ownedProcess.once("exit", () => processEvent("exit"));
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(40, Math.max(startupDeadlineAt - Date.now(), 1)));
					generation.controller.signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					}, { once: true });
				});
				if (Date.now() >= startupDeadlineAt && lastError) throw lastError;
			}
		} catch (error) {
			lastError = error;
			throw error;
		} finally {
			generation.settled = true;
			if (state.brokerStartupGeneration === generation) {
				state.brokerStartupGeneration = null;
				state.brokerClientPromise = null;
			}
			if (lastError && generation.processHandle && state.brokerProcess === generation.processHandle) {
				state.brokerProcess = null;
				state.brokerGenerationUnavailable = true;
				terminateBrokerProcess(state, generation.processHandle);
			}
		}
	})();
	generation.promise = startup;
	state.brokerClientPromise = startup;
	// The generation promise is shared by all waiters; retain a rejection sink.
	startup.catch(() => undefined);
	return waitForBrokerStartup(state, generation, deadlineAt, signal);
}

async function releaseBrokerLease(client: BrokerClient): Promise<void> {
	const state = brokerStateForClient(client);
	if (!state) return;
	await withBrokerLifecycle(async () => {
		const remaining = releaseBrokerClient(state, client);
		if (remaining === 0 && state.retiredBrokerClients.delete(client)) {
			const deferredProcess = state.brokerDeferredProcess;
			if (state.brokerClient === client) state.brokerClient = null;
			try {
				await teardownBrokerResources({ state, client, processHandle: deferredProcess });
			} catch (error) {
				debug("broker", "deferred cleanup failed", sanitizeBrokerError(error, ""));
			}
		}
		if (remaining === 0 && state.brokerTeardownPending && state.brokerClient === client) {
			const resources = detachBrokerResources(state, client);
			if (resources) try { await teardownBrokerResources(resources); }
			catch (error) { debug("broker", "deferred cleanup failed", sanitizeBrokerError(error, "")); }
		}
	});
}

export function closeGoogleBroker(expectedClient?: BrokerClient): Promise<void> {
	const states = expectedClient
		? (brokerStateForClient(expectedClient) ? [brokerStateForClient(expectedClient)!] : [])
		: [...brokerStates.values()];
	const sharedState = states.length === 1 ? states[0] : undefined;
	if (sharedState?.closePromise && sharedState.closePromiseHasExpectedClient === Boolean(expectedClient))
		return sharedState.closePromise;
	const closePromise = withBrokerLifecycle(async () => {
		for (const state of states) {
			if (expectedClient && state.brokerClient !== expectedClient) continue;
			if (state.brokerStartupGeneration && state.brokerStartupGeneration.waiters === 0)
				cancelBrokerStartupGeneration(state, state.brokerStartupGeneration);
			if (state.brokerClient && (state.brokerClientUsers.get(state.brokerClient) ?? 0) > 0) {
				state.retiredBrokerClients.add(state.brokerClient);
				if (state.brokerProcess) {
					retainDeferredProcess(state, state.brokerProcess);
					state.brokerProcess = null;
				}
				state.brokerGenerationUnavailable = true;
				state.brokerTeardownPending = true;
				continue;
			}
			const resources = detachBrokerResources(state, expectedClient);
			if (resources) await teardownBrokerResources(resources);
		}
	});
	const sharedClosePromise = closePromise.finally(() => {
		if (sharedState?.closePromise === sharedClosePromise) sharedState.closePromise = null;
	});
	if (sharedState) {
		sharedState.closePromise = sharedClosePromise;
		sharedState.closePromiseHasExpectedClient = Boolean(expectedClient);
	}
	return sharedClosePromise;
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
		processFactory?: BrokerProcessFactory;
	}) => Promise<BrokerClient>;
	/** Narrow seam for deterministic broker-child lifecycle integration tests. */
	brokerProcessFactory?: BrokerProcessFactory;
	/** Internal test seam; production keeps the stable shared Chrome profile. */
	brokerProfileDir?: string;
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
	if (!brokerEnabled()) {
		await closeGoogleBroker();
		return legacySearch(query, options);
	}

	const profileDir =
		dependencies.brokerProfileDir ??
		`${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
	const brokerState = brokerStateForProfile(profileDir);
	const usesManagedBroker = !dependencies.connectBroker;
	const ensure = dependencies.ensureChrome ?? ensureChrome;
	const connect =
		dependencies.connectBroker ??
		((brokerOptions) =>
			ensureGoogleBroker(
				brokerOptions.profileDir,
				brokerOptions.deadlineAt,
				dependencies.brokerProcessFactory,
				brokerOptions.signal,
			));
	const defaultCleanup = async (ownedClient?: BrokerClient) => {
		// No client means this attempt never acquired the singleton. In
		// particular, a failed connect must not tear down a broker another request
		// acquired concurrently.
		if (ownedClient) await closeGoogleBroker(ownedClient);
	};
	const cleanup = dependencies.cleanupBroker ?? defaultCleanup;
	// A connector can outlive the caller's request fence. Keep explicit attempt
	// state so a late client is closed exactly once, while a client adopted by a
	// newer waiter/generation is left alone.
	let connectAttemptCandidate: BrokerClient | undefined;
	let connectAttemptFenced = false;
	let connectAttemptAdopted = false;
	let connectAttemptCloseStarted = false;
	const closeUnadoptedConnectClient = async (
		candidate: BrokerClient,
	): Promise<void> => {
		if (connectAttemptAdopted || connectAttemptCloseStarted || brokerClientCloseStarted.has(candidate)) return;
		if (
			((brokerStateForClient(candidate)?.brokerClientUsers.get(candidate) ?? 0) > 0) ||
			(brokerStateForClient(candidate)?.brokerClient === candidate && !brokerStateForClient(candidate)?.brokerGenerationUnavailable)
		) {
			connectAttemptAdopted = true;
			return;
		}
		connectAttemptCloseStarted = true;
		brokerClientCloseStarted.add(candidate);
		await runBoundedCleanup(() =>
			cleanup === defaultCleanup ? candidate.close() : cleanup(candidate),
		);
	};
	const observeConnectAttempt = (attempt: Promise<BrokerClient>) => {
		attempt.then(
			(candidate) => {
				connectAttemptCandidate = candidate;
				if (connectAttemptFenced && !connectAttemptAdopted) {
					// Let all same-generation waiters run their adoption continuations
					// before quarantining a shared result.
					setTimeout(() => {
						void withBrokerLifecycle(async () => {
							if (connectAttemptFenced && !connectAttemptAdopted)
								await closeUnadoptedConnectClient(candidate);
						}).catch(() => undefined);
					}, 0);
				}
			},
			() => undefined,
		);
		return attempt;
	};
	const directConnectAttempt = !usesManagedBroker
		? (() => {
				let attempt: Promise<BrokerClient>;
				try {
					assertBrokerBudget({ deadlineAt, signal: options.signal });
					attempt = Promise.resolve(connect({ profileDir, deadlineAt, signal: options.signal }));
				} catch (error) {
					attempt = Promise.reject(error);
				}
				return observeConnectAttempt(attempt);
			})()
		: undefined;
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
		// The shared startup promise must not be held inside the lifecycle queue:
		// one caller may abort while another caller is waiting for the same
		// generation to connect. Only the short publication/lease step is queued.
		const connectedClient = await awaitWithinBudget(
			() => {
				assertBrokerBudget({ deadlineAt, signal: options.signal });
				return directConnectAttempt ?? observeConnectAttempt(
					Promise.resolve().then(() =>
						connect({
							profileDir,
							deadlineAt,
							signal: options.signal,
						}),
					),
				);
			},
			{ deadlineAt, signal: options.signal },
		);
		await withBrokerLifecycle(async () => {
			assertBrokerBudget({ deadlineAt, signal: options.signal });
			if (!usesManagedBroker && brokerState.brokerClient && brokerState.brokerClient !== connectedClient && brokerState.brokerClient.connected === false) {
				const disconnected = brokerState.brokerClient;
				brokerState.brokerClient = null;
				brokerClientStates.delete(disconnected);
				closeBrokerClientOnce(disconnected);
			}
			if (usesManagedBroker && brokerState.brokerGenerationUnavailable && brokerState.brokerClient !== connectedClient)
				throw Object.assign(new Error("Broker generation unavailable"), {
					code: "connection_closed",
				});
			retainBrokerClient(brokerState, connectedClient);
			if (!usesManagedBroker) brokerState.brokerClient = connectedClient;
			brokerClientStates.set(connectedClient, brokerState);
			connectAttemptAdopted = true;
			if (brokerState.brokerPublicationPending === connectedClient)
				brokerState.brokerPublicationPending = null;
			client = connectedClient;
			retainedClient = true;
		});
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
		connectAttemptFenced = true;
		const cleanupPromise = withBrokerLifecycle(async () => {
			let cleanupResources: BrokerResources | null = null;
			if (
				!retainedClient &&
				connectAttemptCandidate &&
				!connectAttemptAdopted
			) {
				try {
					await closeUnadoptedConnectClient(connectAttemptCandidate);
					cleanupOutcome = "succeeded";
				} catch (cleanupFailure) {
					cleanupOutcome = "failed";
					cleanupError = cleanupFailure;
				}
				return;
			}
			if (retainedClient && client) {
				retainedClient = false;
				const ownerState = brokerStateForClient(client) ?? brokerState;
				const remaining = releaseBrokerClient(ownerState, client);
				if (remaining > 0) {
					cleanupOutcome = "skipped_shared";
					return;
				}
			// Quarantine before invoking an arbitrary cleanup hook. A timed-out
			// hook must not leave a client eligible for a later acquisition.
			if (brokerState.brokerClient === client) cleanupResources = detachBrokerResources(brokerState, client);
			else if (brokerState.retiredBrokerClients.delete(client)) {
				const deferredProcess = brokerState.brokerDeferredProcess;
				brokerState.brokerDeferredProcess = null;
				cleanupResources = { state: brokerState, client, processHandle: deferredProcess };
				brokerClientStates.delete(client);
			}
			}
			if (!client && cleanup === defaultCleanup) {
				cleanupOutcome = "not_attempted";
				return;
			}
			if (cleanup === defaultCleanup && client && !cleanupResources)
				// The injectable connect seam does not populate the production
				// singleton, but the acquired client still needs deterministic close.
				cleanupResources = { state: brokerState, client, processHandle: null };
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
