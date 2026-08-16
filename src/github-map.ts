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
export interface FeatureLink {
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
 * Detect architecture signals from a list of repo file paths.
 * Pure function — exported for unit testing.
 */
export function detectArchitectureSignals(paths: string[]): string {
	const lines: string[] = [];

	if (
		paths.some((p) =>
			/^(Dockerfile|docker-compose\.(yml|yaml)|\.dockerignore)$/.test(p),
		)
	)
		lines.push("- 🐳 **Docker:** yes");

	const ciCd = matched(CI_PATTERNS, paths);
	if (ciCd.length) lines.push(`- 🔄 **CI/CD:** ${ciCd.join(", ")}`);

	const tests = matched(TEST_PATTERNS, paths);
	const hasTestDir = paths.some(
		(p) =>
			p.startsWith("__tests__/") ||
			p.startsWith("tests/") ||
			p.startsWith("test/") ||
			p.startsWith("spec/"),
	);
	if (hasTestDir && !tests.length) tests.push("(test dir present)");
	if (tests.length) lines.push(`- 🧪 **Tests:** ${tests.join(", ")}`);

	const monorepo = matched(MONOREPO_PATTERNS, paths);
	const pkgJsons = paths.filter((p) => p.endsWith("/package.json"));
	if (pkgJsons.length > 1 && !monorepo.length) monorepo.push("multi-package");
	if (monorepo.length) lines.push(`- 📦 **Monorepo:** ${monorepo.join(", ")}`);

	const pms = new Set<string>();
	for (const [file, pm] of Object.entries(LOCKFILE_MAP)) {
		if (paths.some((p) => p === file || p.endsWith(`/${file}`))) pms.add(pm);
	}
	if (pms.size) lines.push(`- 📋 **Package managers:** ${[...pms].join(", ")}`);

	const secSignals: string[] = [];
	if (paths.some((p) => p === "SECURITY.md")) secSignals.push("SECURITY.md");
	if (paths.some((p) => p === ".env")) secSignals.push("⚠ .env committed");
	if (
		paths.some(
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
		let cur = root;
		let acc = "";
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i]!;
			acc = acc ? `${acc}/${seg}` : seg;
			const isFile = i === segs.length - 1;
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
}

/**
 * Walk a directory recursively, returning all relative paths.
 * Hidden dirs (.git, node_modules, .venv, target, dist, build, etc.)
 * are skipped to keep the tree focused on source.
 */
export async function walkRepo(
	root: string,
	opts: { maxEntries?: number; skipHidden?: boolean } = {},
): Promise<WalkResult> {
	const skipHidden = opts.skipHidden !== false;
	const maxEntries = opts.maxEntries ?? 100_000;
	const skipDirs = new Set([
		".git",
		"node_modules",
		".venv",
		"venv",
		"target",
		"dist",
		"build",
		".next",
		".nuxt",
		".cache",
		"__pycache__",
		".pytest_cache",
		".mypy_cache",
		".tox",
		"vendor",
	]);
	const paths: string[] = [];
	let files = 0;
	let dirs = 0;

	async function walk(dir: string, rel: string): Promise<void> {
		if (paths.length >= maxEntries) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// Stable order: dirs first, then alpha
		entries.sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});
		for (const e of entries) {
			if (paths.length >= maxEntries) return;
			if (skipHidden && e.name.startsWith(".") && e.name !== ".github") {
				// Keep .github/ but skip other hidden dirs/files
				if (e.isDirectory()) continue;
			}
			if (e.isDirectory()) {
				if (skipDirs.has(e.name)) continue;
				dirs++;
				await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
			} else if (e.isFile()) {
				const relPath = rel ? `${rel}/${e.name}` : e.name;
				paths.push(relPath);
				files++;
			}
		}
	}
	await walk(root, "");
	return { paths, files, dirs };
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

interface ApiEntry {
	name: string;
	path: string;
	type: "file" | "dir";
	html_url?: string;
}

/**
 * List a directory's contents via the GitHub API. Returns entries with
 * {name, path, type} — caller is responsible for recursion control.
 */
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
			type: e.type === "dir" ? "dir" : "file",
			html_url: e.html_url,
		}));
	} catch {
		return null;
	}
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
		const paths: string[] = [];
		for (const item of data.tree) {
			if (typeof item.path === "string" && item.type === "blob") {
				paths.push(item.path);
			}
		}
		return { paths, truncated: data.truncated === true };
	} catch {
		return null;
	}
}

/** Hard cap on repo-tree size to keep the map response sane. */
const MAX_TREE_PATHS = 20_000;

/** Substring patterns to exclude from repo trees (asset files, builds, deps). */
const REPO_PATH_EXCLUSIONS = [
	"node_modules/",
	"vendor/",
	"venv/",
	".venv/",
	"__pycache__/",
	"pycache/",
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

/** Filter noisy asset/build/dep paths out of a repo tree. */
export function filterRepoPaths(paths: string[]): string[] {
	// Lowercase all patterns once up front for case-insensitive matching
	const loweredExclusions = REPO_PATH_EXCLUSIONS.map((p) => p.toLowerCase());
	const filtered: string[] = [];
	for (const p of paths) {
		const lower = p.toLowerCase();
		if (loweredExclusions.some((sub) => lower.includes(sub))) continue;
		filtered.push(p);
		if (filtered.length >= MAX_TREE_PATHS) break;
	}
	return filtered;
}

/** Count distinct file paths (entries without trailing slash). */
function countFiles(paths: string[]): number {
	let n = 0;
	for (const p of paths) if (!p.endsWith("/")) n++;
	return n;
}

/** Count distinct directory paths (entries with trailing slash). */
function countDirs(paths: string[]): number {
	let n = 0;
	for (const p of paths) if (p.endsWith("/")) n++;
	return n;
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
		if (!Array.isArray(data)) return [];
		// Unwrap workflow_runs wrapper for /actions/runs
		if (data && Array.isArray((data as any).workflow_runs)) {
			data = (data as any).workflow_runs;
		}
		return data.slice(0, limit).map((item: any): FeatureLink => {
			const url =
				item.html_url ||
				`https://github.com/${owner}/${repo}/${feature}/${item.number ?? item.name ?? ""}`;
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
	let truncated = false;
	let source: "repo-clone" | "github-api" | "github-api+clone" = "github-api";
	let clonedOk = false;
	let walk: WalkResult | null = null;

	const treeResult = await fetchRecursiveTree(owner, repo, defaultBranch);
	if (treeResult && !treeResult.truncated) {
		paths = treeResult.paths;
		// Re-apply our own exclusion filter on top of the API result
		// (the API doesn't filter; we want to drop noise like
		// node_modules, .git, asset files before building the tree).
		const filtered = filterRepoPaths(paths);
		paths = filtered;
	} else if (treeResult?.truncated) {
		truncated = true;
		// Tree too large — fall back to cloning and walking
		const cloneDir = join(BASE_TEMP, "github-maps", `${owner}--${repo}`);
		const clone = await cloneRepo(owner, repo, cloneDir);
		if (clone.ok && clone.path) {
			clonedOk = true;
			source = "github-api+clone";
			walk = await walkRepo(clone.path, { maxEntries: maxFiles });
			paths = walk?.paths ?? [];
		}
	} else {
		// API tree failed entirely (404, network) — try clone as last resort
		const cloneDir = join(BASE_TEMP, "github-maps", `${owner}--${repo}`);
		const clone = await cloneRepo(owner, repo, cloneDir);
		if (clone.ok && clone.path) {
			clonedOk = true;
			source = "github-api+clone";
			walk = await walkRepo(clone.path, { maxEntries: maxFiles });
			paths = walk?.paths ?? [];
		} else {
			// Last resort: top-level contents listing
			const contents = await listContents(owner, repo, defaultBranch, "");
			if (contents && contents.length > 0) {
				paths = contents.map((e) => e.path);
			}
		}
	}

	let treeMarkdown: string | undefined;
	let architecture: string | undefined;

	if (paths.length > 0) {
		const tree = buildTree(paths);
		const rendered = renderTree(tree);
		const label = truncated
			? `## File Tree (${paths.length} entries, truncated by API)`
			: `## File Tree (${paths.length} entries)`;
		treeMarkdown = `${label}\n\n\`\`\`\n${rendered || "(empty)"}\n\`\`\`\n`;
		architecture = detectArchitectureSignals(paths);

		// Generate a blob/tree URL per entry (cap at max)
		const repoUrl = `https://github.com/${owner}/${repo}`;
		const fileEntries = paths.slice(0, max);
		for (const p of fileEntries) {
			allUrls.push(`${repoUrl}/blob/${defaultBranch}/${p}`);
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
	summaryParts.push(
		`\nDiscovered ${totalUrls} URLs via ${Object.keys(sources).length} sources:`,
	);
	for (const [src, urls] of Object.entries(sources)) {
		summaryParts.push(`  • ${src}: ${urls.length} URLs`);
	}
	if (walk) {
		summaryParts.push(
			`\nFiles: ${walk.files}, Dirs: ${walk.dirs}, Total entries: ${walk.paths.length}`,
		);
	} else if (paths.length > 0) {
		summaryParts.push(`\nTotal entries: ${paths.length}`);
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
			totalFiles: walk?.files ?? countFiles(paths),
			totalDirs: walk?.dirs ?? countDirs(paths),
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

	const truncated = contents.slice(0, max);
	const rendered = truncated
		.map((e) => {
			const target = e.type === "dir" ? "tree" : "blob";
			return `${e.type === "dir" ? "📁" : "📄"} [${e.name}](${repoUrl}/${target}/${branch}/${e.path})`;
		})
		.join("\n");

	const treeMarkdown = `## Contents of ${path || "/"}\n\n${rendered || "_(empty)_"}\n`;
	allUrls.push(
		...truncated.map(
			(e) =>
				`${repoUrl}/${e.type === "dir" ? "tree" : "blob"}/${branch}/${e.path}`,
		),
	);
	sources["github-api"] = [...allUrls];

	return {
		ok: true,
		url: `${repoUrl}/tree/${branch}/${path}`,
		source: "github-api",
		urls: allUrls,
		sources,
		treeMarkdown,
		summary: `🗂️  Tree map for ${owner}/${repo}@${branch}/${path || "/"}\n\nFound ${contents.length} entries (${allUrls.length} shown).`,
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
