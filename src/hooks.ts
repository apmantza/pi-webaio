// ─── Lifecycle hook registry ─────────────────────────────────────────
// Loads user-defined hook modules from ~/.pi/agent/webaio/hooks/ at startup.
// Each module exports a `pattern` glob matched against the full URL, plus
// optional `afterFetch` and `afterExtract` callbacks.
// Hooks must NEVER throw — errors are caught, logged, and the hook is skipped.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PullResult } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface AfterFetchCtx {
	status: number;
	headers: Record<string, string>;
	html: string;
}

interface UserHookModule {
	pattern: string;
	afterFetch?: (
		url: string,
		ctx: AfterFetchCtx,
	) => string | null | undefined | Promise<string | null | undefined>;
	afterExtract?: (
		url: string,
		result: PullResult,
	) => PullResult | null | undefined | Promise<PullResult | null | undefined>;
}

interface RegisteredHook {
	pattern: string;
	filePath: string;
	afterFetch?: UserHookModule["afterFetch"];
	afterExtract?: UserHookModule["afterExtract"];
}

// ─── Minimal glob matcher (supports * and ** over URL strings) ───────

function globToRegex(pattern: string): RegExp {
	let src = "";
	let i = 0;
	// Bound the pattern size so a pathological glob cannot build a
	// pathological regex (opengrep ReDoS hardening); globs are config-file
	// inputs but the guard is cheap.
	const maxLen = 4096;
	while (i < pattern.length && i < maxLen) {
		if (pattern[i] === "*" && pattern[i + 1] === "*") {
			src += ".*";
			i += 2;
			if (pattern[i] === "/") i++;
		} else if (pattern[i] === "*") {
			src += "[^/]*";
			i++;
		} else {
			src += pattern[i]!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i++;
		}
	}
	return new RegExp(`^${src}$`);
}

function matchGlob(pattern: string, url: string): boolean {
	try {
		return globToRegex(pattern).test(url);
	} catch {
		return false;
	}
}

// ─── State ───────────────────────────────────────────────────────────

let _hooks: RegisteredHook[] = [];

// ─── Validation ──────────────────────────────────────────────────────

function validate(mod: unknown): UserHookModule | string {
	if (!mod || typeof mod !== "object") {
		return "export is not an object";
	}
	const m = mod as Record<string, unknown>;
	if (typeof m.pattern !== "string" || m.pattern.trim() === "") {
		return 'missing or empty string field "pattern"';
	}
	if (m.afterFetch !== undefined && typeof m.afterFetch !== "function") {
		return '"afterFetch" must be a function if present';
	}
	if (m.afterExtract !== undefined && typeof m.afterExtract !== "function") {
		return '"afterExtract" must be a function if present';
	}
	// SAFETY: The checks above validate every required field and callback before this cast.
	return m as unknown as UserHookModule;
}

// ─── Loader ──────────────────────────────────────────────────────────

function resolveHooksDir(override?: string): string {
	if (override) return resolve(override);
	if (process.env.PI_WEBAIO_USER_HOOKS_DIR) {
		return resolve(process.env.PI_WEBAIO_USER_HOOKS_DIR);
	}
	return join(homedir(), ".pi", "agent", "webaio", "hooks");
}

/**
 * Load hook modules from the config directory and register them.
 * Safe to call multiple times; subsequent calls replace the previous set.
 *
 * @param dirPath Optional override for the config directory path (for tests).
 */
export async function initUserHooks(dirPath?: string): Promise<void> {
	const dir = resolveHooksDir(dirPath);
	let entries: string[];

	try {
		entries = await readdir(dir);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			_hooks = [];
			return;
		}
		console.error(
			`[pi-webaio] Cannot read hooks directory ${dir}: ${(err as Error).message}`,
		);
		_hooks = [];
		return;
	}

	const files = entries
		.filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
		.map((f) => join(dir, f));

	const loaded: RegisteredHook[] = [];

	for (const filePath of files) {
		let rawMod: unknown;
		try {
			rawMod = await import(pathToFileURL(filePath).href);
		} catch (err) {
			console.error(
				`[pi-webaio] Failed to import hook ${filePath}: ${(err as Error).message}`,
			);
			continue;
		}

		const candidate =
			(rawMod as Record<string, unknown>).default ??
			(rawMod as Record<string, unknown>).hook ??
			rawMod;

		const result = validate(candidate);
		if (typeof result === "string") {
			console.error(`[pi-webaio] Skipping hook ${filePath}: ${result}`);
			continue;
		}

		loaded.push({
			pattern: result.pattern,
			filePath,
			afterFetch: result.afterFetch,
			afterExtract: result.afterExtract,
		});
	}

	_hooks = loaded;
}

/**
 * Returns a copy of the currently registered hooks (for tests/diagnostics).
 */
export function getUserHooks(): RegisteredHook[] {
	return [..._hooks];
}

// ─── Runner: afterFetch ───────────────────────────────────────────────

/**
 * Run all matching afterFetch hooks in load order.
 * Each hook receives the output of the previous one.
 * Throwing hooks are skipped with a console.error.
 */
export async function runAfterFetchHooks(
	url: string,
	ctx: AfterFetchCtx,
): Promise<string> {
	if (_hooks.length === 0) return ctx.html;
	let html = ctx.html;
	for (const hook of _hooks) {
		if (!hook.afterFetch) continue;
		if (!matchGlob(hook.pattern, url)) continue;
		try {
			const out = await hook.afterFetch(url, { ...ctx, html });
			if (out != null) html = out;
		} catch (err) {
			console.error(
				`[pi-webaio] afterFetch hook ${hook.filePath} threw for ${url}: ${(err as Error).message}`,
			);
		}
	}
	return html;
}

// ─── Runner: afterExtract ─────────────────────────────────────────────

/**
 * Run all matching afterExtract hooks in load order.
 * Each hook receives the output of the previous one.
 * Throwing hooks are skipped with a console.error.
 */
export async function runAfterExtractHooks(
	url: string,
	result: PullResult,
): Promise<PullResult> {
	if (_hooks.length === 0) return result;
	let current = result;
	for (const hook of _hooks) {
		if (!hook.afterExtract) continue;
		if (!matchGlob(hook.pattern, url)) continue;
		try {
			const out = await hook.afterExtract(url, current);
			if (out != null) current = out;
		} catch (err) {
			console.error(
				`[pi-webaio] afterExtract hook ${hook.filePath} threw for ${url}: ${(err as Error).message}`,
			);
		}
	}
	return current;
}
