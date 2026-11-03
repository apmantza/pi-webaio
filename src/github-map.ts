// ─── GitHub repo mapping (aio-webmap GitHub support) ──────────────────
//
// `aio-webmap` historically fell back to sitemap/nav/crawl when given a
// GitHub URL, which produced a useless map of GitHub.com's explore pages
// instead of the actual repo. This module provides a GitHub-native
// alternative that:
//
//   1. Clones (or fallbacks to API contents listing) for repo URLs
//   2. Builds a file tree with architecture signals (CI, tests, package mgrs)
//   3. Lists issues, PRs, releases, tags, workflows via the GitHub API
//   4. Returns URLs grouped by discovery source (matches the existing
//      aio-webmap output shape: `sources` field on details)
//
// The map intentionally does NOT fetch file contents — that's what
// aio-webfetch is for. The map tells the agent what's in the repo so
// it can plan subsequent aio-webfetch calls.

import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ghFetch, getGithubToken, ghFetchWithFallback } from "./github-api.ts";
import { BASE_TEMP } from "./session-store.ts";
import { resolveBinary } from "./tools/utils.ts";
import type { FetchOpts } from "./types.ts";

// ─── Types ────────────────────────────────────────────────────────────

/** A structured view of a GitHub URL suitable for mapping. */
export type GitHubMapRef =
	| { kind: "repo"; owner: string; repo: string }
	| { kind: "tree"; owner: string; repo: string; ref: string; path: string }
	| { kind: "blob"; owner: string; repo: string; ref: string; path: string }
	| {
			kind: "feature";
			owner: string;
			repo: string;
			feature: string;
			/** Optional sub-path (e.g. /issues/123, /pull/45, /releases/tag/v1) */
			sub?: string[];
	  };

/** A single feature URL returned from the API listing. */
interface FeatureLink {
	url: string;
	title: string;
	number?: number;
	state?: string;
}

/** Result returned by mapGitHubRepo(). */
export interface GitHubMapResult {
	ok: boolean;
	url: string;
	source: "repo-clone" | "github-api" | "github-api+clone" | "error";
	/** All discovered URLs (flat list — matches existing aio-webmap shape). */
	urls: string[];
	/** URLs grouped by discovery source. */
	sources: Record<string, string[]>;
	/** Markdown file tree (only for `repo-clone` and `tree` kinds). */
	treeMarkdown?: string;
	/** Architecture signals (only for `repo-clone`). */
	architecture?: string;
	/** Repo metadata (only for `repo` kind). */
	repo?: {
		owner: string;
		repo: string;
		ref: string;
		totalFiles: number;
		totalDirs: number;
		/**
		 * What those two totals mean: they count what was COLLECTED, not what the
		 * repository holds. Without this a structured consumer sees a bare number where
		 * the human summary carries a qualifier, so a root-only listing, a capped clone
		 * and a failed collection all read as repository totals (#184 verify round).
		 */
		coverage?: { scope: "recursive" | "root"; bound?: "api-truncated" | "walk-cap" | "read-error" };
		description?: string;
		topics?: string[];
		language?: string;
		stars?: number;
		forks?: number;
		license?: string;
		defaultBranch?: string;
		cloned?: boolean;
		clonePath?: string;
	};
	/** A short, human-readable summary of the map. */
	summary: string;
	error?: string;
}

// ─── URL parsing ─────────────────────────────────────────────────────

const GITHUB_HOSTS = new Set([
	"github.com",
	"www.github.com",
	"gist.github.com",
	"raw.githubusercontent.com",
]);

/** Returns true if the URL points at GitHub.com (any sub-page). */
export function isGitHubUrl(input: string): boolean {
	try {
		const u = new URL(input);
		return GITHUB_HOSTS.has(u.hostname.toLowerCase());
	} catch {
		return false;
	}
}

/**
 * Parse a GitHub URL into a typed ref. Returns null for URLs that don't
 * have a recognizable shape (raw.githubusercontent.com blob URLs are
 * returned as "blob" so they can be mapped to a single file).
 */
export function parseGitHubMapUrl(url: string): GitHubMapRef | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (!GITHUB_HOSTS.has(u.hostname.toLowerCase())) return null;

	// raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
	if (u.hostname.toLowerCase() === "raw.githubusercontent.com") {
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 4) return null;
		// Use explicit indexing — the leading-hole destructuring
		// (`const [, a, b] = parts`) doesn't survive every TS-to-JS
		// transform cleanly across Node versions.
		const owner = parts[0] ?? "";
		const repo = parts[1] ?? "";
		const ref = parts[2] ?? "HEAD";
		const pathParts = parts.slice(3);
		return {
			kind: "blob",
			owner,
			repo,
			ref,
			path: pathParts.join("/"),
		};
	}

	const parts = u.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	const owner = parts[0] ?? "";
	const repo = parts[1] ?? "";
	const third = parts[2];
	const rest = parts.slice(3);

	if (!third) {
		return { kind: "repo", owner, repo };
	}
	if (third === "tree") {
		const ref = rest[0] ?? "HEAD";
		const path = rest.slice(1).join("/");
		return { kind: "tree", owner, repo, ref, path };
	}
	if (third === "blob") {
		const ref = rest[0] ?? "HEAD";
		const path = rest.slice(1).join("/");
		return { kind: "blob", owner, repo, ref, path };
	}
	// Feature page: issues, pulls, actions, releases, tags, etc.
	return { kind: "feature", owner, repo, feature: third, sub: rest };
}

// ─── Architecture detection (matches src/github-pipeline.ts) ─────────

const CI_PATTERNS: [RegExp, string][] = [
	[/^\.github\/workflows\//, "GitHub Actions"],
	[/^\.gitlab-ci\.yml$/, "GitLab CI"],
	[/^Jenkinsfile$/, "Jenkins"],
	[/^\.circleci\//, "CircleCI"],
	[/^\.travis\.yml$/, "Travis CI"],
	[/^azure-pipelines\.yml$/, "Azure Pipelines"],
	[/^bitbucket-pipelines\.yml$/, "Bitbucket Pipelines"],
];

const TEST_PATTERNS: [RegExp, string][] = [
	[/^jest\.config\./, "Jest"],
	[/^vitest\.config\./, "Vitest"],
	[/^playwright\.config\./, "Playwright"],
	[/^cypress\.config\./, "Cypress"],
	[/^(.*\/)?conftest\.py$/, "pytest"],
	[/^pytest\.ini$/, "pytest"],
	[/^\.mocharc\./, "Mocha"],
	[/^karma\.conf\./, "Karma"],
];

const MONOREPO_PATTERNS: [RegExp, string][] = [
	[/^lerna\.json$/, "Lerna"],
	[/^nx\.json$/, "Nx"],
	[/^turbo\.json$/, "Turborepo"],
	[/^pnpm-workspace\.yaml$/, "pnpm workspaces"],
	[/^rush\.json$/, "Rush"],
];

const LOCKFILE_MAP: Record<string, string> = {
	"package-lock.json": "npm",
	"yarn.lock": "yarn",
	"pnpm-lock.yaml": "pnpm",
	"bun.lockb": "bun",
	"uv.lock": "uv",
	"poetry.lock": "poetry",
	"Pipfile.lock": "pipenv",
	"Cargo.lock": "cargo",
	"Gemfile.lock": "bundler",
};

function matched(patterns: [RegExp, string][], paths: string[]): string[] {
	const found = new Set<string>();
	for (const p of paths) {
		for (const [re, label] of patterns) {
			if (re.test(p)) found.add(label);
		}
	}
	return [...found];
}

/**
 * Detect architecture signals from a repo path list.
 *
 * The list is the repo-map representation, which since #184 carries directories as
 * well as files. Every signal below except `hasTestDir` is a claim about a FILE
 * (a workflow, a config, a lockfile, a Dockerfile), so each one reads `files`
 * only. Handing directories to those regexes invented signals: a
 * `jest.config.assets/` directory established Jest, and a `.github/workflows/`
 * directory whose only contents were excluded images established GitHub Actions
 * (review of PR #191). Directory presence remains the right evidence for the one
 * label that means "a test directory exists", so `hasTestDir` reads the whole list.
 *
 * Pure function — exported for unit testing.
 */
export function detectArchitectureSignals(paths: string[]): string {
	const lines: string[] = [];
	const files = paths.filter((p) => !p.endsWith("/"));

	if (
		files.some((p) =>
			/^(Dockerfile|docker-compose\.(yml|yaml)|\.dockerignore)$/.test(p),
		)
	)
		lines.push("- 🐳 **Docker:** yes");

	const ciCd = matched(CI_PATTERNS, files);
	if (ciCd.length) lines.push(`- 🔄 **CI/CD:** ${ciCd.join(", ")}`);

	const tests = matched(TEST_PATTERNS, files);
	const hasTestDir = paths.some(
		(p) =>
			p.startsWith("__tests__/") ||
			p.startsWith("tests/") ||
			p.startsWith("test/") ||
			p.startsWith("spec/"),
	);
	if (hasTestDir && !tests.length) tests.push("(test dir present)");
	if (tests.length) lines.push(`- 🧪 **Tests:** ${tests.join(", ")}`);

	const monorepo = matched(MONOREPO_PATTERNS, files);
	const pkgJsons = files.filter((p) => p.endsWith("/package.json"));
	if (pkgJsons.length > 1 && !monorepo.length) monorepo.push("multi-package");
	if (monorepo.length) lines.push(`- 📦 **Monorepo:** ${monorepo.join(", ")}`);

	const pms = new Set<string>();
	for (const [file, pm] of Object.entries(LOCKFILE_MAP)) {
		if (files.some((p) => p === file || p.endsWith(`/${file}`))) pms.add(pm);
	}
	if (pms.size) lines.push(`- 📋 **Package managers:** ${[...pms].join(", ")}`);

	const secSignals: string[] = [];
	if (files.some((p) => p === "SECURITY.md")) secSignals.push("SECURITY.md");
	if (files.some((p) => p === ".env")) secSignals.push("⚠ .env committed");
	if (
		files.some(
			(p) => p === ".github/dependabot.yml" || p === ".github/dependabot.yaml",
		)
	)
		secSignals.push("Dependabot");
	if (secSignals.length)
		lines.push(`- 🔒 **Security:** ${secSignals.join(", ")}`);

	if (!lines.length) return "";
	return `\n## Architecture\n\n${lines.join("\n")}\n`;
}

// ─── Tree rendering ──────────────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	type: "file" | "dir";
	children?: TreeNode[];
}

/**
 * Render a tree-shaped object as a Unicode tree string. The shape is
 * `src/github-pipeline.ts`'s `tree()` output style, but cheaper to build
 * (we don't need to walk the filesystem — the caller already collected
 * a flat path list).
 *
 * Exported for unit testing — production callers use `buildTree` then
 * render the result inline.
 */
export function renderTree(root: TreeNode, prefix = ""): string {
	if (!root.children?.length) return "";
	const lines: string[] = [];
	const sorted = [...root.children].sort((a, b) => {
		// dirs first, then alphabetical
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	for (let i = 0; i < sorted.length; i++) {
		const e = sorted[i]!;
		const isLast = i === sorted.length - 1;
		const branch = isLast ? "└── " : "├── ";
		lines.push(`${prefix}${branch}${e.name}${e.type === "dir" ? "/" : ""}`);
		if (e.type === "dir" && e.children?.length) {
			const ext = isLast ? "    " : "│   ";
			lines.push(renderTree(e, prefix + ext));
		}
	}
	return lines.join("\n");
}

/** Build a tree from a flat list of relative paths. */
export function buildTree(paths: string[]): TreeNode {
	const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
	for (const p of paths) {
		const segs = p.split("/").filter(Boolean);
		// A slash-terminated path names a DIRECTORY, not a file whose last segment
		// happens to be its name. Without this, the trailing slash that
		// `contentEntryPaths` carries (and that `countDirs` reads) silently became a
		// file leaf in the rendered tree.
		const lastIsDir = p.endsWith("/");
		let cur = root;
		let acc = "";
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i]!;
			acc = acc ? `${acc}/${seg}` : seg;
			const isFile = i === segs.length - 1 && !lastIsDir;
			cur.children ??= [];
			let next = cur.children.find((c) => c.name === seg);
			if (!next) {
				next = {
					name: seg,
					path: acc,
					type: isFile ? "file" : "dir",
					children: isFile ? undefined : [],
				};
				cur.children.push(next);
			}
			cur = next;
		}
	}
	return root;
}

// ─── File system walking ─────────────────────────────────────────────

interface WalkResult {
	paths: string[];
	files: number;
	dirs: number;
	/**
	 * True when the walk stopped because it reached `maxEntries`, i.e. `paths`
	 * is a LOWER BOUND on the repository's size and must never be presented as
	 * the full tree (issue #173).
	 */
	hitCap: boolean;
	/**
	 * True when a directory could not be read (EACCES, ELOOP, a disappearing path).
	 * The children of that directory were never seen, so `paths` is NOT a complete
	 * enumeration even though the cap was never reached. Until the verify round on
	 * master this was swallowed and the result was still presented as the exact full
	 * tree — the fail-open direction for a coverage claim.
	 */
	readFailed: boolean;
	/**
	 * How many counted entries are symlinks.
	 *
	 * A symlink is a blob in git (mode 120000) — there is no directory-symlink type — so
	 * the recursive trees API counts every one of them and the clone walk must too, or the
	 * same repository reports two totals depending on which source answered (#197). The
	 * count is surfaced rather than folded silently into `files` because the clone summary
	 * has to say what its number included: an unqualified total labelled `exact` is what
	 * made the old undercount arrive with a guarantee attached.
	 */
	symlinks: number;
}

/**
 * Walk a directory recursively, returning all relative paths.
 * Hidden dirs (.git, node_modules, .venv, target, dist, build, etc.)
 * are skipped to keep the tree focused on source.
 */
export async function walkRepo(
	root: string,
	opts: { maxEntries?: number } = {},
): Promise<WalkResult> {
	// No second exclusion list, and no name-based prune set at all. `isExcludedPath` below
	// is the only pruning rule, and it is the same list the API path filters with.
	//
	// A `.git` name-based set was written here first, on the reasoning that `git ls-tree`
	// never lists `.git/` so it could legitimately differ from the shared list. Probing
	// showed the reasoning was wrong and the set was dead: `REPO_PATH_EXCLUSIONS` already
	// carries `".git/"`, and `isExcludedPath(".git/")` is true — so removing the set changed
	// nothing and no mutation of it could fail a test. A guard that cannot be made red does
	// not stay in the file (#200).
	const maxEntries = opts.maxEntries ?? 100_000;
	const paths: string[] = [];
	let files = 0;
	let dirs = 0;
	let symlinks = 0;
	// Set only when a RETAINABLE entry was actually refused. `paths.length >=
	// maxEntries` alone is not that test: a repository with exactly `maxEntries`
	// entries fills the budget and then trips the same comparison, so an exact count
	// was reported as "at least N".
	let dropped = false;
	// Set when a directory could not be read; see `WalkResult.readFailed`.
	let readFailed = false;

	async function walk(dir: string, rel: string): Promise<void> {
		// No early return on `paths.length >= maxEntries` here. The version added in
		// 652e5bd reasoned that a git checkout has no empty directory, so an unvisited
		// directory must hold something that was dropped — true about TRACKED entries,
		// false about RETAINABLE ones. A directory containing only excluded files (e.g.
		// `assets/logo.png`) is non-empty and contributes nothing, so an exact census of
		// one was reported as "at least 1". The per-entry check below is the only place
		// that knows an entry was retainable; reading the directory is the honest cost of
		// not over-claiming.
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			// Swallowing this made a partial enumeration look exact (#184 verify round).
			readFailed = true;
			return;
		}
		// Stable order: dirs first, then alpha
		entries.sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});
		for (const e of entries) {
			// No blanket "starts with `.`" rule. It was a FILESYSTEM instinct (hide dotfiles)
			// applied to a SOURCE repository, where it is wrong: it pruned every dot-prefixed
			// directory except `.github`, so what survived depended on whether a tool happened
			// to name its cache with a leading dot. Measured on `actions/checkout`, it hid exactly
			// 28 of the API's 108 entries — all of them under `.licenses/`, the per-dependency
			// license metadata an agent needs to answer "what does this ship under" — and the
			// total was still labelled exact. `.circleci/` goes the same way in any repository
			// using it. `.github` was already special-cased out of the rule, which is the tell: a
			// rule that needs an exception for the one directory whose contents you want was never
			// about source relevance (#200).
			if (e.isDirectory()) {
				// Directories are entries here exactly as they are in the other two
				// sources (#184 asks that all three obey one convention): slash-terminated,
				// so `repoEntryCensus`, `buildTree` and `repoTreeEntryUrl` read them the same
				// way, and a cloned map reports the same denominators as an API map of the
				// same repository.
				const relDir = rel ? `${rel}/${e.name}` : e.name;
				// The marker comes from the same writer the API admission uses. Written
				// inline here until PR #195 review caught it: neutering the canonical writer
				// left the clone producer still emitting slashes, so the convention had two
				// homes and the census, renderer and URL builder read one of them.
				const relDirPath = canonicalEntryPath(relDir, true);
				// Exclusion BEFORE the cap check and before recursing: an asset file that
				// sorts ahead of the sources used to spend a slot and then be dropped by
				// `mapWalkToCoverage`, so a large repository could end the walk before its
				// real files were reached, and the bound counted entries we keep neither.
				if (isExcludedPath(relDirPath)) continue;
				if (paths.length >= maxEntries) {
					dropped = true;
					continue;
				}
				paths.push(relDirPath);
				dirs++;
				await walk(join(dir, e.name), relDir);
			} else if (e.isFile() || e.isSymbolicLink()) {
				// A symlink is admitted through the SAME door as a file, on purpose. git
				// stores it as a blob (mode 120000) even when it points at a directory, so
				// `git ls-tree -r -t` — the view the recursive trees API serves — lists it as
				// a blob, and counting it anywhere else would split the census again (#197).
				// It is also NOT recursed: `isDirectory()` is false for a symlink, which is what
				// keeps a cycle and ELOOP out of the walk, and git lists the target's children
				// once, under the real directory, not again under the link.
				const relPath = rel ? `${rel}/${e.name}` : e.name;
				if (isExcludedPath(relPath)) continue;
				if (paths.length >= maxEntries) {
					dropped = true;
					continue;
				}
				paths.push(relPath);
				files++;
				if (e.isSymbolicLink()) symlinks++;
			}
		}
	}
	await walk(root, "");
	return { paths, files, dirs, symlinks, hitCap: dropped, readFailed };
}

/**
 * The clone walk's counts line, in one named place so the wording cannot drift from the
 * thing it describes.
 *
 * `symlinks` is stated because `files` silently includes them: a reader comparing this
 * against an API census needs to know the 3 counted two links as blobs, which is the
 * only reason the two numbers are comparable at all (#197). Repositories with no
 * symlinks get no sentence about them — a label that always mentions a category reads
 * as if the category were the exception.
 *
 * `entries` is the already-rendered "Total entries…" sentence and is folded in HERE rather
 * than at the call site: the caller used to concatenate it with a hand-placed comma and a
 * `replace(/^\n/, "")`, which meant the line a reader actually sees existed nowhere and
 * nothing tested it (adversarial review P3).
 */
export function walkSummaryLine(walk: WalkResult, entries = ""): string {
	// Two flat statements rather than a ternary inside a ternary: this is user-facing
	// text and the plural is easier to read than to nest.
	const noun = walk.symlinks > 1 ? "symlinks" : "symlink";
	const symlinkNote =
		walk.symlinks > 0 ? ` (incl. ${walk.symlinks} ${noun}; counted as files)` : "";
	const tail = entries.replace(/^\n/, "");
	// The space after the comma is deliberate: the old call site concatenated
	// `"…Dirs: N," + entries.replace(/^\n/, "")`, which rendered `Dirs: 1,Total entries`
	// with no separator. Nothing pinned it because the composed line existed in no function
	// until now, and this is the line a reader actually reads.
	return `\nFiles: ${walk.files}${symlinkNote}, Dirs: ${walk.dirs}${tail === "" ? "" : `, ${tail}`}`;
}

// ─── Cloning ─────────────────────────────────────────────────────────

export interface CloneResult {
	ok: boolean;
	path?: string;
	error?: string;
}

export async function cloneRepo(
	owner: string,
	repo: string,
	outDir: string,
	_fetchOpts?: FetchOpts,
): Promise<CloneResult> {
	try {
		await mkdir(outDir, { recursive: true });

		// Prefer gh CLI (handles auth, private repos)
		const ghPath = resolveBinary("gh");
		if (ghPath) {
			await new Promise<void>((resolve, reject) => {
				const proc = spawn(
					ghPath,
					["repo", "clone", `${owner}/${repo}`, outDir, "--", "--depth", "1"],
					{ stdio: "pipe" },
				);
				let stderr = "";
				proc.stderr.on("data", (d: Buffer) => (stderr += d));
				proc.on("close", (code: number) => {
					if (code === 0) resolve();
					else reject(new Error(stderr || `gh repo clone exit ${code}`));
				});
				proc.on("error", reject);
			});
			return { ok: true, path: outDir };
		}

		// Fallback: git clone
		let cloneUrl = `https://github.com/${owner}/${repo}.git`;
		const token = await getGithubToken();
		if (token) {
			cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
		}
		const gitPath = resolveBinary("git") || "git";
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(gitPath, ["clone", "--depth", "1", cloneUrl, outDir], {
				stdio: "pipe",
			});
			let stderr = "";
			proc.stderr.on("data", (d: Buffer) => (stderr += d));
			proc.on("close", (code: number) => {
				if (code === 0) resolve();
				else reject(new Error(stderr || `git clone exited with ${code}`));
			});
			proc.on("error", reject);
		});
		return { ok: true, path: outDir };
	} catch (err: any) {
		return { ok: false, path: outDir, error: err?.message ?? "Clone failed" };
	}
}

// ─── API helpers ─────────────────────────────────────────────────────

/** The entry shapes this file knows how to turn into an in-repo URL. */
export type ContentEntryType = "file" | "dir" | "symlink" | "submodule" | "unknown";

interface ApiEntry {
	name: string;
	path: string;
	/**
	 * The shapes the contents endpoint actually returns, plus `unknown` for
	 * anything else. Declaring only `"file" | "dir"` is what let the collapse
	 * `type === "dir" ? "dir" : "file"` type-check at all: the type said no other
	 * entry could exist, so inventing a `file` for a `submodule` looked legal.
	 */
	type: "file" | "dir" | "symlink" | "submodule" | "unknown";
	html_url?: string;
}

/**
 * List a directory's contents via the GitHub API. Returns entries with
 * {name, path, type} — caller is responsible for recursion control.
 */
/**
 * Map a contents-API entry type to the shape `contentEntryPaths` consumes.
 *
 * Extracted as a pure leaf because the interesting behaviour lives here and
 * `listContents` itself is a network call: collapsing everything that is not
 * `dir` to `file` (which this used to do) invented `file` entries for `symlink`
 * and `submodule`, those then reached the URL builder and became `/blob/` links,
 * and a submodule path does not exist as a blob in this repository so the link
 * 404s — #176's defect shape arriving through the door the first #176 fix
 * opened. Anything unrecognised maps to `unknown` rather than to `file`, so a
 * new GitHub entry type is excluded from URLs by default instead of being
 * guessed at.
 */
export function normalizeContentEntryType(type: unknown): ContentEntryType {
	return type === "dir" || type === "file" || type === "symlink" || type === "submodule"
		? type
		: "unknown";
}

async function listContents(
	owner: string,
	repo: string,
	ref: string,
	path: string,
): Promise<ApiEntry[] | null> {
	const encoded = path
		? `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
		: `/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(ref)}`;
	try {
		const data = (await ghFetch(encoded)) as ApiEntry[] | { message: string };
		if (!Array.isArray(data)) return null;
		return data.map((e) => ({
			name: e.name,
			path: e.path,
			type: normalizeContentEntryType(e.type),
			html_url: e.html_url,
		}));
	} catch {
		return null;
	}
}

/**
 * Map a recursive Git Trees API response to the repo-map path representation.
 *
 * This is the NORMAL source for a repo map — the last-resort contents listing in
 * `listContents` is the fallback — and until #184 it kept only `type === "blob"`,
 * so `paths` could not contain a directory on the common path while `countDirs`,
 * `buildTree` and `repoTreeEntryUrl` all read the trailing-slash convention from
 * it. The result was `repo.totalDirs: 0` for every repository mapped through the
 * API, a constant presented as a shape signal.
 *
 * Directories are therefore kept, slash-terminated, which is the one spelling
 * those three consumers already share (see `contentEntryPaths`).
 *
 * What this endpoint actually emits, verified live rather than assumed: entry
 * `type` is only ever `blob`, `tree` or `commit`. `symlink` and `submodule` are
 * contents-API type names and never appear here — an earlier revision of this
 * comment, and a fixture, claimed to exclude them and tested a shape that cannot
 * occur. A symlink is a blob carrying mode `120000` (observed on `git/git` and
 * `torvalds/linux`) and its `/blob/` URL resolves — `torvalds/linux/blob/master/AGENTS.md`
 * returns 200 — so symlinks are kept, and dropping them would discard reachable
 * entries. A gitlink is `type: "commit"` and its `/blob/` URL 404s
 * (`git/git/blob/master/sha1collisiondetection`), so only THAT kind is excluded:
 * an entry whose in-repo URL we cannot state gets no link, the fail-closed rule
 * #176 settled, applied to the one case where it is actually true.
 *
 * Extracted as a pure leaf for the reason `normalizeContentEntryType` was: the
 * behaviour is here, the enclosing function is a network call, and a permanently
 * zero counter survived precisely because nothing could be run over this mapping.
 */
export function recursiveTreePaths(tree: Array<{ path?: unknown; type?: unknown }>): string[] {
	// No `symlink` spelling to admit here: the recursive trees API reports a symlink as
	// `blob` with mode 120000, so it already arrives as the file kind. `commit` (a gitlink)
	// stays excluded because its derived /blob/ URL 404s.
	return entryPaths(tree, { dir: ["tree"], file: ["blob"] });
}

/**
 * Fetch the entire repo tree in one API call using the Git Trees endpoint
 * with `?recursive=1`. Returns flat paths plus a `truncated` flag from
 * the API — if the repo has >100k entries, GitHub returns the first
 * 100k and sets truncated:true (inspiration: gitdiagram).
 */
async function fetchRecursiveTree(
	owner: string,
	repo: string,
	ref: string,
): Promise<{ paths: string[]; truncated: boolean } | null> {
	try {
		const data = (await ghFetch(
			`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
		)) as {
			tree?: Array<{ path?: string; type?: string }>;
			truncated?: boolean;
			message?: string;
		};
		if (!data || !Array.isArray(data.tree)) return null;
		const paths = recursiveTreePaths(data.tree);
		return { paths, truncated: data.truncated === true };
	} catch {
		return null;
	}
}

/** Hard cap on repo-tree size to keep the map response sane. */
export const MAX_TREE_PATHS = 20_000;

/** Substring patterns to exclude from repo trees (asset files, builds, deps). */
const REPO_PATH_EXCLUSIONS = [
	"node_modules/",
	"vendor/",
	"venv/",
	".venv/",
	"__pycache__/",
	"pycache/",
	// Tool caches, the same bucket as `__pycache__`. They were pruned by the clone walk's
	// own `skipDirs` and by nothing on the API side, so the two sources disagreed on every
	// Python repository (`#200`).
	".pytest_cache/",
	".mypy_cache/",
	".tox/",
	".cache/",
	".tmp/",
	".tmp",
	".min.",
	".pyc",
	".pyo",
	".pyd",
	".so",
	".dll",
	".class",
	".jpg",
	".jpeg",
	".png",
	".gif",
	".ico",
	".svg",
	".ttf",
	".woff",
	".woff2",
	".webp",
	".mp4",
	".mp3",
	".webm",
	".mov",
	".avi",
	".zip",
	".tar",
	".gz",
	".tgz",
	".lockb",
	"yarn.lock",
	"pnpm-lock.yaml",
	"package-lock.json",
	"Cargo.lock",
	"dist/",
	"build/",
	"target/",
	".next/",
	".nuxt/",
	".output/",
	"out/",
	".vscode/",
	".idea/",
	".git/",
	".github/ISSUE_TEMPLATE/",
	"docs/",
	".log",
	".dmg",
	".pkg",
	".exe",
	".deb",
	".rpm",
	".whl",
	".jar",
];

/**
 * Turn a contents-listing response into repo-tree `paths`.
 *
 * The contents endpoint is the only tree source that returns directories, and
 * directories are KEPT (#176 asks for the directory-inclusive count and names
 * the emitted URLs as the defect, not the entries). They are kept
 * slash-terminated because that is already the representation this file uses
 * for "directory" everywhere else: `countDirs`/`countFiles` test the trailing
 * slash, `buildTree` marks the last segment as a directory only when the slash
 * says so, and `repoTreeEntryUrl` picks `/tree/` over `/blob/` on it. One
 * representation, four consumers — the #176 bug was one consumer (the URL
 * builder) being handed an entry whose shape it could not see.
 *
 * `symlink` and `submodule` are excluded deliberately. Both used to be renamed
 * to `file` and emitted as `/blob/`, and a `/blob/` link for a submodule is a
 * 404 because the path resolves in another repository. This is the fail-closed
 * side of the rule: an entry whose canonical in-repo URL we cannot state is not
 * given a guessed one. The contents API does carry an authoritative `html_url`
 * per entry, so a later round that wants them should use that field rather than
 * re-deriving a path shape here.
 */
export function contentEntryPaths(
	entries: Array<{ path: string; type?: string }>,
): string[] {
	// `symlink` is admitted as a file. It used to be excluded alongside `submodule` on
	// the reasoning that a `/blob/` link cannot render the entry — true of a gitlink, which
	// is not cloned into the web tree and 404s at both derivable URLs, and FALSE of a
	// symlink, measured live on the entries the API reports for git/git:
	//   200  /blob/master/RelNotes             (file symlink)
	//   200  /blob/master/subprojects/git-gui  (DIRECTORY symlink)
	// Leaving it dropped made this third source disagree with the other two about the same
	// repository, which is the #197 defect surviving the #197 fix in the one place the
	// first version did not look.
	return entryPaths(entries, { dir: ["dir"], file: ["file", "symlink"] });
}

/**
 * The one place the repo-map path representation is written: a file is its path,
 * a directory is its path plus a trailing slash, and anything else is dropped.
 *
 * Two GitHub endpoints spell the same concept with different words — the contents
 * API says `dir`/`file`, the recursive trees API says `tree`/`blob` — and #176 and
 * #184 were both the same defect arriving through one of them: the count, the tree
 * renderer and the URL builder each read the trailing slash, so a source that
 * spelled it differently (or not at all) silently produced `/blob/` links for
 * directories, or a `totalDirs` of 0. Keeping the vocabulary difference in the two
 * thin callers above and the convention here is what stops them drifting again.
 *
 * Entries of any other kind are excluded rather than guessed; see the fail-closed
 * note on `contentEntryPaths`.
 */
/**
 * The one admission rule for repo-map entries, and the one place the directory
 * convention is written: a file is its path, a directory is its path plus a trailing
 * slash, anything else is dropped.
 *
 * Exposed as a shape rather than as a string list because a second caller
 * (`mapGitHubTree`, #193) needs the same decision but also needs the entry beside it
 * to render a display name. Having that caller re-implement the decision is exactly
 * how #193 happened: it folded `submodule` into `file` and emitted `/blob/` links for
 * paths that are not blobs, which is #176's 404 shape arriving through the door
 * #176's fix opened.
 *
 * Two GitHub endpoints spell the same concept with different words — the contents API
 * says `dir`/`file`, the recursive trees API says `tree`/`blob` — so the vocabulary
 * difference stays in the thin callers and the convention stays here.
 */
/**
 * The one place the directory marker is APPENDED. #184 review round 2 established
 * that a second writer of this convention is the defect class, and PR #195 claimed
 * to have removed the second writer while leaving one in `walkRepo` — a claim the
 * reviewer disproved by neutering the canonical one and watching the two producers
 * diverge. Both now call this.
 *
 * Deliberately a function rather than an inline template: the point is that a change
 * to the marker governs every producer, which is only testable if there is one
 * address to change.
 */
export function canonicalEntryPath(path: string, isDir: boolean): string {
	return isDir ? `${path}/` : path;
}

export type AdmittedEntry<T = unknown> = { path: string; isDir: boolean; entry: T };

function admitEntries<T extends { path?: unknown; type?: unknown }>(
	entries: readonly T[],
	kinds: { dir: string[]; file: string[] },
): Array<AdmittedEntry<T>> {
	const out: Array<AdmittedEntry<T>> = [];
	for (const item of entries) {
		// Fail closed on anything that is not a usable path: the field arrives off the
		// network, and an empty or non-string value must not reach the URL builder (an
		// empty path would render as the bare repo URL, presenting the repository itself
		// as one of its own entries).
		if (typeof item.path !== "string" || item.path === "") continue;
		// A LIST of accepted spellings per kind, because one endpoint can report the same
		// kind under two words. The contents API says `file` for a regular file and
		// `symlink` for a symlink, and both have a reachable `/blob/` URL, so both are the
		// file kind; the trees API needs no such widening because it reports a symlink as
		// `blob` with mode 120000 in the first place.
		if (typeof item.type === "string" && kinds.file.includes(item.type)) {
			out.push({ path: item.path, isDir: false, entry: item });
		} else if (typeof item.type === "string" && kinds.dir.includes(item.type)) {
			// Neither endpoint ever returns a trailing slash of its own, so there is no
			// "already terminated" branch here: a mutation of it is untestable, and an
			// untestable branch is not allowed to sit inside the one writer of a convention.
			out.push({
				path: canonicalEntryPath(item.path, true),
				isDir: true,
				entry: item,
			});
		}
	}
	return out;
}

/**
 * The repo-map path representation, as strings. Thin projection of `admitEntries`:
 * the slash is written in one place, not restated here.
 */
function entryPaths(
	entries: Array<{ path?: unknown; type?: unknown }>,
	kinds: { dir: string[]; file: string[] },
): string[] {
	return admitEntries(entries, kinds).map((e) => e.path);
}

/**
 * True when an entry's authoritative `html_url` points at a DIFFERENT repository
 * than the one being mapped.
 *
 * This exists for gitlinks. Verified live against `daeuniverse/dae`, whose
 * `.gitmodules` declares `control/kern/headers`: the contents API reports it as
 * `type: "file"` (so the admission rule cannot see it), and both URLs derivable from
 * the parent — `/blob/main/control/kern/headers` and `/tree/main/control/kern/headers`
 * — return 404, because a submodule is not cloned into the web tree. The entry's
 * `html_url` is the only reachable address, and it points at the submodule's own
 * repository.
 *
 * The comparison is on parsed owner/repo SEGMENTS, not a string prefix: the
 * submodule above is `daeuniverse/dae_bpf_headers` inside `daeuniverse/dae`, so a
 * `startsWith(repoUrl)` test calls a foreign object local — the same prefix-shaped
 * trap that bit hostname handling in #132.
 *
 * An entry whose URL cannot be parsed is treated as local, which is the behaviour
 * before this function existed: the risk of guessing a foreign URL is emitting a
 * confident 404, and the risk of treating an unparseable one as local is the status
 * quo, not a new failure.
 */
export function isForeignEntryUrl(repoUrl: string, htmlUrl: unknown): boolean {
	const local = repoUrlSegments(repoUrl);
	const entry = typeof htmlUrl === "string" ? repoUrlSegments(htmlUrl) : null;
	if (!local || !entry) return false;
	return local[0] !== entry[0] || local[1] !== entry[1];
}

function repoUrlSegments(u: string): [string, string] | null {
	try {
		const parts = new URL(u).pathname.split("/").filter(Boolean);
		if (parts.length < 2) return null;
		return [parts[0].toLowerCase(), parts[1].toLowerCase()];
	} catch {
		return null;
	}
}

/**
 * Build the GitHub URL for one tree entry of a repo map.
 *
 * GitHub serves `/blob/` only for files, so a directory emitted as `/blob/` is
 * a 404 (#176). The canonical directory URL is `/tree/<branch>/<path>` with no
 * trailing slash, so an entry's own slash is dropped rather than left to
 * redirect, and the path is not pre-encoded (GitHub accepts the literal path,
 * and encoding here would double-encode a path already carrying `%XX`).
 *
 * Reachability, stated honestly: the last-resort contents listing keeps
 * directory entries (#176 asks for the directory-inclusive count), so the
 * `/tree/` branch below is a LIVE path, not a convention guard. An earlier
 * revision of this comment called it unreachable because that round had made
 * every source files-only; that is the case this function exists to prevent and
 * it was wrong to describe the fix that way. `tests/github-map-urls.test.mjs`
 * keeps both branches red.
 */
export function repoTreeEntryUrl(
	repoUrl: string,
	branch: string,
	p: string,
): string {
	const isDir = p.endsWith("/");
	const path = isDir ? p.replace(/\/+$/, "") : p;
	const base = `${repoUrl}/${isDir ? "tree" : "blob"}/${branch}`;
	return path ? `${base}/${path}` : base;
}

/**
 * Drop asset/build/dependency paths, WITHOUT bounding the result.
 *
 * Split out of the old `filterRepoPaths` because the two jobs it was doing have
 * different
 * consequences now that directories are entries too. Exclusion decides what the
 * counts mean; the cap decides only what is retained. Applying the cap first made
 * it corrupt the census: a repository of 11 000 directories holding one file each
 * was a complete map before #184 and became a 10 000-file repository afterwards,
 * because half the cap's slots went to directories (review of PR #191).
 */
/**
 * One path against the noise list. Case-insensitive substring match, which is what
 * `dropExcludedPaths` has always done; split out so `walkRepo` can apply the SAME
 * rule before an entry consumes a `maxEntries` slot.
 */
export function isExcludedPath(path: string): boolean {
	const lower = path.toLowerCase();
	return loweredRepoExclusions().some((sub) => lower.includes(sub));
}

let exclusionsLowered: string[] | null = null;
function loweredRepoExclusions(): string[] {
	// Built once: this now runs per filesystem entry during a clone walk, not once
	// per array, so recomputing the lowercase copy would be O(entries x patterns).
	if (!exclusionsLowered) exclusionsLowered = REPO_PATH_EXCLUSIONS.map((p) => p.toLowerCase());
	return exclusionsLowered;
}

export function dropExcludedPaths(paths: string[]): string[] {
	return paths.filter((p) => !isExcludedPath(p));
}

/**
 * Bound a path list to `MAX_TREE_PATHS`, reporting whether the bound bit.
 *
 * `capped` is what makes a count honest: a retained list that stopped at the limit
 * is a lower bound, and the caller must say so rather than print the number as a
 * census.
 */
export function capRepoPaths(paths: string[]): { kept: string[]; capped: boolean } {
	return {
		kept: paths.length > MAX_TREE_PATHS ? paths.slice(0, MAX_TREE_PATHS) : paths,
		capped: paths.length > MAX_TREE_PATHS,
	};
}

/**
 * Count files and directories in a repo-map path list.
 *
 * Exported because the counts are the thing #184 was about, and until now they
 * were asserted by re-implementing their rule inside the test — so replacing the
 * body of `countDirs` with `return 0` left the entire suite green (review of
 * PR #191). A named census is a seam the dispatcher actually calls.
 */
export function repoEntryCensus(paths: string[]): { files: number; dirs: number } {
	let files = 0;
	let dirs = 0;
	for (const p of paths) {
		if (p.endsWith("/")) dirs++;
		else files++;
	}
	return { files, dirs };
}

/**
 * Fetch the repo README via the API and return the first ~8KB as plain
 * text (base64-decoded). Returns null if no README or on error. This
 * gives the agent immediate context about the repo without forcing a
 * second aio-webfetch round-trip.
 */
async function fetchReadmeExcerpt(
	owner: string,
	repo: string,
	maxBytes = 8 * 1024,
): Promise<string | null> {
	try {
		const data = (await ghFetch(`/repos/${owner}/${repo}/readme`)) as {
			content?: string;
			encoding?: string;
			message?: string;
		};
		if (!data || !data.content) return null;
		let text: string;
		if (data.encoding === "base64") {
			text = Buffer.from(data.content, "base64").toString("utf8");
		} else {
			text = data.content;
		}
		if (text.length > maxBytes) {
			text = text.slice(0, maxBytes) + "\n\n... (truncated)";
		}
		return text.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Map one GitHub API list onto the links aio-webmap publishes.
 *
 * Pure and exported so the URL shapes are unit-testable without the network
 * (issue #165 F12/F13). Two shapes matter here:
 *  - the Tags API returns no `html_url`, so the generic fallback built
 *    `/tags/<name>`, which GitHub answers with 404. `/releases/tag/<name>` is
 *    the page that actually exists — verified 200 for tags WITH a release and
 *    for bare tags in repos that publish no releases at all (torvalds/linux,
 *    golang/go: 100 tags, 0 releases, all 200).
 *  - the Issues API also returns pull requests; without filtering them out the
 *    `github-api:issues` bucket duplicates the `pulls` bucket.
 */
export function mapFeatureItems(
	owner: string,
	repo: string,
	feature: string,
	data: unknown,
	limit = 20,
): FeatureLink[] {
	// /actions/runs answers `{ total_count, workflow_runs: [...] }`, not an array.
	// Unwrap BEFORE the array check: the original order returned `[]` on the
	// object body first, so the unwrap below could never run and the
	// `github-api:actions` bucket was always empty (new finding, same function).
	let items: unknown = data;
	if (items && !Array.isArray(items) && Array.isArray((items as any).workflow_runs)) {
		items = (items as any).workflow_runs;
	}
	if (!Array.isArray(items)) return [];
	return items
		.filter((item: any) => {
			// GitHub's issues list includes pull requests (they share the issue
			// number space). They belong in the `pulls` bucket only.
			if (feature !== "issues") return true;
			return !item || typeof item !== "object" || !("pull_request" in item);
		})
		.slice(0, limit)
		.map((item: any): FeatureLink => {
			const fallbackUrl =
				feature === "tags"
					? `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(item.name ?? "")}`
					: // The chain exists for APIs that omit html_url. Commits carry
						// neither `number` nor `name`, so without `sha` the fallback
						// produced a ref-less `.../commits/`.
						`https://github.com/${owner}/${repo}/${feature}/${item.number ?? item.name ?? item.sha ?? ""}`;
			const url = item.html_url || fallbackUrl;
			const title =
				item.title ||
				item.display_title ||
				item.name ||
				item.tag_name ||
				item.commit?.message?.split("\n")[0] ||
				item.sha?.slice(0, 7) ||
				"(untitled)";
		return {
			url,
			title,
			number: item.number,
			state: item.state || item.conclusion,
		};
	});
}

/**
 * List a feature (issues, pulls, etc.) and return URL+title pairs.
 * Returns up to `limit` items.
 *
 * Optional `branch` is used for the `commits` feature, which filters
 * commit history to a specific ref.
 */
async function listFeatureItems(
	owner: string,
	repo: string,
	feature: string,
	limit = 20,
	branch?: string,
): Promise<FeatureLink[]> {
	try {
		let data: any;
		switch (feature) {
			case "issues":
				data = await ghFetch(
					`/repos/${owner}/${repo}/issues?state=all&per_page=${limit}`,
				);
				break;
			case "pulls":
				data = await ghFetch(
					`/repos/${owner}/${repo}/pulls?state=all&per_page=${limit}`,
				);
				break;
			case "actions":
				data = await ghFetch(
					`/repos/${owner}/${repo}/actions/runs?per_page=${limit}`,
				);
				break;
			case "releases":
				data = await ghFetch(`/repos/${owner}/${repo}/releases?per_page=${limit}`);
				break;
			case "tags":
				data = await ghFetch(`/repos/${owner}/${repo}/tags?per_page=${limit}`);
				break;
			case "branches":
				data = await ghFetch(`/repos/${owner}/${repo}/branches?per_page=${limit}`);
				break;
			case "commits": {
				const q = branch
					? `?sha=${encodeURIComponent(branch)}&per_page=${limit}`
					: `?per_page=${limit}`;
				data = await ghFetch(`/repos/${owner}/${repo}/commits${q}`);
				break;
			}
			default:
				return [];
		}
		// No array pre-check here: /actions/runs returns an object body and
		// mapFeatureItems unwraps it, then rejects anything genuinely non-list.
		return mapFeatureItems(owner, repo, feature, data, limit);
	} catch {
		return [];
	}
}

// ─── Main entry points ───────────────────────────────────────────────

/**
 * Map a repo URL — clone (or fall back to API contents), build a file
 * tree + architecture summary, and enumerate feature URLs (issues,
 * PRs, releases, tags) via the GitHub API.
 */
export async function mapGitHubRepo(
	url: string,
	ref: GitHubMapRef,
	opts: { max?: number; maxFiles?: number } = {},
): Promise<GitHubMapResult> {
	const max = opts.max ?? 100;
	const maxFiles = opts.maxFiles ?? 2000;

	if (ref.kind === "blob") {
		const singleUrl = `https://github.com/${ref.owner}/${ref.repo}/blob/${ref.ref}/${ref.path}`;
		return {
			ok: true,
			url,
			source: "github-api",
			urls: [singleUrl],
			sources: { "github-api": [singleUrl] },
			summary: `Blob: ${ref.owner}/${ref.repo}@${ref.ref}/${ref.path}`,
		};
	}

	if (ref.kind === "tree") {
		const result = await mapGitHubTree(ref, max, maxFiles);
		result.url = url;
		return result;
	}

	// Feature page: enumerate feature items and return them as the map
	if (ref.kind === "feature") {
		const result = await mapGitHubFeaturePage(ref, max);
		result.url = url;
		return result;
	}

	// ref.kind === "repo" — full repo map
	return mapGitHubRepoFull(ref, max, maxFiles);
}

// ─── Repo full map (clone + tree + features) ─────────────────────────

/**
 * Issue #168: label each summary count with its own denominator.
 *
 * `aio-webmap` used to print `Discovered 108 URLs` next to `Total entries: 269`.
 * The first counted the URL list, built from `paths.slice(0, max)` —
 * capped. The second counted the FULL tree. Neither line said so, and "Discovered"
 * read as a total: an agent could conclude it had enumerated the repository when
 * the list had stopped at `max`.
 *
 * Exported for unit testing.
 */
/**
 * What a repo map actually collected, as one value decided where the collection
 * happened.
 *
 * This replaced three independent booleans (`treeEntries`,
 * `treeEntriesAreLowerBound`, `retainedBounded`). Three rounds in a row produced a
 * wrong label from that shape — a retained cap read as a census floor (#191
 * verify), then an exact census read as a floor, then a root-only listing read as
 * "the full tree" — because the caller was asked to assert exactness directly and
 * could assert it about the wrong thing. `exact` is now DERIVED here, so a caller
 * cannot claim exactness for a partial scope: the question stops being "is this
 * number a floor?" and becomes "what did you collect?", which is the question the
 * label actually answers.
 */
export type EntryCoverage = {
	/** Entries collected after exclusion, BEFORE the retention cap. */
	total: number;
	/**
	 * `recursive` — the whole tree was enumerated (Git Trees API, or a clone walk).
	 * `root` — only the top-level contents listing could be obtained; child
	 * directories were never listed, so the count is exact about the root and wrong
	 * about the repository.
	 */
	scope: "recursive" | "root";
	/** Why the count is a floor, when it is one. */
	bound?: "api-truncated" | "walk-cap" | "read-error";
	/** Our own `MAX_TREE_PATHS` cap stopped the RENDERED list. Says nothing about the census. */
	retainedBounded?: boolean;
};

/**
 * Map a cloned-tree walk onto the same representation the API branch produces.
 *
 * Both clone branches used to assign `walk.paths` straight through, while the API
 * branch ran `dropExcludedPaths` first. `walkRepo` skipped a dozen directory NAMES
 * but no asset files and no `docs/`, so the same repository reported different
 * totals and emitted different URLs depending on which source answered — a
 * denominator that moves with the code path is the #168 class.
 *
 * The exclusion itself now happens INSIDE `walkRepo`, before an entry consumes a
 * `maxEntries` slot, because filtering here instead let discarded files spend the
 * budget and end the walk before the real sources were reached. This leaf is the
 * single place the two clone branches become one representation, so the parity
 * cannot drift again.
 */
export function mapWalkToCoverage(walk: WalkResult | null): {
	paths: string[];
	coverage: EntryCoverage;
} {
	const eligible = walk?.paths ?? [];
	const census = repoEntryCensus(eligible);
	return {
		paths: eligible,
		coverage: {
			total: census.files + census.dirs,
			scope: "recursive",
			// A read failure means an entire subtree was never seen. That is a bound for
			// a different reason than the cap, and naming the reason matters: "the walk
			// stopped at its limit" would send a reader to raise `maxFiles`, which would
			// not help.
			bound: boundFromWalk(walk),
		},
	};
}

/**
 * Why a clone walk's count is a floor.
 *
 * `read-error` outranks `walk-cap` because a read failure is the reason that can
 * invalidate the whole figure — an entire branch was never seen, and raising
 * `maxFiles` cannot fix that. When BOTH happen (reviewer probe E on #196) the cap is
 * also real and raising `maxFiles` would bring back the entries the cap refused, so
 * this single label understates rather than overstates: it never sends the reader to
 * a knob that cannot help, at the cost of not naming one that sometimes can. The
 * count stays marked as a floor either way. A second field would name both; it is
 * not worth a third axis on a human label.
 */
function boundFromWalk(walk: WalkResult | null): EntryCoverage["bound"] {
	if (!walk) return undefined;
	if (walk.readFailed) return "read-error";
	if (walk.hitCap) return "walk-cap";
	return undefined;
}


/**
 * Why a count is a floor, in the reader's terms. Each reason names the thing that
 * would actually help, and none of them may claim more than the producer knows.
 *
 * `read-error` is the delicate one: an unreadable directory is itself counted while
 * its contents are unknown, so "the repository may hold more" would be an
 * over-claim in the opposite direction — those contents might be empty. It says what
 * is unknown, not what exists. Naming `maxFiles` here would also be wrong, which is
 * why the cap and the read failure do not share a sentence.
 */
function boundReason(bound: EntryCoverage["bound"]): string {
	switch (bound) {
		case "api-truncated":
			return "the API truncated the tree — the repository holds more";
		case "read-error":
			return "one or more directories could not be read — their contents are unknown";
		case "walk-cap":
			return "the cloned-tree walk stopped at its limit — the repository may hold more";
		default:
			return "the count is a lower bound";
	}
}

/**
 * Why a collection produced NOTHING, keeping the three failure shapes distinct and
 * sharing `boundReason`'s vocabulary so the zero-entry and non-zero summaries cannot
 * describe the same bound differently. Zero from a bound collection is not an empty
 * repository; naming only "produced nothing" hides whether `maxFiles`, a retry, or a
 * permissions check is the next move.
 */
function zeroReason(bound: EntryCoverage["bound"]): string {
	switch (bound) {
		case "api-truncated":
			return "the API truncated the tree and the clone fallback produced nothing";
		case "read-error":
			return "the cloned-tree walk produced nothing and one or more directories could not be read — their contents are unknown";
		case "walk-cap":
			return "the cloned-tree walk produced nothing before reaching its limit";
		default:
			return "the cloned-tree walk produced nothing";
	}
}

export function formatRepoMapCounts(opts: {
	totalUrls: number;
	max: number;
	/**
	 * How many tree entries were turned into URLs. NOT "file urls": since #184 the
	 * entry list carries directories too, so this slice mixes `/blob/` and `/tree/`
	 * links and a label calling it files misstates its denominator (#168's class).
	 */
	entriesIncluded: number;
	coverage: EntryCoverage;
}): { discovered: string; entries: string } {
	const { coverage } = opts;
	const capped = opts.entriesIncluded >= opts.max && coverage.total > opts.max;
	const discovered = capped
		? `\nDiscovered ${opts.totalUrls} URLs (entry URLs capped at \`max\`=${opts.max} of ${coverage.total} tree entries)`
		: `\nDiscovered ${opts.totalUrls} URLs`;
	if (coverage.total <= 0) {
		// Zero from a BOUND collection is not an empty repository — it means the
		// collection itself produced nothing (API truncated, clone fallback failed),
		// which the caller must be able to tell apart from a repo with no files.
		// Returning "" here made both render as a successful empty map.
		const entries = coverage.bound
			? `\nTotal entries: no entries were collected (${zeroReason(coverage.bound)})`
			: coverage.scope === "root"
				? "\nTotal entries: the repository root listing returned nothing"
				: "";
		return { discovered, entries };
	}
	const urls = `${opts.entriesIncluded} included as URLs`;
	if (coverage.scope === "root") {
		return {
			discovered,
			entries:
				`\nTotal entries: ${coverage.total} collected from the repository ROOT only ` +
				`(the recursive tree was unavailable — subdirectories were not listed; ${urls})`,
		};
	}
	if (coverage.bound) {
		return {
			discovered,
			entries:
				`\nTotal entries: at least ${coverage.total} (${boundReason(coverage.bound)}; ${urls})`,
		};
	}
	return {
		discovered,
		entries:
			`\nTotal entries: ${coverage.total} in the full tree (uncapped; ${urls})` +
			(coverage.retainedBounded
				? `; the rendered tree keeps the first ${MAX_TREE_PATHS}`
				: ""),
	};
}

/**
 * The qualifier a tree heading carries, or "" when the count is exact. Kept beside
 * `boundReason` so the two renderings of the same coverage value cannot drift —
 * three rounds of #184 produced a label that was wrong about which quantity it
 * described.
 */
function treeBoundLabel(coverage: EntryCoverage): string {
	if (coverage.bound === "api-truncated") return ", truncated by API";
	if (coverage.scope === "root") return ", repository root only";
	if (coverage.bound === "read-error") return ", a directory could not be read";
	if (coverage.bound === "walk-cap") return ", bounded by the cloned-tree walk limit";
	if (coverage.retainedBounded) return `, bounded by the ${MAX_TREE_PATHS}-entry retention cap`;
	return "";
}

/**
 * Render the repo file tree, bounded to `max` entries.
 *
 * The subdirectory path already caps its listing at `max`; the full-repo
 * path used to render every collected path, so a small `max` still
 * dumped a maxFiles-sized tree (observed: 2000 entries for nodejs/node at
 * `max: 12`) — pure token bloat, since the blob-URL list is capped at the
 * same `max`. Architecture signals are computed from the FULL path list by
 * the caller, so bounding the display loses no analysis.
 *
 * Exported for unit testing.
 */
export function renderRepoTreeMarkdown(
	paths: string[],
	max: number,
	coverage: EntryCoverage,
): string {
	const budget = Math.max(1, Math.min(paths.length, max));
	const shownPaths = paths.length > budget ? paths.slice(0, budget) : paths;
	const rendered = renderTree(buildTree(shownPaths));
	// The heading and the summary line must describe the SAME collection, so both
	// read it off one coverage value instead of each being handed its own boolean —
	// three rounds produced a label where one of them was wrong about which
	// quantity it described.
	// Each bound names the thing that would actually help; see `boundReason` for why
	// they must not share wording — a read failure must not tell the reader to raise
	// `maxFiles`, and must not claim the repository holds more than was counted.
	const bound = treeBoundLabel(coverage);
	const label = `## File Tree (${paths.length} entries${bound})`;
	const note =
		shownPaths.length < paths.length
			? `\n_showing first ${shownPaths.length} of ${paths.length} entries; raise \`max\` for more_\n`
			: "";
	return `${label}${note}\n\`\`\`\n${rendered || "(empty)"}\n\`\`\`\n`;
}

async function mapGitHubRepoFull(
	ref: { kind: "repo"; owner: string; repo: string },
	max: number,
	maxFiles: number,
): Promise<GitHubMapResult> {
	const { owner, repo } = ref;
	const sources: Record<string, string[]> = {};
	const allUrls: string[] = [];

	let defaultBranch = "main";
	let repoMeta: any = null;

	try {
		repoMeta = await ghFetchWithFallback<any>(`/repos/${owner}/${repo}`);
		if (repoMeta && !repoMeta.message && typeof repoMeta === "object") {
			defaultBranch = repoMeta.default_branch || "main";
		}
	} catch {
		/* API failed — proceed with tree attempt */
	}

	// 1. Try the recursive Git Trees API (inspiration: gitdiagram).
	//    Single API call returns the whole tree as flat paths — much
	//    faster than cloning (no blobs downloaded) and doesn't need
	//    git/SSH credentials.
	let paths: string[] = [];
	/**
	 * What architecture detection reads: the ELIGIBLE list before the retention cap.
	 * Reading `paths` instead makes a root-level `Dockerfile` past entry 20 000
	 * invisible to signals while the census still counts it, and directories now
	 * consume cap slots so that happens sooner than it used to.
	 */
	let signalPaths: string[] = [];
	let truncated = false;
	let source: "repo-clone" | "github-api" | "github-api+clone" = "github-api";
	let clonedOk = false;
	let walk: WalkResult | null = null;

	const treeResult = await fetchRecursiveTree(owner, repo, defaultBranch);
	// Census of everything that survived EXCLUSION, taken before the retention cap.
	// Counting after the cap is what turned a complete map into a silently smaller
	// repository once directories started consuming cap slots.
	let census: { files: number; dirs: number } | null = null;
	let localCapped = false;
	// Decided in whichever branch actually collected the entries, not reconstructed
	// afterwards: the three sources differ in what they enumerate, and the last one
	// enumerates only the repository root.
	let coverage: EntryCoverage = { total: 0, scope: "recursive" };
	if (treeResult && !treeResult.truncated) {
		paths = treeResult.paths;
		// Re-apply our own exclusion filter on top of the API result
		// (the API doesn't filter; we want to drop noise like
		// node_modules, .git, asset files before building the tree).
		const eligible = dropExcludedPaths(paths);
		census = repoEntryCensus(eligible);
		const bounded = capRepoPaths(eligible);
		paths = bounded.kept;
		signalPaths = eligible;
		localCapped = bounded.capped;
		coverage = {
			total: census.files + census.dirs,
			scope: "recursive",
			retainedBounded: localCapped,
		};
	} else if (treeResult?.truncated) {
		truncated = true;
		// Tree too large — fall back to cloning and walking
		const cloneDir = join(BASE_TEMP, "github-maps", `${owner}--${repo}`);
		const clone = await cloneRepo(owner, repo, cloneDir);
		if (clone.ok && clone.path) {
			clonedOk = true;
			source = "github-api+clone";
			walk = await walkRepo(clone.path, { maxEntries: maxFiles });
			const mapped = mapWalkToCoverage(walk);
			paths = mapped.paths;
			coverage = mapped.coverage;
			signalPaths = paths;
		} else {
			// Nothing was collected: the API truncated and the clone failed.
			coverage = { total: 0, scope: "recursive", bound: "api-truncated" };
		}
	} else {
		// API tree failed entirely (404, network) — try clone as last resort
		const cloneDir = join(BASE_TEMP, "github-maps", `${owner}--${repo}`);
		const clone = await cloneRepo(owner, repo, cloneDir);
		if (clone.ok && clone.path) {
			clonedOk = true;
			source = "github-api+clone";
			walk = await walkRepo(clone.path, { maxEntries: maxFiles });
			const mapped = mapWalkToCoverage(walk);
			paths = mapped.paths;
			coverage = mapped.coverage;
			signalPaths = paths;
		} else {
			// Last resort: top-level contents listing. Unlike the recursive tree
			// API (`type === "blob"`) and the clone walk (`e.isFile()`), this
			// endpoint also returns directories, and dropping them here is what
			// made a repo whose root is mostly directories map to an empty tree.
			// #176 asks for the directory-inclusive count and names the URLs as the
			// defect, so directories are kept — slash-terminated, which is how this
			// file already spells "directory" to `countDirs`, `buildTree` and
			// `repoTreeEntryUrl`. The URL shape is then decided per entry rather
			// than assumed for the whole list.
			const contents = await listContents(owner, repo, defaultBranch, "");
			if (contents && contents.length > 0) {
				paths = contentEntryPaths(contents);
			}
			// This endpoint lists ONE directory. The count is exact about the root
			// and wrong about the repository, so it must never be phrased as a full
			// tree — the label that used to be produced here claimed "uncapped" for
			// a repository whose subdirectories were never requested.
			coverage = { total: paths.length, scope: "root" };
			signalPaths = paths;
		}
	}

	let treeMarkdown: string | undefined;
	let architecture: string | undefined;

	if (paths.length > 0) {
		treeMarkdown = renderRepoTreeMarkdown(paths, max, coverage);
		architecture = detectArchitectureSignals(signalPaths);

		// Generate a blob/tree URL per entry (cap at max)
		const repoUrl = `https://github.com/${owner}/${repo}`;
		// One URL per entry. Directories are part of this list when the count
		// came from the API tree (the clone walk yields files only), which is why
		// the shape is decided per entry by `repoTreeEntryUrl` and the variable is
		// not called `files` — that name is what made the #176 `/blob/`-for-every-
		// entry bug look correct.
		const urlEntries = paths.slice(0, max);
		for (const p of urlEntries) {
			allUrls.push(repoTreeEntryUrl(repoUrl, defaultBranch, p));
		}
		sources[clonedOk ? "repo-clone" : "github-api:tree"] = [...allUrls];
	}

	// 2. Fetch feature URLs (issues, PRs, releases, tags, branches)
	const featureSources = await collectFeatureUrls(
		owner,
		repo,
		defaultBranch,
		max,
	);
	for (const [src, urls] of Object.entries(featureSources)) {
		sources[src] = urls;
		allUrls.push(...urls);
	}

	// 3. Fetch README excerpt (first 8KB) so the map gives the agent
	//    immediate context about the repo's purpose.
	const readmeExcerpt = await fetchReadmeExcerpt(owner, repo);
	if (readmeExcerpt) {
		sources["github-api:readme"] = [`https://github.com/${owner}/${repo}#readme`];
		if (repoMeta) repoMeta._readmeExcerpt = readmeExcerpt;
	}

	const totalUrls = allUrls.length;

	const summaryParts: string[] = [];
	summaryParts.push(
		`🗺️  Repo map for ${owner}/${repo}${clonedOk ? " (cloned)" : ""}${truncated ? " (tree truncated by API)" : ""}`,
	);
	const counts = formatRepoMapCounts({
		totalUrls,
		max,
		entriesIncluded: Math.min(paths.length, max),
		coverage,
	});
	summaryParts.push(`${counts.discovered} via ${Object.keys(sources).length} sources:`);
	for (const [src, urls] of Object.entries(sources)) {
		summaryParts.push(`  • ${src}: ${urls.length} URLs`);
	}
	if (walk) {
		summaryParts.push(walkSummaryLine(walk, counts.entries));
	} else if (counts.entries) {
		summaryParts.push(counts.entries);
	}
	if (repoMeta && !repoMeta.message && typeof repoMeta === "object") {
		const stars = repoMeta.stargazers_count ?? 0;
		const forks = repoMeta.forks_count ?? 0;
		const lang = repoMeta.language;
		const license = repoMeta.license?.spdx_id || repoMeta.license?.key;
		const desc = repoMeta.description;
		const metaBits: string[] = [];
		if (desc) metaBits.push(`> ${desc}`);
		metaBits.push(
			`⭐ ${stars}  🍴 ${forks}  📝 ${lang || "N/A"}  📄 ${license || "N/A"}  🌿 ${defaultBranch}`,
		);
		summaryParts.push(`\n${metaBits.join("\n")}`);
	}
	if (readmeExcerpt) {
		summaryParts.push(`\n## README excerpt\n\n${readmeExcerpt}\n`);
	}

	return {
		ok: true,
		url: `https://github.com/${owner}/${repo}`,
		source,
		urls: allUrls,
		sources,
		treeMarkdown,
		architecture,
		repo: {
			owner,
			repo,
			ref: defaultBranch,
			totalFiles: census?.files ?? repoEntryCensus(paths).files,
			totalDirs: census?.dirs ?? repoEntryCensus(paths).dirs,
			/**
			 * What the two totals above mean. They count what was COLLECTED, not what the
			 * repository holds; without this field a structured consumer sees a bare number
			 * where the human summary carries a qualifier, so a root-only listing, a capped
			 * clone and a failed collection all look like repository totals (#184 verify
			 * round). Additive: no existing consumer has to change.
			 */
			coverage: coverage.bound
				? { scope: coverage.scope, bound: coverage.bound }
				: { scope: coverage.scope },
			description: repoMeta?.description,
			topics: repoMeta?.topics,
			language: repoMeta?.language,
			stars: repoMeta?.stargazers_count,
			forks: repoMeta?.forks_count,
			license: repoMeta?.license?.spdx_id,
			defaultBranch,
			cloned: clonedOk,
			clonePath: clonedOk
				? join(BASE_TEMP, "github-maps", `${owner}--${repo}`)
				: undefined,
		},
		summary: summaryParts.join("\n"),
	};
}

// ─── Tree (subdirectory) map ─────────────────────────────────────────

async function mapGitHubTree(
	ref: { kind: "tree"; owner: string; repo: string; ref: string; path: string },
	max: number,
	_maxFiles: number,
): Promise<GitHubMapResult> {
	const { owner, repo, ref: branch, path } = ref;
	const repoUrl = `https://github.com/${owner}/${repo}`;

	const sources: Record<string, string[]> = {};
	const allUrls: string[] = [];

	const contents = await listContents(owner, repo, branch, path);
	if (!contents) {
		return {
			ok: false,
			url: `${repoUrl}/tree/${branch}/${path}`,
			source: "github-api",
			urls: [],
			sources: {},
			summary: `Failed to list ${owner}/${repo}@${branch}/${path}`,
			error: "GitHub API call failed",
		};
	}

	// Admission first, `max` second. Bounding the raw list let unreachable entries
	// (submodules, anything unrecognised) consume budget slots and then be dropped,
	// so a listing of 4 entries holding 2 reachable ones could render 0 after the
	// discard — the same "the bound counts what we keep neither" mistake as the walk
	// cap, reached through a third door.
	// Same contents vocabulary as `contentEntryPaths`, so `symlink` is admitted here too:
	// a symlink's derived `/blob/` URL resolves (measured on git/git), while a gitlink's
	// does not and stays out.
	const reachable = admitEntries(contents, { dir: ["dir"], file: ["file", "symlink"] });
	const admitted = reachable.slice(0, max);
	const entryUrl = (e: AdmittedEntry) => {
		// A gitlink is reachable only in its own repository, and GitHub already says
		// which one. Deriving a path URL for it produces a confident 404 (#193).
		const html = (e.entry as { html_url?: unknown }).html_url;
		if (isForeignEntryUrl(repoUrl, html) && typeof html === "string" && html) return html;
		return repoTreeEntryUrl(repoUrl, branch, e.path);
	};

	const rendered = admitted
		.map((e) => {
			const name = (e.entry as { name?: unknown }).name;
			return `${e.isDir ? "📁" : "📄"} [${typeof name === "string" && name ? name : e.path}](${entryUrl(e)})`;
		})
		.join("\n");

	const treeMarkdown = `## Contents of ${path || "/"}\n\n${rendered || "_(empty)_"}\n`;
	allUrls.push(...admitted.map(entryUrl));
	sources["github-api"] = [...allUrls];

	return {
		ok: true,
		url: `${repoUrl}/tree/${branch}/${path}`,
		source: "github-api",
		urls: allUrls,
		sources,
		treeMarkdown,
		// One denominator: "entries" is what was listed, "reachable" what admission
		// accepted, "shown" what `max` retained. The old sentence compared `shown`
		// against the raw listing, so a discard made "shown" drop without anything
		// explaining the gap — #168's mismatch, in a second caller.
		summary:
			`🗂️  Tree map for ${owner}/${repo}@${branch}/${path || "/"}\n\n` +
			`Found ${contents.length} entries, ${reachable.length} reachable (${allUrls.length} shown).`,
	};
}

// ─── Feature page map ────────────────────────────────────────────────

async function mapGitHubFeaturePage(
	ref: {
		kind: "feature";
		owner: string;
		repo: string;
		feature: string;
		sub?: string[];
	},
	max: number,
): Promise<GitHubMapResult> {
	const { owner, repo, feature } = ref;
	const repoUrl = `https://github.com/${owner}/${repo}`;

	const sources: Record<string, string[]> = {};
	const allUrls: string[] = [];

	const items = await listFeatureItems(owner, repo, feature, max);
	for (const item of items) {
		allUrls.push(item.url);
	}
	sources[`github-api:${feature}`] = allUrls;

	const rendered =
		items.length === 0
			? "_(no items found)_"
			: items
					.map((item, i) => {
						const num = item.number ? `#${item.number}` : "";
						const state = item.state ? ` _${item.state}_` : "";
						return `${i + 1}. ${num}${state} ${item.title} — ${item.url}`;
					})
					.join("\n");

	const summary = `📋 ${owner}/${repo} — ${feature}\n\nFound ${items.length} items.`;

	return {
		ok: true,
		url: `${repoUrl}/${feature}`,
		source: "github-api",
		urls: allUrls,
		sources,
		treeMarkdown: `## ${feature} (${items.length})\n\n${rendered}\n`,
		summary,
	};
}

// ─── Feature URL aggregator ──────────────────────────────────────────

async function collectFeatureUrls(
	owner: string,
	repo: string,
	_defaultBranch: string,
	max: number,
): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	const features: Array<{ name: string; apiFeature: string }> = [
		{ name: "issues", apiFeature: "issues" },
		{ name: "pulls", apiFeature: "pulls" },
		{ name: "releases", apiFeature: "releases" },
		{ name: "tags", apiFeature: "tags" },
		{ name: "actions", apiFeature: "actions" },
		{ name: "branches", apiFeature: "branches" },
	];

	// Run all feature queries in parallel — they're independent
	const results = await Promise.allSettled(
		features.map(async (f) => {
			const items = await listFeatureItems(
				owner,
				repo,
				f.apiFeature,
				Math.min(20, max),
			);
			return { name: f.name, items };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const r = results[i]!;
		const fname = features[i]!.name;
		if (r.status === "fulfilled" && r.value.items.length > 0) {
			out[`github-api:${fname}`] = r.value.items.map((it) => it.url);
		}
	}

	return out;
}
