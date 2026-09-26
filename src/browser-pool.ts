/**
 * Browser Pool — reusable Playwright browser instances for same-domain pulls.
 *
 * Instead of launching/closing a browser per page (which costs ~2-3s overhead),
 * this pool keeps 1-N browser instances alive and reuses pages across requests.
 *
 * Features:
 * - Acquire/release page lifecycle
 * - Automatic browser recycling after N navigations (memory leak defense)
 * - Crash recovery: if a page/browser crashes, it's retired and replaced
 * - Configurable max browsers and pages per browser
 * - Pre-warming: browsers are launched on first use, not upfront
 */

import { debug } from "./debug.ts";

// ─── Types ───────────────────────────────────────────────────────────

// Playwright types are accessed via dynamic import to avoid type dependency issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any

export interface BrowserPoolOptions {
	/** Maximum number of concurrent browser instances (default: 2) */
	maxBrowsers?: number;
	/** Maximum pages to navigate per browser before recycling (default: 50) */
	maxPagesPerBrowser?: number;
	/** Whether to run headless (default: true) */
	headless?: boolean;
	/** Browser channel to use (e.g. "chrome" for system Chrome) */
	channel?: string;
	/** Navigation timeout in ms (default: 30_000) */
	navigationTimeout?: number;
}

export interface PooledPage {
	/** The Playwright Page object */
	page: any;
	/** Browser this page belongs to */
	browser: any;
	/** Release the page back to the pool */
	release: () => void;
}

interface PoolBrowser {
	browser: any;
	pagesInUse: Set<any>;
	pagesUsed: number; // total navigations performed (for recycling)
	closed: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULTS: Required<BrowserPoolOptions> = {
	maxBrowsers: 2,
	maxPagesPerBrowser: 50,
	headless: true,
	channel: "chrome",
	navigationTimeout: 30_000,
};

// ─── Launch observability helpers (observability audit P4) ──────────
//
// Browser launches are the slowest part of the browser path (~2-3s) and a
// background relaunch that fails used to be fully silenced, so a degraded pool
// later hung in acquire() with no record of why. These small pure helpers hold
// the launch-error-record + timing logic so it is unit-testable offline, without
// needing Playwright installed.

export interface LaunchErrorRecord {
	/** The launch failure message. */
	message: string;
	/** Epoch ms when the failure was recorded. */
	at: number;
}

/**
 * Normalize an unknown launch failure into a storable record. Pure — does not
 * throw, so it is safe to call from a background `.catch()`.
 */
export function toLaunchErrorRecord(
	err: unknown,
	now: number = Date.now(),
): LaunchErrorRecord {
	const message = err instanceof Error ? err.message : String(err);
	return { message, at: now };
}

/**
 * Human-readable degraded-pool notice, or null when the pool is healthy.
 * Callers (e.g. acquire()) can surface this instead of hanging silently.
 */
export function degradedPoolNotice(
	lastLaunchError: LaunchErrorRecord | null,
): string | null {
	if (!lastLaunchError) return null;
	return `pool degraded: last launch failed (${lastLaunchError.message})`;
}

/**
 * Compact launch-timing line, e.g. `browser launch took 2143ms (channel=chrome)`
 * or `browser launch took 1890ms (bundled browser)`. Pure + offline-testable.
 */
export function formatLaunchTiming(
	durationMs: number,
	channel: string | null,
): string {
	const which = channel ? `channel=${channel}` : "bundled browser";
	return `browser launch took ${durationMs}ms (${which})`;
}

// ─── BrowserPool ─────────────────────────────────────────────────────

export class BrowserPool {
	private readonly options: Required<BrowserPoolOptions>;
	private browsers: PoolBrowser[] = [];
	private launchQueue: Promise<PoolBrowser>[] = [];
	private totalLaunched = 0;
	private totalCrashes = 0;
	private _closed = false;
	private _lastLaunchError: LaunchErrorRecord | null = null;
	private waiters: Array<() => void> = [];

	constructor(options: BrowserPoolOptions = {}) {
		this.options = { ...DEFAULTS, ...options };
	}

	// ── Public API ──────────────────────────────────────────────────

	/**
	 * Acquire a page from the pool.
	 * If an idle browser is available, its page is returned immediately.
	 * If all browsers are at capacity, a new one is launched (up to maxBrowsers).
	 * If at max, waits for a page to be released.
	 */
	async acquirePage(): Promise<PooledPage> {
		while (!this._closed) {
			// Try to find an existing browser with capacity
			const available = this.findAvailableBrowser();
			if (available) {
				return this.createPooledPage(available);
			}

			// Try to launch a new browser if under max
			if (this.browsers.length < this.options.maxBrowsers) {
				try {
					const pb = await this.launchBrowser();
					if (pb.pagesUsed < this.options.maxPagesPerBrowser && !pb.closed) {
						return this.createPooledPage(pb);
					}
				} catch (err) {
					// If pool has no browsers and no launches in flight, fail fast
					if (this.browsers.length === 0 && this.launchQueue.length === 0) {
						throw err;
					}
				}
				continue;
			}

			// If a launch is in progress, await it
			if (this.launchQueue.length > 0) {
				try {
					const pb = await this.launchQueue[this.launchQueue.length - 1];
					if (pb.pagesUsed < this.options.maxPagesPerBrowser && !pb.closed) {
						return this.createPooledPage(pb);
					}
				} catch {
					// In-flight launch failed; loop back to re-evaluate
				}
				continue;
			}

			// All browsers are recycling/capped — wait for a release or launch.
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
			});
		}

		throw new Error("BrowserPool is closed");
	}

	/**
	 * Close all browsers and clean up.
	 */
	async drain(): Promise<void> {
		this._closed = true;
		this.notifyWaiters();
		const closePromises: Promise<void>[] = [];
		for (const pb of this.browsers) {
			pb.closed = true;
			closePromises.push(
				(async () => {
					try {
						await pb.browser.close();
					} catch {
						// already closed
					}
				})(),
			);
		}
		// Also wait for in-flight launches so their processes don't leak
		for (const lp of this.launchQueue) {
			closePromises.push(
				lp
					.then(async (pb) => {
						try {
							await pb.browser.close();
						} catch {
							// already closed
						}
					})
					.catch(() => {}),
			);
		}
		await Promise.allSettled(closePromises);
		this.browsers = [];
	}

	/**
	 * Pool statistics for monitoring.
	 */
	stats(): {
		active: number;
		idle: number;
		totalLaunched: number;
		crashes: number;
		browsers: number;
		lastLaunchError: LaunchErrorRecord | null;
	} {
		let active = 0;
		for (const pb of this.browsers) {
			active += pb.pagesInUse.size;
		}
		return {
			active,
			idle: this.browsers.length - active,
			totalLaunched: this.totalLaunched,
			crashes: this.totalCrashes,
			browsers: this.browsers.length,
			lastLaunchError: this._lastLaunchError,
		};
	}

	get closed(): boolean {
		return this._closed;
	}

	/**
	 * The last background replacement-launch failure, or null if none. When
	 * non-null the pool is degraded — acquire() may hang/fail with no further
	 * launches coming. See degradedPoolNotice().
	 */
	get lastLaunchError(): LaunchErrorRecord | null {
		return this._lastLaunchError;
	}

	/** Convenience: the degraded-pool notice, or null when healthy. */
	get degradedNotice(): string | null {
		return degradedPoolNotice(this._lastLaunchError);
	}

	// ── Internal ────────────────────────────────────────────────────

	private findAvailableBrowser(): PoolBrowser | null {
		for (const pb of this.browsers) {
			if (pb.closed) continue;
			// Has room and hasn't exceeded page limit
			if (pb.pagesUsed < this.options.maxPagesPerBrowser) {
				return pb;
			}
			// Exceeded limit: recycle only when idle. Recycling a browser with
			// checked-out pages would close in-flight navigations and turn
			// healthy pulls into spurious failures (tla/KILL-IN-FLIGHT); a busy
			// browser is recycled once its pages drain (see release()).
			if (pb.pagesInUse.size === 0) {
				this.recycleBrowser(pb);
			}
		}
		return null;
	}

	private async launchBrowser(): Promise<PoolBrowser> {
		// Deduplicate concurrent launch requests
		if (this.launchQueue.length > 0) {
			// If there's already a launch in progress, wait for it
			const existing = this.launchQueue[this.launchQueue.length - 1];
			const pb = await existing;
			// But check if it has capacity
			if (pb.pagesUsed < this.options.maxPagesPerBrowser && !pb.closed) {
				return pb;
			}
		}

		// Re-check capacity before launching: in-flight launches or concurrent
		// calls might have reached maxBrowsers while awaiting existing launches.
		if (this.browsers.length >= this.options.maxBrowsers) {
			throw new Error("BrowserPool at max capacity");
		}

		const launchPromise = this._launchBrowser();
		this.launchQueue.push(launchPromise);
		try {
			const pb = await launchPromise;
			return pb;
		} finally {
			this.launchQueue = this.launchQueue.filter((p) => p !== launchPromise);
		}
	}

	private async _launchBrowser(): Promise<PoolBrowser> {
		const { chromium } = await import("playwright");
		const launchOpts: any = { headless: this.options.headless };
		if (this.options.channel) {
			launchOpts.channel = this.options.channel;
		}

		const launchStartedAt = Date.now();
		let browser: any;
		let usedChannel: string | null = this.options.channel ?? null;
		try {
			browser = await chromium.launch(launchOpts);
		} catch (err) {
			// Fallback: try without channel (Playwright's bundled browser)
			if (this.options.channel) {
				// Log the channel failure reason before falling back, so a second
				// (bundled) failure doesn't erase the trace of the first (P4).
				debug(
					"browser-pool",
					`channel launch failed (channel=${this.options.channel}): ${
						err instanceof Error ? err.message : String(err)
					} — falling back to bundled browser`,
				);
				delete launchOpts.channel;
				usedChannel = null;
				browser = await chromium.launch(launchOpts);
			} else {
				throw err;
			}
		}
		debug(
			"browser-pool",
			formatLaunchTiming(Date.now() - launchStartedAt, usedChannel),
		);

		// If the pool was closed while this launch was in progress, close the
		// browser immediately to prevent leaking processes (tla/DRAIN-LEAK).
		if (this._closed) {
			try {
				await browser.close();
			} catch {
				// already closed
			}
			throw new Error("BrowserPool is closed");
		}

		// A successful launch clears any prior degraded state.
		this._lastLaunchError = null;
		this.totalLaunched++;
		const pb: PoolBrowser = {
			browser,
			pagesInUse: new Set(),
			pagesUsed: 0,
			closed: false,
		};
		this.browsers.push(pb);
		this.notifyWaiters();
		return pb;
	}

	private async createPooledPage(pb: PoolBrowser): Promise<PooledPage> {
		const context = pb.browser.contexts()[0] ?? (await pb.browser.newContext());
		const page = await context.newPage();
		page.setDefaultTimeout(this.options.navigationTimeout);
		pb.pagesInUse.add(page);
		pb.pagesUsed++;

		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			pb.pagesInUse.delete(page);
			page.close().catch(() => {});
			// Lazy budget recycle: an at-budget browser skipped by
			// findAvailableBrowser() while busy retires once its last page
			// drains, so the page budget is still enforced without ever
			// killing in-flight work.
			if (
				pb.pagesInUse.size === 0 &&
				pb.pagesUsed >= this.options.maxPagesPerBrowser &&
				!pb.closed
			) {
				this.recycleBrowser(pb);
			}
			this.notifyWaiters();
		};

		// Detect crashes: if the page (or its browser) dies, auto-release

		page.on("crash", () => {
			this.totalCrashes++;
			release();
			// If the browser is now empty, recycle it
			if (pb.pagesInUse.size === 0 && !pb.closed) {
				this.recycleBrowser(pb);
			}
		});

		return { page, browser: pb.browser, release };
	}

	private notifyWaiters(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const wake of waiters) wake();
	}

	private async recycleBrowser(pb: PoolBrowser): Promise<void> {
		if (pb.closed) return;
		pb.closed = true;
		this.browsers = this.browsers.filter((b) => b !== pb);
		try {
			// Close remaining pages
			for (const page of pb.pagesInUse) {
				page.close().catch(() => {});
			}
			await pb.browser.close();
		} catch {
			// already gone
		}
		// Launch a replacement immediately if we're still open and need capacity.
		// Don't throw from the background relaunch, but record the failure so the
		// pool can report "degraded" instead of silently hanging later (P4).
		if (!this._closed && this.browsers.length < this.options.maxBrowsers) {
			void (async () => {
				try {
					await this.launchBrowser();
				} catch (err) {
					this._lastLaunchError = toLaunchErrorRecord(err);
					debug(
						"browser-pool",
						`replacement launch failed: ${this._lastLaunchError.message} — ${degradedPoolNotice(
							this._lastLaunchError,
						)}`,
					);
					this.notifyWaiters();
				}
			})();
		}
	}
}
