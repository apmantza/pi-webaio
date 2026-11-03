// #200 — `walkRepo` prunes with its OWN `skipDirs` set plus a blanket "starts with ."
// rule; the API path prunes with `REPO_PATH_EXCLUSIONS` via `dropExcludedPaths`. Two
// independent lists, so the same repository reports different totals depending on which
// source answered — and, exactly as in #197, the clone total arrives labelled EXACT.
//
// The decision recorded on the issue: the WALK stops pruning what the FILTER does not
// prune, and `REPO_PATH_EXCLUSIONS` becomes the one source. Direction chosen on
// evidence, not taste — the API is the primary source and the clone walk is the
// fallback, so the fallback bends to it; and the blanket dot rule does not hide noise:
//   $ gh api repos/actions/checkout/git/trees/main?recursive=1 → 43 dot-paths
//   .github/workflows/check-dist.yml, codeql-analysis.yml, licensed.yml …
// i.e. it hides the CI configuration, usually the most decision-relevant material in a
// repository for an agent surveying it, while labelling the total exact.
//
// Parity is asserted against git's own `ls-tree -r -t` through the project's own
// `recursiveTreePaths` + `dropExcludedPaths`, not hand-shaped API JSON.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { walkRepo, dropExcludedPaths, recursiveTreePaths } = await import("../src/github-map.ts");

/** A committed repository, so `git ls-tree` answers about real index entries. */
function fixtureRepo(t, files) {
	const root = mkdtempSync(join(tmpdir(), "p200-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const f of files) {
		mkdirSync(join(root, f.split("/").slice(0, -1).join("/") || "."), { recursive: true });
		writeFileSync(join(root, f), "content\n");
	}
	for (const cmd of [["git", ["init", "-q"]], ["git", ["add", "-A"]], ["git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]]]) {
		execFileSync(cmd[0], cmd[1], { cwd: root, stdio: "ignore" });
	}
	return root;
}

/** The API's own view of the same tree, filtered by the API's own exclusion list. */
function apiCensus(root) {
	// Parse git's REAL entry type. Mapping every line to `blob` is the trap: a tree then
	// loses its trailing slash, `"node_modules/"` stops matching the bare `node_modules`
	// directory, and the instrument reports a phantom divergence in the API's own filter
	// (same class of error as #197's raw-ls-tree comparison).
	const out = execFileSync("git", ["ls-tree", "-r", "-t", "HEAD"], { cwd: root, encoding: "utf8" });
	const entries = out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [meta, path] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
			const type = meta.split(/\s+/)[1]; // blob | tree | commit | symlink
			return { path, type };
		});
	return dropExcludedPaths(recursiveTreePaths(entries));
}

// Every entry the issue's member list names, plus the ones the list claimed were
// "consistent" and the code says are not.
const SPEC = [
	"mirror.ts",
	"src/app.ts",
	".github/workflows/ci.yml",   // kept by both today (explicit exemption)
	".config/c.ts",               // blanket dot rule prunes it in the walk only
	".circleci/config.ts",
	".pytest_cache/v.ts",
	".mypy_cache/x.ts",
	".tox/y.ts",
	"target/out.ts",
	"dist/bundle.ts",
	"build/gen.ts",
	".next/n.ts",
	".nuxt/n.ts",
	"node_modules/pkg/i.js",      // excluded by both
];

test("#200: the clone walk and the API exclusion filter agree on the same tree", async (t) => {
	const root = fixtureRepo(t, SPEC);
	const walk = await walkRepo(root);
	const api = apiCensus(root);
	// PATHS, not counts — two sources can hold the same number of entries and still
	// disagree about which ones (#197's lesson).
	assert.deepEqual(
		[...walk.paths].sort(),
		[...api].sort(),
		`clone census and API census disagree:\n  walk: ${JSON.stringify([...walk.paths].sort())}\n  api : ${JSON.stringify([...api].sort())}`,
	);
});

test("#200: hidden directories the API shows are not hidden by the map", async (t) => {
	const root = fixtureRepo(t, SPEC);
	const walk = await walkRepo(root);
	// The CI configuration is the concrete reason this is a defect and not a
	// presentation preference: GitHub shows it, the API counts it, and a map that omits
	// it is a confidently wrong answer labelled exact.
	assert.ok(walk.paths.includes(".github/workflows/ci.yml"), JSON.stringify(walk.paths));
	assert.ok(walk.paths.includes(".config/c.ts"), `dot-dir file hidden: ${JSON.stringify(walk.paths)}`);
	assert.ok(walk.paths.includes(".circleci/config.ts"), JSON.stringify(walk.paths));
});

test("#200: tool caches are excluded by BOTH sources", async (t) => {
	const root = fixtureRepo(t, SPEC);
	const walk = await walkRepo(root);
	for (const p of [".pytest_cache/v.ts", ".mypy_cache/x.ts", ".tox/y.ts", "node_modules/pkg/i.js"]) {
		assert.ok(!walk.paths.includes(p), `${p} must be excluded by the shared list`);
	}
});
