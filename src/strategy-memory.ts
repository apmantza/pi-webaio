// ─── Per-domain fetch strategy memory ──────────────────────────────
// Persists per-domain fetch strategy outcomes across process restarts so
// the fetch ladder can start at the remembered rung rather than always
// probing from the cheapest strategy. Also tracks per-engine search stats
// to deprioritize blocked/slow engines.
//
// Design goals:
//  - Bounded (MAX_DOMAIN_ENTRIES / MAX_ENGINE_ENTRIES) with LRU eviction
//  - Entries expire after STRATEGY_MEMORY_TTL_MS (7 days by default)
//  - Debounced disk writes, unref'd timer — never keeps the process alive
//  - Re-probe logic: after RE_PROBE_SUCCESS_COUNT successes at the
//    remembered rung, or after TTL expiry, try from the cheapest rung
//    again to see if a cheaper strategy now works (escape hatch so
//    browser-rung cost doesn't persist forever).
//  - Single process; no file locking needed beyond Node's serialised I/O.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BASE_TEMP } from "./session-store.ts";

// ─── Constants ─────────────────────────────────────────────────────

export const STRATEGY_MEMORY_FILE = join(BASE_TEMP, "strategy-memory.json");

/** How long a domain entry is considered fresh (7 days). */
export const STRATEGY_MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum number of domain entries kept (LRU-evict oldest when exceeded). */
export const MAX_DOMAIN_ENTRIES = 500;

/** Maximum number of engine stat entries. */
export const MAX_ENGINE_ENTRIES = 20;

/** After this many successes at the remembered rung, re-probe from cheapest. */
export const RE_PROBE_SUCCESS_COUNT = 10;

/** Debounce for disk writes (ms). */
const WRITE_DEBOUNCE_MS = 500;

// ─── Types ─────────────────────────────────────────────────────────

/**
 * Fetch strategies, ordered cheapest → most expensive.
 * "plain" = standard wreq fetch
 * "wreq"  = wreq with explicit TLS fingerprinting / browser profile
 * "browser" = headless Playwright browser
 */
export type FetchStrategy = "plain" | "wreq" | "browser";

export const STRATEGY_ORDER: FetchStrategy[] = ["plain", "wreq", "browser"];

export interface DomainStrategyEntry {
	/** The last strategy that succeeded for this domain. */
	lastSuccessStrategy: FetchStrategy;
	/** Consecutive failures per strategy (reset on success for that strategy). */
	consecutiveFailures: Partial<Record<FetchStrategy, number>>;
	/** Number of successful fetches at `lastSuccessStrategy` since last update. */
	successCount: number;
	/** Whether the next fetch should re-probe from the cheapest rung. */
	reprobeNext: boolean;
	/** When this entry was last updated (ms since epoch). */
	updatedAt: number;
}

export interface EngineStatEntry {
	/** Total successful searches. */
	successes: number;
	/** Total blocked/failed searches. */
	failures: number;
	/** Cumulative latency in ms (for avg calculation). */
	totalLatencyMs: number;
	/** Number of latency samples. */
	latencySamples: number;
	/** When this entry was last updated. */
	updatedAt: number;
}

interface MemoryStore {
	domains: Record<string, DomainStrategyEntry>;
	engines: Record<string, EngineStatEntry>;
}

// ─── In-memory state ───────────────────────────────────────────────

const domainMemory = new Map<string, DomainStrategyEntry>();
const engineMemory = new Map<string, EngineStatEntry>();

// ─── LRU helpers ───────────────────────────────────────────────────

function evictDomainIfNeeded(): void {
	while (domainMemory.size >= MAX_DOMAIN_ENTRIES) {
		const oldest = domainMemory.keys().next().value;
		if (oldest === undefined) break;
		domainMemory.delete(oldest);
	}
}

// ─── Domain strategy API ───────────────────────────────────────────

/**
 * Return the recommended starting strategy for a domain, or null if there
 * is no memory (caller should start at the cheapest rung).
 *
 * Returns null (forcing a re-probe from cheapest) when:
 *  - no entry exists
 *  - the entry is stale (> TTL)
 *  - reprobeNext flag is set
 */
export function getStartingStrategy(domain: string): FetchStrategy | null {
	const entry = domainMemory.get(domain);
	if (!entry) return null;

	const age = Date.now() - entry.updatedAt;
	if (age > STRATEGY_MEMORY_TTL_MS) {
		domainMemory.delete(domain);
		scheduleSave();
		return null;
	}

	if (entry.reprobeNext) return null;

	return entry.lastSuccessStrategy;
}

/**
 * Record a successful fetch for a domain at a given strategy.
 *
 * If this is a cheaper strategy than what was remembered, we downgrade
 * the memory (the escape hatch). Otherwise we increment the success
 * counter and set reprobeNext once RE_PROBE_SUCCESS_COUNT is reached.
 */
export function recordDomainSuccess(
	domain: string,
	strategy: FetchStrategy,
): void {
	const existing = domainMemory.get(domain);

	// If an existing entry has reprobeNext set, this is the re-probe result.
	// We always want to persist the cheapest successful strategy.
	const rememberedIdx = existing
		? STRATEGY_ORDER.indexOf(existing.lastSuccessStrategy)
		: Infinity;
	const newIdx = STRATEGY_ORDER.indexOf(strategy);

	if (existing) {
		// Strictly cheaper strategy succeeding → downgrade memory
		if (newIdx < rememberedIdx) {
			existing.lastSuccessStrategy = strategy;
			existing.consecutiveFailures = {};
			existing.successCount = 1;
			existing.reprobeNext = false;
		} else {
			// Same or more expensive strategy still working — increment counter
			// and schedule a re-probe once the threshold is hit so we don't pay
			// browser cost forever if a cheaper rung later becomes viable.
			existing.consecutiveFailures[strategy] = 0;
			existing.successCount += 1;
			if (existing.successCount >= RE_PROBE_SUCCESS_COUNT) {
				existing.reprobeNext = true;
				existing.successCount = 0;
			}
		}
		existing.updatedAt = Date.now();
		// Re-insert to refresh LRU position
		domainMemory.delete(domain);
		domainMemory.set(domain, existing);
	} else {
		evictDomainIfNeeded();
		domainMemory.set(domain, {
			lastSuccessStrategy: strategy,
			consecutiveFailures: {},
			successCount: 1,
			reprobeNext: false,
			updatedAt: Date.now(),
		});
	}

	scheduleSave();
}

/**
 * Record a failed/blocked fetch for a domain at a given strategy.
 */
export function recordDomainFailure(
	domain: string,
	strategy: FetchStrategy,
): void {
	const existing = domainMemory.get(domain);

	if (existing) {
		existing.consecutiveFailures[strategy] =
			(existing.consecutiveFailures[strategy] ?? 0) + 1;
		existing.updatedAt = Date.now();
		// Re-insert to refresh LRU position
		domainMemory.delete(domain);
		domainMemory.set(domain, existing);
	} else {
		evictDomainIfNeeded();
		domainMemory.set(domain, {
			lastSuccessStrategy: "plain",
			consecutiveFailures: { [strategy]: 1 },
			successCount: 0,
			reprobeNext: false,
			updatedAt: Date.now(),
		});
	}

	scheduleSave();
}

// ─── Engine stats API ──────────────────────────────────────────────

function getOrCreateEngineEntry(engine: string): EngineStatEntry {
	const existing = engineMemory.get(engine);
	if (existing) return existing;

	// Evict oldest if at cap
	while (engineMemory.size >= MAX_ENGINE_ENTRIES) {
		const oldest = engineMemory.keys().next().value;
		if (oldest === undefined) break;
		engineMemory.delete(oldest);
	}

	const created: EngineStatEntry = {
		successes: 0,
		failures: 0,
		totalLatencyMs: 0,
		latencySamples: 0,
		updatedAt: Date.now(),
	};
	engineMemory.set(engine, created);
	return created;
}

export function recordEngineSearchSuccess(
	engine: string,
	latencyMs: number,
): void {
	const entry = getOrCreateEngineEntry(engine);
	entry.successes += 1;
	entry.totalLatencyMs += latencyMs;
	entry.latencySamples += 1;
	entry.updatedAt = Date.now();
	scheduleSave();
}

export function recordEngineSearchFailure(engine: string): void {
	const entry = getOrCreateEngineEntry(engine);
	entry.failures += 1;
	entry.updatedAt = Date.now();
	scheduleSave();
}

/**
 * Return engines sorted best-first by a simple reliability score.
 * Score = successes / (successes + failures), with a tie-break on avg
 * latency (lower is better). Engines with no history are scored at 0.5
 * (neutral) so they're not penalised for being new.
 *
 * The returned array is always the same length as the input — engines are
 * only reordered, never dropped.
 */
export function rankEngines<T extends { id: string }>(engines: T[]): T[] {
	function score(engine: string): number {
		const entry = engineMemory.get(engine);
		if (!entry) return 0.5; // no history → neutral

		const total = entry.successes + entry.failures;
		if (total === 0) return 0.5;

		const reliability = entry.successes / total;
		// Normalise avg latency to a 0–0.1 penalty (10s reference)
		const avgLatency =
			entry.latencySamples > 0
				? entry.totalLatencyMs / entry.latencySamples
				: 0;
		const latencyPenalty = Math.min(avgLatency / 10_000, 0.1);

		return reliability - latencyPenalty;
	}

	return [...engines].sort((a, b) => score(b.id) - score(a.id));
}

// ─── Disk persistence ──────────────────────────────────────────────

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
	if (_saveTimer) return;
	_saveTimer = setTimeout(() => {
		_saveTimer = null;
		saveMemoryToDisk().catch(() => {});
	}, WRITE_DEBOUNCE_MS);
	_saveTimer.unref?.();
}

export async function saveMemoryToDisk(): Promise<void> {
	try {
		const now = Date.now();
		// Prune stale domain entries before saving
		for (const [domain, entry] of domainMemory) {
			if (now - entry.updatedAt > STRATEGY_MEMORY_TTL_MS) {
				domainMemory.delete(domain);
			}
		}

		const store: MemoryStore = {
			domains: Object.fromEntries(domainMemory),
			engines: Object.fromEntries(engineMemory),
		};
		await mkdir(BASE_TEMP, { recursive: true });
		await writeFile(
			STRATEGY_MEMORY_FILE,
			JSON.stringify(store, null, 2),
			"utf8",
		);
	} catch {
		// ignore write failures — memory still works in-process
	}
}

export async function loadMemoryFromDisk(): Promise<void> {
	try {
		const text = await readFile(STRATEGY_MEMORY_FILE, "utf8");
		const store = JSON.parse(text) as MemoryStore;
		const now = Date.now();

		if (store.domains && typeof store.domains === "object") {
			for (const [domain, entry] of Object.entries(store.domains)) {
				if (
					entry &&
					typeof entry === "object" &&
					now - (entry.updatedAt ?? 0) < STRATEGY_MEMORY_TTL_MS
				) {
					evictDomainIfNeeded();
					domainMemory.set(domain, entry);
				}
			}
		}

		if (store.engines && typeof store.engines === "object") {
			for (const [engine, entry] of Object.entries(store.engines)) {
				if (entry && typeof entry === "object") {
					engineMemory.set(engine, entry);
				}
			}
		}
	} catch {
		// ignore — fresh start if file missing or corrupt
	}
}

// ─── Exported maps for testing ─────────────────────────────────────

export { domainMemory, engineMemory };
