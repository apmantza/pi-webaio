// ─── Shared CDP client for Reddit fetch/search ──────────────────────
// Extracted from src/verticals/reddit.ts so both the fetch vertical
// and the search tool can share one implementation.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir as osTmpdir } from "os";
import http from "http";

/** CDP connection timeout */
const CDP_CONNECT_TIMEOUT_MS = 5_000;

/** Resolve the WebSocket URL for the dedicated Chrome instance. */
export function getCdpWsUrl(): string {
	const profileDir =
		process.env.CDP_PROFILE_DIR ||
		join(osTmpdir(), "greedysearch-chrome-profile");
	const p = join(profileDir, "DevToolsActivePort");
	if (!existsSync(p)) {
		throw new Error(
			`DevToolsActivePort not found at ${p}. Run: node bin/launch.mjs`,
		);
	}
	const lines = readFileSync(p, "utf8").trim().split("\n");
	return `ws://localhost:${lines[0]}${lines[1]}`;
}

/** Quick liveness probe — returns true if Chrome responds on the port. */
export async function cdpIsAvailable(portPath?: string): Promise<boolean> {
	const profileDir =
		process.env.CDP_PROFILE_DIR ||
		join(osTmpdir(), "greedysearch-chrome-profile");
	const p = portPath || join(profileDir, "DevToolsActivePort");
	if (!existsSync(p)) return false;

	try {
		const lines = readFileSync(p, "utf8").trim().split("\n");
		const port = parseInt(lines[0], 10);
		if (!port || isNaN(port)) return false;

		const probe = await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const req = http.get(`http://localhost:${port}/json/version`, (res) => {
				// This is only a status probe. Consume and close the body so it
				// cannot keep the agent's socket alive.
				res.on("error", () => {});
				res.resume();
				res.destroy();
				finish(res.statusCode === 200);
			});
			req.on("error", () => finish(false));
			req.setTimeout(3000, () => {
				req.destroy();
				finish(false);
			});
		});
		return probe;
	} catch {
		return false;
	}
}

/**
 * Minimal CDP client — just enough for Reddit fetch/search.
 * Reuses the Runtime.context-capture pattern from bin/cdp.mjs so
 * Runtime.enable is never left on (anti-bot detection mitigation).
 */
export class CDPClient {
	#ws: any;
	#id = 0;
	#pending = new Map<
		number,
		{
			resolve: (v: any) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	#closeHandlers = new Set<() => void>();
	#closeHandlersNotified = false;
	#closed = false;
	wsUrl: string;

	constructor(wsUrl: string) {
		this.wsUrl = wsUrl;
	}

	async connect(): Promise<void> {
		if (this.#closed) throw new Error("CDP connection is closed");
		const { default: WebSocket } = await import("ws");
		return new Promise((resolve, reject) => {
			let settled = false;
			const failConnect = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			this.#ws = new WebSocket(this.wsUrl);
			this.#ws.onopen = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			this.#ws.onerror = (e: any) => {
				const error = new Error(`WebSocket error: ${e.message || e.type}`);
				this.#closed = true;
				this.#rejectPending(error);
				this.#notifyClose();
				failConnect(error);
				try {
					this.#ws.close();
				} catch {
					// The socket may already be closing.
				}
			};
			this.#ws.onclose = () => {
				this.#closed = true;
				this.#rejectPending(new Error("CDP connection closed"));
				this.#notifyClose();
				failConnect(new Error("CDP connection closed"));
			};
			this.#ws.onmessage = (ev: any) => {
				let msg: any;
				try {
					msg = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (msg.id && this.#pending.has(msg.id)) {
					const { resolve, reject, timer } = this.#pending.get(msg.id)!;
					clearTimeout(timer);
					this.#pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				} else if (msg.method && this.#hasHandler(msg.method)) {
					this.#fireHandlers(msg.method, msg.params || {}, msg);
				}
			};
		});
	}

	#handlers = new Map<string, Set<(...args: any[]) => void>>();

	#hasHandler(method: string): boolean {
		return this.#handlers.has(method);
	}

	#fireHandlers(method: string, params: any, msg: any): void {
		const handlers = this.#handlers.get(method);
		if (handlers) {
			for (const h of [...handlers]) {
				try {
					// Observe the return value so an async handler rejecting
					// after an await cannot become an unhandled rejection.
					void Promise.resolve(h(params, msg)).catch(() => {});
				} catch {
					// Event observers must not break the WebSocket message loop.
				}
			}
		}
	}

	onEvent(method: string, handler: (...args: any[]) => void): () => void {
		if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
		const handlers = this.#handlers.get(method)!;
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#handlers.delete(method);
		};
	}

	onClose(handler: () => void): () => void {
		if (this.#closeHandlersNotified) {
			// Already closed: fire immediately (once) so late registrants
			// still settle instead of hanging forever.
			try {
				void Promise.resolve(handler()).catch(() => {});
			} catch {
				// Close observers must not create an unhandled rejection.
			}
			return () => {};
		}
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	waitForEvent(method: string, timeout = CDP_CONNECT_TIMEOUT_MS) {
		if (this.#closed) {
			// Already closed: reject immediately instead of waiting out the
			// full timeout.
			const promise = Promise.reject(new Error("CDP connection closed"));
			promise.catch(() => {});
			return { promise, cancel() {} };
		}
		let settled = false;
		let off: (() => void) | undefined;
		let offClose: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout>;
		let resolveWait: (value: any) => void;
		const finish = (settle: (value: any) => void, value: any) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off?.();
			offClose?.();
			settle(value);
		};
		const promise = new Promise<any>((resolve, reject) => {
			resolveWait = resolve;
			off = this.onEvent(method, (params) => finish(resolve, params));
			offClose = this.onClose(() =>
				finish(reject, new Error("CDP connection closed")),
			);
			timer = setTimeout(
				() =>
					finish(
						reject,
						new Error(`Timeout waiting for event: ${method}`),
					),
				 timeout,
			);
		});
		promise.catch(() => {});
		return {
			promise,
			cancel() {
				if (!settled) finish(resolveWait, undefined);
			},
		};
	}

	#notifyClose(): void {
		if (this.#closeHandlersNotified) return;
		this.#closeHandlersNotified = true;
		for (const h of [...this.#closeHandlers]) {
			try {
				// Observe the return value so an async handler rejecting
				// after an await cannot become an unhandled rejection.
				void Promise.resolve(h()).catch(() => {});
			} catch {
				// Close observers must not create an unhandled rejection.
			}
		}
	}

	#rejectPending(error: Error): void {
		for (const { reject, timer } of this.#pending.values()) {
			clearTimeout(timer);
			reject(error);
		}
		this.#pending.clear();
	}

	send(method: string, params = {}, sessionId?: string): Promise<any> {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			if (this.#closed || !this.#ws) {
				reject(new Error("CDP connection is closed"));
				return;
			}
			const timer = setTimeout(() => {
				if (this.#pending.has(id)) {
					this.#pending.delete(id);
					reject(new Error(`Timeout: ${method}`));
				}
			}, CDP_CONNECT_TIMEOUT_MS);
			this.#pending.set(id, { resolve, reject, timer });
			const msg: any = { id, method, params };
			if (sessionId) msg.sessionId = sessionId;
			try {
				this.#ws.send(JSON.stringify(msg));
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectPending(new Error("CDP connection closed"));
		this.#notifyClose();
		try {
			this.#ws?.close();
		} catch {
			// The socket may already be closing.
		}
	}
}

/** Lazily capture the main execution context via brief Runtime.enable. */
const mainCtxCache = new Map<string, number | null>();

/** Forget a session's cached context after its target is closed or detached. */
export function clearMainContext(sessionId: string): void {
	mainCtxCache.delete(sessionId);
}

export async function captureMainContext(
	cdp: CDPClient,
	sessionId: string,
): Promise<number | null> {
	const contexts: any[] = [];
	const off = cdp.onEvent("Runtime.executionContextCreated", (params: any) => {
		if (params?.context) contexts.push(params.context);
	});

	let enabled = false;
	try {
		await cdp.send("Runtime.enable", {}, sessionId);
		enabled = true;
		await new Promise((r) => setTimeout(r, 100));
	} finally {
		// Cleanup is required even when enable or the session itself fails.
		off();
		if (enabled)
			await cdp.send("Runtime.disable", {}, sessionId).catch(() => {});
	}

	let rootFrameId: string | null = null;
	try {
		const ft = await cdp.send("Page.getFrameTree", {}, sessionId);
		rootFrameId = ft?.frameTree?.frame?.id ?? null;
	} catch {
		/* ignore frame-tree probe */
	}

	const defaults = contexts.filter(
		(ctx: any) => ctx.auxData?.isDefault && ctx.auxData?.type === "default",
	);
	const main =
		(rootFrameId &&
			defaults.find((c: any) => c.auxData?.frameId === rootFrameId)) ||
		defaults[0] ||
		null;
	return main?.id ?? null;
}

/**
 * Evaluate a JS expression in the main execution context WITHOUT
 * persistent Runtime.enable. Uses the contextId captured at session
 * startup via brief Runtime.enable → Runtime.disable.
 */
export async function evalInMainContext(
	cdp: CDPClient,
	sessionId: string,
	expr: string,
): Promise<string> {
	let contextId = mainCtxCache.get(sessionId);

	async function doEval(cid: number): Promise<string> {
		const result = await cdp.send(
			"Runtime.evaluate",
			{
				expression: expr,
				contextId: cid,
				returnByValue: true,
				awaitPromise: true,
			},
			sessionId,
		);
		if (result.exceptionDetails) {
			throw new Error(
				result.exceptionDetails.text ||
					result.exceptionDetails.exception?.description,
			);
		}
		const val = result.result.value;
		return typeof val === "object"
			? JSON.stringify(val, null, 2)
			: String(val ?? "");
	}

	if (contextId == null) {
		contextId = await captureMainContext(cdp, sessionId);
		if (contextId == null) {
			throw new Error(
				"Failed to capture main execution context — is the page loaded?",
			);
		}
		mainCtxCache.set(sessionId, contextId);
	}

	try {
		return await doEval(contextId);
	} catch {
		mainCtxCache.delete(sessionId);
		contextId = await captureMainContext(cdp, sessionId);
		if (contextId == null) {
			throw new Error(
				"Failed to re-capture execution context after navigation",
			);
		}
		mainCtxCache.set(sessionId, contextId);
		return await doEval(contextId);
	}
}
