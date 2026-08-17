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
		| "shared_active"
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
	close(): Promise<void> | void;
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

type BrokerClientOwnership = {
	state: BrokerState;
	generation: number;
};

type BrokerClientToken = BrokerClientOwnership & {
	client: BrokerClient;
};

type BrokerConnectAttempt = {
	state: BrokerState;
	profileKey: string;
	attemptToken: number;
	promise: Promise<BrokerClient>;
	candidate?: BrokerClient;
	settled: boolean;
	fenced: boolean;
	adopted: boolean;
	closeStarted: boolean;
};

type ExpectedBrokerClient = {
	client: BrokerClient;
	generation: number;
};

type BrokerState = {
	profileKey: string;
	brokerClient: BrokerClient | null;
	brokerClientPromise: Promise<BrokerClient> | null;
	brokerStartupGeneration: BrokerStartupGeneration | null;
	brokerProcess: BrokerProcess | null;
	brokerDeferredProcess: BrokerProcess | null;
	brokerDeferredProcessExit: {
		processHandle: BrokerProcess;
		promise: Promise<void>;
	} | null;
	brokerClientUsers: Map<BrokerClient, number>;
	brokerClientUserGenerations: Map<BrokerClient, Map<number, number>>;
	brokerGenerationUnavailable: boolean;
	brokerTeardownPending: boolean;
	brokerPublicationPending: BrokerClient | null;
	retiredBrokerClients: Set<BrokerClient>;
	failedBrokerClients: Set<BrokerClient>;
	brokerClientGenerations: Map<BrokerClient, number>;
	nextBrokerGeneration: number;
	brokerLeaseWaiters: Set<() => void>;
	brokerKilledProcesses: WeakSet<object>;
	clientClosePromises: Map<
		BrokerClient,
		{ generation: number; promise: Promise<void> }
	>;
	customCleanupPromises: Map<
		BrokerClient,
		{ generation: number; promise: Promise<void> }
	>;
	confirmedClosedClients: Map<BrokerClient, number>;
	scopedClosePromises: Map<
		BrokerClient,
		{ generation: number; promise: Promise<void> }
	>;
	/** Every connector attempt remains tracked until it settles and is adopted or quarantined. */
	brokerPendingConnects: Set<BrokerConnectAttempt>;
	brokerFencedConnects: Set<BrokerConnectAttempt>;
	nextBrokerAttemptToken: number;
	closePromise: Promise<void> | null;
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
const brokerClientStates = new Map<BrokerClient, BrokerClientOwnership>();
let brokerLifecycleTail: Promise<void> = Promise.resolve();
let brokerLegacyFallbackActive = false;
const brokerFallbackWaiters = new Set<() => void>();
let brokerAcquisitionReservations = 0;
// An unqualified close spans every profile. Keep this fence active until all
// profiles, connectors, reservations, and in-flight teardown operations are
// quiescent; a rejected/expired close must not silently reopen acquisition.
let brokerGlobalTeardownActive = false;
let brokerGlobalClosePromise: Promise<void> | null = null;
const brokerGlobalTeardownWaiters = new Set<() => void>();
// Client closure is tracked per profile and generation. A close attempt that
// throws is deliberately not treated as ownership completion: the client stays
// quarantined until a later bounded retry confirms closure.

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
			brokerClientUserGenerations: new Map(),
			brokerGenerationUnavailable: false,
			brokerTeardownPending: false,
			brokerPublicationPending: null,
			retiredBrokerClients: new Set(),
			failedBrokerClients: new Set(),
			brokerClientGenerations: new Map(),
			nextBrokerGeneration: 0,
			brokerLeaseWaiters: new Set(),
			brokerKilledProcesses: new WeakSet(),
			clientClosePromises: new Map(),
			customCleanupPromises: new Map(),
			confirmedClosedClients: new Map(),
			scopedClosePromises: new Map(),
			brokerPendingConnects: new Set(),
			brokerFencedConnects: new Set(),
			nextBrokerAttemptToken: 0,
			closePromise: null,
		};
		brokerStates.set(profileKey, state);
	}
	return state;
}

function brokerStateForClient(client: BrokerClient): BrokerState | undefined {
	return brokerClientStates.get(client)?.state;
}

function brokerOwnershipForClient(
	client: BrokerClient,
): BrokerClientOwnership | undefined {
	return brokerClientStates.get(client);
}

function notifyBrokerLeaseWaiters(state: BrokerState): void {
	for (const waiter of state.brokerLeaseWaiters) waiter();
	state.brokerLeaseWaiters.clear();
}

function forgetBrokerClientOwnership(
	state: BrokerState,
	client: BrokerClient,
): void {
	const ownership = brokerClientStates.get(client);
	if (
		ownership?.state === state &&
		(state.brokerClientUsers.get(client) ?? 0) === 0 &&
		state.brokerClient !== client &&
		!state.retiredBrokerClients.has(client) &&
		!state.failedBrokerClients.has(client)
	) {
		brokerClientStates.delete(client);
		state.brokerClientGenerations.delete(client);
		state.brokerClientUserGenerations.delete(client);
	}
}

/**
 * Complete teardown for a client closed by an injected cleanup hook. Hooks do
 * not go through closeBrokerClientOnce, so they must explicitly perform the
 * same owner/generation finalization as the default teardown path.
 */
function finalizeSuccessfulBrokerClientTeardown(
	state: BrokerState,
	client: BrokerClient,
	generation: number,
): void {
	const ownership = brokerClientStates.get(client);
	if (ownership?.state !== state || ownership.generation !== generation) return;
	if (state.brokerClient === client) state.brokerClient = null;
	if (state.brokerPublicationPending === client)
		state.brokerPublicationPending = null;
	state.confirmedClosedClients.set(client, generation);
	state.retiredBrokerClients.delete(client);
	state.failedBrokerClients.delete(client);
	forgetBrokerClientOwnership(state, client);
	finalizeBrokerTeardown(state);
}

function currentClientGeneration(
	state: BrokerState,
	client: BrokerClient,
): number | undefined {
	const ownership = brokerClientStates.get(client);
	return ownership?.state === state
		? ownership.generation
		: state.brokerClientGenerations.get(client);
}

function expectedMatches(
	state: BrokerState,
	expected: ExpectedBrokerClient | undefined,
	client: BrokerClient,
): boolean {
	if (!expected) return true;
	return (
		expected.client === client &&
		currentClientGeneration(state, client) === expected.generation
	);
}

async function awaitBrokerCloseUntil(
	promise: Promise<void>,
	deadlineAt: number,
): Promise<void> {
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) {
		throw Object.assign(new Error("Broker cleanup timed out"), {
			code: "cleanup_timeout",
		});
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							Object.assign(new Error("Broker cleanup timed out"), {
								code: "cleanup_timeout",
							}),
						),
					Math.max(deadlineAt - Date.now(), 1),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function startTrackedCustomCleanup(
	state: BrokerState,
	client: BrokerClient,
	generation: number,
	operation: () => Promise<void> | void,
): Promise<void> {
	const existing = state.customCleanupPromises.get(client);
	if (existing?.generation === generation) return existing.promise;
	let promise!: Promise<void>;
	promise = (async () => {
		try {
			await Promise.resolve().then(operation);
			// Only the settled custom operation may release the generation fence.
			finalizeSuccessfulBrokerClientTeardown(state, client, generation);
		} finally {
			if (state.customCleanupPromises.get(client)?.promise === promise)
				state.customCleanupPromises.delete(client);
			finalizeBrokerTeardown(state);
		}
	})();
	state.customCleanupPromises.set(client, { generation, promise });
	// Custom hooks are injected boundaries and may outlive their bounded caller.
	// Always sink the eventual rejection while retaining the exact promise above.
	promise.catch(() => undefined);
	return promise;
}

async function closeBrokerClientOnce(
	state: BrokerState,
	client: BrokerClient,
	generation: number,
	deadlineAt = Date.now() + BROKER_CLEANUP_TIMEOUT_MS,
): Promise<void> {
	if (state.confirmedClosedClients.get(client) === generation) {
		state.retiredBrokerClients.delete(client);
		state.failedBrokerClients.delete(client);
		forgetBrokerClientOwnership(state, client);
		finalizeBrokerTeardown(state);
		return;
	}
	const customCleanup = state.customCleanupPromises.get(client);
	if (customCleanup?.generation === generation)
		return awaitBrokerCloseUntil(customCleanup.promise, deadlineAt);
	const existing = state.clientClosePromises.get(client);
	if (existing?.generation === generation)
		return awaitBrokerCloseUntil(existing.promise, deadlineAt);
	let promise!: Promise<void>;
	promise = (async () => {
		try {
			// Defer invocation until after clientClosePromises is published below;
			// otherwise a synchronous throw can settle this async body before the
			// in-flight marker is installed, leaving a stale rejected promise.
			await Promise.resolve().then(() => client.close());
			state.failedBrokerClients.delete(client);
			state.retiredBrokerClients.delete(client);
			state.confirmedClosedClients.set(client, generation);
			forgetBrokerClientOwnership(state, client);
		} catch (error) {
			// close() throwing means the transport's terminal state is unknown.
			// Retain ownership and quarantine the exact generation; replacement and
			// legacy fallback must remain fenced until a later retry succeeds.
			state.failedBrokerClients.add(client);
			state.retiredBrokerClients.add(client);
			state.brokerTeardownPending = true;
			throw error;
		} finally {
			if (state.clientClosePromises.get(client)?.promise === promise)
				state.clientClosePromises.delete(client);
			finalizeBrokerTeardown(state);
		}
	})();
	state.clientClosePromises.set(client, { generation, promise });
	// A close promise may outlive the bounded caller. It is intentionally kept
	// tracked and rejection-sunk until the transport reaches a terminal state.
	promise.catch(() => undefined);
	return awaitBrokerCloseUntil(promise, deadlineAt);
}
const BROKER_CLEANUP_TIMEOUT_MS = 250;
const BROKER_STARTUP_TIMEOUT_MS = 30_000;
const BROKER_MIN_FALLBACK_BUDGET_MS = 1_000;

function brokerEnabled(): boolean {
	// The Google CDP broker is the default search path (faster cold start,
	// tighter p95, 100% Google success under concurrency — see speed.md).
	// Opt out to the legacy CDP path with PI_WEBAIO_CDP_BROKER=0.
	return process.env.PI_WEBAIO_CDP_BROKER !== "0";
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
			"broker_fallback_active",
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
	/\b(?:(?:authorization\s*(?:[:=]\s*)?(?:bearer|basic|token))|(?:bearer|basic))\s+[^\s,;"'}\]]+/gi;
const BROKER_JWT_RE = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BROKER_ID_WITH_VALUE_RE =
	/\b(?:target\s*id|session\s*id|client\s*id|targetid|sessionid|clientid|target|session|client)\s*"?\s*(?:[:=]|\s)\s*"?[^,;\s}"']+/gi;
const BROKER_ID_LABEL_RE =
	/\b(?:target\s*id|session\s*id|client\s*id|targetid|sessionid|clientid)\b/gi;

function sanitizeBrokerEnvelopeText(text: string, query: string): string {
	let safe = redactBrokerEnvelopeFields(redactSecrets(text));
	if (query) {
		// The first replacement handles ordinary error strings; the second handles
		// a query that was JSON-escaped by a newly-added envelope field.
		safe = safe.split(query).join("[redacted-query]");
		const escapedQuery = JSON.stringify(query);
		if (escapedQuery)
			safe = safe.split(escapedQuery.slice(1, -1)).join("[redacted-query]");
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
	const names = [
		"targetSetupMs",
		"navigationMs",
		"extractionMs",
		"resetMs",
	] as const;
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
		debug(
			"broker",
			JSON.stringify(scrubBrokerEnvelopeValue(envelope, undefined, true)),
		);
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

function notifyGlobalTeardownWaiters(): void {
	for (const waiter of brokerGlobalTeardownWaiters) waiter();
	brokerGlobalTeardownWaiters.clear();
}

function maybeFinishGlobalTeardown(): void {
	// Do not release the latch from an unrelated state finalizer while the
	// coalesced global close operation is still draining its snapshot.
	if (
		!brokerGlobalTeardownActive ||
		brokerGlobalClosePromise ||
		brokerAcquisitionReservations > 0
	)
		return;
	if (
		[...brokerStates.values()].some((state) => brokerHasUnresolvedTeardown(state))
	)
		return;
	brokerGlobalTeardownActive = false;
	notifyGlobalTeardownWaiters();
}

/** Fence every connector already in flight before a global close waits. */
function fenceAllBrokerConnectAttempts(): void {
	for (const state of brokerStates.values()) {
		for (const attempt of state.brokerPendingConnects) {
			if (attempt.adopted || (attempt.settled && !attempt.candidate)) continue;
			attempt.fenced = true;
			state.brokerFencedConnects.add(attempt);
		}
	}
}

async function waitForGlobalTeardownToClear(
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<void> {
	while (brokerGlobalTeardownActive) {
		let waiter: (() => void) | undefined;
		try {
			await awaitWithinBudget(
				new Promise<void>((resolve) => {
					waiter = resolve;
					brokerGlobalTeardownWaiters.add(resolve);
				}),
				{ deadlineAt, signal },
			);
		} finally {
			if (waiter) brokerGlobalTeardownWaiters.delete(waiter);
		}
	}
}

async function waitForBrokerAcquisitionReservations(
	deadlineAt: number,
): Promise<void> {
	while (brokerAcquisitionReservations > 0) {
		let waiter: (() => void) | undefined;
		try {
			await awaitWithinBudget(
				new Promise<void>((resolve) => {
					waiter = resolve;
					brokerGlobalTeardownWaiters.add(resolve);
				}),
				{ deadlineAt },
			);
		} finally {
			if (waiter) brokerGlobalTeardownWaiters.delete(waiter);
		}
	}
}

async function waitForLegacyFallbackToClear(
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<void> {
	while (brokerLegacyFallbackActive) {
		let waiter: (() => void) | undefined;
		try {
			await awaitWithinBudget(
				new Promise<void>((resolve) => {
					waiter = resolve;
					brokerFallbackWaiters.add(resolve);
				}),
				{ deadlineAt, signal },
			);
		} finally {
			if (waiter) brokerFallbackWaiters.delete(waiter);
		}
	}
}

async function reserveBrokerAcquisition(
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	await waitForGlobalTeardownToClear(deadlineAt, signal);
	await waitForLegacyFallbackToClear(deadlineAt, signal);
	await withBrokerLifecycle(async () => {
		assertBrokerBudget({ deadlineAt, signal });
		if (brokerGlobalTeardownActive)
			throw Object.assign(new Error("Global broker teardown is still pending"), {
				code: "broker_process_pending",
			});
		if (brokerLegacyFallbackActive)
			throw Object.assign(new Error("Legacy fallback is active"), {
				code: "broker_fallback_active",
			});
		brokerAcquisitionReservations++;
	});
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await withBrokerLifecycle(async () => {
			brokerAcquisitionReservations = Math.max(
				brokerAcquisitionReservations - 1,
				0,
			);
			maybeFinishGlobalTeardown();
			notifyGlobalTeardownWaiters();
		});
	};
}

async function reserveLegacyFallback(
	state: BrokerState | undefined,
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<(() => Promise<void>) | null> {
	for (;;) {
		await waitForLegacyFallbackToClear(deadlineAt, signal);
		const result = await withBrokerLifecycle(async () => {
			assertBrokerBudget({ deadlineAt, signal });
			if (brokerLegacyFallbackActive) return "wait" as const;
			if (brokerAcquisitionReservations > 0 || !brokerIsQuiescentForLegacy(state))
				return "blocked" as const;
			brokerLegacyFallbackActive = true;
			return "acquired" as const;
		});
		if (result === "blocked") return null;
		if (result === "acquired") {
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await withBrokerLifecycle(async () => {
					brokerLegacyFallbackActive = false;
					for (const waiter of brokerFallbackWaiters) waiter();
					brokerFallbackWaiters.clear();
				});
			};
		}
	}
}

function publishBrokerClient(
	state: BrokerState,
	client: BrokerClient,
	forceNewGeneration = false,
): BrokerClientToken {
	let generation = state.brokerClientGenerations.get(client);
	if (generation === undefined) {
		if (!forceNewGeneration)
			generation = state.confirmedClosedClients.get(client);
		if (generation === undefined) generation = ++state.nextBrokerGeneration;
		state.brokerClientGenerations.set(client, generation);
	}
	const token = { state, client, generation };
	brokerClientStates.set(client, { state, generation });
	return token;
}

function retainBrokerClient(
	state: BrokerState,
	client: BrokerClient,
): BrokerClientToken {
	const token = publishBrokerClient(
		state,
		client,
		state.confirmedClosedClients.has(client),
	);
	const byGeneration =
		state.brokerClientUserGenerations.get(client) || new Map<number, number>();
	byGeneration.set(
		token.generation,
		(byGeneration.get(token.generation) ?? 0) + 1,
	);
	state.brokerClientUserGenerations.set(client, byGeneration);
	state.brokerClientUsers.set(
		client,
		(state.brokerClientUsers.get(client) ?? 0) + 1,
	);
	return token;
}

function releaseBrokerClient(token: BrokerClientToken): number {
	const state = token.state;
	const ownership = brokerClientStates.get(token.client);
	const byGeneration = state.brokerClientUserGenerations.get(token.client);
	const generationCount = byGeneration?.get(token.generation) ?? 0;
	// A stale request must never release a lease belonging to a reused object.
	if (
		ownership?.state !== state ||
		ownership.generation !== token.generation ||
		generationCount === 0
	)
		return state.brokerClientUsers.get(token.client) ?? 0;
	if (generationCount === 1) byGeneration?.delete(token.generation);
	else byGeneration?.set(token.generation, generationCount - 1);
	if (!byGeneration?.size)
		state.brokerClientUserGenerations.delete(token.client);
	const remaining = Math.max(
		(state.brokerClientUsers.get(token.client) ?? 1) - 1,
		0,
	);
	if (remaining === 0) state.brokerClientUsers.delete(token.client);
	else state.brokerClientUsers.set(token.client, remaining);
	notifyBrokerLeaseWaiters(state);
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
	const promise = typeof operation === "function" ? operation() : operation;
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

async function runLegacyWithFallbackBarrier<T>(
	operation: () => Promise<T>,
	deadlineAt: number,
	signal: AbortSignal | undefined,
	release: () => Promise<void>,
): Promise<T> {
	let pending: Promise<T> | undefined;
	try {
		pending = Promise.resolve().then(operation);
		const releaseWhenSettled = pending.then(release, release);
		releaseWhenSettled.catch(() => undefined);
		const result = await awaitWithinBudget(pending, { deadlineAt, signal });
		await releaseWhenSettled;
		return result;
	} catch (error) {
		// If invocation itself failed before a promise was installed, release the
		// barrier here. Otherwise the settlement continuation above owns release,
		// including when the caller's absolute deadline has already fired.
		if (!pending) await release();
		throw error;
	}
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
	clientGeneration?: number;
	processHandle: BrokerProcess | null;
};

function processHasExited(processHandle: BrokerProcess): boolean {
	return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

function hasActiveBrokerUsers(state: BrokerState): boolean {
	return [...state.brokerClientUsers.values()].some((count) => count > 0);
}

function brokerHasUnresolvedTeardown(state: BrokerState): boolean {
	return (
		hasActiveBrokerUsers(state) ||
		Boolean(state.brokerClient) ||
		Boolean(state.brokerProcess) ||
		Boolean(state.brokerDeferredProcess) ||
		Boolean(state.brokerStartupGeneration) ||
		Boolean(state.brokerPublicationPending) ||
		state.retiredBrokerClients.size > 0 ||
		state.failedBrokerClients.size > 0 ||
		state.clientClosePromises.size > 0 ||
		state.customCleanupPromises.size > 0 ||
		state.brokerPendingConnects.size > 0 ||
		state.brokerFencedConnects.size > 0
	);
}

function brokerHasGlobalFallbackBlocker(state: BrokerState): boolean {
	// Broker profiles may have separate sockets and children, but they share the
	// machine/browser resource domain. A legacy fallback is therefore unsafe
	// while any profile still owns a lease or has work that can publish, close,
	// or release a broker resource. An idle, healthy client alone is not a
	// teardown blocker; it is deliberately left available for broker reuse.
	return (
		state.brokerTeardownPending ||
		hasActiveBrokerUsers(state) ||
		Boolean(state.brokerProcess) ||
		Boolean(state.brokerDeferredProcess) ||
		Boolean(state.brokerStartupGeneration) ||
		Boolean(state.brokerPublicationPending) ||
		state.retiredBrokerClients.size > 0 ||
		state.failedBrokerClients.size > 0 ||
		state.clientClosePromises.size > 0 ||
		state.customCleanupPromises.size > 0 ||
		state.brokerPendingConnects.size > 0 ||
		state.brokerFencedConnects.size > 0 ||
		(state.brokerClient !== null && state.brokerGenerationUnavailable)
	);
}

function brokerIsQuiescentForLegacy(_state?: BrokerState): boolean {
	let quiescent = true;
	for (const state of brokerStates.values()) {
		if (brokerHasGlobalFallbackBlocker(state)) {
			quiescent = false;
			continue;
		}
		if (!brokerHasUnresolvedTeardown(state)) state.brokerTeardownPending = false;
	}
	return quiescent;
}

/**
 * Finish the teardown fence only after every resource that could still be
 * released has gone away. In particular, a killed-but-not-yet-exited child is
 * still a quarantine resource even after the bounded cleanup operation returns.
 */
function finalizeBrokerTeardown(state: BrokerState): void {
	if (
		(!state.brokerClient || !state.brokerGenerationUnavailable) &&
		!state.brokerProcess &&
		!state.brokerDeferredProcess &&
		!state.brokerPublicationPending &&
		state.retiredBrokerClients.size === 0 &&
		state.failedBrokerClients.size === 0 &&
		state.clientClosePromises.size === 0 &&
		state.customCleanupPromises.size === 0 &&
		state.brokerPendingConnects.size === 0 &&
		state.brokerFencedConnects.size === 0 &&
		!hasActiveBrokerUsers(state)
	)
		state.brokerTeardownPending = false;
	maybeFinishGlobalTeardown();
}

function forgetDeferredProcess(
	state: BrokerState,
	processHandle: BrokerProcess,
): void {
	if (state.brokerDeferredProcess !== processHandle) return;
	state.brokerDeferredProcess = null;
	state.brokerDeferredProcessExit = null;
	notifyBrokerLeaseWaiters(state);
	finalizeBrokerTeardown(state);
}

/** Retain a child handle until its exit event, even after a forced kill. */
function retainDeferredProcess(
	state: BrokerState,
	processHandle: BrokerProcess,
): void {
	if (processHasExited(processHandle)) {
		forgetDeferredProcess(state, processHandle);
		return;
	}
	if (state.brokerDeferredProcess === processHandle) return;
	// There must never be two generations in flight for one profile. Different
	// profiles have independent children and are intentionally not blocked here.
	if (
		state.brokerDeferredProcess &&
		state.brokerDeferredProcess !== processHandle
	)
		return;
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

async function waitForDeferredProcess(
	state: BrokerState,
	deadlineAt: number,
): Promise<void> {
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
		clientGeneration: state.brokerClient
			? currentClientGeneration(state, state.brokerClient)
			: undefined,
		processHandle: state.brokerProcess ?? state.brokerDeferredProcess,
	};
	state.brokerClient = null;
	state.brokerProcess = null;
	if (state.brokerPublicationPending === resources.client)
		state.brokerPublicationPending = null;
	state.brokerGenerationUnavailable = true;
	state.brokerTeardownPending = Boolean(
		resources.processHandle || resources.client,
	);
	if (resources.processHandle)
		retainDeferredProcess(state, resources.processHandle);
	return resources;
}

function terminateBrokerProcess(
	state: BrokerState,
	processHandle: BrokerProcess,
): void {
	if (processHasExited(processHandle)) return;
	retainDeferredProcess(state, processHandle);
	try {
		processHandle.stdin?.end();
	} catch {
		// The kill below is still attempted when stdin is already closed.
	}
	if (
		processHasExited(processHandle) ||
		state.brokerKilledProcesses.has(processHandle)
	)
		return;
	state.brokerKilledProcesses.add(processHandle);
	try {
		processHandle.kill();
	} catch {
		// The deferred exit observer remains the quarantine release mechanism.
	}
}

async function teardownBrokerResources(
	resources: BrokerResources,
	deadlineAt = Date.now() + BROKER_CLEANUP_TIMEOUT_MS,
): Promise<void> {
	let closeError: unknown;
	let clientClosed = !resources.client;
	try {
		if (resources.client) {
			const generation =
				resources.clientGeneration ??
				currentClientGeneration(resources.state, resources.client);
			if (generation === undefined)
				throw new Error("Broker client generation is unavailable");
			await closeBrokerClientOnce(
				resources.state,
				resources.client,
				generation,
				deadlineAt,
			);
			clientClosed = true;
		}
	} catch (error) {
		const customStillPending =
			resources.client &&
			resources.state.customCleanupPromises.get(resources.client)?.generation ===
				resources.clientGeneration;
		// A timed-out custom hook still owns the close operation. Do not invoke
		// client.close() again, and let the persistent custom promise keep the
		// generation/global fence active until it settles.
		if (!(customStillPending && errorCode(error) === "cleanup_timeout"))
			closeError = error;
		if (resources.client) {
			resources.state.failedBrokerClients.add(resources.client);
			resources.state.retiredBrokerClients.add(resources.client);
			resources.state.brokerTeardownPending = true;
		}
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
					Math.max(deadlineAt - Date.now(), 1),
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
	if (resources.client && clientClosed)
		forgetBrokerClientOwnership(resources.state, resources.client);
	else if (resources.client) {
		resources.state.failedBrokerClients.add(resources.client);
		resources.state.retiredBrokerClients.add(resources.client);
		resources.state.brokerTeardownPending = true;
	}
	finalizeBrokerTeardown(resources.state);
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
		finalizeBrokerTeardown(state);
		return;
	}
	retainDeferredProcess(state, ownedProcess);
	if (
		state.brokerClient &&
		(state.brokerClientUsers.get(state.brokerClient) ?? 0) > 0
	) {
		state.retiredBrokerClients.add(state.brokerClient);
		state.brokerTeardownPending = true;
		return;
	}
	const resources = detachBrokerResources(state);
	if (resources) {
		try {
			await teardownBrokerResources(resources);
		} catch (error) {
			debug(
				"broker",
				"process-event cleanup failed",
				sanitizeBrokerError(error, ""),
			);
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
		const state = brokerStateForClient(client);
		if (!state) {
			try {
				await Promise.resolve(client.close());
			} catch (error) {
				debug(
					"broker",
					"unknown client close failed",
					sanitizeBrokerError(error, ""),
				);
			}
			return;
		}
		state.brokerGenerationUnavailable = true;
		if ((state.brokerClientUsers.get(client) ?? 0) > 0) {
			state.retiredBrokerClients.add(client);
			state.brokerTeardownPending = true;
			return;
		}
		if (state.brokerClient === client) {
			state.brokerClient = null;
		}
		await teardownBrokerResources({ state, client, processHandle: null });
	});
}

function brokerStartupCancellationError(): Error & { code: string } {
	return Object.assign(new Error("Broker startup was cancelled"), {
		code: "request_fenced",
	});
}

function cancelBrokerStartupGeneration(
	state: BrokerState,
	generation: BrokerStartupGeneration,
): void {
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
	finalizeBrokerTeardown(state);
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
	// Acquisition enters the same lifecycle queue as teardown. A failed close
	// leaves brokerTeardownPending set, so no replacement or legacy profile can
	// run until a later bounded close retry confirms the old client is closed.
	await waitForGlobalTeardownToClear(deadlineAt, signal);
	await waitForLegacyFallbackToClear(deadlineAt, signal);
	await withBrokerLifecycle(async () => {
		if (brokerGlobalTeardownActive)
			throw Object.assign(new Error("Global broker teardown is still pending"), {
				code: "broker_process_pending",
			});
		if (brokerLegacyFallbackActive)
			throw Object.assign(new Error("Legacy fallback is active"), {
				code: "broker_fallback_active",
			});
		if (
			brokerHasUnresolvedTeardown(state) &&
			(state.brokerTeardownPending ||
				state.retiredBrokerClients.size > 0 ||
				state.failedBrokerClients.size > 0 ||
				state.clientClosePromises.size > 0 ||
				state.customCleanupPromises.size > 0 ||
				state.brokerFencedConnects.size > 0)
		)
			throw Object.assign(new Error("Broker teardown is still pending"), {
				code: "broker_process_pending",
			});
		// The disconnected-client test and its close must be one serialized state
		// transition. Otherwise acquisition can observe the detached pointer while
		// a concurrent close still owns the generation and can close a replacement.
		if (state.brokerClient?.connected === false) {
			const disconnected = state.brokerClient;
			const generation = currentClientGeneration(state, disconnected);
			state.brokerClient = null;
			state.brokerGenerationUnavailable = true;
			if ((state.brokerClientUsers.get(disconnected) ?? 0) === 0) {
				try {
					await teardownBrokerResources({
						state,
						client: disconnected,
						clientGeneration: generation,
						processHandle: null,
					});
				} catch (error) {
					debug(
						"broker",
						"disconnected client cleanup failed",
						sanitizeBrokerError(error, ""),
					);
					throw Object.assign(
						new Error("Disconnected broker client teardown is still pending"),
						{
							code: "broker_process_pending",
							cause: error,
						},
					);
				}
			} else {
				state.retiredBrokerClients.add(disconnected);
				state.brokerTeardownPending = true;
			}
		}
	});
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
		return waitForBrokerStartup(
			state,
			state.brokerStartupGeneration,
			deadlineAt,
			signal,
		);

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
				if (generation.cancelled || !brokerEnabled())
					throw brokerStartupCancellationError();
				if (Date.now() >= startupDeadlineAt)
					throw Object.assign(new Error("Broker startup deadline expired"), {
						code: "connect_timeout",
					});
				try {
					const connected = await connect();
					if (
						generation.cancelled ||
						!brokerEnabled() ||
						brokerGlobalTeardownActive ||
						state.brokerStartupGeneration !== generation ||
						state.brokerGenerationUnavailable
					) {
						try {
							const token = publishBrokerClient(state, connected);
							state.retiredBrokerClients.add(connected);
							await closeBrokerClientOnce(state, connected, token.generation);
						} catch {
							/* stale connector remains quarantined */
						}
						throw Object.assign(new Error("Broker generation unavailable"), {
							code: "connection_closed",
						});
					}
					lastError = undefined;
					state.brokerClient = connected;
					publishBrokerClient(state, connected);
					state.brokerPublicationPending = connected;
					state.brokerGenerationUnavailable = false;
					setTimeout(() => {
						if (state.brokerPublicationPending !== connected) return;
						void withBrokerLifecycle(async () => {
							if (
								state.brokerPublicationPending !== connected ||
								state.brokerClient !== connected ||
								(state.brokerClientUsers.get(connected) ?? 0) > 0
							)
								return;
							state.brokerPublicationPending = null;
							const resources = detachBrokerResources(state, connected);
							if (!resources) return;
							try {
								await teardownBrokerResources(resources);
							} catch (error) {
								debug(
									"broker",
									"unadopted startup cleanup failed",
									sanitizeBrokerError(error, ""),
								);
							}
						}).catch(() => undefined);
					}, 0);
					return connected;
				} catch (error) {
					lastError = error;
				}
				if (generation.cancelled || !brokerEnabled())
					throw brokerStartupCancellationError();
				if (state.brokerDeferredProcess) {
					await waitForDeferredProcess(state, startupDeadlineAt);
					if (state.brokerDeferredProcess)
						throw Object.assign(new Error("Previous broker process has not exited"), {
							code: "broker_process_pending",
						});
				}
				if (!state.brokerProcess || processHasExited(state.brokerProcess)) {
					if (
						generation.cancelled ||
						!brokerEnabled() ||
						state.brokerStartupGeneration !== generation
					)
						throw brokerStartupCancellationError();
					state.brokerProcess = processFactory(
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
					generation.processHandle = state.brokerProcess;
					state.brokerGenerationUnavailable = false;
					const ownedProcess = state.brokerProcess;
					let childCreated = false;
					ownedProcess.once("spawn", () => {
						childCreated = true;
					});
					const processEvent = (kind: "error" | "close" | "exit") => {
						void withBrokerLifecycle(() =>
							handleBrokerProcessEvent(
								state,
								ownedProcess,
								childCreated || kind === "exit",
							),
						).catch(() => undefined);
					};
					ownedProcess.once("error", () => processEvent("error"));
					ownedProcess.once("close", () => processEvent("close"));
					ownedProcess.once("exit", () => processEvent("exit"));
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(
						resolve,
						Math.min(40, Math.max(startupDeadlineAt - Date.now(), 1)),
					);
					generation.controller.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
				if (generation.cancelled || !brokerEnabled())
					throw brokerStartupCancellationError();
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
			if (
				lastError &&
				generation.processHandle &&
				state.brokerProcess === generation.processHandle
			) {
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

async function releaseBrokerLease(token: BrokerClientToken): Promise<void> {
	const state = token.state;
	if (!state) return;
	await withBrokerLifecycle(async () => {
		const remaining = releaseBrokerClient(token);
		if (remaining === 0 && state.retiredBrokerClients.delete(token.client)) {
			const deferredProcess = state.brokerDeferredProcess;
			if (state.brokerClient === token.client) state.brokerClient = null;
			try {
				await teardownBrokerResources({
					state,
					client: token.client,
					clientGeneration: token.generation,
					processHandle: deferredProcess,
				});
			} catch (error) {
				debug("broker", "deferred cleanup failed", sanitizeBrokerError(error, ""));
			}
		}
		if (
			remaining === 0 &&
			state.brokerTeardownPending &&
			state.brokerGenerationUnavailable &&
			state.brokerClient === token.client &&
			currentClientGeneration(state, token.client) === token.generation
		) {
			const resources = detachBrokerResources(state, token.client);
			if (resources)
				try {
					await teardownBrokerResources(resources);
				} catch (error) {
					debug("broker", "deferred cleanup failed", sanitizeBrokerError(error, ""));
				}
		}
	});
}

async function retireSupersededBrokerClient(
	state: BrokerState,
	client: BrokerClient,
): Promise<void> {
	if (state.brokerClient !== client) return;
	state.brokerClient = null;
	state.brokerGenerationUnavailable = true;
	if ((state.brokerClientUsers.get(client) ?? 0) > 0) {
		state.retiredBrokerClients.add(client);
		state.brokerTeardownPending = true;
		return;
	}
	await teardownBrokerResources({ state, client, processHandle: null });
}

function hasTargetedBrokerUsers(
	state: BrokerState,
	expected?: ExpectedBrokerClient,
): boolean {
	if (!expected) return hasActiveBrokerUsers(state);
	const byGeneration = state.brokerClientUserGenerations.get(expected.client);
	return (byGeneration?.get(expected.generation) ?? 0) > 0;
}

function prepareBrokerCloseState(
	state: BrokerState,
	expected?: ExpectedBrokerClient,
): void {
	// A scoped close must never cancel a startup that may publish a newer
	// generation. Only an unqualified close owns the startup cancellation fence.
	if (!expected && state.brokerStartupGeneration)
		cancelBrokerStartupGeneration(state, state.brokerStartupGeneration);
	if (!expected) {
		for (const attempt of state.brokerPendingConnects) {
			if (attempt.adopted || (attempt.settled && !attempt.candidate)) continue;
			attempt.fenced = true;
			state.brokerFencedConnects.add(attempt);
		}
	}
	const current = state.brokerClient;
	if (current && expectedMatches(state, expected, current)) {
		state.brokerTeardownPending = true;
		if (hasTargetedBrokerUsers(state, expected)) {
			state.retiredBrokerClients.add(current);
			state.brokerGenerationUnavailable = true;
		}
	}
	if (
		state.brokerProcess &&
		(!expected || (current !== null && expectedMatches(state, expected, current)))
	) {
		retainDeferredProcess(state, state.brokerProcess);
		state.brokerProcess = null;
		state.brokerTeardownPending = true;
	}
	if (!expected) state.brokerGenerationUnavailable = true;
}

async function waitForBrokerStateUsers(
	state: BrokerState,
	expected: ExpectedBrokerClient | undefined,
	deadlineAt: number,
): Promise<void> {
	while (hasTargetedBrokerUsers(state, expected)) {
		let waiter: (() => void) | undefined;
		try {
			await awaitWithinBudget(
				new Promise<void>((resolve) => {
					waiter = resolve;
					state.brokerLeaseWaiters.add(resolve);
				}),
				{ deadlineAt },
			);
		} finally {
			if (waiter) state.brokerLeaseWaiters.delete(waiter);
		}
	}
}

async function drainBrokerState(
	state: BrokerState,
	expected: ExpectedBrokerClient | undefined,
	deadlineAt: number,
): Promise<void> {
	await waitForBrokerStateUsers(state, expected, deadlineAt);
	// Detach under the lifecycle queue, but never await transport cleanup while
	// holding it. A shared close may outlive one caller's deadline; keeping the
	// queue free lets other callers observe the quarantine instead of inheriting
	// the first waiter's timeout.
	const resources = await withBrokerLifecycle(async () => {
		const detached: BrokerResources[] = [];
		const current = state.brokerClient;
		if (current && expectedMatches(state, expected, current)) {
			const resource = detachBrokerResources(state, current);
			if (resource) detached.push(resource);
		}
		for (const client of [...state.retiredBrokerClients]) {
			if (expected && !expectedMatches(state, expected, client)) continue;
			if ((state.brokerClientUsers.get(client) ?? 0) > 0) continue;
			state.retiredBrokerClients.delete(client);
			detached.push({
				state,
				client,
				clientGeneration: currentClientGeneration(state, client),
				processHandle: null,
			});
		}
		if (
			state.brokerDeferredProcess &&
			(!expected ||
				(current !== null && expectedMatches(state, expected, current))) &&
			!detached.some((resource) => resource.processHandle)
		) {
			detached.push({
				state,
				client: null,
				processHandle: state.brokerDeferredProcess,
			});
		}
		return detached;
	});
	const outcomes = await Promise.allSettled(
		resources.map((resource) => teardownBrokerResources(resource, deadlineAt)),
	);
	const errors = outcomes.flatMap((outcome) =>
		outcome.status === "rejected" ? [outcome.reason] : [],
	);
	if (state.brokerDeferredProcess) {
		try {
			await waitForDeferredProcess(state, deadlineAt);
			for (let index = errors.length - 1; index >= 0; index--)
				if (errorCode(errors[index]) === "cleanup_timeout") errors.splice(index, 1);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) throw errors[0];
	finalizeBrokerTeardown(state);
}

export function closeGoogleBroker(
	expectedClient?: BrokerClient,
	options: { deadlineAt?: number } = {},
): Promise<void> {
	const isUnqualified = expectedClient === undefined;
	const deadlineAt =
		options.deadlineAt ?? Date.now() + BROKER_CLEANUP_TIMEOUT_MS;
	const awaitCloseForCaller = (promise: Promise<void>): Promise<void> => {
		const waiter = awaitBrokerCloseUntil(promise, deadlineAt).catch((error) => {
			// A global close waiting on a live lease/reservation historically reports
			// a request deadline, while a detached client close reports cleanup_timeout.
			// Keep that distinction without changing the shared operation or its
			// quarantine lifetime.
			if (
				isUnqualified &&
				errorCode(error) === "cleanup_timeout" &&
				(brokerAcquisitionReservations > 0 ||
					[...brokerStates.values()].some((state) => hasActiveBrokerUsers(state)))
			)
				throw Object.assign(new Error("Broker cleanup timed out"), {
					code: "connect_timeout",
				});
			throw error;
		});
		waiter.catch(() => undefined);
		return waiter;
	};
	if (isUnqualified && brokerGlobalClosePromise)
		return awaitCloseForCaller(brokerGlobalClosePromise);
	const ownership = expectedClient
		? brokerOwnershipForClient(expectedClient)
		: undefined;
	const expected =
		ownership && expectedClient
			? { client: expectedClient, generation: ownership.generation }
			: undefined;
	const states = expectedClient
		? ownership
			? [ownership.state]
			: []
		: [...brokerStates.values()];
	const sharedState = states.length === 1 ? states[0] : undefined;
	if (sharedState && expected) {
		const existing = sharedState.scopedClosePromises.get(expected.client);
		if (existing?.generation === expected.generation)
			return awaitCloseForCaller(existing.promise);
	} else if (sharedState?.closePromise) {
		return awaitCloseForCaller(sharedState.closePromise);
	}
	if (isUnqualified) {
		// Publish the global fence synchronously, before this close enters the
		// lifecycle queue. This closes the snapshot race: another profile cannot
		// reserve or publish a broker after the queue releases this close.
		brokerGlobalTeardownActive = true;
		// This must happen synchronously with the latch publication. Otherwise a
		// pending connector can resolve while the close waits for reservations and
		// publish a client into the supposedly quiescent global teardown.
		fenceAllBrokerConnectAttempts();
	}
	// The shared operation has its own bounded cleanup budget. Individual callers
	// race that operation with their own absolute deadline below; one short waiter
	// must not shorten or cancel cleanup observed by another waiter.
	const cleanupDeadlineAt = Date.now() + BROKER_CLEANUP_TIMEOUT_MS;
	const closePromise = (async () => {
		await withBrokerLifecycle(async () => {
			for (const state of states) prepareBrokerCloseState(state, expected);
		});
		if (isUnqualified)
			await waitForBrokerAcquisitionReservations(cleanupDeadlineAt);
		const outcomes = await Promise.allSettled(
			states.map((state) => drainBrokerState(state, expected, cleanupDeadlineAt)),
		);
		const firstError = outcomes.find((outcome) => outcome.status === "rejected");
		if (firstError?.status === "rejected") throw firstError.reason;
	})();
	const closeEntry = {
		generation: expected?.generation ?? 0,
		promise: undefined as unknown as Promise<void>,
	};
	const sharedClosePromise = closePromise.finally(() => {
		if (sharedState && expected) {
			if (sharedState.scopedClosePromises.get(expected.client) === closeEntry)
				sharedState.scopedClosePromises.delete(expected.client);
		} else if (sharedState?.closePromise === sharedClosePromise) {
			sharedState.closePromise = null;
		}
		if (isUnqualified) {
			if (brokerGlobalClosePromise === sharedClosePromise)
				brokerGlobalClosePromise = null;
			maybeFinishGlobalTeardown();
		}
	});
	// close() is an injected boundary and callers may intentionally fire-and-
	// forget closeGoogleBroker(). Keep a rejection sink on the public promise as
	// well as on the underlying operation; callers can still observe rejection
	// by awaiting the original promise.
	sharedClosePromise.catch(() => undefined);
	closeEntry.promise = sharedClosePromise;
	if (sharedState && expected)
		sharedState.scopedClosePromises.set(expected.client, closeEntry);
	else if (sharedState) sharedState.closePromise = sharedClosePromise;
	if (isUnqualified) brokerGlobalClosePromise = sharedClosePromise;
	return awaitCloseForCaller(sharedClosePromise);
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
			env: {
				...process.env,
				// Session-owner coupling (#96): the pi host pid flows down to
				// the cdp.mjs CLI and its detached daemon, which polls it and
				// exits when this process dies — instead of accumulating as an
				// orphan daemon after session exit.
				PI_WEBAIO_SESSION_PID: String(process.pid),
				...(options.env ?? {}),
			},
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
			result.stderr.trim() || `google-search.mjs exited with code ${result.code}`,
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
		try {
			await closeGoogleBroker(undefined, { deadlineAt });
		} catch (error) {
			// A disabled broker may only fall back once every active lease and child
			// process has reached a confirmed terminal state. A kill request or a
			// cleanup timeout is not a safe point for legacy search concurrency.
			debug(
				"broker",
				"runtime-disable cleanup failed",
				sanitizeBrokerError(error, query),
			);
			throw error;
		}
		const releaseFallback = await reserveLegacyFallback(
			undefined,
			deadlineAt,
			options.signal,
		);
		if (!releaseFallback)
			throw Object.assign(new Error("Broker resources are still active"), {
				code: "broker_process_pending",
			});
		return runLegacyWithFallbackBarrier(
			() => legacySearch(query, options),
			deadlineAt,
			options.signal,
			releaseFallback,
		);
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
	// A connector can outlive the caller's request fence. Every connector is
	// represented by an owning profile and an attempt token, and remains in the
	// state sets until it settles and its result is adopted or quarantined.
	let connectAttemptCandidate: BrokerClient | undefined;
	let connectAttemptAdopted = false;
	let connectAttemptCloseStarted = false;
	let connectAttempt: BrokerConnectAttempt | undefined;
	const closeUnadoptedConnectClient = async (
		candidate: BrokerClient,
		trackedAttempt?: BrokerConnectAttempt,
	): Promise<void> => {
		if (
			connectAttemptAdopted ||
			connectAttemptCloseStarted ||
			trackedAttempt?.adopted ||
			trackedAttempt?.closeStarted
		)
			return;
		const ownerState =
			brokerStateForClient(candidate) ?? trackedAttempt?.state ?? brokerState;
		if (
			(ownerState.brokerClientUsers.get(candidate) ?? 0) > 0 ||
			(ownerState.brokerClient === candidate &&
				!ownerState.brokerGenerationUnavailable)
		) {
			connectAttemptAdopted = true;
			if (trackedAttempt) {
				trackedAttempt.adopted = true;
				ownerState.brokerPendingConnects.delete(trackedAttempt);
				ownerState.brokerFencedConnects.delete(trackedAttempt);
				finalizeBrokerTeardown(ownerState);
			}
			return;
		}
		connectAttemptCloseStarted = true;
		if (trackedAttempt) trackedAttempt.closeStarted = true;
		const token = publishBrokerClient(ownerState, candidate);
		ownerState.retiredBrokerClients.add(candidate);
		ownerState.brokerTeardownPending = true;
		try {
			if (cleanup === defaultCleanup) {
				await runBoundedCleanup(() =>
					teardownBrokerResources({
						state: ownerState,
						client: candidate,
						clientGeneration: token.generation,
						processHandle: null,
					}),
				);
			} else {
				const customCleanupPromise = startTrackedCustomCleanup(
					ownerState,
					candidate,
					token.generation,
					() => cleanup(candidate),
				);
				await runBoundedCleanup(() => customCleanupPromise);
			}
			if (trackedAttempt) {
				ownerState.brokerPendingConnects.delete(trackedAttempt);
				ownerState.brokerFencedConnects.delete(trackedAttempt);
				finalizeBrokerTeardown(ownerState);
			}
		} catch (error) {
			const inFlightClose =
				ownerState.clientClosePromises.get(candidate)?.promise ??
				ownerState.customCleanupPromises.get(candidate)?.promise;
			if (trackedAttempt && inFlightClose) {
				// Keep the stale generation fenced until the underlying close settles,
				// even though this bounded observer has already returned.
				inFlightClose
					.finally(() => {
						ownerState.brokerPendingConnects.delete(trackedAttempt);
						ownerState.brokerFencedConnects.delete(trackedAttempt);
						finalizeBrokerTeardown(ownerState);
					})
					.catch(() => undefined);
			} else if (trackedAttempt) {
				ownerState.brokerPendingConnects.delete(trackedAttempt);
				ownerState.brokerFencedConnects.delete(trackedAttempt);
				finalizeBrokerTeardown(ownerState);
			}
			// Keep the exact owner/generation quarantined when a custom cleanup
			// rejects or times out; a later acquisition must not reuse it.
			ownerState.failedBrokerClients.add(candidate);
			ownerState.retiredBrokerClients.add(candidate);
			ownerState.brokerTeardownPending = true;
			throw error;
		}
	};
	const observeConnectAttempt = (promise: Promise<BrokerClient>) => {
		const tracked: BrokerConnectAttempt = {
			state: brokerState,
			profileKey: brokerState.profileKey,
			attemptToken: ++brokerState.nextBrokerAttemptToken,
			promise,
			settled: false,
			// A global teardown may have latched between the acquisition reservation
			// and this connector's publication in the pending set. Fence at creation
			// as well as at teardown start so that race cannot publish a late client.
			fenced: brokerGlobalTeardownActive,
			adopted: false,
			closeStarted: false,
		};
		connectAttempt = tracked;
		brokerState.brokerPendingConnects.add(tracked);
		if (tracked.fenced) brokerState.brokerFencedConnects.add(tracked);
		promise.then(
			(candidate) => {
				tracked.settled = true;
				tracked.candidate = candidate;
				connectAttemptCandidate = candidate;
				if (!tracked.fenced) {
					void withBrokerLifecycle(async () => {
						if (!tracked.fenced) {
							brokerState.brokerPendingConnects.delete(tracked);
							finalizeBrokerTeardown(brokerState);
						}
					}).catch(() => undefined);
				}
				if (tracked.fenced && !tracked.adopted) {
					// Let same-generation adoption continuations run before closing a
					// shared result. The fenced/pending markers remain until then.
					setTimeout(() => {
						void withBrokerLifecycle(async () => {
							if (tracked.fenced && !tracked.adopted && tracked.candidate) {
								const closePromise = closeUnadoptedConnectClient(
									tracked.candidate,
									tracked,
								);
								closePromise.catch(() => undefined);
							}
						}).catch(() => undefined);
					}, 0);
				}
			},
			() => {
				tracked.settled = true;
				// A rejected connector has no client to adopt or close. Remove its
				// markers synchronously so a normal broker failure can still enter the
				// fallback decision without waiting behind another lifecycle turn.
				brokerState.brokerPendingConnects.delete(tracked);
				brokerState.brokerFencedConnects.delete(tracked);
				finalizeBrokerTeardown(brokerState);
			},
		);
		return promise;
	};
	const fenceConnectAttempt = () => {
		if (
			!connectAttempt ||
			connectAttempt.adopted ||
			(connectAttempt.settled && !connectAttempt.candidate)
		)
			return;
		connectAttempt.fenced = true;
		// This is deliberately synchronous: abort/deadline must publish the fence
		// before releasing the acquisition reservation or allowing fallback.
		brokerState.brokerFencedConnects.add(connectAttempt);
	};
	let directConnectAttempt: Promise<BrokerClient> | undefined;
	const startDirectConnectAttempt = () => {
		if (directConnectAttempt) return directConnectAttempt;
		let attempt: Promise<BrokerClient>;
		try {
			assertBrokerBudget({ deadlineAt, signal: options.signal });
			attempt = Promise.resolve(
				connect({ profileDir, deadlineAt, signal: options.signal }),
			);
		} catch (error) {
			attempt = Promise.reject(error);
		}
		directConnectAttempt = observeConnectAttempt(attempt);
		return directConnectAttempt;
	};
	const requestId = randomUUID();
	const queryHash = createHash("sha256").update(query).digest("hex");
	const attemptStartedAt = Date.now();
	let phase: BrokerAttemptPhase = "startup";
	let client: BrokerClient | undefined;
	let retainedToken: BrokerClientToken | undefined;
	let retainedClient = false;
	let cleanupOutcome: BrokerAttemptEnvelope["cleanupOutcome"];
	let cleanupError: unknown;
	let releaseBrokerAcquisition: (() => Promise<void>) | undefined;

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
		releaseBrokerAcquisition = await reserveBrokerAcquisition(
			deadlineAt,
			options.signal,
		);
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
		await withBrokerLifecycle(async () => {
			if (brokerGlobalTeardownActive)
				throw Object.assign(new Error("Global broker teardown is still pending"), {
					code: "broker_process_pending",
				});
			if (brokerLegacyFallbackActive)
				throw Object.assign(new Error("Legacy fallback is active"), {
					code: "broker_fallback_active",
				});
			if (
				brokerHasUnresolvedTeardown(brokerState) &&
				(brokerState.brokerTeardownPending ||
					brokerState.retiredBrokerClients.size > 0 ||
					brokerState.failedBrokerClients.size > 0 ||
					brokerState.clientClosePromises.size > 0 ||
					brokerState.customCleanupPromises.size > 0 ||
					brokerState.brokerFencedConnects.size > 0)
			)
				throw Object.assign(new Error("Broker teardown is still pending"), {
					code: "broker_process_pending",
				});
		});
		const connectedClient = await awaitWithinBudget(
			() => {
				assertBrokerBudget({ deadlineAt, signal: options.signal });
				return startDirectConnectAttempt();
			},
			{ deadlineAt, signal: options.signal },
		);
		await withBrokerLifecycle(async () => {
			assertBrokerBudget({ deadlineAt, signal: options.signal });
			if (brokerGlobalTeardownActive)
				throw Object.assign(new Error("Global broker teardown is still pending"), {
					code: "broker_process_pending",
				});
			if (!brokerEnabled()) {
				const token = publishBrokerClient(brokerState, connectedClient);
				brokerState.retiredBrokerClients.add(connectedClient);
				await closeBrokerClientOnce(brokerState, connectedClient, token.generation);
				throw brokerStartupCancellationError();
			}
			if (
				!usesManagedBroker &&
				brokerState.brokerClient &&
				brokerState.brokerClient !== connectedClient &&
				brokerState.brokerClient.connected === false
			) {
				const disconnected = brokerState.brokerClient;
				brokerState.brokerClient = null;
				const generation = currentClientGeneration(brokerState, disconnected);
				if (generation !== undefined)
					await closeBrokerClientOnce(brokerState, disconnected, generation);
			}
			if (
				brokerState.brokerGenerationUnavailable &&
				brokerState.brokerTeardownPending &&
				hasActiveBrokerUsers(brokerState) &&
				brokerState.brokerClient !== connectedClient
			)
				throw Object.assign(new Error("Broker generation unavailable"), {
					code: "connection_closed",
				});
			if (
				!usesManagedBroker &&
				brokerState.brokerClient &&
				brokerState.brokerClient !== connectedClient
			)
				await retireSupersededBrokerClient(brokerState, brokerState.brokerClient);
			retainedToken = retainBrokerClient(brokerState, connectedClient);
			if (!usesManagedBroker) brokerState.brokerClient = connectedClient;
			brokerState.brokerGenerationUnavailable = false;
			publishBrokerClient(brokerState, connectedClient);
			connectAttemptAdopted = true;
			if (connectAttempt) {
				connectAttempt.adopted = true;
				connectAttempt.fenced = false;
				brokerState.brokerPendingConnects.delete(connectAttempt);
				brokerState.brokerFencedConnects.delete(connectAttempt);
				finalizeBrokerTeardown(brokerState);
			}
			if (brokerState.brokerPublicationPending === connectedClient)
				brokerState.brokerPublicationPending = null;
			client = connectedClient;
			retainedClient = true;
		});
		if (releaseBrokerAcquisition) {
			await releaseBrokerAcquisition();
			releaseBrokerAcquisition = undefined;
		}
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
		if (retainedClient && retainedToken) {
			await releaseBrokerLease(retainedToken);
			retainedClient = false;
			retainedToken = undefined;
		}
		return result;
	} catch (error) {
		// Publish the fence synchronously, before cleanup or reservation release,
		// even when the connector has not resolved to a candidate yet.
		if (!connectAttemptAdopted) fenceConnectAttempt();
		const cleanupPromise = withBrokerLifecycle(async () => {
			if (connectAttempt && !connectAttemptAdopted && connectAttemptCandidate)
				brokerState.brokerFencedConnects.add(connectAttempt);
			let cleanupResources: BrokerResources | null = null;
			let cleanupOwnerToken: BrokerClientToken | undefined;
			if (!retainedClient && connectAttemptCandidate && !connectAttemptAdopted) {
				try {
					await closeUnadoptedConnectClient(connectAttemptCandidate, connectAttempt);
					cleanupOutcome = "succeeded";
				} catch (cleanupFailure) {
					cleanupOutcome = "failed";
					cleanupError = cleanupFailure;
				}
				return;
			}
			if (retainedClient && client) {
				retainedClient = false;
				const ownerToken = retainedToken ?? {
					state: brokerStateForClient(client) ?? brokerState,
					client,
					generation:
						currentClientGeneration(
							brokerStateForClient(client) ?? brokerState,
							client,
						) ?? 0,
				};
				cleanupOwnerToken = ownerToken;
				const ownerState = ownerToken.state;
				const remaining = releaseBrokerClient(ownerToken);
				if (remaining > 0) {
					cleanupOutcome = "skipped_shared";
					return;
				}
				// The final lease owner owns a teardown fence even when an injected
				// cleanup hook (or close()) later times out.
				ownerState.brokerTeardownPending = true;
				ownerState.retiredBrokerClients.add(client);
				// Quarantine before invoking an arbitrary cleanup hook. A timed-out
				// hook must not leave a client eligible for a later acquisition.
				if (ownerState.brokerClient === client)
					cleanupResources = detachBrokerResources(ownerState, client);
				else if (ownerState.retiredBrokerClients.delete(client)) {
					const deferredProcess = ownerState.brokerDeferredProcess;
					ownerState.brokerDeferredProcess = null;
					cleanupResources = {
						state: ownerState,
						client,
						processHandle: deferredProcess,
					};
				}
			}
			if (!client) {
				// A connector can still resolve after this request has fenced. The
				// observer owns that late candidate; never invoke an injected cleanup
				// hook with an undefined client or claim that teardown completed.
				cleanupOutcome = "not_attempted";
				return;
			}
			if (cleanup === defaultCleanup && !cleanupResources)
				// The injectable connect seam does not always populate the production
				// singleton, but the acquired client still needs deterministic close.
				cleanupResources = {
					state: cleanupOwnerToken?.state ?? brokerState,
					client,
					clientGeneration: cleanupOwnerToken?.generation,
					processHandle: null,
				};
			try {
				let customCleanupPromise: Promise<void> | undefined;
				if (cleanup !== defaultCleanup && client) {
					const ownerState =
						cleanupOwnerToken?.state ?? brokerStateForClient(client) ?? brokerState;
					const generation =
						cleanupOwnerToken?.generation ??
						currentClientGeneration(ownerState, client);
					if (generation !== undefined) {
						customCleanupPromise = startTrackedCustomCleanup(
							ownerState,
							client,
							generation,
							() => cleanup(client),
						);
					}
				}
				await runBoundedCleanup(() =>
					cleanup === defaultCleanup && cleanupResources
						? teardownBrokerResources(cleanupResources)
						: (customCleanupPromise ?? cleanup(client)),
				);
				cleanupOutcome = "succeeded";
			} catch (cleanupFailure) {
				if (cleanup !== defaultCleanup && client) {
					const ownerState = cleanupOwnerToken?.state ?? brokerState;
					ownerState.failedBrokerClients.add(client);
					ownerState.retiredBrokerClients.add(client);
					ownerState.brokerTeardownPending = true;
				}
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
			if (releaseBrokerAcquisition) {
				await releaseBrokerAcquisition();
				releaseBrokerAcquisition = undefined;
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
				cleanupAborted ? "aborted" : cleanupExpired ? "deadline" : "cleanup_failed",
			);
			if (releaseBrokerAcquisition) {
				await releaseBrokerAcquisition();
				releaseBrokerAcquisition = undefined;
			}
			throw error;
		}
		if (releaseBrokerAcquisition) {
			await releaseBrokerAcquisition();
			releaseBrokerAcquisition = undefined;
		}
		if (cleanupOutcome === "failed" || cleanupOutcome === "skipped_shared") {
			emitFailure(
				error,
				"skipped",
				cleanupOutcome === "skipped_shared" ? "shared_active" : "cleanup_failed",
			);
			throw error;
		}
		// A pending teardown or fallback barrier is a safety fence, not an
		// ordinary broker failure. Never turn that state into a legacy request:
		// doing so could overlap a connector that is still able to publish or a
		// cleanup that has not yet reached a terminal state.
		if (
			errorCode(error) === "broker_process_pending" ||
			errorCode(error) === "broker_fallback_active"
		) {
			emitFailure(error, "skipped", "shared_active");
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
		const releaseFallback = await reserveLegacyFallback(
			brokerState,
			deadlineAt,
			options.signal,
		);
		if (!releaseFallback) {
			emitFailure(error, "skipped", "shared_active");
			throw error;
		}

		try {
			const legacyResult = await runLegacyWithFallbackBarrier(
				() =>
					legacySearch(query, {
						...options,
						timeoutMs: Math.max(deadlineAt - Date.now(), 1),
						deadlineAt,
					}),
				deadlineAt,
				options.signal,
				releaseFallback,
			);
			emitFailure(error, "succeeded", "broker_failure");
			return legacyResult;
		} catch (legacyError) {
			const legacyAborted = isBrokerCancellation(legacyError, options.signal);
			const legacyExpired = Date.now() >= deadlineAt;
			if (legacyAborted || legacyExpired) {
				emitFailure(error, "skipped", legacyAborted ? "aborted" : "deadline");
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
 *
 * The Google CDP broker is the default search path (post-#97), but it falls
 * back to the legacy extractor when the broker is unavailable; the summary
 * and Reddit lanes use the same Chrome/CDP infrastructure. So availability
 * means EITHER the broker files OR the legacy extractor files are present —
 * a partial install still gets a working Google lane via the fallback.
 */
export function cdpAvailable(): boolean {
	const legacyPresent =
		existsSync(resolvePath("bin", "cdp.mjs")) &&
		existsSync(resolvePath("bin", "launch.mjs")) &&
		existsSync(resolvePath("extractors", "google-ai.mjs")) &&
		existsSync(resolvePath("extractors", "google-search.mjs")) &&
		existsSync(resolvePath("extractors", "common.mjs")) &&
		existsSync(resolvePath("extractors", "consent.mjs")) &&
		existsSync(resolvePath("extractors", "selectors.mjs"));
	if (legacyPresent) return true;
	// Broker-only installs: the broker needs its binary + client module.
	return (
		existsSync(resolvePath("bin", "google-cdp-broker.mjs")) &&
		existsSync(resolvePath("extractors", "google-cdp-broker-client.mjs"))
	);
}
