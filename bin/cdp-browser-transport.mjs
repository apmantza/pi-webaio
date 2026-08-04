import { EventEmitter } from "node:events";
import WebSocket from "ws";

export class CdpTransportError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = "CdpTransportError";
		this.code = code;
		this.details = details;
	}
}

function asDeadline(deadlineAt, fallbackMs) {
	const value = deadlineAt ?? Date.now() + fallbackMs;
	if (!Number.isInteger(value) || value <= Date.now())
		throw new CdpTransportError("deadline_expired", "CDP deadline has expired");
	return value;
}

function signalError() {
	return new CdpTransportError(
		"request_fenced",
		"CDP request was cancelled or its deadline expired",
	);
}

function validateWebSocketUrl(value, expectedPort = undefined) {
	if (typeof value !== "string" || value.length > 2048)
		throw new CdpTransportError("cdp_invalid", "CDP WebSocket URL is invalid");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new CdpTransportError("cdp_invalid", "CDP WebSocket URL is invalid");
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:")
		throw new CdpTransportError(
			"cdp_invalid",
			"CDP endpoint must use ws:// or wss://",
		);
	if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname))
		throw new CdpTransportError("cdp_invalid", "CDP endpoint must be loopback");
	if (
		expectedPort !== undefined &&
		url.port &&
		Number(url.port) !== expectedPort
	)
		throw new CdpTransportError(
			"cdp_invalid",
			"CDP endpoint port does not match",
		);
	return url.href;
}

export async function discoverCdpBrowser({
	port = 9222,
	fetchImpl = globalThis.fetch,
	timeoutMs = 1500,
	signal,
} = {}) {
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new CdpTransportError("cdp_invalid", "CDP port is invalid");
	if (typeof fetchImpl !== "function")
		throw new CdpTransportError("cdp_unavailable", "fetch is unavailable");
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	try {
		let response;
		try {
			response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
				signal: controller.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw signalError();
			throw new CdpTransportError(
				"cdp_unavailable",
				String(error?.message || error),
			);
		}
		if (!response?.ok)
			throw new CdpTransportError(
				"cdp_unavailable",
				`CDP returned HTTP ${response?.status ?? "unknown"}`,
			);
		let version;
		try {
			version = await response.json();
		} catch {
			throw new CdpTransportError(
				"cdp_invalid",
				"CDP version response is not valid JSON",
			);
		}
		return {
			port,
			browser: typeof version?.Browser === "string" ? version.Browser : null,
			webSocketDebuggerUrl: validateWebSocketUrl(
				version?.webSocketDebuggerUrl,
				port,
			),
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

/**
 * Browser-level CDP transport. It only connects to an already-running Chrome;
 * it never starts or terminates the browser process.
 */
export class BrowserCdpTransport extends EventEmitter {
	constructor({
		port = 9222,
		fetchImpl = globalThis.fetch,
		WebSocketImpl = WebSocket,
		endpoint,
		connectTimeoutMs = 1500,
		defaultTimeoutMs = 30_000,
	} = {}) {
		super();
		this.port = port;
		this.fetchImpl = fetchImpl;
		this.WebSocketImpl = WebSocketImpl;
		this.endpoint = endpoint;
		this.connectTimeoutMs = connectTimeoutMs;
		this.defaultTimeoutMs = defaultTimeoutMs;
		this.socket = null;
		this.connected = false;
		this.generation = 1;
		this.nextId = 1;
		this.pending = new Map();
		this.sessionListeners = new Map();
		this.closing = false;
		this.browser = null;
		this.webSocketDebuggerUrl = null;
	}

	info() {
		return {
			connected: this.connected,
			generation: this.generation,
			port: this.port,
			browser: this.browser,
		};
	}

	onSessionEvent(sessionId, listener) {
		if (typeof sessionId !== "string" || typeof listener !== "function")
			throw new TypeError("sessionId and listener are required");
		const listeners = this.sessionListeners.get(sessionId) || new Set();
		listeners.add(listener);
		this.sessionListeners.set(sessionId, listeners);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.sessionListeners.delete(sessionId);
		};
	}

	async connect({ signal, deadlineAt } = {}) {
		if (this.connected) return this.info();
		const deadline = asDeadline(
			deadlineAt,
			this.connectTimeoutMs + this.defaultTimeoutMs,
		);
		if (signal?.aborted) throw signalError();
		const endpoint = this.endpoint
			? {
					port: this.port,
					browser: null,
					webSocketDebuggerUrl: validateWebSocketUrl(this.endpoint, this.port),
				}
			: await discoverCdpBrowser({
					port: this.port,
					fetchImpl: this.fetchImpl,
					timeoutMs: Math.min(
						this.connectTimeoutMs,
						Math.max(deadline - Date.now(), 1),
					),
					signal,
				});
		if (Date.now() >= deadline) throw signalError();
		this.browser = endpoint.browser;
		this.webSocketDebuggerUrl = endpoint.webSocketDebuggerUrl;
		const socket = new this.WebSocketImpl(endpoint.webSocketDebuggerUrl);
		this.socket = socket;
		this.closing = false;
		await new Promise((resolve, reject) => {
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
					socket.close?.();
				} catch {}
				finish(signalError());
			};
			const timer = setTimeout(
				() => {
					try {
						socket.close?.();
					} catch {}
					finish(signalError());
				},
				Math.max(deadline - Date.now(), 1),
			);
			const onOpen = () => {
				this.connected = true;
				this.attachSocket(socket);
				finish();
			};
			const onError = (error) =>
				finish(
					new CdpTransportError(
						"cdp_unavailable",
						String(error?.message || "CDP WebSocket connection failed"),
					),
				);
			if (typeof socket.once === "function") {
				socket.once("open", onOpen);
				socket.once("error", onError);
			} else {
				throw new CdpTransportError("cdp_unavailable", "Invalid WebSocket");
			}
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
		});
		return this.info();
	}

	attachSocket(socket) {
		const onMessage = (data) => this.handleMessage(data);
		const onClose = () => this.markClosed();
		const onError = (error) => this.emit("socketError", error);
		socket.on("message", onMessage);
		socket.on("close", onClose);
		socket.on("error", onError);
	}

	handleMessage(data) {
		let message;
		try {
			message = JSON.parse(
				Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
			);
		} catch {
			this.emit(
				"protocolError",
				new CdpTransportError("cdp_protocol", "Invalid CDP JSON"),
			);
			return;
		}
		if (!message || typeof message !== "object") return;
		const sessionId =
			typeof message.sessionId === "string" ? message.sessionId : null;
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			if (
				!pending ||
				pending.generation !== this.generation ||
				pending.sessionId !== sessionId
			)
				return;
			this.emit("response", { ...message, sessionId });
			if (message.error) {
				this.settle(
					pending,
					new CdpTransportError(
						"cdp_error",
						message.error.message || "CDP command failed",
						message.error,
					),
				);
			} else this.settle(pending, undefined, message.result);
			return;
		}
		if (sessionId) {
			this.emit("sessionEvent", sessionId, message);
			for (const listener of this.sessionListeners.get(sessionId) || [])
				listener(message);
		} else this.emit("event", message);
	}

	send(method, params = {}, { sessionId, signal, deadlineAt } = {}) {
		if (!this.connected || !this.socket)
			return Promise.reject(
				new CdpTransportError(
					"cdp_disconnected",
					"CDP browser is disconnected",
				),
			);
		if (typeof method !== "string" || !method)
			return Promise.reject(
				new CdpTransportError("cdp_invalid", "CDP method is invalid"),
			);
		let deadline;
		try {
			deadline = asDeadline(deadlineAt, this.defaultTimeoutMs);
		} catch (error) {
			return Promise.reject(error);
		}
		if (signal?.aborted) return Promise.reject(signalError());
		const id = this.nextId++;
		const normalizedSessionId =
			typeof sessionId === "string" ? sessionId : null;
		const pending = {
			id,
			generation: this.generation,
			sessionId: normalizedSessionId,
			settled: false,
			resolve: null,
			reject: null,
			timer: null,
			abort: null,
			signal,
		};
		const promise = new Promise((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
		});
		pending.abort = () => this.settle(pending, signalError());
		pending.timer = setTimeout(
			pending.abort,
			Math.max(deadline - Date.now(), 1),
		);
		if (signal) signal.addEventListener("abort", pending.abort, { once: true });
		this.pending.set(id, pending);
		try {
			this.socket.send(
				JSON.stringify({
					id,
					method,
					params,
					...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
				}),
			);
		} catch (error) {
			this.settle(
				pending,
				new CdpTransportError(
					"cdp_disconnected",
					String(error?.message || error),
				),
			);
		}
		return promise;
	}

	settle(pending, error, value) {
		if (!pending || pending.settled) return false;
		pending.settled = true;
		this.pending.delete(pending.id);
		clearTimeout(pending.timer);
		// Removing the listener is important for long-lived browser sessions.
		pending.signal?.removeEventListener("abort", pending.abort);
		if (error) pending.reject(error);
		else pending.resolve(value);
		return true;
	}

	markClosed() {
		if (!this.connected && !this.pending.size) return;
		this.connected = false;
		this.socket = null;
		this.generation++;
		const error = new CdpTransportError(
			"cdp_disconnected",
			"CDP browser WebSocket disconnected",
			{ generation: this.generation },
		);
		for (const pending of [...this.pending.values()])
			this.settle(pending, error);
		this.emit("close", error);
	}

	async close() {
		this.closing = true;
		const socket = this.socket;
		if (!socket) {
			this.markClosed();
			return;
		}
		try {
			socket.close?.();
		} catch {}
		this.markClosed();
	}
}
