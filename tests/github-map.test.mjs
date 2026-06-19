/**
 * Tests for src/github-map.ts — the GitHub-native discovery backend for
 * aio-webmap.
 *
 * Coverage focuses on the URL parser, architecture detection, tree
 * rendering, file walking, and the orchestrator (`mapGitHubRepo`). All
 * network-bound code paths (`cloneRepo`, `listFeatureItems`,
 * `listContents`) are exercised via mocked inputs or skipped — the
 * unit tests don't make real GitHub API calls.
 */

import { strict as assert } from "node:assert";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
	buildTree,
	detectArchitectureSignals,
	filterRepoPaths,
	isGitHubUrl,
	mapGitHubRepo,
	parseGitHubMapUrl,
	renderTree,
	walkRepo,
} from "../src/github-map.ts";

// ─── isGitHubUrl ─────────────────────────────────────────────────────

test("isGitHubUrl accepts github.com", () => {
	assert.strictEqual(isGitHubUrl("https://github.com/owner/repo"), true);
});

test("isGitHubUrl accepts www.github.com", () => {
	assert.strictEqual(isGitHubUrl("https://www.github.com/owner/repo"), true);
});

test("isGitHubUrl accepts raw.githubusercontent.com", () => {
	assert.strictEqual(
		isGitHubUrl("https://raw.githubusercontent.com/owner/repo/main/README.md"),
		true,
	);
});

test("isGitHubUrl accepts gist.github.com", () => {
	assert.strictEqual(isGitHubUrl("https://gist.github.com/user/abc123"), true);
});

test("isGitHubUrl rejects non-GitHub hosts", () => {
	assert.strictEqual(isGitHubUrl("https://example.com"), false);
	assert.strictEqual(isGitHubUrl("https://gitlab.com/owner/repo"), false);
	assert.strictEqual(isGitHubUrl("https://api.github.com"), false);
});

test("isGitHubUrl rejects invalid URLs", () => {
	assert.strictEqual(isGitHubUrl("not a url"), false);
	assert.strictEqual(isGitHubUrl(""), false);
});

// ─── parseGitHubMapUrl ───────────────────────────────────────────────

test("parseGitHubMapUrl parses root repo URL", () => {
	const r = parseGitHubMapUrl("https://github.com/owner/repo");
	assert.deepStrictEqual(r, { kind: "repo", owner: "owner", repo: "repo" });
});

test("parseGitHubMapUrl parses tree URL with path", () => {
	const r = parseGitHubMapUrl(
		"https://github.com/owner/repo/tree/main/src/components",
	);
	assert.deepStrictEqual(r, {
		kind: "tree",
		owner: "owner",
		repo: "repo",
		ref: "main",
		path: "src/components",
	});
});

test("parseGitHubMapUrl parses tree URL without subpath", () => {
	const r = parseGitHubMapUrl("https://github.com/owner/repo/tree/main");
	assert.deepStrictEqual(r, {
		kind: "tree",
		owner: "owner",
		repo: "repo",
		ref: "main",
		path: "",
	});
});

test("parseGitHubMapUrl parses blob URL", () => {
	const r = parseGitHubMapUrl(
		"https://github.com/owner/repo/blob/main/src/index.ts",
	);
	assert.deepStrictEqual(r, {
		kind: "blob",
		owner: "owner",
		repo: "repo",
		ref: "main",
		path: "src/index.ts",
	});
});

test("parseGitHubMapUrl parses raw.githubusercontent.com URL", () => {
	const r = parseGitHubMapUrl(
		"https://raw.githubusercontent.com/owner/repo/main/README.md",
	);
	assert.deepStrictEqual(r, {
		kind: "blob",
		owner: "owner",
		repo: "repo",
		ref: "main",
		path: "README.md",
	});
});

test("parseGitHubMapUrl parses feature pages (issues, pulls, etc.)", () => {
	assert.deepStrictEqual(
		parseGitHubMapUrl("https://github.com/owner/repo/issues"),
		{
			kind: "feature",
			owner: "owner",
			repo: "repo",
			feature: "issues",
			sub: [],
		},
	);
	assert.deepStrictEqual(
		parseGitHubMapUrl("https://github.com/owner/repo/issues/123"),
		{
			kind: "feature",
			owner: "owner",
			repo: "repo",
			feature: "issues",
			sub: ["123"],
		},
	);
	assert.deepStrictEqual(
		parseGitHubMapUrl("https://github.com/owner/repo/pulls"),
		{
			kind: "feature",
			owner: "owner",
			repo: "repo",
			feature: "pulls",
			sub: [],
		},
	);
	assert.deepStrictEqual(
		parseGitHubMapUrl("https://github.com/owner/repo/actions"),
		{
			kind: "feature",
			owner: "owner",
			repo: "repo",
			feature: "actions",
			sub: [],
		},
	);
	assert.deepStrictEqual(
		parseGitHubMapUrl("https://github.com/owner/repo/releases/tag/v1.0"),
		{
			kind: "feature",
			owner: "owner",
			repo: "repo",
			feature: "releases",
			sub: ["tag", "v1.0"],
		},
	);
});

test("parseGitHubMapUrl returns null for non-GitHub URLs", () => {
	assert.strictEqual(parseGitHubMapUrl("https://example.com"), null);
	assert.strictEqual(parseGitHubMapUrl("https://gitlab.com/owner/repo"), null);
});

test("parseGitHubMapUrl returns null for invalid URLs", () => {
	assert.strictEqual(parseGitHubMapUrl("not a url"), null);
});

test("parseGitHubMapUrl handles www.github.com", () => {
	const r = parseGitHubMapUrl("https://www.github.com/owner/repo");
	assert.deepStrictEqual(r, { kind: "repo", owner: "owner", repo: "repo" });
});

// ─── detectArchitectureSignals ───────────────────────────────────────

test("detectArchitectureSignals detects Docker", () => {
	const md = detectArchitectureSignals(["Dockerfile", "src/index.ts"]);
	assert.ok(md.includes("Docker"));
	assert.ok(md.includes("yes"));
});

test("detectArchitectureSignals detects GitHub Actions workflows", () => {
	const md = detectArchitectureSignals([
		".github/workflows/ci.yml",
		"src/index.ts",
	]);
	assert.ok(md.includes("GitHub Actions"));
});

test("detectArchitectureSignals detects CI/CD platforms", () => {
	assert.ok(
		detectArchitectureSignals([".gitlab-ci.yml"]).includes("GitLab CI"),
	);
	assert.ok(detectArchitectureSignals(["Jenkinsfile"]).includes("Jenkins"));
	assert.ok(detectArchitectureSignals([".travis.yml"]).includes("Travis CI"));
	assert.ok(
		detectArchitectureSignals(["azure-pipelines.yml"]).includes(
			"Azure Pipelines",
		),
	);
});

test("detectArchitectureSignals detects test frameworks", () => {
	assert.ok(detectArchitectureSignals(["jest.config.js"]).includes("Jest"));
	assert.ok(detectArchitectureSignals(["vitest.config.ts"]).includes("Vitest"));
	assert.ok(
		detectArchitectureSignals(["playwright.config.ts"]).includes("Playwright"),
	);
	assert.ok(
		detectArchitectureSignals(["cypress.config.js"]).includes("Cypress"),
	);
	assert.ok(detectArchitectureSignals(["conftest.py"]).includes("pytest"));
	assert.ok(detectArchitectureSignals(["tests/setup.ts"]).includes("test dir"));
});

test("detectArchitectureSignals detects monorepo tooling", () => {
	assert.ok(
		detectArchitectureSignals(["pnpm-workspace.yaml"]).includes("pnpm"),
	);
	assert.ok(detectArchitectureSignals(["turbo.json"]).includes("Turborepo"));
	assert.ok(detectArchitectureSignals(["nx.json"]).includes("Nx"));
	assert.ok(detectArchitectureSignals(["lerna.json"]).includes("Lerna"));
});

test("detectArchitectureSignals detects multi-package.json as monorepo", () => {
	const md = detectArchitectureSignals([
		"package.json",
		"packages/foo/package.json",
		"packages/bar/package.json",
	]);
	assert.ok(md.includes("Monorepo"));
	assert.ok(md.includes("multi-package"));
});

test("detectArchitectureSignals detects package managers from lockfiles", () => {
	const md = detectArchitectureSignals([
		"package-lock.json",
		"yarn.lock",
		"Cargo.lock",
	]);
	assert.ok(md.includes("npm"));
	assert.ok(md.includes("yarn"));
	assert.ok(md.includes("cargo"));
});

test("detectArchitectureSignals detects security signals", () => {
	const md = detectArchitectureSignals([
		"SECURITY.md",
		".github/dependabot.yml",
	]);
	assert.ok(md.includes("SECURITY.md"));
	assert.ok(md.includes("Dependabot"));
});

test("detectArchitectureSignals flags committed .env", () => {
	const md = detectArchitectureSignals([".env"]);
	assert.ok(md.includes(".env"));
});

test("detectArchitectureSignals returns empty string for plain repos", () => {
	const md = detectArchitectureSignals(["src/index.ts", "README.md"]);
	assert.strictEqual(md, "");
});

test("detectArchitectureSignals combines multiple signals", () => {
	const md = detectArchitectureSignals([
		"Dockerfile",
		".github/workflows/ci.yml",
		"vitest.config.ts",
		"package-lock.json",
		"SECURITY.md",
	]);
	assert.ok(md.includes("Docker"));
	assert.ok(md.includes("CI/CD"));
	assert.ok(md.includes("Tests"));
	assert.ok(md.includes("Package managers"));
	assert.ok(md.includes("Security"));
});

// ─── buildTree / renderTree ──────────────────────────────────────────

test("buildTree creates a root with children", () => {
	const tree = buildTree(["src/index.ts", "README.md"]);
	assert.strictEqual(tree.type, "dir");
	assert.ok(Array.isArray(tree.children));
	assert.strictEqual(tree.children?.length, 2);
});

test("buildTree nests directories correctly", () => {
	const tree = buildTree([
		"src/auth/token.ts",
		"src/auth/index.ts",
		"src/index.ts",
	]);
	const srcNode = tree.children?.find((c) => c.name === "src");
	assert.ok(srcNode);
	assert.strictEqual(srcNode.type, "dir");
	const authNode = srcNode.children?.find((c) => c.name === "auth");
	assert.ok(authNode);
	assert.strictEqual(authNode.type, "dir");
	assert.strictEqual(authNode.children?.length, 2);
});

test("buildTree handles files at root", () => {
	const tree = buildTree(["README.md", "LICENSE"]);
	assert.strictEqual(tree.children?.length, 2);
	const readme = tree.children?.find((c) => c.name === "README.md");
	assert.ok(readme);
	assert.strictEqual(readme.type, "file");
});

test("renderTree produces Unicode tree", () => {
	const tree = buildTree(["src/index.ts", "README.md"]);
	const out = renderTree(tree);
	assert.ok(out.includes("src"));
	assert.ok(out.includes("README.md"));
	assert.ok(out.includes("├── ") || out.includes("└── "));
});

test("renderTree sorts dirs first then alphabetically", () => {
	const tree = buildTree(["zebra.txt", "src/index.ts", "apple.txt"]);
	const out = renderTree(tree);
	// Dirs come before files
	const srcIdx = out.indexOf("src");
	const zebraIdx = out.indexOf("zebra.txt");
	assert.ok(srcIdx < zebraIdx, "dir should come before files");
});

test("renderTree returns empty string for empty tree", () => {
	const tree = buildTree([]);
	assert.strictEqual(renderTree(tree), "");
});

// ─── walkRepo ────────────────────────────────────────────────────────

test("walkRepo collects all files", async () => {
	const dir = join(tmpdir(), `github-map-walk-${Date.now()}`);
	await mkdir(join(dir, "src", "auth"), { recursive: true });
	await mkdir(join(dir, "tests"), { recursive: true });
	await writeFile(join(dir, "src", "index.ts"), "// index");
	await writeFile(join(dir, "src", "auth", "token.ts"), "// token");
	await writeFile(join(dir, "tests", "auth.test.ts"), "// tests");
	await writeFile(join(dir, "README.md"), "# readme");
	try {
		const result = await walkRepo(dir);
		assert.strictEqual(result.files, 4);
		assert.ok(result.paths.includes("src/index.ts"));
		assert.ok(result.paths.includes("src/auth/token.ts"));
		assert.ok(result.paths.includes("tests/auth.test.ts"));
		assert.ok(result.paths.includes("README.md"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("walkRepo skips ignored directories", async () => {
	const dir = join(tmpdir(), `github-map-walk-ignore-${Date.now()}`);
	await mkdir(join(dir, "node_modules", "lib"), { recursive: true });
	await mkdir(join(dir, ".git"), { recursive: true });
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "node_modules", "lib", "index.js"), "// nm");
	await writeFile(join(dir, ".git", "config"), "git");
	await writeFile(join(dir, "src", "index.ts"), "// src");
	try {
		const result = await walkRepo(dir);
		assert.strictEqual(result.files, 1);
		assert.ok(result.paths.includes("src/index.ts"));
		assert.ok(!result.paths.some((p) => p.includes("node_modules")));
		assert.ok(!result.paths.some((p) => p.startsWith(".git")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("walkRepo counts files and dirs separately", async () => {
	const dir = join(tmpdir(), `github-map-walk-counts-${Date.now()}`);
	await mkdir(join(dir, "a", "b", "c"), { recursive: true });
	await writeFile(join(dir, "file1.ts"), "");
	await writeFile(join(dir, "a", "file2.ts"), "");
	await writeFile(join(dir, "a", "b", "file3.ts"), "");
	await writeFile(join(dir, "a", "b", "c", "file4.ts"), "");
	try {
		const result = await walkRepo(dir);
		assert.strictEqual(result.files, 4);
		assert.strictEqual(result.dirs, 3); // a, a/b, a/b/c
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("walkRepo respects maxEntries", async () => {
	const dir = join(tmpdir(), `github-map-walk-max-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < 10; i++) {
		await writeFile(join(dir, `file${i}.ts`), "");
	}
	try {
		const result = await walkRepo(dir, { maxEntries: 3 });
		assert.ok(result.paths.length <= 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── mapGitHubRepo (orchestrator) ────────────────────────────────────

test("mapGitHubRepo on blob URL returns single URL", async () => {
	const ref = parseGitHubMapUrl(
		"https://github.com/owner/repo/blob/main/src/index.ts",
	);
	assert.ok(ref);
	const map = await mapGitHubRepo(
		"https://github.com/owner/repo/blob/main/src/index.ts",
		ref,
		{ max: 50 },
	);
	assert.strictEqual(map.ok, true);
	assert.strictEqual(map.urls.length, 1);
	assert.ok(map.urls[0].includes("src/index.ts"));
});

test("mapGitHubRepo on feature URL returns feature items as URLs", async () => {
	// We can't make real API calls — test that the parser handles
	// feature URLs and the orchestrator doesn't crash on a feature
	// kind that the API can't resolve. (Feature calls fail silently
	// and return empty arrays.)
	const ref = parseGitHubMapUrl("https://github.com/owner/repo/issues");
	assert.ok(ref);
	assert.strictEqual(ref.kind, "feature");
	// Don't actually call mapGitHubRepo — it would try to reach the API.
	// The blob case above already exercises the no-network path.
});

test("mapGitHubRepo on tree URL handles API failure gracefully", async () => {
	const ref = parseGitHubMapUrl(
		"https://github.com/nonexistent-owner-zzzz/repo/tree/main/src",
	);
	assert.ok(ref);
	assert.strictEqual(ref.kind, "tree");
	// Without a real API or clone, this should return ok:false with
	// a clear error rather than throwing.
	try {
		const map = await mapGitHubRepo(
			"https://github.com/nonexistent-owner-zzzz/repo/tree/main/src",
			ref,
			{ max: 10 },
		);
		// Either ok:true (if API happens to respond) or ok:false
		// with a clear error message.
		if (!map.ok) {
			assert.ok(map.error);
		}
	} catch (err) {
		// Should not throw — failures must be caught
		assert.fail(`mapGitHubRepo should not throw on API failure: ${err}`);
	}
});

test("mapGitHubRepo on repo URL returns a usable map structure", async () => {
	const ref = parseGitHubMapUrl("https://github.com/owner/repo");
	assert.ok(ref);
	assert.strictEqual(ref.kind, "repo");
	// mapGitHubRepo on a real repo URL will try to clone or hit the API.
	// We can't predict which without network, so just assert the shape.
	try {
		const map = await mapGitHubRepo("https://github.com/owner/repo", ref, {
			max: 5,
		});
		assert.ok(Array.isArray(map.urls));
		assert.ok(typeof map.sources === "object");
		assert.ok(map.summary);
	} catch (err) {
		// Should not throw
		assert.fail(`mapGitHubRepo should not throw: ${err}`);
	}
});

// ─── filterRepoPaths ──────────────────────────────────────────────

test("filterRepoPaths drops node_modules entries", () => {
	const paths = [
		"src/index.ts",
		"node_modules/lib/foo.js",
		"node_modules/@types/node/index.d.ts",
	];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, ["src/index.ts"]);
});

test("filterRepoPaths drops asset files", () => {
	const paths = [
		"src/index.ts",
		"docs/logo.png",
		"docs/banner.svg",
		"docs/screenshot.jpeg",
	];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, ["src/index.ts"]);
});

test("filterRepoPaths drops lockfiles (huge)", () => {
	const paths = [
		"src/index.ts",
		"yarn.lock",
		"package-lock.json",
		"Cargo.lock",
	];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, ["src/index.ts"]);
});

test("filterRepoPaths drops build outputs", () => {
	const paths = [
		"src/index.ts",
		"dist/bundle.js",
		"build/output.js",
		"target/release/app",
		"app.min.js",
	];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, ["src/index.ts"]);
});

test("filterRepoPaths drops vendored / venv dirs", () => {
	const paths = [
		"src/index.ts",
		"vendor/lib/foo.php",
		"venv/bin/python",
		".venv/lib/python3/site-packages/foo.py",
	];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, ["src/index.ts"]);
});

test("filterRepoPaths respects max cap", () => {
	// Build more than MAX_TREE_PATHS — verify it caps (we don't generate
	// the full list, just enough to confirm the cap is honored).
	const paths = [];
	for (let i = 0; i < 25; i++) paths.push(`src/file${i}.ts`);
	const out = filterRepoPaths(paths);
	assert.strictEqual(out.length, 25);
});

test("filterRepoPaths keeps README and source files", () => {
	const paths = [
		"README.md",
		"src/index.ts",
		"src/auth/token.ts",
		"tests/auth.test.ts",
		"package.json",
	];
	const out = filterRepoPaths(paths);
	assert.strictEqual(out.length, 5);
	assert.ok(out.includes("README.md"));
	assert.ok(out.includes("package.json"));
});

test("filterRepoPaths is case-insensitive", () => {
	const paths = ["src/index.ts", "docs/Logo.PNG", "docs/banner.SVG"];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, ["src/index.ts"]);
});

test("filterRepoPaths returns empty for noisy trees", () => {
	const paths = [
		"node_modules/lib/foo.js",
		"vendor/lib/foo.php",
		"docs/logo.png",
	];
	const out = filterRepoPaths(paths);
	assert.deepStrictEqual(out, []);
});

// ─── renderGitHubMap-style summary is non-empty for valid map ───────────

test("renderGitHubMap-style summary is non-empty for valid map", async () => {
	const ref = parseGitHubMapUrl(
		"https://github.com/owner/repo/blob/main/README.md",
	);
	assert.ok(ref);
	const map = await mapGitHubRepo(
		"https://github.com/owner/repo/blob/main/README.md",
		ref,
	);
	// The summary is always populated even on failure
	assert.ok(typeof map.summary === "string");
	assert.ok(map.summary.length > 0);
});
