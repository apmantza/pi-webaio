// Dispatcher-level: architecture signals must be derived from the ELIGIBLE list
// (after exclusion, BEFORE the retention cap), not from the capped `paths` the tree
// and URLs are built from.
//
// Why this needs to be at dispatcher level: a unit-level call of
// detectArchitectureSignals with a capped vs uncapped list does NOT pin the wiring —
// reverting the call site from `signalPaths` back to `paths` left every unit test
// GREEN, which is exactly how the gap survived the refactor.
//
// Own file because mock.module cannot be installed twice in one process, and each
// test file gets its own module graph (verified with a two-file probe, not assumed).
import assert from "node:assert";
import test, { mock } from "node:test";

let tree = [];

const api = async (path) => {
	if (path.includes("/git/trees/")) return { tree, truncated: false };
	if (/^\/repos\/big\/r\?/.test(path) || path === "/repos/big/r") {
		return {
			full_name: "big/r",
			default_branch: "main",
			description: "d",
			stargazers_count: 0,
			forks_count: 0,
			language: "TypeScript",
		};
	}
	return null;
};

mock.module(new URL("../src/github-api.ts", import.meta.url).href, {
	namedExports: {
		ghFetch: api,
		ghFetchWithFallback: api,
		getGithubToken: () => null,
	},
});

const mod = await import("../src/github-map.ts");
const { MAX_TREE_PATHS } = mod;

test("#184: the dispatcher derives signals from the uncapped eligible list", async () => {
	const big = [];
	for (let i = 0; i < MAX_TREE_PATHS + 500; i++) {
		big.push({ path: `d${i}/f${i}.ts`, type: "blob" });
	}
	// Past the retention cap, but inside the eligible set the census counts.
	big.push({ path: "Dockerfile", type: "blob" });
	tree = big;

	const r = await mod.mapGitHubRepo(
		"https://github.com/big/r",
		{ kind: "repo", owner: "big", repo: "r", ref: "main" },
		{ max: 10 },
	);
	const signals = String(r.architecture || "");
	assert.ok(
		r.repo.totalFiles > MAX_TREE_PATHS,
		`fixture must cross the cap; the census said ${r.repo.totalFiles}`,
	);
	assert.match(
		signals,
		/Docker/i,
		`the census counted ${r.repo.totalFiles} files but signals missed the ` +
			`Dockerfile that sits past the cap: "${signals}"`,
	);
});
