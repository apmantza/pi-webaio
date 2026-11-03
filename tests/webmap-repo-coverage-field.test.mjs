// Verify round on master, finding 3: `repo.totalFiles` / `totalDirs` are consumed
// programmatically and carried no qualifier, so a root-only listing read as a
// repository total even though the human summary said otherwise.
//
// Own file because mock.module cannot be installed twice in one process.
import assert from "node:assert";
import test, { mock } from "node:test";

const tree = [
	{ path: "README.md", type: "blob" },
	{ path: "src", type: "tree" },
];

const api = async (path) => {
	if (path.includes("/git/trees/")) return { tree, truncated: false };
	if (/^\/repos\/small\/r(\?|$)/.test(path)) {
		return {
			full_name: "small/r",
			default_branch: "main",
			description: "d",
			stargazers_count: 0,
			forks_count: 0,
			language: "TS",
		};
	}
	if (path.includes("/contents")) {
		return [{ name: "README.md", path: "README.md", type: "file" }];
	}
	return null;
};

mock.module(new URL("../src/github-api.ts", import.meta.url).href, {
	namedExports: { ghFetch: api, ghFetchWithFallback: api, getGithubToken: () => null },
});

const mod = await import("../src/github-map.ts");

// Verify round on master, finding 3: `repo.totalFiles` / `totalDirs` are consumed
// programmatically and carried no qualifier, so a root-only listing read as a
// repository total even though the human summary said otherwise.
test("#184: the structured totals carry the scope they were counted over", async () => {
	const url = "https://github.com/small/r";
	const full = await mod.mapGitHubRepo(url, mod.parseGitHubMapUrl(url), { max: 10 });
	assert.ok(full.repo, "repo metadata expected for a repo map");
	assert.ok(
		full.repo.coverage && typeof full.repo.coverage.scope === "string",
		`structured totals must be qualified: ${JSON.stringify(full.repo.coverage)}`,
	);
	assert.equal(full.repo.coverage.scope, "recursive");
	assert.equal(full.repo.coverage.bound, undefined, "a complete tree must not carry a bound");
});
