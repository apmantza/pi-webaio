#!/usr/bin/env node

// Opt-in F22 prototype. This broker owns only a narrow lease protocol; it does
// not replace the existing Google extractor and does not launch Chrome.

import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, unlink, stat } from "node:fs/promises";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_FRAME_BYTES = 64 * 1024;
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_ORPHAN_TTL_MS = 15_000;
export const DEFAULT_PROVIDER_CAPS = Object.freeze({
	"google-search": 2,
	"google-ai": 1,
	reddit: 1,
});

const PROFILE_ROOT = join(tmpdir(), "pi-webaio-google-cdp");
const ALLOWED_PROVIDERS = new Set(Object.keys(DEFAULT_PROVIDER_CAPS));

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
	return { code: "internal_error", message: String(error?.message || error) };
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

/** Claim the profile lock with O_EXCL. A live owner is never removed. */
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
	await mkdir(dirname(lockPath), { recursive: true });
	const record = {
		version: 1,
		profileKey,
		socketPath,
		pid,
		ownerNonce,
		startedAt: new Date().toISOString(),
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
			await handle.close();
			return {
				ok: true,
				ownerNonce,
				record,
				async release() {
					try {
						const current = JSON.parse(await readFile(lockPath, "utf8"));
						if (current.ownerNonce === ownerNonce) await unlink(lockPath);
					} catch {
						// The broker may already have been cleaned up after a crash.
					}
				},
			};
		} catch (error) {
			if (error?.code !== "EEXIST")
				return fail(
					new BrokerError("lock_failed", String(error?.message || error)),
				);
			let current;
			try {
				current = JSON.parse(await readFile(lockPath, "utf8"));
			} catch {
				current = undefined;
			}
			let oldEnough = false;
			try {
				oldEnough = Date.now() - (await stat(lockPath)).mtimeMs > staleAfterMs;
			} catch {
				oldEnough = true;
			}
			const live = processIsAlive(current?.pid);
			if (live || !oldEnough) {
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
			try {
				await unlink(lockPath);
			} catch {
				return fail(
					new BrokerError(
						"lock_race",
						"A stale broker lock could not be removed",
					),
				);
			}
		}
	}
	return fail(
		new BrokerError("lock_race", "Broker startup lost the profile lock race"),
	);
}

function targetKey(clientId, sessionId, provider) {
	return `${clientId}\u0000${sessionId}\u0000${provider}`;
}

function checkSignal(signal) {
	if (signal?.aborted)
		throw new BrokerError(
			"request_fenced",
			"Request was cancelled or its client disconnected",
		);
}

export class LeaseRegistry {
	constructor(options = {}) {
		this.globalCap = asPositiveInt(options.globalCap, 4, 64);
		this.providerCaps = {
			...DEFAULT_PROVIDER_CAPS,
			...(options.providerCaps || {}),
		};
		this.ttlMs = asPositiveInt(
			options.ttlMs,
			DEFAULT_LEASE_TTL_MS,
			10 * 60_000,
		);
		this.orphanTtlMs = asPositiveInt(
			options.orphanTtlMs,
			DEFAULT_ORPHAN_TTL_MS,
			10 * 60_000,
		);
		this.clients = new Map();
		this.leases = new Map();
		this.activeByKey = new Map();
		this.targets = new Map();
		this.waiters = new Map();
		this.browserGeneration = 1;
	}

	register({ clientId, sessionId }) {
		clientId = asString(clientId, "clientId");
		sessionId = asString(sessionId, "sessionId");
		const existing = this.clients.get(clientId);
		if (existing && existing.sessionId !== sessionId) {
			throw new BrokerError(
				"client_conflict",
				"clientId is already registered to another session",
			);
		}
		const client = existing || {
			clientId,
			sessionId,
			registeredAt: Date.now(),
		};
		client.lastHeartbeat = Date.now();
		this.clients.set(clientId, client);
		return { clientId, sessionId, heartbeatTtlMs: this.orphanTtlMs };
	}

	assertClient(clientId, sessionId) {
		const client = this.clients.get(clientId);
		if (!client)
			throw new BrokerError(
				"not_registered",
				"Client must register before leasing",
			);
		if (sessionId !== undefined && client.sessionId !== sessionId) {
			throw new BrokerError(
				"session_mismatch",
				"sessionId does not match the registered client",
			);
		}
		client.lastHeartbeat = Date.now();
		return client;
	}

	validateProvider(provider) {
		if (
			!ALLOWED_PROVIDERS.has(provider) ||
			this.providerCaps[provider] === undefined
		) {
			throw new BrokerError(
				"unsupported_provider",
				`Provider is not enabled: ${provider}`,
			);
		}
	}

	async lease({
		clientId,
		sessionId,
		provider,
		ttlMs,
		waitMs = this.ttlMs,
		signal,
	}) {
		checkSignal(signal);
		this.assertClient(clientId, sessionId);
		provider = asString(provider, "provider");
		this.validateProvider(provider);
		const key = targetKey(clientId, sessionId, provider);
		const active = this.activeByKey.get(key);
		if (active) {
			return this.enqueue(
				key,
				{ clientId, sessionId, provider, ttlMs, signal },
				waitMs,
			);
		}
		if (
			this.activeCount() >= this.globalCap ||
			this.providerActive(provider) >= this.providerCaps[provider]
		) {
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
		}
		return this.allocate({ key, clientId, sessionId, provider, ttlMs, signal });
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
					new BrokerError(
						"lease_wait_timeout",
						"The session lease remained busy",
					),
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

	allocate({ key, clientId, sessionId, provider, ttlMs, signal }) {
		checkSignal(signal);
		const target =
			[...this.targets.values()].find(
				(candidate) =>
					candidate.provider === provider &&
					candidate.generation === this.browserGeneration &&
					!candidate.busy &&
					!candidate.dirty,
			) || this.createTarget(provider);
		target.busy = true;
		const leaseId = randomUUID();
		const lease = {
			leaseId,
			key,
			clientId,
			sessionId,
			provider,
			targetId: target.targetId,
			generation: target.generation,
			expiresAt:
				Date.now() +
				Math.min(Math.max(Number(ttlMs) || this.ttlMs, 1), 10 * 60_000),
		};
		this.leases.set(leaseId, lease);
		this.activeByKey.set(key, leaseId);
		return this.publicLease(lease);
	}

	createTarget(provider) {
		const target = {
			targetId: `${provider}-${randomUUID()}`,
			provider,
			generation: this.browserGeneration,
			busy: false,
			dirty: false,
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
			// A real CDP target is deliberately not exposed by this prototype.
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

	findLease({ clientId, leaseId, targetId, generation }) {
		const lease = this.leases.get(leaseId);
		if (!lease)
			throw new BrokerError("lease_not_found", "Lease does not exist");
		if (lease.clientId !== clientId)
			throw new BrokerError("lease_owner", "Lease belongs to another client");
		if (targetId !== lease.targetId)
			throw new BrokerError(
				"target_mismatch",
				"targetId does not match the lease",
			);
		if (
			generation !== lease.generation ||
			lease.generation !== this.browserGeneration
		) {
			throw new BrokerError(
				"stale_generation",
				"Target belongs to an old browser generation",
				{
					targetId: lease.targetId,
					leaseGeneration: lease.generation,
					currentGeneration: this.browserGeneration,
				},
			);
		}
		return lease;
	}

	release(request) {
		const lease = this.leases.get(request.leaseId);
		if (!lease)
			throw new BrokerError("lease_not_found", "Lease does not exist");
		if (lease.clientId !== request.clientId)
			throw new BrokerError("lease_owner", "Lease belongs to another client");
		if (request.targetId !== lease.targetId)
			throw new BrokerError(
				"target_mismatch",
				"targetId does not match the lease",
			);
		const stale =
			request.generation !== lease.generation ||
			lease.generation !== this.browserGeneration;
		this.retireLease(lease, stale);
		if (stale)
			throw new BrokerError(
				"stale_generation",
				"Target belongs to an old browser generation",
				{
					targetId: lease.targetId,
					leaseGeneration: lease.generation,
					currentGeneration: this.browserGeneration,
				},
			);
		return { released: true, leaseId: lease.leaseId, targetId: lease.targetId };
	}

	heartbeat(request) {
		const client = this.assertClient(request.clientId, request.sessionId);
		const now = Date.now();
		if (!request.leaseId) {
			let renewed = 0;
			for (const lease of this.leases.values()) {
				if (lease.clientId !== client.clientId) continue;
				if (lease.generation !== this.browserGeneration) continue;
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
			target.dirty ||= dirty;
		}
		this.drain(lease.key);
	}

	drain(key) {
		if (this.activeByKey.has(key)) return;
		const queue = this.waiters.get(key);
		if (!queue?.length) return;
		const waiter = queue.shift();
		if (!queue.length) this.waiters.delete(key);
		if (waiter.settled) return this.drain(key);
		try {
			const value = this.lease(waiter).then(
				(lease) => this.finishWaiter(waiter, undefined, lease),
				(error) => this.finishWaiter(waiter, error),
			);
			void value;
		} catch (error) {
			this.finishWaiter(waiter, error);
		}
	}

	disconnect(clientId) {
		if (!this.clients.has(clientId)) return { released: 0 };
		let released = 0;
		for (const lease of [...this.leases.values()]) {
			if (lease.clientId === clientId) {
				this.retireLease(lease, true);
				released++;
			}
		}
		for (const [key, queue] of this.waiters) {
			for (const waiter of [...queue]) {
				if (waiter.clientId !== clientId) continue;
				this.removeWaiter(key, waiter);
				this.finishWaiter(
					waiter,
					new BrokerError("request_fenced", "Client disconnected"),
				);
			}
		}
		this.clients.delete(clientId);
		return { released };
	}

	close(clientId) {
		return this.disconnect(clientId);
	}

	bumpBrowserGeneration() {
		this.browserGeneration++;
		return { generation: this.browserGeneration };
	}

	sweep(now = Date.now()) {
		const expired = [];
		for (const lease of [...this.leases.values()]) {
			if (lease.expiresAt <= now) {
				expired.push(lease.leaseId);
				this.retireLease(lease, true);
			}
		}
		for (const [clientId, client] of this.clients) {
			if (client.lastHeartbeat + this.orphanTtlMs <= now)
				this.disconnect(clientId);
		}
		return { expiredLeases: expired };
	}

	snapshot() {
		return {
			generation: this.browserGeneration,
			clients: this.clients.size,
			active: this.activeCount(),
			globalCap: this.globalCap,
			providers: Object.fromEntries(
				Object.entries(this.providerCaps).map(([provider, cap]) => [
					provider,
					{
						active: this.providerActive(provider),
						cap,
					},
				]),
			),
			leases: [...this.leases.values()].map((lease) => this.publicLease(lease)),
		};
	}
}

async function probeExistingCdp(port, timeoutMs = 1500) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: controller.signal,
		});
		if (!response.ok)
			throw new BrokerError(
				"cdp_unavailable",
				`CDP returned HTTP ${response.status}`,
			);
		const version = await response.json();
		if (typeof version?.webSocketDebuggerUrl !== "string")
			throw new BrokerError(
				"cdp_invalid",
				"CDP version response has no WebSocket URL",
			);
		return { connected: true, port, browser: version.Browser || null };
	} catch (error) {
		return { connected: false, port, error: errorInfo(error) };
	} finally {
		clearTimeout(timer);
	}
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
		this.registry = options.registry || new LeaseRegistry(options);
		this.ownerNonce = randomUUID();
		this.connections = new Set();
		this.started = false;
		this.server = null;
		this.lock = null;
		this.sweepTimer = null;
		this.cdp = { connected: false, explicit: options.connectCdp === true };
		this.cdpPort = Number(options.cdpPort || 9222);
	}

	async start() {
		if (this.started) return ok(this.info());
		const lock = await claimStartupLock({
			lockPath: this.lockPath,
			socketPath: this.socketPath,
			profileKey: this.profileKey,
			ownerNonce: this.ownerNonce,
		});
		if (!lock.ok) return lock;
		this.lock = lock;
		try {
			if (platform() !== "win32") {
				try {
					if (
						existsSync(this.socketPath) &&
						lstatSync(this.socketPath).isSocket()
					)
						unlinkSync(this.socketPath);
				} catch (error) {
					throw new BrokerError(
						"socket_prepare_failed",
						String(error?.message || error),
					);
				}
			}
			this.server = net.createServer((connection) => this.accept(connection));
			this.server.on("error", () => {});
			await new Promise((resolveListen, rejectListen) => {
				const onError = (error) => {
					this.server?.off("listening", onListening);
					rejectListen(error);
				};
				const onListening = () => {
					this.server?.off("error", onError);
					resolveListen();
				};
				this.server.once("error", onError);
				this.server.once("listening", onListening);
				this.server.listen(this.socketPath);
			});
			this.started = true;
			this.sweepTimer = setInterval(
				() => {
					try {
						this.registry.sweep();
					} catch {
						/* cleanup is fail-soft */
					}
				},
				Math.max(250, Math.min(this.registry.ttlMs, 5000)),
			);
			this.sweepTimer.unref?.();
			if (this.cdp.explicit) this.cdp = await probeExistingCdp(this.cdpPort);
			return ok(this.info());
		} catch (error) {
			await this.stop();
			return fail(error);
		}
	}

	info() {
		return {
			profileKey: this.profileKey,
			socketPath: this.socketPath,
			ownerNonce: this.ownerNonce,
			protocol: 1,
			cdp: this.cdp,
			registry: this.registry.snapshot(),
		};
	}

	accept(connection) {
		const state = {
			connection,
			buffer: "",
			clientId: null,
			closed: false,
			seenIds: new Set(),
			pending: new Map(),
		};
		this.connections.add(state);
		connection.setNoDelay?.(true);
		const close = () => this.disconnect(state);
		connection.on("data", (chunk) => this.receive(state, chunk));
		connection.on("error", close);
		connection.on("end", close);
		connection.on("close", close);
	}

	disconnect(state) {
		if (state.closed) return;
		state.closed = true;
		for (const controller of state.pending.values()) controller.abort();
		state.pending.clear();
		if (state.clientId) this.registry.disconnect(state.clientId);
		this.connections.delete(state);
	}

	write(state, payload) {
		if (state.closed || state.connection.destroyed) return;
		const line = `${JSON.stringify(payload)}\n`;
		if (Buffer.byteLength(line) > this.maxFrameBytes) {
			state.connection.destroy(
				new BrokerError(
					"frame_too_large",
					"Broker response exceeds frame limit",
				),
			);
			return;
		}
		try {
			state.connection.write(line);
		} catch {
			this.disconnect(state);
		}
	}

	receive(state, chunk) {
		if (state.closed) return;
		state.buffer += chunk.toString("utf8");
		if (Buffer.byteLength(state.buffer) > this.maxFrameBytes) {
			this.write(state, {
				id: null,
				ok: false,
				error: {
					code: "frame_too_large",
					message: "Request exceeds frame limit",
				},
			});
			state.connection.destroy();
			return;
		}
		const lines = state.buffer.split("\n");
		state.buffer = lines.pop() || "";
		for (const line of lines) {
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
			void this.dispatch(state, request).catch(() => {
				// dispatch always converts failures; this is a final promise fence.
			});
		}
	}

	async dispatch(state, request) {
		const id =
			request &&
			(typeof request.id === "string" || typeof request.id === "number")
				? request.id
				: null;
		if (id === null || typeof request !== "object" || Array.isArray(request)) {
			this.write(state, {
				id,
				ok: false,
				error: {
					code: "invalid_request",
					message: "Request object needs a string or numeric id",
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
		state.seenIds.add(id);
		const controller = new AbortController();
		state.pending.set(id, controller);
		let response;
		try {
			response = await this.operation(state, request, controller.signal);
			if (!state.closed) this.write(state, { id, ...response });
		} catch (error) {
			if (!state.closed) this.write(state, { id, ...fail(error) });
		} finally {
			state.pending.delete(id);
		}
	}

	async operation(state, request, signal) {
		const op = request.op;
		if (typeof op !== "string")
			throw new BrokerError("invalid_request", "op is required");
		if (op === "health") return ok(this.info());
		if (op === "register") {
			const result = this.registry.register({
				clientId: request.clientId,
				sessionId: request.sessionId,
			});
			state.clientId = result.clientId;
			return ok(result);
		}
		if (
			!state.clientId ||
			(request.clientId !== undefined && request.clientId !== state.clientId)
		) {
			throw new BrokerError(
				"not_registered",
				"Register this connection before using broker operations",
			);
		}
		checkSignal(signal);
		switch (op) {
			case "lease": {
				const result = await this.registry.lease({
					clientId: state.clientId,
					sessionId: request.sessionId,
					provider: request.provider,
					ttlMs: request.ttlMs,
					waitMs: request.waitMs,
					signal,
				});
				checkSignal(signal);
				return ok(result);
			}
			case "release":
				return ok(
					this.registry.release({ ...request, clientId: state.clientId }),
				);
			case "heartbeat":
				return ok(
					this.registry.heartbeat({ ...request, clientId: state.clientId }),
				);
			case "close":
				return ok(this.registry.close(state.clientId));
			default:
				throw new BrokerError(
					"unsupported_operation",
					`Unsupported broker operation: ${op}`,
				);
		}
	}

	async stop() {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const state of [...this.connections]) {
			try {
				state.connection.destroy();
			} catch {}
			this.disconnect(state);
		}
		if (this.server) {
			await new Promise((resolveClose) => {
				try {
					this.server.close(() => resolveClose());
				} catch {
					resolveClose();
				}
			});
		}
		this.server = null;
		this.started = false;
		if (this.lock) await this.lock.release();
		this.lock = null;
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
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new BrokerError("invalid_cli", `Unknown option: ${arg}`);
	}
	const paths = brokerPaths(options.profileDir);
	return { ...paths, ...options };
}

const USAGE = `google-cdp-broker (F22 prototype, registry-only by default)\n\nUsage: node bin/google-cdp-broker.mjs [--profile DIR] [--connect-cdp] [--cdp-port PORT]\n\nThe broker does not launch Chrome. --connect-cdp only probes an existing\ndedicated Chrome; no production Google path uses this prototype.\n`;

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
		process.stderr.write(
			`Google CDP broker listening at ${broker.socketPath}\n`,
		);
		const shutdown = () => {
			void broker.stop().finally(() => process.exit(0));
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	} catch (error) {
		process.stderr.write(`${JSON.stringify(fail(error))}\n`);
		process.exitCode = 1;
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	void main();
}
