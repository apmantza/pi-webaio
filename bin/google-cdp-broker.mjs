#!/usr/bin/env node

// Google CDP broker — the default Google search lane (post-#97). It owns a
// narrow lease protocol over a shared Chrome/CDP connection, serializing
// concurrent searches. The production wrapper (src/google-ai.ts) passes
// --connect-cdp --cdp-port 9222 --parent-stdin; it does not launch Chrome
// itself (the wrapper's launch.mjs owns that) and exits on parent death.

import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	writeFile,
	rm,
	rename,
	lstat,
	chmod,
} from "node:fs/promises";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserCdpTransport } from "./cdp-browser-transport.mjs";

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_IN_FLIGHT_REQUESTS = 32;
export const MAX_REQUEST_ID_HISTORY = 1024;
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_ORPHAN_TTL_MS = 15_000;
export const DEFAULT_PROVIDER_CAPS = Object.freeze({
	"google-search": 2,
	"google-ai": 1,
	reddit: 1,
});

const PROFILE_ROOT = join(tmpdir(), "pi-webaio-google-cdp");
const ALLOWED_PROVIDERS = new Set(Object.keys(DEFAULT_PROVIDER_CAPS));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class BrokerError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = "BrokerError";
		this.code = code;
		this.details = details;
	}
}

function errorInfo(error) {
	if (error instanceof BrokerError) {
		return {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	return {
		code: error?.code || "internal_error",
		message: String(error?.message || error),
		...(error?.details === undefined ? {} : { details: error.details }),
	};
}

function ok(result) {
	return { ok: true, result };
}

function fail(error) {
	return { ok: false, error: errorInfo(error) };
}

function asString(value, name) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		throw new BrokerError(
			"invalid_request",
			`${name} must be a non-empty string`,
		);
	}
	return value;
}

function asCapability(value) {
	if (typeof value !== "string" || value.length < 32 || value.length > 256)
		throw new BrokerError(
			"unauthorized",
			"A broker-bound capability is required",
		);
	return value;
}

function asRequestId(value) {
	if (
		typeof value !== "string" ||
		!ID_PATTERN.test(value) ||
		Buffer.byteLength(value, "utf8") > MAX_REQUEST_ID_BYTES
	)
		throw new BrokerError(
			"invalid_request_id",
			"id must be a canonical bounded string",
		);
	return value;
}

function asPositiveInt(value, fallback, max) {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new BrokerError(
			"invalid_request",
			"numeric option must be a positive integer",
		);
	}
	return Math.min(number, max);
}

function profileHash(profileKey) {
	return createHash("sha256").update(profileKey).digest("hex").slice(0, 24);
}

/**
 * The marker profile hash a broker instance for `profileDir` uses for its
 * crash-orphan marker URLs. Exported for tests to fabricate prior-generation
 * orphan targets with the same hash but a different nonce.
 */
export function brokerProfileHashFor(profileDir) {
	const profileKey = resolve(profileDir);
	return profileHash(
		platform() === "win32" ? profileKey.toLowerCase() : profileKey,
	);
}

// Crash-orphan target recovery (#95 P2 item 2): broker-created Chrome
// targets use a unique per-broker marker URL so a restarted broker can tell
// its own targets from orphaned ones left behind by a hard crash of a prior
// broker generation. A data: URL round-trips reliably through
// Target.createTarget/getTargets (an about:blank fragment might not), and
// the profile hash + per-start nonce make cross-profile and cross-generation
// collisions impossible.
const TARGET_MARKER_PREFIX = "data:text/plain,pi-webaio-broker:";
export { TARGET_MARKER_PREFIX };

function targetMarkerUrl(profileHashValue, nonce) {
	return `${TARGET_MARKER_PREFIX}${profileHashValue}:${nonce}`;
}

function isBrokerMarkerUrl(url) {
	return typeof url === "string" && url.startsWith(TARGET_MARKER_PREFIX);
}

function markerProfileHash(url) {
	// "data:text/plain,pi-webaio-broker:<hash>:<nonce>" -> "<hash>"
	const rest = url.slice(TARGET_MARKER_PREFIX.length);
	const sep = rest.indexOf(":");
	return sep === -1 ? "" : rest.slice(0, sep);
}

function markerNonce(url) {
	const rest = url.slice(TARGET_MARKER_PREFIX.length);
	const sep = rest.indexOf(":");
	return sep === -1 ? "" : rest.slice(sep + 1);
}

function newCapability() {
	return `${randomUUID()}-${randomUUID()}`;
}

export function brokerPaths(
	profileDir = join(tmpdir(), "greedysearch-chrome-profile"),
) {
	const profileKey = resolve(profileDir);
	const hash = profileHash(
		platform() === "win32" ? profileKey.toLowerCase() : profileKey,
	);
	return {
		profileKey,
		lockPath: join(PROFILE_ROOT, `${hash}.lock`),
		socketPath:
			platform() === "win32"
				? `\\\\.\\pipe\\pi-webaio-google-cdp-${hash}`
				: join(tmpdir(), `pi-webaio-google-cdp-${hash}.sock`),
	};
}

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readLockRecord(lockPath) {
	try {
		return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
	} catch {
		// Read the pre-directory format too, but recover it only via rename below.
		try {
			return JSON.parse(await readFile(lockPath, "utf8"));
		} catch {
			return undefined;
		}
	}
}

/** Claim a lock directory. Stale recovery is an atomic rename CAS. */
export async function claimStartupLock({
	lockPath,
	socketPath,
	profileKey,
	pid = process.pid,
	ownerNonce = randomUUID(),
	staleAfterMs = 120_000,
} = {}) {
	if (!lockPath || !socketPath || !profileKey) {
		return fail(
			new BrokerError(
				"invalid_lock",
				"profileKey, lockPath and socketPath are required",
			),
		);
	}
	try {
		await mkdir(dirname(lockPath), { recursive: true });
	} catch (error) {
		return fail(new BrokerError("lock_failed", String(error?.message || error)));
	}
	const record = {
		version: 2,
		profileKey,
		socketPath,
		pid,
		ownerNonce,
		startedAt: new Date().toISOString(),
	};
	let recoveryAttempts = 0;
	for (;;) {
		try {
			await mkdir(lockPath, { recursive: false, mode: 0o700 });
			try {
				await writeFile(
					join(lockPath, "owner.json"),
					`${JSON.stringify(record)}\n`,
					{
						encoding: "utf8",
						mode: 0o600,
					},
				);
			} catch (writeError) {
				await rm(lockPath, { recursive: true, force: true }).catch(() => {});
				return fail(
					new BrokerError("lock_failed", String(writeError?.message || writeError)),
				);
			}
			return {
				ok: true,
				ownerNonce,
				record,
				async release() {
					const current = await readLockRecord(lockPath);
					if (current?.ownerNonce !== ownerNonce) return;
					const tombstone = `${lockPath}.release-${ownerNonce}`;
					try {
						await rename(lockPath, tombstone);
						const moved = await readLockRecord(tombstone);
						if (moved?.ownerNonce !== ownerNonce) {
							try {
								await rename(tombstone, lockPath);
							} catch {}
							return;
						}
						await rm(tombstone, { recursive: true, force: true });
					} catch (error) {
						if (error?.code !== "ENOENT") throw error;
					}
				},
			};
		} catch (error) {
			if (error?.code !== "EEXIST")
				return fail(
					new BrokerError("lock_failed", String(error?.message || error)),
				);
		}
		const current = await readLockRecord(lockPath);
		if (current?.profileKey && current.profileKey !== profileKey)
			return fail(
				new BrokerError(
					"lock_profile_mismatch",
					"Lock belongs to another Chrome profile",
				),
			);
		let oldEnough = false;
		try {
			oldEnough = Date.now() - (await lstat(lockPath)).mtimeMs > staleAfterMs;
		} catch {
			oldEnough = true;
		}
		const live = processIsAlive(current?.pid);
		const hasOwnerPid = Number.isInteger(current?.pid) && current.pid > 0;
		if (live) {
			return fail(
				new BrokerError(
					"already_running",
					"A broker already owns this Chrome profile",
					{
						pid: current?.pid,
						ownerNonce: current?.ownerNonce,
						socketPath: current?.socketPath || socketPath,
					},
				),
			);
		}
		// A dead owner pid is stale by definition — the lock cannot be racing
		// anyone, so take it over without waiting out the age gate. Without a
		// valid owner pid (unreadable/record-mid-write), keep the age gate: it
		// protects the tiny mkdir→writeFile window of a writer that has not
		// recorded its pid yet.
		if (!hasOwnerPid && !oldEnough) {
			return fail(
				new BrokerError(
					"already_running",
					"A broker already owns this Chrome profile",
					{
						pid: current?.pid,
						ownerNonce: current?.ownerNonce,
						socketPath: current?.socketPath || socketPath,
					},
				),
			);
		}
		// rename() is the compare-and-swap: only the contender that moves the
		// exact stale directory may recover it. Never unlink a live owner's lock.
		const quarantine = `${lockPath}.stale-${randomUUID()}`;
		try {
			await rename(lockPath, quarantine);
			// Re-read the moved record before deleting it. A rename is atomic, but
			// portable filesystems do not provide a general CAS across the rename
			// and the cleanup. If the owner changed or the record is incomplete,
			// preserve the moved directory and report the safe outcome.
			const moved = await readLockRecord(quarantine);
			if (
				!moved?.ownerNonce ||
				!current?.ownerNonce ||
				moved.ownerNonce !== current.ownerNonce
			) {
				try {
					await rename(quarantine, lockPath);
				} catch {
					// A new owner may already have claimed lockPath. Keeping the
					// quarantine is safer than deleting either owner's record.
				}
				return fail(
					new BrokerError(
						"already_running",
						"A broker already owns this Chrome profile",
						{
							pid: moved?.pid ?? current?.pid,
							ownerNonce: moved?.ownerNonce ?? current?.ownerNonce,
							socketPath: moved?.socketPath || current?.socketPath || socketPath,
						},
					),
				);
			}
			await rm(quarantine, { recursive: true, force: true });
		} catch (error) {
			if (
				["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EBUSY"].includes(error?.code)
			) {
				recoveryAttempts++;
				if (recoveryAttempts <= 32) {
					await new Promise((resolveResult) => setTimeout(resolveResult, 5));
					continue;
				}
			}
			return fail(
				new BrokerError(
					"lock_race",
					"A stale broker lock could not be atomically recovered",
				),
			);
		}
	}
}

function targetKey(sessionId, provider) {
	return `${sessionId}\u0000${provider}`;
}

const MAX_SEARCH_QUERY_BYTES = 256;
// Keep this aligned with aio-websearch's documented per-engine range while
// retaining a broker-side ceiling against unbounded browser extraction.
export const MAX_SEARCH_RESULTS = 25;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
// Google paginates its classic SERP in strides of 10 via `?start=`. Each
// extra page costs a navigation + extraction poll round, so a second page is
// only attempted when at least this much search deadline remains. If less,
// the broker returns the first page's organics (bounded, never late).
const GOOGLE_PAGE_STRIDE = 10;
const GOOGLE_PAGE_BUDGET_FLOOR_MS = 2_000;
// Per-page extraction ceiling: a sparse last SERP page must not burn the
// whole search deadline waiting for the >=3-result gate. Pages are bounded
// individually; the overall search deadline still applies on top.
const GOOGLE_PAGE_EXTRACT_BUDGET_MS = 3_500;
const SEARCH_POLL_INTERVAL_MS = 150;
const CDP_CLOSE_RETRY_BASE_MS = 250;
const CDP_CLOSE_RETRY_MAX_MS = 30_000;
const CDP_CLOSE_CONFIRM_AFTER_ATTEMPTS = 3;
const SEARCH_REQUEST_FIELDS = new Set([
	"id",
	"op",
	"deadlineAt",
	"clientId",
	"sessionId",
	"capability",
	"provider",
	"query",
	"maxResults",
]);
const SEARCH_FORBIDDEN_FIELDS = new Set([
	"targetId",
	"cdpTargetId",
	"cdpSessionId",
	"method",
	"cdpMethod",
	"params",
	"url",
	"script",
	"expression",
	"javascript",
]);

// This is intentionally a broker-owned expression. Search callers provide no
// selector, script, URL, or CDP method; the only variable data is validated by
// the broker before it is used to build the canonical navigation URL.
const GOOGLE_SEARCH_EXTRACTION_SCRIPT = String.raw`(() => {
	const consentSelectors = [
		"button#L2AGLb",
		"button[aria-label=\"Accept all\"]",
		"button[aria-label=\"I agree\"]",
		"form[action*=\"consent\"] button",
	];
	let consentDismissed = false;
	for (const selector of consentSelectors) {
		const button = document.querySelector(selector);
		if (button instanceof HTMLElement && button.offsetParent !== null) {
			button.click();
			consentDismissed = true;
			break;
		}
	}
	const results = [];
	const seen = new Set();
	const headings = document.querySelectorAll("a[href^=\"http\"] h3");
	for (const heading of headings) {
		if (results.length >= 25) break;
		const anchor = heading.closest("a");
		if (!anchor) continue;
		const url = anchor.href;
		try {
			const parsed = new URL(url);
			const googleHost = parsed.hostname === "google.com" || parsed.hostname.endsWith(".google.com");
			if (googleHost && !parsed.pathname.startsWith("/search")) continue;
		} catch {
			continue;
		}
		if (seen.has(url)) continue;
		seen.add(url);
		const title = (heading.innerText || heading.textContent || "").trim();
		if (!title) continue;
		const container = anchor.closest(".g, [data-sokoban-container], .MjjYud") || anchor.parentElement;
		let snippetElement = container?.querySelector(".VwiC3b, [data-sncf], span.aCOpRe, .lEBKkf, div[style*=\"-webkit-line-clamp\"]");
		if (!snippetElement && container) {
			snippetElement = [...container.querySelectorAll("span, div")]
				.filter((element) => {
					const text = element.innerText?.trim();
					return text && text.length > 30 && text !== title && !element.querySelector("h3");
				})
				.sort((left, right) => right.innerText.length - left.innerText.length)[0];
		}
		const snippet = (snippetElement?.innerText || "").trim().slice(0, 300);
		results.push({ title, url, snippet });
	}
	return { consentDismissed, ready: document.readyState === "complete", results };
})()`;

function checkSignal(signal) {
	if (signal?.aborted)
		throw new BrokerError(
			"request_fenced",
			"Request was cancelled or its client disconnected",
		);
}

function boundedCleanupDeadline(request, limitMs = 500) {
	const requestDeadline = Number.isInteger(request?.deadlineAt)
		? request.deadlineAt
		: Date.now() + limitMs;
	return Math.max(
		Date.now() + 1,
		Math.min(requestDeadline, Date.now() + limitMs),
	);
}

function evaluationString(evaluation) {
	const value = searchEvaluationValue(evaluation);
	return typeof value === "string" ? value : undefined;
}

export function isGoogleSearchLocation(value, expected) {
	if (typeof value !== "string") return false;
	try {
		const actual = new URL(value);
		const wanted = new URL(expected);
		return (
			actual.origin === wanted.origin &&
			actual.pathname === "/search" &&
			actual.searchParams.get("q") === wanted.searchParams.get("q") &&
			actual.searchParams.get("num") === wanted.searchParams.get("num")
		);
	} catch {
		return false;
	}
}

function hasSearchControlCharacter(value) {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
	}
	return false;
}

function validateSearchRequest(request) {
	for (const field of SEARCH_FORBIDDEN_FIELDS)
		if (Object.hasOwn(request, field))
			throw new BrokerError(
				"invalid_request",
				`${field} is private to the broker and is not accepted for search`,
			);
	for (const field of Object.keys(request))
		if (!SEARCH_REQUEST_FIELDS.has(field))
			throw new BrokerError(
				"invalid_request",
				`${field} is not accepted for the broker search operation`,
			);
	if (request.provider !== "google-search")
		throw new BrokerError(
			"unsupported_provider",
			"Search is only available for provider google-search",
		);
	if (
		typeof request.query !== "string" ||
		request.query.length === 0 ||
		request.query.length > MAX_SEARCH_QUERY_BYTES ||
		Buffer.byteLength(request.query, "utf8") > MAX_SEARCH_QUERY_BYTES ||
		hasSearchControlCharacter(request.query) ||
		!request.query.trim()
	)
		throw new BrokerError(
			"invalid_request",
			"query must be a bounded, non-empty search string",
		);
	const maxResults = request.maxResults === undefined ? 15 : request.maxResults;
	if (
		!Number.isInteger(maxResults) ||
		maxResults < 1 ||
		maxResults > MAX_SEARCH_RESULTS
	)
		throw new BrokerError(
			"invalid_request",
			`maxResults must be an integer from 1 to ${MAX_SEARCH_RESULTS}`,
		);
	return { query: request.query, maxResults };
}

export function canonicalGoogleSearchUrl(query, maxResults, start = 0) {
	try {
		const url = new URL("https://www.google.com/search");
		url.searchParams.set("q", query);
		url.searchParams.set("num", String(maxResults));
		// Google ignores `num` for logged-out organic SERPs (deprecated) and
		// renders only the first page of ~8-10 organics. `start` is the only
		// mechanism that offsets into the full result set — same one Google's
		// own "Next" links use. Keep `num` constant across pages so the
		// location check in verifyCdpLocation holds for every paginated URL.
		if (start > 0) url.searchParams.set("start", String(start));
		return url.href;
	} catch {
		throw new BrokerError("invalid_request", "Search URL could not be built");
	}
}

function searchEvaluationValue(evaluation) {
	const value = evaluation?.result?.value;
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value && typeof value === "object" ? value : undefined;
}

function waitForSearchPoll(signal, deadlineAt) {
	return new Promise((resolve, reject) => {
		const delay = Math.max(
			1,
			Math.min(SEARCH_POLL_INTERVAL_MS, deadlineAt - Date.now()),
		);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, delay);
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new BrokerError("request_fenced", "Search was cancelled"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export class LeaseRegistry {
	constructor(options = {}) {
		this.globalCap = asPositiveInt(options.globalCap, 4, 64);
		this.providerCaps = {
			...DEFAULT_PROVIDER_CAPS,
			...(options.providerCaps || {}),
		};
		this.ttlMs = asPositiveInt(options.ttlMs, DEFAULT_LEASE_TTL_MS, 10 * 60_000);
		this.orphanTtlMs = asPositiveInt(
			options.orphanTtlMs,
			DEFAULT_ORPHAN_TTL_MS,
			10 * 60_000,
		);
		this.clients = new Map();
		this.sessions = new Map();
		this.leases = new Map();
		this.activeByKey = new Map();
		this.targets = new Map();
		this.waiters = new Map();
		this.idleTargetTtlMs = asPositiveInt(
			options.idleTargetTtlMs,
			10 * 60_000,
			60 * 60_000,
		);
		this.browserGeneration = 1;
	}

	register({ clientId, sessionId, capability = newCapability() }) {
		clientId = asString(clientId, "clientId");
		sessionId = asString(sessionId, "sessionId");
		capability = asCapability(capability);
		const existing = this.clients.get(clientId);
		const sessionOwner = this.sessions.get(sessionId);
		if (existing && existing.capability !== capability)
			throw new BrokerError(
				"connection_ownership",
				"clientId is owned by another connection",
			);
		if (existing && existing.sessionId !== sessionId)
			throw new BrokerError(
				"client_conflict",
				"clientId is already registered to another session",
			);
		if (sessionOwner && sessionOwner !== clientId)
			throw new BrokerError(
				"session_conflict",
				"sessionId is already registered to another client",
			);
		const client = existing || {
			clientId,
			sessionId,
			capability,
			registeredAt: Date.now(),
		};
		client.lastHeartbeat = Date.now();
		this.clients.set(clientId, client);
		this.sessions.set(sessionId, clientId);
		return {
			clientId,
			sessionId,
			capability,
			heartbeatTtlMs: this.orphanTtlMs,
		};
	}

	assertClient({ clientId, sessionId, capability }) {
		clientId = asString(clientId, "clientId");
		sessionId = asString(sessionId, "sessionId");
		capability = asCapability(capability);
		const client = this.clients.get(clientId);
		if (!client)
			throw new BrokerError(
				"not_registered",
				"Client must register before leasing",
			);
		if (client.sessionId !== sessionId)
			throw new BrokerError(
				"session_mismatch",
				"sessionId does not match the registered client",
			);
		if (client.capability !== capability)
			throw new BrokerError(
				"unauthorized",
				"Capability does not own this connection",
			);
		client.lastHeartbeat = Date.now();
		return client;
	}

	validateProvider(provider) {
		if (
			!ALLOWED_PROVIDERS.has(provider) ||
			this.providerCaps[provider] === undefined
		)
			throw new BrokerError(
				"unsupported_provider",
				`Provider is not enabled: ${provider}`,
			);
	}

	async lease({
		clientId,
		sessionId,
		capability,
		provider,
		ttlMs,
		waitMs = this.ttlMs,
		signal,
	}) {
		checkSignal(signal);
		this.assertClient({ clientId, sessionId, capability });
		provider = asString(provider, "provider");
		this.validateProvider(provider);
		const key = targetKey(sessionId, provider);
		if (this.activeByKey.has(key))
			return this.enqueue(
				key,
				{ clientId, sessionId, capability, provider, ttlMs, signal },
				waitMs,
			);
		if (
			this.activeCount() >= this.globalCap ||
			this.providerActive(provider) >= this.providerCaps[provider]
		)
			throw new BrokerError(
				"capacity_exhausted",
				"Lease concurrency cap reached",
				{
					global: { active: this.activeCount(), cap: this.globalCap },
					provider: {
						provider,
						active: this.providerActive(provider),
						cap: this.providerCaps[provider],
					},
				},
			);
		return this.allocate({
			key,
			clientId,
			sessionId,
			capability,
			provider,
			ttlMs,
			signal,
		});
	}

	enqueue(key, request, waitMs) {
		const timeout = Math.min(
			Math.max(Number(waitMs) || this.ttlMs, 1),
			10 * 60_000,
		);
		return new Promise((resolve, reject) => {
			const waiter = {
				...request,
				resolve,
				reject,
				timer: undefined,
				settled: false,
			};
			waiter.timer = setTimeout(() => {
				this.removeWaiter(key, waiter);
				this.finishWaiter(
					waiter,
					new BrokerError("lease_wait_timeout", "The session lease remained busy"),
				);
			}, timeout);
			waiter.timer.unref?.();
			if (request.signal) {
				const abort = () => {
					this.removeWaiter(key, waiter);
					this.finishWaiter(
						waiter,
						new BrokerError(
							"request_fenced",
							"Request was cancelled or its client disconnected",
						),
					);
				};
				waiter.abort = abort;
				if (request.signal.aborted) return abort();
				request.signal.addEventListener("abort", abort, { once: true });
			}
			const queue = this.waiters.get(key) || [];
			queue.push(waiter);
			this.waiters.set(key, queue);
		});
	}

	removeWaiter(key, waiter) {
		const queue = this.waiters.get(key);
		if (!queue) return;
		const index = queue.indexOf(waiter);
		if (index !== -1) queue.splice(index, 1);
		if (queue.length === 0) this.waiters.delete(key);
	}

	finishWaiter(waiter, error, value) {
		if (waiter.settled) return;
		waiter.settled = true;
		clearTimeout(waiter.timer);
		waiter.signal?.removeEventListener("abort", waiter.abort);
		if (error) waiter.reject(error);
		else waiter.resolve(value);
	}

	allocate({ key, clientId, sessionId, capability, provider, ttlMs, signal }) {
		checkSignal(signal);
		const target =
			[...this.targets.values()].find(
				(candidate) =>
					candidate.provider === provider &&
					candidate.sessionId === sessionId &&
					candidate.generation === this.browserGeneration &&
					!candidate.busy &&
					!candidate.dirty,
			) || this.createTarget(provider, sessionId);
		target.busy = true;
		target.idleSince = null;
		const lease = {
			leaseId: randomUUID(),
			key,
			clientId,
			sessionId,
			capability,
			provider,
			targetId: target.targetId,
			generation: target.generation,
			expiresAt:
				Date.now() +
				Math.min(Math.max(Number(ttlMs) || this.ttlMs, 1), 10 * 60_000),
		};
		this.leases.set(lease.leaseId, lease);
		this.activeByKey.set(key, lease.leaseId);
		return this.publicLease(lease);
	}

	createTarget(provider, sessionId) {
		const target = {
			targetId: `${provider}-${randomUUID()}`,
			provider,
			sessionId,
			generation: this.browserGeneration,
			busy: false,
			dirty: false,
			// CDP identifiers are deliberately internal registry state. They are
			// never included in the IPC lease envelope.
			cdpTargetId: null,
			cdpSessionId: null,
			idleSince: null,
		};
		this.targets.set(target.targetId, target);
		return target;
	}

	publicLease(lease) {
		return {
			leaseId: lease.leaseId,
			targetId: lease.targetId,
			provider: lease.provider,
			generation: lease.generation,
			expiresAt: lease.expiresAt,
			mode: "registry-only",
		};
	}

	activeCount() {
		return this.leases.size;
	}
	providerActive(provider) {
		return [...this.leases.values()].filter(
			(lease) => lease.provider === provider,
		).length;
	}

	findLease({ clientId, sessionId, capability, leaseId, targetId, generation }) {
		this.assertClient({ clientId, sessionId, capability });
		const lease = this.leases.get(leaseId);
		if (!lease) throw new BrokerError("lease_not_found", "Lease does not exist");
		if (
			lease.clientId !== clientId ||
			lease.capability !== capability ||
			lease.sessionId !== sessionId
		)
			throw new BrokerError("lease_owner", "Lease belongs to another connection");
		if (targetId !== undefined && targetId !== lease.targetId)
			throw new BrokerError(
				"target_mismatch",
				"targetId does not match the lease",
			);
		if (
			(generation !== undefined && generation !== lease.generation) ||
			lease.generation !== this.browserGeneration
		)
			throw new BrokerError(
				"stale_generation",
				"Target belongs to an old browser generation",
				{
					targetId: lease.targetId,
					leaseGeneration: lease.generation,
					currentGeneration: this.browserGeneration,
				},
			);
		return lease;
	}

	release(request) {
		const lease = this.findLease(request);
		this.retireLease(lease, false);
		return { released: true, leaseId: lease.leaseId, targetId: lease.targetId };
	}

	heartbeat(request) {
		const client = this.assertClient(request);
		const now = Date.now();
		if (!request.leaseId) {
			let renewed = 0;
			for (const lease of this.leases.values()) {
				if (
					lease.clientId !== client.clientId ||
					lease.sessionId !== client.sessionId ||
					lease.capability !== client.capability ||
					lease.generation !== this.browserGeneration
				)
					continue;
				lease.expiresAt = now + this.ttlMs;
				renewed++;
			}
			return { renewed, clientId: client.clientId, at: now };
		}
		const lease = this.findLease(request);
		lease.expiresAt = now + this.ttlMs;
		return { renewed: 1, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
	}

	retireLease(lease, dirty = false) {
		this.leases.delete(lease.leaseId);
		if (this.activeByKey.get(lease.key) === lease.leaseId)
			this.activeByKey.delete(lease.key);
		const target = this.targets.get(lease.targetId);
		if (target) {
			target.busy = false;
			if (dirty || target.generation !== this.browserGeneration)
				this.targets.delete(target.targetId);
			else target.idleSince = Date.now();
		}
		this.drain(lease.key);
	}

	cancelLease(leaseId) {
		const lease = this.leases.get(leaseId);
		if (lease) this.retireLease(lease, true);
	}

	drain(key) {
		if (this.activeByKey.has(key)) return;
		const queue = this.waiters.get(key);
		if (!queue?.length) return;
		const waiter = queue.shift();
		if (!queue.length) this.waiters.delete(key);
		if (waiter.settled) return this.drain(key);
		try {
			void this.lease(waiter).then(
				(lease) => this.finishWaiter(waiter, undefined, lease),
				(error) => this.finishWaiter(waiter, error),
			);
		} catch (error) {
			this.finishWaiter(waiter, error);
		}
	}

	disconnect(identity) {
		if (typeof identity === "string") identity = { clientId: identity };
		const client = this.clients.get(identity?.clientId);
		if (!client) return { released: 0 };
		if (identity.capability && client.capability !== identity.capability)
			return { released: 0 };
		let released = 0;
		for (const [key, queue] of this.waiters) {
			for (const waiter of [...queue]) {
				if (
					waiter.clientId !== client.clientId ||
					waiter.capability !== client.capability
				)
					continue;
				this.removeWaiter(key, waiter);
				this.finishWaiter(
					waiter,
					new BrokerError("request_fenced", "Client disconnected"),
				);
			}
		}
		for (const lease of [...this.leases.values()]) {
			if (
				lease.clientId === client.clientId &&
				lease.capability === client.capability
			) {
				this.retireLease(lease, true);
				released++;
			}
		}
		// A released warm target is safe only while its owning session remains
		// registered. Remove idle targets when the session disconnects so a later
		// client cannot inherit its page state by reusing the same session ID.
		for (const [targetId, target] of this.targets) {
			if (target.sessionId === client.sessionId) this.targets.delete(targetId);
		}
		this.clients.delete(client.clientId);
		if (this.sessions.get(client.sessionId) === client.clientId)
			this.sessions.delete(client.sessionId);
		return { released };
	}

	close(identity) {
		return this.disconnect(identity);
	}

	bumpBrowserGeneration() {
		this.browserGeneration++;
		for (const lease of [...this.leases.values()]) this.retireLease(lease, true);
		for (const [id, target] of this.targets)
			if (target.generation !== this.browserGeneration) this.targets.delete(id);
		return { generation: this.browserGeneration };
	}

	sweep(now = Date.now()) {
		const expired = [];
		for (const lease of [...this.leases.values()])
			if (lease.expiresAt <= now) {
				expired.push(lease.leaseId);
				this.retireLease(lease, true);
			}
		for (const client of [...this.clients.values()])
			if (client.lastHeartbeat + this.orphanTtlMs <= now)
				this.disconnect({
					clientId: client.clientId,
					capability: client.capability,
				});
		const evictedTargets = [];
		for (const [targetId, target] of this.targets) {
			if (
				!target.busy &&
				target.idleSince &&
				target.idleSince + this.idleTargetTtlMs <= now
			) {
				this.targets.delete(targetId);
				evictedTargets.push(targetId);
			}
		}
		return { expiredLeases: expired, evictedTargets };
	}

	snapshot() {
		return {
			generation: this.browserGeneration,
			clients: this.clients.size,
			active: this.activeCount(),
			targets: this.targets.size,
			globalCap: this.globalCap,
			providers: Object.fromEntries(
				Object.entries(this.providerCaps).map(([provider, cap]) => [
					provider,
					{ active: this.providerActive(provider), cap },
				]),
			),
			leases: [...this.leases.values()].map((lease) => this.publicLease(lease)),
		};
	}
}

async function validateProfileCdpPort(profileKey, expectedPort) {
	const activePortPath = join(profileKey, "DevToolsActivePort");
	let content;
	try {
		content = await readFile(activePortPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw new BrokerError(
			"cdp_profile_mismatch",
			"The Chrome profile DevToolsActivePort file could not be read",
		);
	}
	const port = Number.parseInt(String(content).split(/\r?\n/, 1)[0], 10);
	if (!Number.isInteger(port) || port !== expectedPort)
		throw new BrokerError(
			"cdp_profile_mismatch",
			"Chrome profile is active on a different DevTools port",
			{ expectedPort, actualPort: Number.isInteger(port) ? port : null },
		);
}

async function endpointIsAlive(socketPath) {
	return new Promise((resolveResult) => {
		const socket = net.createConnection(socketPath);
		let settled = false;
		const finish = (alive) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolveResult(alive);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		setTimeout(() => finish(true), 250).unref?.();
	});
}

export class GoogleCdpBroker {
	constructor(options = {}) {
		const paths =
			options.profileKey && options.lockPath && options.socketPath
				? options
				: { ...brokerPaths(options.profileDir), ...options };
		this.profileKey = paths.profileKey;
		this.lockPath = paths.lockPath;
		this.socketPath = paths.socketPath;
		this.maxFrameBytes = Math.min(
			Math.max(options.maxFrameBytes || MAX_FRAME_BYTES, 1024),
			MAX_FRAME_BYTES,
		);
		this.maxInFlight = Math.min(
			Math.max(options.maxInFlight || MAX_IN_FLIGHT_REQUESTS, 1),
			MAX_IN_FLIGHT_REQUESTS,
		);
		this.maxIdHistory = Math.min(
			Math.max(options.maxIdHistory || MAX_REQUEST_ID_HISTORY, 1),
			MAX_REQUEST_ID_HISTORY,
		);
		this.registry = options.registry || new LeaseRegistry(options);
		this.ownerNonce = randomUUID();
		// Crash-orphan recovery (#95 P2 item 2): this instance's marker nonce
		// and profile hash identify which Chrome targets belong to THIS broker
		// generation. Targets carrying a different nonce for the same profile
		// hash were orphaned by a hard crash of a prior broker process.
		this.brokerNonce = randomUUID();
		this.brokerProfileHash = profileHash(
			platform() === "win32" ? this.profileKey.toLowerCase() : this.profileKey,
		);
		this.targetMarker = targetMarkerUrl(this.brokerProfileHash, this.brokerNonce);
		this.connections = new Set();
		this.started = false;
		this.server = null;
		this.lock = null;
		this.endpointOwned = false;
		this.sweepTimer = null;
		this.cdpPort = Number(options.cdpPort || 9222);
		this.cdp = {
			connected: false,
			explicit: options.connectCdp === true,
			generation: this.registry.browserGeneration,
			port: this.cdpPort,
			browser: null,
		};
		this.cdpTransport =
			options.cdpTransport ||
			(options.connectCdp === true
				? new BrowserCdpTransport({ port: this.cdpPort })
				: null);
		this.cdpTargets = new Map();
		this.cdpTargetCloseRetries = new Map();
		this.cdpTargetClosePromises = new Map();
		this.runtimeError = null;
		this.lifecycle = Promise.resolve();
	}

	start() {
		return this.serializeLifecycle(() => this.startInternal());
	}
	stop() {
		return this.serializeLifecycle(() => this.stopInternal());
	}
	serializeLifecycle(action) {
		const result = this.lifecycle.catch(() => {}).then(action);
		this.lifecycle = result.catch(() => {});
		return result;
	}

	attachCdpTransport() {
		if (!this.cdpTransport || this.cdpTransportAttached) return;
		this.cdpTransportAttached = true;
		this.cdpTransport.on?.("close", (error) => this.handleCdpLoss(error));
		this.cdpTransport.on?.("socketError", (error) => {
			this.runtimeError = errorInfo(error);
		});
	}

	handleCdpLoss(error) {
		if (!this.cdp.explicit || !this.cdp.connected) return;
		this.cdp.connected = false;
		this.cdp.generation = this.registry.bumpBrowserGeneration().generation;
		this.cdpTargets.clear();
		this.cdpTargetCloseRetries.clear();
		this.cdpTargetClosePromises.clear();
		if (error) this.runtimeError = errorInfo(error);
	}

	async cdpSend(method, params, request, signal, sessionId = undefined) {
		if (!this.cdpTransport || !this.cdp.connected)
			throw new BrokerError("cdp_disconnected", "CDP browser is disconnected");
		checkSignal(signal);
		try {
			return await this.cdpTransport.send(method, params, {
				sessionId,
				signal,
				deadlineAt: request?.deadlineAt,
			});
		} catch (error) {
			if (signal?.aborted)
				throw new BrokerError("request_fenced", "Request was cancelled");
			throw error;
		}
	}

	async closeCdpTarget(target, request = undefined) {
		if (!target?.cdpTargetId) return;
		const targetId = target.cdpTargetId;
		const existing = this.cdpTargetClosePromises.get(targetId);
		if (existing) return existing;
		const promise = this.closeCdpTargetAttempt(target, request);
		this.cdpTargetClosePromises.set(targetId, promise);
		try {
			await promise;
		} finally {
			if (this.cdpTargetClosePromises.get(targetId) === promise)
				this.cdpTargetClosePromises.delete(targetId);
		}
	}

	async closeCdpTargetAttempt(target, request = undefined) {
		if (!target?.cdpTargetId) return;
		const targetId = target.cdpTargetId;
		const generation = this.cdp.generation;
		const isCurrentCdp = () =>
			this.cdp.connected && this.cdp.generation === generation;
		if (!isCurrentCdp()) {
			// Browser loss clears the in-memory map in handleCdpLoss(); if the
			// transport is already unavailable here, there is no live CDP target
			// left that a later sweep could close.
			target.cdpTargetId = null;
			target.cdpSessionId = null;
			this.cdpTargets.delete(target.targetId);
			this.cdpTargetCloseRetries.delete(targetId);
			return;
		}
		try {
			await this.cdpTransport.send(
				"Target.closeTarget",
				{ targetId },
				{
					deadlineAt: boundedCleanupDeadline(request),
				},
			);
			// A response from a previous browser generation must not mutate the
			// state of a newly connected browser. The old target ID is invalid
			// after CDP loss, so clear it from the lease object but do not touch
			// the new generation's maps.
			if (!isCurrentCdp()) {
				target.cdpTargetId = null;
				target.cdpSessionId = null;
				return;
			}
			// Only forget the target after CDP confirms the close. A failed close
			// remains tracked so the next bounded sweep can retry it.
			target.cdpTargetId = null;
			target.cdpSessionId = null;
			this.cdpTargets.delete(target.targetId);
			this.cdpTargetCloseRetries.delete(targetId);
		} catch {
			if (!isCurrentCdp()) {
				target.cdpTargetId = null;
				target.cdpSessionId = null;
				return;
			}
			// Keep the target tracked for a later retry. Backoff prevents a
			// permanently failing close from consuming every sweep tick.
			const previous = this.cdpTargetCloseRetries.get(targetId);
			const attempts = (previous?.attempts ?? 0) + 1;
			if (attempts >= CDP_CLOSE_CONFIRM_AFTER_ATTEMPTS) {
				try {
					const result = await this.cdpTransport.send(
						"Target.getTargets",
						{},
						{ deadlineAt: boundedCleanupDeadline(request) },
					);
					if (!isCurrentCdp()) {
						target.cdpTargetId = null;
						target.cdpSessionId = null;
						return;
					}
					if (!Array.isArray(result?.targetInfos))
						throw new Error("Target enumeration response was malformed");
					const stillPresent = result.targetInfos.some(
						(info) => info?.targetId === targetId,
					);
					if (!stillPresent) {
						target.cdpTargetId = null;
						target.cdpSessionId = null;
						this.cdpTargets.delete(target.targetId);
						this.cdpTargetCloseRetries.delete(targetId);
						return;
					}
				} catch {
					// Keep the record when confirmation is unavailable; a later
					// bounded retry may still close the live target.
				}
			}
			const delay = Math.min(
				CDP_CLOSE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10),
				CDP_CLOSE_RETRY_MAX_MS,
			);
			this.cdpTargetCloseRetries.set(targetId, {
				attempts,
				nextRetryAt: Date.now() + delay,
			});
		}
	}

	async verifyCdpLocation(target, expected, request, signal, description) {
		const deadlineAt =
			request?.deadlineAt ?? Date.now() + DEFAULT_SEARCH_TIMEOUT_MS;
		while (Date.now() < deadlineAt) {
			checkSignal(signal);
			const evaluation = await this.cdpSend(
				"Runtime.evaluate",
				{ expression: "location.href", returnByValue: true },
				{ ...request, deadlineAt },
				signal,
				target.cdpSessionId,
			);
			if (evaluation?.exceptionDetails)
				throw new BrokerError(
					"cdp_protocol",
					`${description} location check failed`,
				);
			if (expected(evaluationString(evaluation))) return;
			await waitForSearchPoll(signal, deadlineAt);
		}
		throw new BrokerError(
			"reset_failed",
			`${description} did not reach the expected location`,
		);
	}

	async resetCdpTarget(target, request, signal) {
		if (!target?.cdpSessionId)
			throw new BrokerError(
				"target_unavailable",
				"Lease has no attached CDP target",
			);
		const resetRequest = {
			...request,
			deadlineAt: boundedCleanupDeadline(request),
		};
		const navigation = await this.cdpSend(
			"Page.navigate",
			{ url: "about:blank" },
			resetRequest,
			signal,
			target.cdpSessionId,
		);
		if (navigation?.errorText)
			throw new BrokerError(
				"reset_failed",
				`Target reset failed: ${navigation.errorText}`,
			);
		await this.verifyCdpLocation(
			target,
			(value) => value === "about:blank",
			resetRequest,
			signal,
			"Target reset",
		);
	}

	async attachCdpTarget(target, request, signal) {
		let created;
		try {
			created = await this.cdpSend(
				"Target.createTarget",
				// Marker URL (#95 P2 item 2): the restart sweep closes only
				// marker-owned targets from PRIOR broker generations. A fresh
				// broker never navigates a reused marker target to about:blank
				// before checking it is its own.
				{ url: this.targetMarker },
				request,
				signal,
			);
			if (typeof created?.targetId !== "string" || !created.targetId)
				throw new BrokerError("cdp_protocol", "CDP did not return a target ID");
			target.cdpTargetId = created.targetId;
			const attached = await this.cdpSend(
				"Target.attachToTarget",
				{ targetId: created.targetId, flatten: true },
				request,
				signal,
			);
			if (typeof attached?.sessionId !== "string" || !attached.sessionId)
				throw new BrokerError("cdp_protocol", "CDP did not return a session ID");
			target.cdpSessionId = attached.sessionId;
			this.cdpTargets.set(target.targetId, target);
		} catch (error) {
			await this.closeCdpTarget(target, request);
			throw error;
		}
	}

	publicCdpLease(lease) {
		const result = this.registry.publicLease(lease);
		delete result.targetId;
		result.mode = "cdp";
		return result;
	}

	async acquireCdpLease(lease, request, signal) {
		const internalLease = this.registry.leases.get(lease.leaseId);
		const target =
			internalLease && this.registry.targets.get(internalLease.targetId);
		if (!internalLease || !target)
			throw new BrokerError("target_unavailable", "Lease target is unavailable");
		try {
			if (target.cdpSessionId) await this.resetCdpTarget(target, request, signal);
			else await this.attachCdpTarget(target, request, signal);
			checkSignal(signal);
			return this.publicCdpLease(internalLease);
		} catch (error) {
			this.registry.cancelLease(internalLease.leaseId);
			await this.closeCdpTarget(target, request);
			throw error;
		}
	}

	async releaseCdpLease(request, identity, signal) {
		if (request.targetId !== undefined)
			throw new BrokerError(
				"invalid_request",
				"CDP target IDs are private to the broker",
			);
		const lease = this.registry.findLease({ ...request, ...identity });
		const target = this.registry.targets.get(lease.targetId);
		try {
			await this.resetCdpTarget(target, request, signal);
			const result = this.registry.release({ ...request, ...identity });
			return { released: true, leaseId: result.leaseId };
		} catch (error) {
			this.registry.retireLease(lease, true);
			await this.closeCdpTarget(target, request);
			throw error;
		}
	}

	async extractGoogleSearchResults(
		request,
		sessionId,
		maxResults,
		signal,
		pageDeadlineAt,
	) {
		const deadlineAt =
			pageDeadlineAt ||
			request.deadlineAt ||
			Date.now() + DEFAULT_SEARCH_TIMEOUT_MS;
		// Return once we have a substantial result set. Requiring a minimum
		// (matching the legacy extractor's `>= 3` gate) avoids returning a
		// partial mid-render snapshot (e.g. 1 of 5 results). If the page
		// never reaches the minimum, fall back to the last observed set at
		// the deadline rather than throwing.
		const minResults = Math.min(Math.max(maxResults ?? 3, 1), 3);
		let lastResults = [];
		while (Date.now() < deadlineAt) {
			checkSignal(signal);
			const evaluation = await this.cdpSend(
				"Runtime.evaluate",
				{
					expression: GOOGLE_SEARCH_EXTRACTION_SCRIPT,
					returnByValue: true,
				},
				request,
				signal,
				sessionId,
			);
			if (evaluation?.exceptionDetails)
				throw new BrokerError(
					"search_extraction_failed",
					"Google result extraction failed",
				);
			const value = searchEvaluationValue(evaluation);
			const results = Array.isArray(value?.results)
				? value.results
						.filter(
							(result) =>
								typeof result?.title === "string" &&
								result.title.length > 0 &&
								typeof result?.url === "string" &&
								(result.url.startsWith("http://") ||
									result.url.startsWith("https://")) &&
								typeof result?.snippet === "string",
						)
						.slice(0, maxResults)
				: [];
			if (results.length > 0) lastResults = results;
			if (results.length >= minResults) return results;
			if (Date.now() >= deadlineAt) break;
			await waitForSearchPoll(signal, deadlineAt);
		}
		checkSignal(signal);
		// Deadline reached: return the best set observed (even a partial one)
		// rather than failing the whole search.
		if (lastResults.length > 0) return lastResults;
		throw new BrokerError(
			"search_timeout",
			"Google search results were not ready before the deadline",
		);
	}

	// Google ignores `num` and renders only ~8-10 organics per SERP page, so
	// a single navigation can never satisfy maxResults > page size. This
	// paginates through ?start=10, ?start=20, … (the same mechanism Google's
	// own "Next" links use), merging and URL-deduping pages until maxResults
	// is reached, the SERP runs out of new organics, or the search deadline
	// is exhausted. Every extra page is budget-fenced: a page is only
	// attempted when at least GOOGLE_PAGE_BUDGET_FLOOR_MS of deadline remains,
	// and each page's extraction is individually bounded so a sparse last
	// page cannot burn the whole search. Page 1 is assumed already navigated
	// (searchGoogle's navigationMs phase); only pages >= 2 are navigated here.
	//
	// Failure semantics: page-1 errors propagate (a genuine total failure —
	// no results were ever observed). A page-2+ failure (navigation error,
	// location-verification failure, or an empty/blank tail page whose
	// extraction throws search_timeout) must NOT discard the results already
	// in hand: it degrades to the merged set and sets `degraded: true` so
	// callers can distinguish a full SERP from an interrupted one.
	async extractGoogleSearchResultsPaginated(
		request,
		target,
		query,
		maxResults,
		signal,
	) {
		const sessionId = target.cdpSessionId;
		const deadlineAt =
			request.deadlineAt || Date.now() + DEFAULT_SEARCH_TIMEOUT_MS;
		const merged = [];
		const seenUrls = new Set();
		let degraded = false;
		let start = 0;
		while (true) {
			checkSignal(signal);
			if (start > 0 && deadlineAt - Date.now() < GOOGLE_PAGE_BUDGET_FLOOR_MS)
				break;
			if (start > 0) {
				const pageUrl = canonicalGoogleSearchUrl(query, maxResults, start);
				try {
					const navigation = await this.cdpSend(
						"Page.navigate",
						{ url: pageUrl },
						request,
						signal,
						sessionId,
					);
					if (navigation?.errorText)
						throw new BrokerError(
							"navigation_failed",
							`Google page ${start} navigation failed: ${navigation.errorText}`,
						);
					await this.verifyCdpLocation(
						target,
						(value) => isGoogleSearchLocation(value, pageUrl),
						request,
						signal,
						`Google search page ${start / GOOGLE_PAGE_STRIDE + 1}`,
					);
				} catch (error) {
					// A page-2+ navigation/verification failure must not abort the
					// search: keep the merged results collected so far.
					degraded = true;
					break;
				}
			}
			let pageResults;
			try {
				pageResults = await this.extractGoogleSearchResults(
					request,
					sessionId,
					maxResults - merged.length,
					signal,
					// Page 1 uses the full search deadline (unchanged behavior);
					// subsequent pages are individually bounded so a sparse last
					// SERP page cannot burn the whole search.
					start === 0
						? undefined
						: Math.min(deadlineAt, Date.now() + GOOGLE_PAGE_EXTRACT_BUDGET_MS),
				);
			} catch (error) {
				// Page 1 extraction failure is a genuine total failure — propagate.
				// A page-2+ extraction failure (typically search_timeout on a
				// blank/empty tail page) means the SERP is exhausted or the page
				// never rendered: degrade to the merged set rather than throwing.
				if (start === 0) throw error;
				degraded = true;
				break;
			}
			let added = 0;
			for (const result of pageResults) {
				if (seenUrls.has(result.url)) continue;
				seenUrls.add(result.url);
				merged.push(result);
				added++;
				if (merged.length >= maxResults) break;
			}
			if (merged.length >= maxResults) break;
			// A page that yielded zero NEW organics means the SERP is exhausted
			// (or a duplicate/redirected page) — do not keep spinning pages.
			if (added === 0) break;
			if (Date.now() >= deadlineAt) break;
			start += GOOGLE_PAGE_STRIDE;
		}
		return { results: merged, degraded };
	}

	async searchGoogle(request, identity, signal) {
		const { query, maxResults } = validateSearchRequest(request);
		if (!this.cdp.explicit)
			throw new BrokerError(
				"cdp_required",
				"Google search requires broker CDP mode",
			);
		checkSignal(signal);
		const canonicalUrl = canonicalGoogleSearchUrl(query, maxResults);
		// Best-effort phase instrumentation. Boundaries: lease/target
		// acquisition -> Page.navigate start -> navigation confirmed ->
		// extraction complete -> reset/release. Each phase records its
		// elapsed time as it settles (even when it throws), and the
		// successful envelope exposes the totals additively as `timings`.
		const timings = {
			targetSetupMs: 0,
			navigationMs: 0,
			extractionMs: 0,
			resetMs: 0,
		};
		const timePhase = async (phase, action) => {
			const started = performance.now();
			try {
				return await action();
			} finally {
				timings[phase] = Math.max(0, performance.now() - started);
			}
		};
		let lease;
		let target;
		try {
			await timePhase("targetSetupMs", async () => {
				lease = await this.registry.lease({
					...identity,
					provider: "google-search",
					signal,
				});
				const internalLease = this.registry.leases.get(lease.leaseId);
				target = internalLease && this.registry.targets.get(internalLease.targetId);
				if (!internalLease || !target)
					throw new BrokerError("target_unavailable", "Lease target is unavailable");
				await this.acquireCdpLease(lease, request, signal);
				checkSignal(signal);
			});
			await timePhase("navigationMs", async () => {
				const navigation = await this.cdpSend(
					"Page.navigate",
					{ url: canonicalUrl },
					request,
					signal,
					target.cdpSessionId,
				);
				if (navigation?.errorText)
					throw new BrokerError(
						"navigation_failed",
						`Google navigation failed: ${navigation.errorText}`,
					);
				await this.verifyCdpLocation(
					target,
					(value) => isGoogleSearchLocation(value, canonicalUrl),
					request,
					signal,
					"Google search",
				);
			});
			const { results, degraded } = await timePhase("extractionMs", () =>
				this.extractGoogleSearchResultsPaginated(
					request,
					target,
					query,
					maxResults,
					signal,
				),
			);
			checkSignal(signal);
			await timePhase("resetMs", async () => {
				await this.resetCdpTarget(target, request, signal);
				checkSignal(signal);
				this.registry.release({ ...identity, leaseId: lease.leaseId });
			});
			return {
				query,
				url: canonicalUrl,
				results,
				degraded: degraded || undefined,
				timings,
			};
		} catch (error) {
			if (lease && this.registry.leases.has(lease.leaseId))
				this.registry.retireLease(lease, true);
			if (target) await this.closeCdpTarget(target, request);
			throw error;
		}
	}

	async cleanupCdpTargets() {
		const now = Date.now();
		for (const target of [...this.cdpTargets.values()]) {
			if (this.registry.targets.has(target.targetId)) continue;
			const retry = this.cdpTargetCloseRetries.get(target.cdpTargetId);
			if (retry && retry.nextRetryAt > now) continue;
			await this.closeCdpTarget(target);
		}
	}

	// Crash-orphan target recovery (#95 P2 item 2). After a hard broker
	// death, Chrome keeps the broker-created targets alive (plain marker
	// URLs, no owner record). On restart, enumerate all targets and close
	// only marker-owned orphans from PRIOR broker generations: targets whose
	// URL is a pi-webaio-broker marker for this profile but whose nonce is
	// NOT this instance's. Never touches unrelated tabs, targets of other
	// profiles, or this broker's own targets. Best-effort and bounded: a
	// failed close or an unavailable CDP connection is logged and skipped,
	// never fatal.
	async recoverOrphanTargets(request = undefined) {
		if (!this.cdpTransport || !this.cdp.connected) return;
		const deadlineAt = boundedCleanupDeadline(request);
		let targetInfos;
		try {
			const result = await this.cdpTransport.send(
				"Target.getTargets",
				{},
				{ deadlineAt },
			);
			targetInfos = result?.targetInfos;
		} catch {
			// Recovery is best-effort; enumeration failure must not block startup.
			return;
		}
		if (!Array.isArray(targetInfos)) return;
		let closed = 0;
		for (const info of targetInfos) {
			const url = info?.url;
			if (!isBrokerMarkerUrl(url)) continue;
			if (markerProfileHash(url) !== this.brokerProfileHash) continue;
			if (markerNonce(url) === this.brokerNonce) continue;
			const targetId = info?.targetId;
			if (typeof targetId !== "string" || !targetId) continue;
			// Do not close targets this instance already owns (paranoia: a
			// reused generation edge case where a prior sweep attached first).
			if ([...this.cdpTargets.values()].some((t) => t.cdpTargetId === targetId))
				continue;
			try {
				await this.cdpTransport.send(
					"Target.closeTarget",
					{ targetId },
					{ deadlineAt },
				);
				closed++;
			} catch {
				// Best-effort: a close failure must not abort the sweep.
			}
		}
		if (closed > 0) this.runtimeError = null; // normal recovery, not an error
		return closed;
	}

	async startInternal() {
		if (this.started) return ok(this.info());
		let lock;
		try {
			lock = await claimStartupLock({
				lockPath: this.lockPath,
				socketPath: this.socketPath,
				profileKey: this.profileKey,
				ownerNonce: this.ownerNonce,
			});
		} catch (error) {
			return fail(error);
		}
		if (!lock.ok) return lock;
		this.lock = lock;
		try {
			if (this.cdp.explicit) {
				if (!this.cdpTransport)
					throw new BrokerError("cdp_unavailable", "CDP transport is unavailable");
				await validateProfileCdpPort(this.profileKey, this.cdpPort);
				this.attachCdpTransport();
				const cdpInfo = await this.cdpTransport.connect();
				this.cdp = {
					...this.cdp,
					...cdpInfo,
					connected: true,
					generation: this.registry.browserGeneration,
				};
				// Crash-orphan recovery (#95 P2 item 2): close marker-owned
				// targets from prior broker generations now that CDP is up.
				// Bounded and best-effort; must not delay startup meaningfully.
				await this.recoverOrphanTargets();
			}
			if (platform() !== "win32") {
				let exists = false;
				try {
					exists = (await lstat(this.socketPath)).isSocket();
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
				if (exists) {
					if (await endpointIsAlive(this.socketPath))
						throw new BrokerError(
							"endpoint_in_use",
							"A live broker endpoint already exists",
						);
					await rm(this.socketPath, { force: true });
				}
			}
			this.server = net.createServer((connection) => this.accept(connection));
			let listening = false;
			this.server.on("error", (error) => {
				this.runtimeError = errorInfo(error);
				if (!listening) return;
			});
			await new Promise((resolveListen, rejectListen) => {
				const onError = (error) => {
					this.server?.off("listening", onListening);
					rejectListen(error);
				};
				const onListening = () => {
					listening = true;
					this.server?.off("error", onError);
					resolveListen();
				};
				this.server.once("error", onError);
				this.server.once("listening", onListening);
				this.server.listen(this.socketPath);
			});
			if (platform() === "win32") {
				// Windows named pipes have no equivalent portable mode bit; capability auth is the boundary.
			} else {
				try {
					await chmod(this.socketPath, 0o600);
				} catch {
					/* Unix permission tightening is best effort. */
				}
			}
			this.endpointOwned = true;
			this.started = true;
			this.sweepTimer = setInterval(
				() => {
					try {
						this.registry.sweep();
						void this.cleanupCdpTargets();
					} catch (error) {
						this.runtimeError = errorInfo(error);
					}
				},
				Math.max(250, Math.min(this.registry.ttlMs, 5000)),
			);
			this.sweepTimer.unref?.();
			return ok(this.info());
		} catch (error) {
			await this.stopInternal();
			return fail(error);
		}
	}

	info() {
		const registry = this.registry.snapshot();
		return {
			profileKey: this.profileKey,
			socketPath: this.socketPath,
			ownerNonce: this.ownerNonce,
			protocol: 1,
			cdp: {
				...this.cdp,
				...(this.cdp.explicit && this.cdpTransport?.info
					? { connected: Boolean(this.cdpTransport.info().connected) }
					: {}),
				generation: registry.generation,
			},
			runtimeError: this.runtimeError,
			registry,
		};
	}

	accept(connection) {
		const state = {
			connection,
			buffer: "",
			clientId: null,
			sessionId: null,
			capability: newCapability(),
			closed: false,
			seenIds: new Set(),
			pending: new Map(),
			paused: false,
		};
		this.connections.add(state);
		connection.setNoDelay?.(true);
		const close = () => this.disconnect(state);
		connection.on("data", (chunk) => this.receive(state, chunk));
		connection.on("error", close);
		connection.on("end", close);
		connection.on("close", close);
		connection.on("drain", () => {
			state.paused = false;
			connection.resume?.();
		});
	}

	disconnect(state) {
		if (state.closed) return;
		state.closed = true;
		for (const controller of state.pending.values()) controller.abort();
		state.pending.clear();
		if (state.clientId)
			this.registry.disconnect({
				clientId: state.clientId,
				sessionId: state.sessionId,
				capability: state.capability,
			});
		void this.cleanupCdpTargets();
		this.connections.delete(state);
	}

	write(state, payload) {
		if (state.closed || state.connection.destroyed) return;
		const line = `${JSON.stringify(payload)}\n`;
		if (Buffer.byteLength(line) > this.maxFrameBytes) {
			this.disconnect(state);
			state.connection.destroy(new Error("response frame too large"));
			return;
		}
		try {
			if (!state.connection.write(line)) {
				state.paused = true;
				state.connection.pause?.();
			}
		} catch {
			this.disconnect(state);
		}
	}

	receive(state, chunk) {
		if (state.closed) return;
		state.buffer += chunk.toString("utf8");
		let newline;
		while ((newline = state.buffer.indexOf("\n")) !== -1) {
			const line = state.buffer.slice(0, newline);
			state.buffer = state.buffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") + 1 > this.maxFrameBytes) {
				this.write(state, {
					id: null,
					ok: false,
					error: {
						code: "frame_too_large",
						message: "Request exceeds frame limit",
					},
				});
				continue;
			}
			if (!line.trim()) continue;
			let request;
			try {
				request = JSON.parse(line);
			} catch {
				this.write(state, {
					id: null,
					ok: false,
					error: {
						code: "malformed_json",
						message: "Request is not valid JSON",
					},
				});
				continue;
			}
			void this.dispatch(state, request).catch((error) => {
				this.runtimeError = errorInfo(error);
			});
		}
		if (Buffer.byteLength(state.buffer, "utf8") >= this.maxFrameBytes) {
			this.write(state, {
				id: null,
				ok: false,
				error: {
					code: "frame_too_large",
					message: "Request exceeds frame limit",
				},
			});
			state.buffer = "";
		}
	}

	validateDeadline(request) {
		if (request.deadlineAt === undefined) return;
		if (!Number.isInteger(request.deadlineAt) || request.deadlineAt <= 0)
			throw new BrokerError(
				"invalid_deadline",
				"deadlineAt must be an absolute millisecond timestamp",
			);
		if (request.deadlineAt <= Date.now())
			throw new BrokerError("deadline_expired", "Request deadline has expired");
	}

	async dispatch(state, request) {
		let id = null;
		try {
			id = asRequestId(request?.id);
		} catch (error) {
			this.write(state, { id: null, ok: false, error: errorInfo(error) });
			return;
		}
		if (!request || typeof request !== "object" || Array.isArray(request)) {
			this.write(state, {
				id,
				ok: false,
				error: {
					code: "invalid_request",
					message: "Request must be an object",
				},
			});
			return;
		}
		if (state.seenIds.has(id)) {
			this.write(state, {
				id,
				ok: false,
				error: {
					code: "duplicate_request_id",
					message: "Request id was already used on this connection",
				},
			});
			return;
		}
		if (state.seenIds.size >= this.maxIdHistory) {
			this.write(state, {
				id,
				ok: false,
				error: {
					code: "request_id_history_exhausted",
					message: "Request id history limit reached",
				},
			});
			return;
		}
		state.seenIds.add(id);
		// Cancellation is a control frame, not normal work. It must remain
		// deliverable even when all normal request slots are occupied.
		if (request.op !== "cancel" && state.pending.size >= this.maxInFlight) {
			this.write(state, {
				id,
				ok: false,
				error: {
					code: "in_flight_limit",
					message: "Too many in-flight requests",
				},
			});
			return;
		}
		try {
			this.validateDeadline(request);
		} catch (error) {
			this.write(state, { id, ok: false, error: errorInfo(error) });
			return;
		}
		const controller = new AbortController();
		state.pending.set(id, controller);
		let timer;
		if (request.deadlineAt !== undefined)
			timer = setTimeout(
				() => controller.abort(),
				request.deadlineAt - Date.now(),
			);
		try {
			const response = await this.operation(state, request, controller.signal);
			if (controller.signal.aborted)
				throw new BrokerError(
					"request_fenced",
					"Request completed after its deadline or cancellation",
				);
			if (!state.closed) this.write(state, { id, ...response });
		} catch (error) {
			if (!state.closed) this.write(state, { id, ...fail(error) });
		} finally {
			clearTimeout(timer);
			state.pending.delete(id);
		}
	}

	identityFor(state, request) {
		if (!state.clientId || !state.sessionId)
			throw new BrokerError(
				"not_registered",
				"Register this connection before using broker operations",
			);
		if (request.clientId !== undefined && request.clientId !== state.clientId)
			throw new BrokerError(
				"connection_ownership",
				"clientId does not match this connection",
			);
		if (request.sessionId !== state.sessionId)
			throw new BrokerError(
				"session_mismatch",
				"sessionId must match the registered identity",
			);
		if (request.capability !== state.capability)
			throw new BrokerError("unauthorized", "Broker-bound capability is required");
		return {
			clientId: state.clientId,
			sessionId: state.sessionId,
			capability: state.capability,
		};
	}

	async operation(state, request, signal) {
		const op = request.op;
		if (typeof op !== "string")
			throw new BrokerError("invalid_request", "op is required");
		if (op === "health") return ok(this.info());
		if (op === "register") {
			if (
				state.clientId &&
				(request.clientId !== state.clientId ||
					request.sessionId !== state.sessionId)
			)
				throw new BrokerError(
					"connection_ownership",
					"A connection cannot be re-registered under another identity",
				);
			checkSignal(signal);
			const result = this.registry.register({
				clientId: request.clientId,
				sessionId: request.sessionId,
				capability: state.capability,
			});
			state.clientId = result.clientId;
			state.sessionId = result.sessionId;
			return ok(result);
		}
		const identity = this.identityFor(state, request);
		this.registry.assertClient(identity);
		if (op === "cancel") {
			const requestId = asRequestId(request.requestId);
			if (requestId === request.id)
				throw new BrokerError("invalid_request", "A request cannot cancel itself");
			const pending = state.pending.get(requestId);
			if (!pending) return ok({ cancelled: false, requestId });
			pending.abort();
			return ok({ cancelled: true, requestId });
		}
		checkSignal(signal);
		switch (op) {
			case "search":
				return ok(await this.searchGoogle(request, identity, signal));
			case "lease": {
				let lease;
				try {
					lease = await this.registry.lease({
						...identity,
						provider: request.provider,
						ttlMs: request.ttlMs,
						waitMs: request.waitMs,
						signal,
					});
					checkSignal(signal);
					if (this.cdp.explicit)
						return ok(await this.acquireCdpLease(lease, request, signal));
				} catch (error) {
					if (lease) this.registry.cancelLease(lease.leaseId);
					throw error;
				}
				return ok(lease);
			}
			case "release":
				return ok(
					this.cdp.explicit
						? await this.releaseCdpLease(request, identity, signal)
						: this.registry.release({ ...request, ...identity }),
				);
			case "reset": {
				if (!this.cdp.explicit)
					throw new BrokerError("unsupported_operation", "Reset requires CDP mode");
				if (request.targetId !== undefined)
					throw new BrokerError(
						"invalid_request",
						"CDP target IDs are private to the broker",
					);
				const lease = this.registry.findLease({ ...request, ...identity });
				const target = this.registry.targets.get(lease.targetId);
				try {
					await this.resetCdpTarget(target, request, signal);
				} catch (error) {
					this.registry.retireLease(lease, true);
					await this.closeCdpTarget(target, request);
					throw error;
				}
				return ok({ reset: true, leaseId: lease.leaseId });
			}
			case "heartbeat":
				return ok(this.registry.heartbeat({ ...request, ...identity }));
			case "close": {
				const result = this.registry.close(identity);
				void this.cleanupCdpTargets();
				setImmediate(() => this.disconnect(state));
				return ok(result);
			}
			default:
				throw new BrokerError(
					"unsupported_operation",
					`Unsupported broker operation: ${op}`,
				);
		}
	}

	async stopInternal() {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const state of [...this.connections]) {
			try {
				state.connection.destroy();
			} catch {}
			this.disconnect(state);
		}
		if (this.server)
			await new Promise((resolveClose) => {
				try {
					this.server.close(() => resolveClose());
				} catch {
					resolveClose();
				}
			});
		this.server = null;
		if (this.cdpTransport) {
			try {
				await this.cdpTransport.close();
			} catch (error) {
				this.runtimeError = errorInfo(error);
			}
		}
		this.cdp.connected = false;
		this.cdpTargets.clear();
		this.cdpTargetCloseRetries.clear();
		this.cdpTargetClosePromises.clear();
		this.started = false;
		// Keep the startup lock while removing our endpoint: otherwise a new
		// owner could bind the path between release() and cleanup().
		if (this.endpointOwned && platform() !== "win32") {
			try {
				await rm(this.socketPath, { force: true });
			} catch (error) {
				this.runtimeError = errorInfo(error);
			}
		}
		this.endpointOwned = false;
		if (this.lock) {
			try {
				await this.lock.release();
			} catch (error) {
				this.runtimeError = errorInfo(error);
			}
			this.lock = null;
		}
	}
}

function parseCli(args) {
	const options = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--profile") options.profileDir = args[++i];
		else if (arg === "--socket") options.socketPath = args[++i];
		else if (arg === "--connect-cdp") options.connectCdp = true;
		else if (arg === "--cdp-port") options.cdpPort = Number(args[++i]);
		else if (arg === "--global-cap") options.globalCap = Number(args[++i]);
		else if (arg === "--parent-stdin") options.parentStdin = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new BrokerError("invalid_cli", `Unknown option: ${arg}`);
	}
	const paths = brokerPaths(options.profileDir);
	return { ...paths, ...options };
}

const USAGE = `google-cdp-broker (default Google search lane)\n\nUsage: node bin/google-cdp-broker.mjs [--profile DIR] [--connect-cdp] [--cdp-port PORT] [--parent-stdin]\n\nThe broker does not launch Chrome; --connect-cdp probes an existing dedicated\nChrome. The production wrapper passes --parent-stdin so the broker exits when\nthe parent dies.\n`;

async function main() {
	try {
		const options = parseCli(process.argv.slice(2));
		if (options.help) {
			process.stderr.write(USAGE);
			return;
		}
		const broker = new GoogleCdpBroker(options);
		const result = await broker.start();
		if (!result.ok) {
			process.stderr.write(`${JSON.stringify(result)}\n`);
			process.exitCode = result.error.code === "already_running" ? 2 : 1;
			return;
		}
		process.stderr.write(`Google CDP broker listening at ${broker.socketPath}\n`);
		const shutdown = () => {
			void broker.stop().finally(() => process.exit(0));
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		if (options.parentStdin) {
			// The production wrapper gives the broker a pipe. EOF means the
			// wrapper died; this stops only the broker and never touches Chrome.
			process.stdin.resume();
			process.stdin.once("end", shutdown);
			process.stdin.once("error", shutdown);
		}
	} catch (error) {
		process.stderr.write(`${JSON.stringify(fail(error))}\n`);
		process.exitCode = 1;
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	void main();
