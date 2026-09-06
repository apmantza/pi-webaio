/**
 * config.ts — pi-webaio user config loader
 *
 * Config sources, checked in order (first wins):
 *   1. `~/.piwebaio/config` — JSON file with dotted keys (e.g. `tinyfish.apiKey`)
 *   2. `~/.piwebaio/.env` — key=value lines (e.g. `TINYFISH_API_KEY=sk-...`)
 *   3. Environment variables (e.g. `TINYFISH_API_KEY`)
 *
 * JSON config format (~/.piwebaio/config):
 *   {
 *     "tinyfish": {
 *       "apiKey": "sk-tinyfish-..."
 *     },
 *     "firecrawl": {
 *       "apiKey": "fc-..."
 *     },
 *     "parallel": {
 *       "apiKey": "..."
 *     }
 *   }
 *
 * .env format (~/.piwebaio/.env):
 *   TINYFISH_API_KEY=sk-tinyfish-...
 *   FIRECRAWL_API_KEY=fc-...
 *   PARALLEL_API_KEY=...
 */

import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debug } from "./debug.ts";

// ─── Paths ─────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".piwebaio");

let overrideConfigPath: string | null = null;

/** For testing: override the config directory. */
export function setConfigDir(dir: string): void {
	cachedJson = null;
	cachedEnv = null;
	overrideConfigPath = dir;
}

function configDir(): string {
	return overrideConfigPath ?? CONFIG_DIR;
}

// ─── JSON config (~/.piwebaio/config) ──────────────────────────────

interface UserConfig {
	tinyfish?: {
		apiKey?: string;
	};
	firecrawl?: {
		apiKey?: string;
	};
	parallel?: {
		apiKey?: string;
	};
}

let cachedJson: UserConfig | null = null;

function loadJsonConfig(): UserConfig {
	if (cachedJson) return cachedJson;

	const path = join(configDir(), "config");
	try {
		accessSync(path, constants.R_OK);
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as UserConfig;
		cachedJson = parsed;
		debug("config", `loaded JSON from ${path}`);
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			debug("config", `no JSON config at ${path} (ok)`);
		} else {
			debug("config", `error reading ${path}: ${String(err)}`);
		}
		cachedJson = {};
		return cachedJson;
	}
}

// ─── .env file (~/.piwebaio/.env) ──────────────────────────────────

let cachedEnv: Record<string, string> | null = null;

function loadDotEnv(): Record<string, string> {
	if (cachedEnv) return cachedEnv;

	const path = join(configDir(), ".env");
	const values: Record<string, string> = {};
	try {
		accessSync(path, constants.R_OK);
		const raw = readFileSync(path, "utf-8");
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx === -1) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			let val = trimmed.slice(eqIdx + 1).trim();
			// Strip surrounding quotes
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			if (key) values[key] = val;
		}
		debug("config", `loaded ${Object.keys(values).length} vars from ${path}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			debug("config", `error reading ${path}: ${String(err)}`);
		}
	}
	cachedEnv = values;
	return values;
}

// ─── Public API ────────────────────────────────────────────────────

/** Get a JSON config value by dotted key path, e.g. "tinyfish.apiKey". */
export function getConfig<T>(key: string, fallback?: T): T | undefined {
	const config = loadJsonConfig();
	const parts = key.split(".");
	let val: unknown = config;
	for (const part of parts) {
		if (
			val &&
			typeof val === "object" &&
			part in (val as Record<string, unknown>)
		) {
			val = (val as Record<string, unknown>)[part];
		} else {
			return fallback;
		}
	}
	return (val as T) ?? fallback;
}

/**
 * Resolve the TinyFish API key, checked in order:
 *   1. `~/.piwebaio/config` JSON (`tinyfish.apiKey`)
 *   2. `~/.piwebaio/.env` (`TINYFISH_API_KEY=...`)
 *   3. `TINYFISH_API_KEY` environment variable
 */
export function resolveTinyfishConfigKey(): string | null {
	const fromJson = getConfig<string>("tinyfish.apiKey");
	if (fromJson) return fromJson;
	const fromEnv = loadDotEnv();
	if (fromEnv.TINYFISH_API_KEY) return fromEnv.TINYFISH_API_KEY;
	return process.env.TINYFISH_API_KEY ?? null;
}

/**
 * Resolve the FireCrawl API key, checked in order:
 *   1. `~/.piwebaio/config` JSON (`firecrawl.apiKey`)
 *   2. `~/.piwebaio/.env` (`FIRECRAWL_API_KEY=...`)
 *   3. `FIRECRAWL_API_KEY` environment variable
 */
export function resolveFirecrawlConfigKey(): string | null {
	const fromJson = getConfig<string>("firecrawl.apiKey");
	if (fromJson) return fromJson;
	const fromEnv = loadDotEnv();
	if (fromEnv.FIRECRAWL_API_KEY) return fromEnv.FIRECRAWL_API_KEY;
	return process.env.FIRECRAWL_API_KEY ?? null;
}

/**
 * Resolve the Parallel API key, checked in order:
 *   1. `~/.piwebaio/config` JSON (`parallel.apiKey`)
 *   2. `~/.piwebaio/.env` (`PARALLEL_API_KEY=...`)
 *   3. `PARALLEL_API_KEY` environment variable
 */
export function resolveParallelConfigKey(): string | null {
	const fromJson = getConfig<string>("parallel.apiKey");
	if (fromJson) return fromJson;
	const fromEnv = loadDotEnv();
	if (fromEnv.PARALLEL_API_KEY) return fromEnv.PARALLEL_API_KEY;
	return process.env.PARALLEL_API_KEY ?? null;
}
