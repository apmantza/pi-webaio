// #193 — `mapGitHubTree` (the `/tree/<ref>/<path>` dispatcher) consumed raw
// contents-API entries and built URLs itself, so neither the admission rule nor the
// `/blob/` vs `/tree/` decision that #176 put in one named place applied to it.
// A submodule became `/blob/`, which is exactly the 404 shape #176 was about,
// arriving through the door #176's fix opened.
//
// Driven through mapGitHubRepo, not the private helper, because the defect is that
// this CALLER bypasses the seam: a unit test on the seam would stay green while the
// bypass stands.
import assert from "node:assert";
import test, { mock } from "node:test";

const REPO_URL = "https://github.com/o/r";

let contents = [];

const api = async (path) => {
	// Route any repository: the prefix-trap test maps daeuniverse/dae, whose name is
	// the point of the test, and a router that only answers o/r turns that case into
	// a "Failed to list" and a passing-looking failure.
	if (/^\/repos\/[^/]+\/[^/]+\/contents/.test(path)) return contents;
	if (/^\/repos\/[^/]+\/[^/]+(\?|$)/.test(path)) {
		return {
			full_name: "o/r",
			default_branch: "main",
			description: "d",
			stargazers_count: 0,
			forks_count: 0,
			language: "TS",
		};
	}
	return null;
};

mock.module(new URL("../src/github-api.ts", import.meta.url).href, {
	namedExports: { ghFetch: api, ghFetchWithFallback: api, getGithubToken: () => null },
});

const mod = await import("../src/github-map.ts");

function mapTree() {
	const url = `${REPO_URL}/tree/main/src`;
	return mod.mapGitHubRepo(url, mod.parseGitHubMapUrl(url), { max: 10 });
}

/**
 * Exact-membership helpers.
 *
 * CodeQL flagged `urls.includes(EXACT_URL)` as "incomplete URL substring
 * sanitization" (2 high). It cannot prove `urls` is an array, so that instance is a
 * false positive — but the CLASS is exactly what this PR exists to remove: deciding
 * anything about a URL by substring is the prefix trap that makes a submodule look
 * local. Asserting `===` is the fix and is strictly stronger: a substring check
 * would also accept the same URL with a host glued in front, or with a query string
 * appended. Converted everywhere, not just on the two flagged lines.
 */
const hasUrl = (urls, want) => urls.some((u) => u === want);

/**
 * A URL is a blob link when the fourth path segment says so — not because the
 * string contains "/blob/". Segment-shaped reasoning is what `isForeignEntryUrl`
 * had to adopt for the same reason, and a test that models the rule as a substring
 * would keep passing if the builder ever emitted `/blob/` inside a path segment.
 */
const isBlobUrl = (u) => {
	const parts = new URL(u).pathname.split("/").filter(Boolean);
	return parts[2] === "blob";
};

test("#193: a submodule in a contents listing never becomes a /blob/ URL", async () => {
	contents = [
		{ name: "lib", path: "src/lib", type: "submodule" },
		{ name: "42", path: "42", type: "file" },
		{ name: "nested", path: "src/nested", type: "dir" },
		{ name: "a.ts", path: "src/a.ts", type: "file" },
	];
	const r = await mapTree();
	assert.ok(r.ok, r.summary);
	const blobbed = r.urls.filter(isBlobUrl);
	assert.ok(
		!hasUrl(blobbed, `${REPO_URL}/blob/main/src/lib`),
		`submodule emitted a /blob/ URL (the #176 404 shape): ${JSON.stringify(blobbed)}`,
	);
	// The directory must still be reachable, as a /tree/ URL with no trailing slash.
	assert.ok(
		hasUrl(r.urls, `${REPO_URL}/tree/main/src/nested`),
		`directory missing its /tree/ URL: ${JSON.stringify(r.urls)}`,
	);
	// And real files must survive — the fix must not become "drop everything".
	assert.ok(
		hasUrl(r.urls, `${REPO_URL}/blob/main/src/a.ts`),
		`a plain file was dropped: ${JSON.stringify(r.urls)}`,
	);
});

test("#193: max bounds admitted entries, not raw ones", async () => {
	// Two submodules sort ahead of two files. Bounding BEFORE admission used to let
	// the discarded submodules consume the budget, so the operator got 2 URLs out of
	// a listing holding 2 reachable entries.
	contents = [
		{ name: "l1", path: "src/l1", type: "submodule" },
		{ name: "l2", path: "src/l2", type: "submodule" },
		{ name: "f1.ts", path: "src/f1.ts", type: "file" },
		{ name: "f2.ts", path: "src/f2.ts", type: "file" },
	];
	const r = await mapTree();
	assert.ok(r.ok, r.summary);
	assert.equal(
		r.urls.length,
		2,
		`max=10 with 2 reachable entries should render both, got ${JSON.stringify(r.urls)}`,
	);
	assert.ok(
		hasUrl(r.urls, `${REPO_URL}/blob/main/src/f1.ts`) &&
			hasUrl(r.urls, `${REPO_URL}/blob/main/src/f2.ts`),
		`reachable files were starved by unreachable ones: ${JSON.stringify(r.urls)}`,
	);
});

test("#193: the tree summary denominators are ordered and named", async () => {
	contents = [
		{ name: "lib", path: "src/lib", type: "submodule" },
		{ name: "a.ts", path: "src/a.ts", type: "file" },
	];
	const r = await mapTree();
	// "listed" is what the API returned, "reachable" what admission accepted,
	// "shown" what `max` retained. The old sentence compared `shown` against the raw
	// listing, so a discard lowered one number with nothing to explain the gap.
	// Asserting the ORDER is what makes this non-vacuous: a rewrite that drops a
	// term must fail the match, not skip the assertion.
	const m = /(\d+) entries, (\d+) reachable \((\d+) shown\)/.exec(r.summary);
	assert.ok(
		m,
		`summary lost one of its three denominators, so the ordering check would ` +
			`have had nothing to check: ${r.summary}`,
	);
	const [listed, reachable, shown] = [Number(m[1]), Number(m[2]), Number(m[3])];
	assert.ok(reachable <= listed, `reachable ${reachable} exceeds listed ${listed}`);
	assert.ok(shown <= reachable, `shown ${shown} exceeds reachable ${reachable}`);
	assert.equal(reachable, 1, "the submodule must not be counted as reachable");
	assert.equal(shown, r.urls.length, "the summary's `shown` must equal urls.length");
});

test("#193: max is applied to reachable entries and reported as the reason", async () => {
	contents = Array.from({ length: 5 }, (_, i) => ({
		name: `f${i}.ts`,
		path: `src/f${i}.ts`,
		type: "file",
	}));
	const r = await mapTree(); // max: 10 -> all fit
	assert.equal(r.urls.length, 5);
	const url = `${REPO_URL}/tree/main/src`;
	const tight = await mod.mapGitHubRepo(url, mod.parseGitHubMapUrl(url), { max: 2 });
	assert.equal(tight.urls.length, 2);
	assert.match(
		tight.summary,
		/5 entries, 5 reachable \(2 shown\)/,
		`a cap that hides 3 reachable entries must say so: ${tight.summary}`,
	);
});

// The shape the issue predicted (`type: "submodule"`) is not what GitHub sends.
// Verified live against daeuniverse/dae, whose .gitmodules declares
// control/kern/headers:
//
//   contents entry          -> { name: "headers", type: "file", size: 0 }
//   /blob/main/<path>       -> 404
//   /tree/main/<path>       -> 404   (the submodule is not cloned into the web tree)
//   entry.html_url          -> https://github.com/daeuniverse/dae_bpf_headers/tree/<sha>
//
// So NO URL derived from the parent repository reaches a gitlink, and the admission
// rule cannot catch it because the endpoint calls it a file. The only reachable
// address is the one GitHub hands us. Note the prefix trap: dae_bpf_headers starts
// with "dae", so deciding "foreign" by string prefix would call this entry local.
test("#193: a gitlink reported as a file gets its authoritative URL, not a 404", async () => {
	const gitlinkHtml =
		"https://github.com/daeuniverse/dae_bpf_headers/tree/56937c66784879fe5e2ff89db5bc05aa061d594c";
	contents = [
		{
			name: "headers",
			path: "control/kern/headers",
			type: "file",
			size: 0,
			html_url: gitlinkHtml,
		},
		{
			name: "tproxy.c",
			path: "control/kern/tproxy.c",
			type: "file",
			size: 1234,
			html_url: "https://github.com/o/r/blob/main/control/kern/tproxy.c",
		},
	];
	const r = await mapTree();
	assert.ok(r.ok, r.summary);
	assert.ok(
		hasUrl(r.urls, gitlinkHtml),
		`the gitlink was not given the URL GitHub says is canonical: ${JSON.stringify(r.urls)}`,
	);
	assert.ok(
		!hasUrl(r.urls, `${REPO_URL}/blob/main/control/kern/headers`),
		`a derived URL was emitted for a gitlink, which 404s: ${JSON.stringify(r.urls)}`,
	);
	// A local file must keep the derived branch form — the fix must not become
	// "trust html_url everywhere", which would silently change every other URL.
	assert.ok(
		hasUrl(r.urls, `${REPO_URL}/blob/main/control/kern/tproxy.c`),
		`the local file lost its derived URL: ${JSON.stringify(r.urls)}`,
	);
});

// The fixture above varies the OWNER, which is the easy case: an owner-only or
// prefix-based check still gets it right. The real repository is the trap —
// `control/kern/headers` is a submodule of `daeuniverse/dae` whose own repo is
// `daeuniverse/dae_bpf_headers`, and "dae_bpf_headers" literally starts with "dae".
// This is the same prefix-shaped bug #132 was about hostnames.
test("#193: a submodule whose repo name extends the parent's is still foreign", async () => {
	const gitlinkHtml =
		"https://github.com/daeuniverse/dae_bpf_headers/tree/56937c66784879fe5e2ff89db5bc05aa061d594c";
	contents = [
		{ name: "headers", path: "control/kern/headers", type: "file", size: 0, html_url: gitlinkHtml },
		{
			name: "tproxy.c",
			path: "control/kern/tproxy.c",
			type: "file",
			size: 99,
			html_url: "https://github.com/daeuniverse/dae/blob/main/control/kern/tproxy.c",
		},
	];
	const url = "https://github.com/daeuniverse/dae/tree/main/control/kern";
	const r = await mod.mapGitHubRepo(url, mod.parseGitHubMapUrl(url), { max: 10 });
	assert.ok(r.ok, r.summary);
	assert.ok(
		hasUrl(r.urls, gitlinkHtml),
		`owner is shared, so a prefix/owner test called the gitlink local and derived a ` +
			`404 URL: ${JSON.stringify(r.urls)}`,
	);
	assert.ok(
		!hasUrl(r.urls, "https://github.com/daeuniverse/dae/blob/main/control/kern/headers"),
		`derived blob URL emitted for a gitlink: ${JSON.stringify(r.urls)}`,
	);
	// The genuinely-local sibling must NOT be dragged out of the repository.
	assert.ok(
		hasUrl(r.urls, "https://github.com/daeuniverse/dae/blob/main/control/kern/tproxy.c"),
		`the local sibling was treated as foreign: ${JSON.stringify(r.urls)}`,
	);
});

// PR #195 review, finding 2: the cap tests used `max` larger than the fixture, so
// nothing ever reached the branch where a rejected entry would have spent a slot.
// `[submodule, file]` at `max=1` is the smallest case where bounding the raw list and
// bounding the admitted list differ — the reviewer's probe showed the mutant returning
// zero URLs while the real code returns the file.
test("#193: a rejected entry at the cap boundary cannot hide the reachable one", async () => {
	contents = [
		{ name: "lib", path: "src/lib", type: "submodule" },
		{ name: "a.ts", path: "src/a.ts", type: "file" },
	];
	const url = `${REPO_URL}/tree/main/src`;
	const r = await mod.mapGitHubRepo(url, mod.parseGitHubMapUrl(url), { max: 1 });
	assert.ok(r.ok, r.summary);
	assert.equal(
		r.urls.length,
		1,
		`max=1 must still yield the one reachable entry: ${JSON.stringify(r.urls)}`,
	);
	assert.ok(
		hasUrl(r.urls, `${REPO_URL}/blob/main/src/a.ts`),
		`the reachable file was starved by a rejected entry ahead of it: ${JSON.stringify(r.urls)}`,
	);
	assert.match(
		r.summary,
		/2 entries, 1 reachable \(1 shown\)/,
		`the summary must report the real denominators: ${r.summary}`,
	);
});
