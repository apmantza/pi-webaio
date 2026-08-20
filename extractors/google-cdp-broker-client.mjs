#!/usr/bin/env node

// Narrow Google CDP broker client. The broker capability is deliberately kept
// in this process only; callers can submit high-level searches, never CDP.

import { randomUUID } from "node:crypto";
import net from "node:net";
import { brokerPaths } from "../bin/google-cdp-broker.mjs";
// Re-exported for the google-ai BrokerModule seam (loadBrokerModule), which
// resolves the socket path before connecting.
export { brokerPaths };

export const BROKER_CLIENT_PROTOCOL = 1;
export const BROKER_CLIENT_DEFAULT_TIMEOUT_MS = 1_500;
export const BROKER_CLIENT_MAX_FRAME_BYTES = 64 * 1024;

const PROCESS_SESSION_NONCE = randomUUID();
const CLIENT_ID = `pi-webaio-${process.pid}-${PROCESS_SESSION_NONCE}`;
const SESSION_ID = `pi-webaio-session-${PROCESS_SESSION_NONCE}`;

export class GoogleCdpBrokerClientError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = "GoogleCdpBrokerClientError";
		this.code = code;
		this.details = details;
	}
}

function deadlineFor(deadlineAt, timeoutMs) {
	const deadline = deadlineAt ?? Date.now() + timeoutMs;
	if (!Number.isInteger(deadline) || deadline <= Date.now())
		throw new GoogleCdpBrokerClientError(
			"deadline_expired",
			"Broker request deadline has expired",
		);
	return deadline;
}

function fencedError(message = "Broker request was cancelled") {
	return new GoogleCdpBrokerClientError("request_fenced", message);
}

function asFrame(request) {
	const frame = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(frame, "utf8") > BROKER_CLIENT_MAX_FRAME_BYTES)
		throw new GoogleCdpBrokerClientError(
			"frame_too_large",
			"Broker request exceeds the frame limit",
		);
	return frame;
}

function brokerError(response) {
	return new GoogleCdpBrokerClientError(
		response?.error?.code || "broker_error",
		response?.error?.message || "Broker request failed",
		response?.error?.details,
	);
}

function connectSocket(socketPath) {
	return net.createConnection(socketPath);
}

/**
 * Connect to an already-running broker and register once. The returned object
 * intentionally exposes only `search` and `close`; raw broker/CDP operations
 * are not part of the client seam.
 */
export async function connectGoogleCdpBroker({
	profileDir,
	socketPath = brokerPaths(profileDir).socketPath,
	connectImpl = connectSocket,
	deadlineAt,
	timeoutMs = BROKER_CLIENT_DEFAULT_TIMEOUT_MS,
	signal,
} = {}) {
	const client = new GoogleCdpBrokerClient({
		socketPath,
		connectImpl,
		deadlineAt,
		timeoutMs,
	});
	await client.connect({ signal });
	return client;
}

export class GoogleCdpBrokerClient {
	constructor({
		socketPath,
		connectImpl = connectSocket,
		deadlineAt,
		timeoutMs = BROKER_CLIENT_DEFAULT_TIMEOUT_MS,
	} = {}) {
		if (typeof socketPath !== "string" || socketPath.length === 0)
			throw new GoogleCdpBrokerClientError(
				"invalid_endpoint",
				"Broker endpoint is invalid",
			);
		this.socketPath = socketPath;
		this.connectImpl = connectImpl;
		this.deadlineAt = deadlineAt;
		this.timeoutMs = timeoutMs;
		this.socket = null;
		this.connected = false;
		this.registered = false;
		this.capability = null;
		this.nextId = 1;
		this.buffer = "";
		this.pending = new Map();
		this.closed = false;
		this.connectPromise = null;
		this.socketGeneration = 0;
		this.heartbeatTimer = null;
	}

	identity() {
		// Useful for diagnostics/tests without returning the capability.
		return { clientId: CLIENT_ID, sessionId: SESSION_ID };
	}

	async connect({ signal, deadlineAt = this.deadlineAt } = {}) {
		if (this.registered) return this;
		if (this.connectPromise) return this.connectPromise;
		const operation = (async () => {
			if (this.closed)
				throw new GoogleCdpBrokerClientError(
					"client_closed",
					"Broker client is closed",
				);
			const deadline = deadlineFor(deadlineAt, this.timeoutMs);
			if (signal?.aborted) throw fencedError();
			let socket;
			try {
				socket = this.connectImpl(this.socketPath);
			} catch (error) {
				throw new GoogleCdpBrokerClientError(
					"connect_failed",
					String(error?.message || error),
				);
			}
			const generation = ++this.socketGeneration;
			this.socket = socket;
			this.attachSocket(socket, generation);
			try {
				await this.waitForConnect(socket, signal, deadline);
				const registration = await this.requestInternal(
					{
						op: "register",
						clientId: CLIENT_ID,
						sessionId: SESSION_ID,
					},
					{ signal, deadlineAt: deadline },
				);
				if (typeof registration?.capability !== "string")
					throw new GoogleCdpBrokerClientError(
						"register_failed",
						"Broker registration did not return a capability",
					);
				this.capability = registration.capability;
				this.connected = true;
				this.registered = true;
				this.startHeartbeat(registration.heartbeatTtlMs);
				return this;
			} catch (error) {
				this.failPending("connection_closed", error, socket);
				if (this.socket === socket) this.socket = null;
				try {
					socket.destroy?.();
				} catch {}
				if (error instanceof GoogleCdpBrokerClientError) throw error;
				throw new GoogleCdpBrokerClientError(
					"connect_failed",
					String(error?.message || error),
				);
			}
		})();
		this.connectPromise = operation;
		try {
			return await operation;
		} finally {
			if (this.connectPromise === operation) this.connectPromise = null;
		}
	}

	startHeartbeat(ttlMs) {
		this.stopHeartbeat();
		const intervalMs = Math.max(
			1_000,
			Math.min(Number(ttlMs) || 15_000, 60_000) / 2,
		);
		this.heartbeatTimer = setInterval(() => {
			if (!this.registered || !this.capability) return;
			void this.requestInternal(
				{
					op: "heartbeat",
					clientId: CLIENT_ID,
					sessionId: SESSION_ID,
					capability: this.capability,
				},
				{ deadlineAt: Date.now() + Math.min(intervalMs, 5_000) },
			).catch(() => {});
		}, intervalMs);
		this.heartbeatTimer.unref?.();
	}

	stopHeartbeat() {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	attachSocket(socket, generation) {
		socket.setNoDelay?.(true);
		socket.on("data", (chunk) => {
			if (this.socket === socket && this.socketGeneration === generation)
				this.receive(chunk);
		});
		socket.on("error", (error) =>
			this.failPending("connection_closed", error, socket),
		);
		socket.on("end", () =>
			this.failPending("connection_closed", undefined, socket),
		);
		socket.on("close", () =>
			this.failPending("connection_closed", undefined, socket),
		);
	}

	waitForConnect(socket, signal, deadlineAt) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve();
			};
			const abort = () => {
				try {
					socket.destroy?.();
				} catch {}
				finish(fencedError());
			};
			const timer = setTimeout(
				() => {
					try {
						socket.destroy?.();
					} catch {}
					finish(
						new GoogleCdpBrokerClientError(
							"connect_timeout",
							"Broker connection did not become ready before the deadline",
						),
					);
				},
				Math.max(deadlineAt - Date.now(), 1),
			);
			const onConnect = () => finish();
			const onError = (error) =>
				finish(
					new GoogleCdpBrokerClientError(
						"connect_failed",
						String(error?.message || error),
					),
				);
			socket.once("connect", onConnect);
			socket.once("error", onError);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
	}

	receive(chunk) {
		if (this.closed) return;
		this.buffer += chunk.toString("utf8");
		if (Buffer.byteLength(this.buffer, "utf8") > BROKER_CLIENT_MAX_FRAME_BYTES) {
			this.failPending("frame_too_large");
			this.close();
			return;
		}
		let newline;
		while ((newline = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let response;
			try {
				response = JSON.parse(line);
			} catch {
				this.failPending("malformed_json");
				this.close();
				return;
			}
			const pending = this.pending.get(String(response.id));
			if (!pending) continue;
			this.pending.delete(String(response.id));
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.abort);
			if (response.ok) pending.resolve(response.result);
			else pending.reject(brokerError(response));
		}
	}

	failPending(code, error = undefined, socket = undefined) {
		if (socket && this.socket !== socket) return;
		if (this.closed && this.pending.size === 0) return;
		const message =
			code === "connection_closed"
				? "Broker connection closed"
				: String(error?.message || "Broker connection failed");
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.abort);
			pending.reject(new GoogleCdpBrokerClientError(code, message));
		}
		this.pending.clear();
		this.connected = false;
		this.registered = false;
		this.capability = null;
		this.stopHeartbeat();
		this.buffer = "";
	}

	requestInternal(body, { signal, deadlineAt } = {}) {
		if (!this.socket || this.socket.destroyed)
			return Promise.reject(
				new GoogleCdpBrokerClientError(
					"connection_closed",
					"Broker connection is not available",
				),
			);
		const id = `client-${this.nextId++}`;
		const deadline = deadlineFor(deadlineAt, this.timeoutMs);
		if (signal?.aborted) return Promise.reject(fencedError());
		let frame;
		try {
			frame = asFrame({ id, ...body });
		} catch (error) {
			return Promise.reject(error);
		}
		const socket = this.socket;
		return new Promise((resolve, reject) => {
			let pending;
			const fence = (error) => {
				if (this.pending.get(id) !== pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				signal?.removeEventListener("abort", abort);
				try {
					// Cancellation is a high-level control frame. It is best effort,
					// uses the authenticated connection, and has no client promise or
					// normal in-flight slot of its own.
					if (socket === this.socket && !socket.destroyed && this.capability)
						socket.write(
							asFrame({
								id: `cancel-${this.nextId++}`,
								op: "cancel",
								requestId: id,
								clientId: CLIENT_ID,
								sessionId: SESSION_ID,
								capability: this.capability,
							}),
						);
				} catch {}
				reject(error);
			};
			const abort = () => fence(fencedError());
			const deadlineAbort = () =>
				fence(
					new GoogleCdpBrokerClientError(
						"deadline_expired",
						"Broker request deadline has expired",
					),
				);
			const timer = setTimeout(deadlineAbort, Math.max(deadline - Date.now(), 1));
			pending = { resolve, reject, timer, signal, abort };
			this.pending.set(id, pending);
			try {
				socket.write(frame);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				try {
					socket.destroy?.();
				} catch {}
				reject(
					new GoogleCdpBrokerClientError(
						"connection_closed",
						String(error?.message || error),
					),
				);
				return;
			}
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
	}

	async search(query, { maxResults = 15, signal, deadlineAt } = {}) {
		if (!this.registered) await this.connect({ signal, deadlineAt });
		if (typeof query !== "string" || query.length === 0)
			throw new GoogleCdpBrokerClientError(
				"invalid_request",
				"Google search query is required",
			);
		const request = () =>
			this.requestInternal(
				{
					op: "search",
					provider: "google-search",
					query,
					maxResults: Math.min(maxResults, 25),
					clientId: CLIENT_ID,
					sessionId: SESSION_ID,
					capability: this.capability,
				},
				{ signal, deadlineAt },
			);
		try {
			return await request();
		} catch (error) {
			if (error?.code !== "not_registered" || this.closed) throw error;
			const staleSocket = this.socket;
			this.socket = null;
			this.connected = false;
			this.registered = false;
			this.capability = null;
			this.stopHeartbeat();
			try {
				staleSocket?.destroy?.();
			} catch {}
			await this.connect({ signal, deadlineAt });
			return request();
		}
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.failPending("connection_closed");
		try {
			this.socket?.destroy?.();
		} catch {}
		this.socket = null;
		this.connected = false;
		this.registered = false;
		this.capability = null;
		this.stopHeartbeat();
	}
}

export function brokerSocketPath(profileDir) {
	return brokerPaths(profileDir).socketPath;
}
