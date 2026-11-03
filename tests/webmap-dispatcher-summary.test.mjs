// Dispatcher-level probe for verify-round finding 1, driving the REAL
// `mapGitHubRepo` with the GitHub transport stubbed, so the summary line is the
// one a user would read rather than a hand-called formatter.
import assert from "node:assert";
import test, { mock } from "node:test";

const N_DIRS = 11000;
const N_FILES = 11000;
const tree = [];
for (let i = 0; i < N_DIRS; i++) tree.push({ path: `d${i}`, type: "tree" });
for (let i = 0; i < N_FILES; i++) tree.push({ path: `d${i}/f${i}.ts`, type: "blob" });

const api = async (path) => {
	if (path.includes("/git/trees/")) return { tree, truncated: false };
	if (/^\/repos\/o\/r\?/.test(path) || path === "/repos/o/r") {
		return {
			full_name: "o/r",
			default_branch: "main",
			description: "probe",
			stargazers_count: 1,
			forks_count: 0,
			language: "TypeScript",
		};
	}
	return null;
};

const apiPath = new URL("../src/github-api.ts", import.meta.url).href;
mock.module(apiPath, {
	namedExports: {
		ghFetch: api,
		ghFetchWithFallback: api,
		getGithubToken: () => null,
	},
});

// The mock must be installed BEFORE github-map is first imported, otherwise its
// static import of ./github-api.ts is already resolved and the stub is ignored.
const mod = await import("../src/github-map.ts");
const { MAX_TREE_PATHS } = mod;

test("#191 verify: the real dispatcher reports an exact pre-cap census as exact", async () => {
	const r = await mod.mapGitHubRepo("https://github.com/o/r", {
		kind: "repo",
		owner: "o",
		repo: "r",
		ref: "main",
	}, { max: 100 });
	const summary = String(r.summary || "");
	const line = summary.split("\n").find((l) => l.includes("Total entries"));
	console.log("SUMMARY:", line);
	console.log("TREE   :", String(r.treeMarkdown || "").split("\n")[0]);
	console.log("repo   :", JSON.stringify({ files: r.repo?.totalFiles, dirs: r.repo?.totalDirs }));

	assert.ok(line, `no Total entries line in: ${summary.slice(0, 300)}`);
	// The API response was complete, so the census is exact even though only
	// MAX_TREE_PATHS entries were retained.
	assert.doesNotMatch(line, /at least/, `exact census reported as a lower bound: ${line}`);
	assert.match(line, new RegExp(`Total entries: ${N_DIRS + N_FILES}`), `census total not reported: ${line}`);
	// The retained bound is still disclosed, as itself.
	assert.match(line, new RegExp(String(MAX_TREE_PATHS)), `retained bound not disclosed: ${line}`);
	// And the shape numbers agree with the census, not the retained slice.
	assert.equal(r.repo.totalFiles, N_FILES);
	assert.equal(r.repo.totalDirs, N_DIRS);
});
