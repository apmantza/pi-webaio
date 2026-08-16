// ─── User-defined vertical extractor loader ─────────────────────────
// Loads .mjs modules from ~/.pi/agent/webaio/verticals/ at startup.
// Each module must default-export (or named-export `extractor`) an object
// conforming to UserExtractorModule. Invalid modules are skipped with a
// warning; a missing directory is silently ignored.
//
// SECURITY: Files in the config directory are executed as arbitrary ESM
// with the full privileges of the pi-webaio agent process. Only place
// modules there that you trust completely.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VerticalResult } from "./types.ts";

// ─── Public contract ────────────────────────────────────────────────

interface UserExtractorModule {
	/** A short identifier shown in the "via <name>" attribution line. */
	name: string;
	/** Returns true when this extractor should handle the given URL. */
	match: (url: string) => boolean;
	/**
	 * Perform the extraction.  Receives lightweight fetch helpers so the
	 * module doesn't need to import anything from the host package.
	 */
	extract: (
		url: string,
		fetchJson: (url: string) => Promise<unknown | null>,
		fetchText: (url: string) => Promise<string | null>,
		fetchHtml: (url: string) => Promise<string | null>,
	) => Promise<VerticalResult | null>;
}

export interface RegisteredUserExtractor {
	name: string;
	filePath: string;
	/**
	 * The user module's `match` export. Named `matchUrl` internally so call
	 * sites don't read as `String.prototype.match` (CodeQL flags `u.match(url)`
	 * as a string-to-RegExp coercion).
	 */
	matchUrl: (url: string) => boolean;
	extract: UserExtractorModule["extract"];
}

// ─── Validation ──────────────────────────────────────────────────────

function validate(mod: unknown): UserExtractorModule | string {
	if (!mod || typeof mod !== "object") {
		return "default export is not an object";
	}
	const m = mod as Record<string, unknown>;

	if (typeof m.name !== "string" || m.name.trim() === "") {
		return 'missing or empty string field "name"';
	}
	if (typeof m.match !== "function") {
		return 'missing or non-function field "match"';
	}
	if (typeof m.extract !== "function") {
		return 'missing or non-function field "extract"';
	}

	// Smoke-test: match() must not throw on a plain URL string
	try {
		m.match("https://example.com/");
	} catch (err) {
		return `match() threw on a test URL: ${(err as Error).message}`;
	}

	return m as unknown as UserExtractorModule;
}

// ─── Loader ──────────────────────────────────────────────────────────

/**
 * Default config directory: ~/.pi/agent/webaio/verticals/
 * Override by passing a dirPath or setting PI_WEBAIO_USER_VERTICALS_DIR
 * (useful for tests).
 */
function resolveUserVerticalsDir(override?: string): string {
	if (override) return resolve(override);
	if (process.env.PI_WEBAIO_USER_VERTICALS_DIR) {
		return resolve(process.env.PI_WEBAIO_USER_VERTICALS_DIR);
	}
	return join(homedir(), ".pi", "agent", "webaio", "verticals");
}

/**
 * Load all .mjs user extractor modules from the given directory.
 * Returns an array of validated extractors ready for registration.
 * Never throws — all errors are logged as warnings.
 */
export async function loadUserExtractors(
	dirPath?: string,
): Promise<RegisteredUserExtractor[]> {
	const dir = resolveUserVerticalsDir(dirPath);
	let entries: string[];

	try {
		entries = await readdir(dir);
	} catch (err: unknown) {
		// Missing directory is the common case — skip silently
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		// Any other FS error (permission, etc.) — warn and continue
		console.warn(
			`[user-verticals] Cannot read directory ${dir}: ${(err as Error).message}`,
		);
		return [];
	}

	const mjsFiles = entries
		.filter((f) => f.endsWith(".mjs"))
		.map((f) => join(dir, f));

	const loaded: RegisteredUserExtractor[] = [];

	for (const filePath of mjsFiles) {
		let rawMod: unknown;
		try {
			rawMod = await import(pathToFileURL(filePath).href);
		} catch (err) {
			console.warn(
				`[user-verticals] Failed to import ${filePath}: ${(err as Error).message}`,
			);
			continue;
		}

		// Support both default export and named `extractor` export
		const candidate =
			(rawMod as Record<string, unknown>).default ??
			(rawMod as Record<string, unknown>).extractor;

		const result = validate(candidate);
		if (typeof result === "string") {
			console.warn(`[user-verticals] Skipping ${filePath}: ${result}`);
			continue;
		}

		loaded.push({
			name: result.name,
			filePath,
			matchUrl: result.match,
			extract: result.extract,
		});
	}

	return loaded;
}
