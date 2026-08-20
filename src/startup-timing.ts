/**
 * Minimal startup timing for pi's extension-load profiler.
 *
 * This module intentionally has no runtime imports. It must stay first in the
 * extension's static graph so `totalMs` includes module evaluation, while the
 * heavy tool graph is loaded only when a tool is first executed.
 *
 * Set PI_TIMING=1 to emit one machine-readable stderr line:
 * `startup-timing {"totalMs":...,"origin":"first-module-load",...}`
 */

const MODULE_LOAD_ORIGIN = performance.now();
const TIMING_ENABLED = process.env.PI_TIMING === "1";
let recorded = false;

function rounded(value: number): number {
	return Math.max(0, Math.round(value));
}

/**
 * Record the completed extension startup. Best effort by design: timing must
 * never make extension loading fail, and normal runs stay silent.
 *
 * `factoryStartedAt` is captured by the entry factory after the module graph
 * has evaluated, allowing the record to separate module evaluation from the
 * synchronous registration work performed by the factory.
 */
export function recordStartupTiming(factoryStartedAt?: number): void {
	if (!TIMING_ENABLED || recorded) return;
	recorded = true;
	try {
		const now = performance.now();
		const factoryStart = factoryStartedAt ?? now;
		process.stderr.write(
			`startup-timing ${JSON.stringify({
				totalMs: rounded(now - MODULE_LOAD_ORIGIN),
				moduleGraphMs: rounded(factoryStart - MODULE_LOAD_ORIGIN),
				factoryMs: rounded(now - factoryStart),
				origin: "first-module-load",
				networkFetches: 0,
				deferredWork: "lazy-tool-and-cache-initialization",
			})}\n`,
		);
	} catch {
		// Observability must never affect extension startup.
	}
}

/** Exposed for focused tests without changing the production log format. */
export function startupTimingOrigin(): number {
	return MODULE_LOAD_ORIGIN;
}
