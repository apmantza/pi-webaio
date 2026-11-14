// ─── On-disk cache location + bounded heavy-artifact sweep ─────────
// Single seam for where pi-webaio's persistent disk cache lives (issue #221).
//
// The cache used to live under os.tmpdir()/pi-webaio, which on Linux is
// usually RAM-backed tmpfs: nothing ever swept it, and the 2026-11-06
// measurement found 2.3 GB (2,344 MB of it github clones) pinning RAM and a
// full 8 GB swap. This module relocates the cache to the platform cache dir
// and bounds the heavy artifacts that caused the leak.
//
// Precedence (mirrors bin/chrome-profile.mjs's override contract):
//   PI_WEBAIO_CACHE_DIR unset or blank → platform default (below);
//   absolute path (or ~ expansion) → honored;
//   relative or garbage → throws. Fail closed: a half-applied override would
//   split the cache across two roots.
//
// Platform defaults:
//   Linux:   $XDG_CACHE_HOME/pi-webaio (default ~/.cache/pi-webaio)
//   macOS:   ~/Library/Caches/pi-webaio
//   Windows: %LOCALAPPDATA%\pi-webaio

import { readdir, rm, stat } from "node:fs/promises";
import { debug } from "./debug.ts";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

export const CACHE_DIR_ENV = "PI_WEBAIO_CACHE_DIR";

function defaultCacheDir() {
	const os = platform();
	const home = homedir();
	if (os === "darwin") return join(home, "Library", "Caches", "pi-webaio");
	if (os === "win32") {
		const localAppData =
			process.env.LOCALAPPDATA || join(home, "AppData", "Local");
		return join(localAppData, "pi-webaio");
	}
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".cache");
	return join(base, "pi-webaio");
}

export function resolveCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CACHE_DIR_ENV];
	if (override === undefined || override.trim() === "") {
		return defaultCacheDir();
	}
	let candidate = override.trim();
	// Bare ~ and ~/ or ~\ prefixes expand (shells expand them, but env set
	// via systemd units / CI / APIs does not). ~user is deliberately not
	// supported — same rule as chrome-profile.
	if (
		candidate === "~" ||
		candidate.startsWith("~/") ||
		candidate.startsWith("~\\")
	) {
		candidate = join(homedir(), candidate.slice(1).replace(/^[/\\]+/, ""));
	}
	if (!isAbsolute(candidate)) {
		throw new Error(
			`${CACHE_DIR_ENV} must be an absolute path (got: "${override}"); ` +
				"unset it to use the platform cache dir",
		);
	}
	return candidate;
}

export const CACHE_DIR = resolveCacheDir();

/** The cache root. Canonical home of the constant that session-store used to
 * own; session-store re-exports it for its existing importers. */
export const BASE_TEMP = CACHE_DIR;

// ─── Heavy-artifact sweep ──────────────────────────────────────────
//
// Bounds ONLY the artifacts that caused the leak: github clones, github-maps
// clones, actions logs, and downloads (2026-11-06: 2,344 MB — all clones).
//
// NOT swept, deliberately: content-cache .md files and pulled corpora are
// persistent by design — `aio-webcontent` survives restarts through them, and
// `aio-webpull` corpora are user artifacts that `aio-webquery` indexes. A
// blanket disk TTL would delete user data (the host-named corpus dirs and the
// content cache share one tree), so the disk layer keeps its restart-survival
// contract; only heavy artifacts age out.

export const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SWEEP_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
export const SWEEP_DIR_NAMES = [
	"github",
	"github-maps",
	"github-logs",
	"downloads",
] as const;

/** Per-entry walk bound: a clone with more files than this is counted as-is. */
const MAX_FILES_PER_ENTRY = 20_000;

export interface SweepSummary {
	/** Entries (files/dirs) removed. */
	removed: number;
	/** Approximate bytes reclaimed. */
	bytes: number;
	/** Entries removed only because the size cap was exceeded (LRU). */
	capped: number;
}

async function entrySize(path: string): Promise<number> {
	let total = 0;
	const stack = [path];
	let visited = 0;
	while (stack.length > 0) {
		if (visited++ >= MAX_FILES_PER_ENTRY) break;
		const current = stack.pop()!;
		let st: import("node:fs").Stats;
		try {
			st = await stat(current);
		} catch {
			continue;
		}
		if (st.isFile()) {
			total += st.size;
		} else if (st.isDirectory()) {
			try {
				for (const name of await readdir(current)) {
					stack.push(join(current, name));
				}
			} catch {
				// unreadable subdir — count what we can
			}
		}
	}
	return total;
}

/**
 * One bounded sweep over `baseTemp`'s heavy-artifact subdirs. Age-expire
 * entries older than maxAgeMs, then LRU-evict (oldest mtime first) until the
 * remaining total is under maxBytes. Returns the summary and emits exactly
 * one debug line per run (#221 observability requirement). Never throws.
 */
export async function sweepHeavyArtifacts(
	baseTemp: string = CACHE_DIR,
	opts: {
		maxAgeMs?: number;
		maxBytes?: number;
		now?: number;
		sweep?: (path: string) => Promise<void>;
	} = {},
): Promise<SweepSummary> {
	const maxAgeMs = opts.maxAgeMs ?? SWEEP_MAX_AGE_MS;
	const maxBytes = opts.maxBytes ?? SWEEP_MAX_BYTES;
	const now = opts.now ?? Date.now();
	const sweepDir =
		opts.sweep ??
		((path: string) =>
			rm(path, { recursive: true, force: true }).then(() => {}));

	const summary: SweepSummary = { removed: 0, bytes: 0, capped: 0 };

	interface Entry {
		path: string;
		mtimeMs: number;
		size?: number;
	}
	const survivors: Entry[] = [];

	// Pass 1 — age-expire per swept dir, collect survivors.
	for (const name of SWEEP_DIR_NAMES) {
		const dir = join(baseTemp, name);
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const entryName of names) {
			const entryPath = join(dir, entryName);
			let st: import("node:fs").Stats;
			try {
				st = await stat(entryPath);
			} catch {
				continue;
			}
			const age = now - st.mtimeMs;
			if (age > maxAgeMs) {
				try {
					await sweepDir(entryPath);
					summary.removed++;
				} catch {
					// best-effort sweep; a stuck entry is swept next run
				}
				continue;
			}
			survivors.push({ path: entryPath, mtimeMs: st.mtimeMs });
		}
	}

	// Pass 2 — one TOTAL size cap across every swept dir (issue #221: the
	// 2.3 GB was clones in one dir; a per-dir cap would still allow 4 × cap).
	// LRU-evict oldest-first until under budget.
	let total = 0;
	for (const entry of survivors) {
		entry.size = await entrySize(entry.path);
		total += entry.size;
	}
	survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const entry of survivors) {
		if (total <= maxBytes) break;
		try {
			await sweepDir(entry.path);
			summary.removed++;
			summary.capped++;
			total -= entry.size ?? 0;
		} catch {
			break; // cannot reclaim this entry; stop rather than loop
		}
	}

	const mb = Math.round(summary.bytes / (1024 * 1024));
	debug(`cache sweep: removed ${summary.removed} entries under ${baseTemp}`);
	if (summary.removed > 0) {
		debug(
			`cache sweep detail: ${summary.capped} evicted by the ${Math.round(maxBytes / (1024 * 1024))} MB cap (${mb} MB reclaimed)`,
		);
	}
	return summary;
}
