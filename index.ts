import { recordStartupTiming } from "./src/startup-timing.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLazyTools } from "./src/tools/lazy.ts";

/**
 * pi-webaio's entry point stays deliberately small. Fetching, extraction,
 * search, browser, and renderer dependencies are loaded by src/tools/lazy.ts
 * when the corresponding tool is first called rather than during pi startup.
 */
export default function (pi: ExtensionAPI) {
	const factoryStartedAt = performance.now();
	let userExtractorsReady: Promise<void> | undefined;
	const ensureUserExtractors = (): Promise<void> => {
		userExtractorsReady ??= import("./src/verticals/registry.ts")
			.then(({ initUserExtractors }) => initUserExtractors())
			.catch((err: unknown) => {
				process.stderr.write(
					`[user-verticals] Failed to initialize user extractors: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			});
		return userExtractorsReady;
	};

	// Cache warming is useful, but it should not extend the synchronous
	// extension-load window measured by pi. Tool calls that depend on a cache
	// await this promise, preventing a first-call miss while the disk scan runs.
	const cacheReady = import("./src/session-store.ts")
		.then(
			async ({
				loadContentCacheFromDisk,
				loadSearchCacheFromDisk,
				cleanupSessionCache,
				SESSION_CACHE_CLEANUP_MS,
			}) => {
				await Promise.all([loadSearchCacheFromDisk(), loadContentCacheFromDisk()]);
				setInterval(cleanupSessionCache, SESSION_CACHE_CLEANUP_MS).unref();
			},
		)
		.catch(() => {});

	// Tool execution awaits these promises, so custom verticals and persisted
	// caches are ready before the first dependent call without putting either
	// dependency graph on the synchronous extension import path.
	registerLazyTools(pi, ensureUserExtractors, cacheReady);

	recordStartupTiming(factoryStartedAt);
}
