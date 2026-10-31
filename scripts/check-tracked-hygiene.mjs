#!/usr/bin/env node
// ─── Tracked-artifact hygiene gate (issue #165, F5) ─────────────────
//
// The previous gate enumerated known-bad names (`inspirat|observability-gaps|
// perf-improvements`). That is the shape that always misses the next spelling:
// this repo shipped a committed `aio-webresearch` bundle (`research-paramtest/`,
// 14 files) plus `speed.md`, `newfeatures.md`, `implementationplan.md`,
// `roadmap_0_5.md` and `test-youtube.mjs`, none of which matched it.
//
// The gate now admits a short list of known-good forms and refuses everything
// else — anything unrecognised is a violation, so a new scratch file or a new
// top-level directory fails CI until it is deliberately allow-listed here.
//
// Runnable locally (`node scripts/check-tracked-hygiene.mjs`) and unit-tested
// against fixture lists, so the gate itself has a detector.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Tracked files that belong at the repository root. */
export const ALLOWED_ROOT_FILES = new Set([
	".gitignore",
	"AGENTS.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"LICENSE",
	"README.md",
	"ROADMAP.md",
	"banner.png",
	"banner.svg",
	"index.ts",
	"knip.json",
	"package-lock.json",
	"package.json",
	"pi-entry.mjs",
	"sonar-project.properties",
	"tsconfig.dist.json",
	"tsconfig.json",
	"tsconfig_strict.json",
]);

/** Tracked directories that belong at the repository root. */
export const ALLOWED_TOP_DIRS = new Set([
	".github",
	"bin",
	"docs",
	"extractors",
	"scripts",
	"src",
	"tests",
	"tla",
	"types",
]);

/**
 * Internal-note name shapes, checked at ANY depth and ANY extension.
 *
 * Kept deliberately, alongside the allow-list rather than replaced by it: the
 * allow-list only judges top-level structure, so `docs/inspiration7.md` or
 * `src/notes/inspiration.txt` would pass it. The two checks cover different
 * axes — this one catches the known class by name wherever it hides, the
 * allow-list catches the unknown class by refusing unfamiliar roots.
 */
export const INTERNAL_NOTE_PATTERN = /inspirat|observability-gaps|perf-improvements/i;

/**
 * Split a tracked-path list into violations. Case is significant: an
 * allow-list that matched case-insensitively would let `SPEED.MD` through.
 */
export function findViolations(paths) {
	const unknownRootFiles = [];
	const unknownRootDirs = new Set();
	const internalNotes = [];
	for (const raw of paths) {
		const p = String(raw ?? "").trim();
		if (!p) continue;
		if (INTERNAL_NOTE_PATTERN.test(p)) internalNotes.push(p);
		const idx = p.indexOf("/");
		if (idx === -1) {
			if (!ALLOWED_ROOT_FILES.has(p)) unknownRootFiles.push(p);
			continue;
		}
		const top = p.slice(0, idx);
		if (!ALLOWED_TOP_DIRS.has(top)) unknownRootDirs.add(top);
	}
	return {
		unknownRootFiles: unknownRootFiles.sort(),
		unknownRootDirs: [...unknownRootDirs].sort(),
		internalNotes: internalNotes.sort(),
	};
}

export function listTrackedFiles(cwd) {
	// Failure here is a hard error, never "clean": a gate that cannot read the
	// index must not report success.
	return execFileSync("git", ["ls-files"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	})
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function main({ cwd = process.cwd() } = {}) {
	let files;
	try {
		files = listTrackedFiles(cwd);
	} catch (err) {
		console.error(
			`::error::git ls-files failed; refusing to report clean. ${err?.message ?? err}`,
		);
		return 1;
	}
	const { unknownRootFiles, unknownRootDirs, internalNotes } = findViolations(files);
	if (
		unknownRootFiles.length === 0 &&
		unknownRootDirs.length === 0 &&
		internalNotes.length === 0
	) {
		console.log(
			`Tracked-artifact hygiene OK (${files.length} paths, root allow-list respected).`,
		);
		return 0;
	}
	console.error(
		"::error::Tracked files outside the published allow-list. Internal notes, scratch logs and research bundles must stay untracked (see the Internal-docs policy in AGENTS.md).",
	);
	for (const f of unknownRootFiles) console.error(`  unexpected root file: ${f}`);
	for (const d of unknownRootDirs)
		console.error(`  unexpected top-level directory: ${d}/`);
	for (const n of internalNotes)
		console.error(`  internal research note tracked: ${n}`);
	console.error(
		"  Fix: git rm --cached <path> and add it to .gitignore, or add it to ALLOWED_ROOT_FILES / ALLOWED_TOP_DIRS in scripts/check-tracked-hygiene.mjs if it genuinely belongs in the repo.",
	);
	return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exit(main());
}
