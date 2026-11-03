// ─── aio-webmap GitHub feature URLs (issue #165, F12/F13) ───
//
// F12: the Tags API returns no `html_url`, so the generic fallback built
// `https://github.com/o/r/tags/<name>` — which GitHub answers with 404. A live
// `aio-webmap("https://github.com/apmantza/pi-webaio")` returned 20 such dead
// URLs. `/releases/tag/<name>` is the page that exists; verified 200 for tags
// WITH a release (pi-webaio, got) and for bare tags in repos publishing no
// releases at all (torvalds/linux, golang/go: 100 tags, 0 releases, all 200).
// A bogus tag name still 404s, so this is not a way to mint fake links.
//
// F13: GitHub's Issues API returns pull requests too (shared number space), and
// nothing filtered them, so `github-api:issues` listed /pull/163, /pull/160 …
// duplicated from the `pulls` bucket.
//
// Recurrence prevented: dead URLs handed to an agent as discovery output, and a
// feature bucket silently duplicating another.
import assert from "node:assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blankCommentsAndStrings } from "./helpers.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
import test from "node:test";
import {
	buildTree,
	contentEntryPaths,
	normalizeContentEntryType,
	mapFeatureItems,
	repoTreeEntryUrl,
	repoEntryCensus,
	recursiveTreePaths,
} from "../src/github-map.ts";

const O = "apmantza";
const R = "pi-webaio";

// ─── F12: tags must resolve ───

test("F12: tag links use /releases/tag/<name>, never /tags/<name>", () => {
	const tags = [
		{ name: "v1.0.9", commit: { sha: "a".repeat(40) } },
		{ name: "v1.0.8", commit: { sha: "b".repeat(40) } },
	];
	const links = mapFeatureItems(O, R, "tags", tags, 20);
	assert.equal(links.length, 2);
	assert.deepEqual(
		links.map((l) => l.url),
		[
			`https://github.com/${O}/${R}/releases/tag/v1.0.9`,
			`https://github.com/${O}/${R}/releases/tag/v1.0.8`,
		],
	);
	// The dead shape, asserted explicitly so a regression cannot slip back in.
	for (const l of links) {
		assert.ok(!l.url.includes("/tags/"), `dead /tags/ URL: ${l.url}`);
		assert.ok(!l.url.includes("/tree/"), `not the tree page: ${l.url}`);
	}
});

test("F12: a tag whose name needs escaping still resolves", () => {
	const links = mapFeatureItems(O, R, "tags", [{ name: "release 2.0" }], 5);
	assert.equal(links.length, 1);
	assert.equal(
		links[0].url,
		`https://github.com/${O}/${R}/releases/tag/release%202.0`,
	);
});

test("F12: a tag carrying html_url keeps the API's own URL", () => {
	const links = mapFeatureItems(
		O,
		R,
		"tags",
		[{ name: "v2", html_url: "https://github.com/o/r/releases/tag/v2" }],
		5,
	);
	assert.equal(links[0].url, "https://github.com/o/r/releases/tag/v2");
});

// ─── F13: pull requests do not belong in the issues bucket ───

test("F13: the issues bucket excludes pull requests", () => {
	const mixed = [
		{ number: 165, title: "Bug hunt round 2", state: "open" },
		{ number: 164, title: "PR: fix search", state: "open", pull_request: { url: "…" } },
		{ number: 163, title: "PR: add verticals", state: "closed", pull_request: { url: "…" } },
		{ number: 160, title: "Real issue", state: "closed" },
	];
	const links = mapFeatureItems(O, R, "issues", mixed, 20);
	assert.deepEqual(
		links.map((l) => l.number),
		[165, 160],
		"only genuine issues survive",
	);
	for (const l of links) {
		assert.ok(!l.url.includes("/pull/"), `PR URL in the issues bucket: ${l.url}`);
	}
	assert.deepEqual(
		links.map((l) => l.url),
		[
			`https://github.com/${O}/${R}/issues/165`,
			`https://github.com/${O}/${R}/issues/160`,
		],
	);
});

test("F13: the pulls bucket keeps pull requests", () => {
	const pulls = [
		{ number: 164, title: "PR: fix search", html_url: "https://github.com/o/r/pull/164" },
		{ number: 163, title: "PR: add verticals", html_url: "https://github.com/o/r/pull/163" },
	];
	const links = mapFeatureItems(O, R, "pulls", pulls, 20);
	assert.equal(links.length, 2);
	assert.ok(links.every((l) => l.url.includes("/pull/")));
});

test("F13: limit counts surviving issues, not pre-filter rows", () => {
	// Five PRs then two issues: a limit of 2 must still yield 2 real issues,
	// not 2 rows that were then all filtered away.
	const rows = [
		...Array.from({ length: 5 }, (_, i) => ({ number: i, title: `PR ${i}`, pull_request: {} })),
		{ number: 10, title: "Issue A" },
		{ number: 11, title: "Issue B" },
	];
	const links = mapFeatureItems(O, R, "issues", rows, 2);
	assert.deepEqual(links.map((l) => l.number), [10, 11]);
});

// ─── No regression on the other feature shapes ───

test("other features keep their URLs and titles", () => {
	const releases = mapFeatureItems(
		O,
		R,
		"releases",
		[{ tag_name: "v1.0.9", name: "v1.0.9", html_url: "https://github.com/o/r/releases/tag/v1.0.9" }],
		5,
	);
	assert.equal(releases[0].url, "https://github.com/o/r/releases/tag/v1.0.9");

	const runs = mapFeatureItems(
		O,
		R,
		"actions",
		{ workflow_runs: [{ id: 1, display_title: "CI", html_url: "https://gh.run/1", conclusion: "success" }] },
		5,
	);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].title, "CI");
	assert.equal(runs[0].state, "success");

	const commits = mapFeatureItems(
		O,
		R,
		"commits",
		[{ sha: "abcdef1234567", commit: { message: "fix: thing\n\nbody" } }],
		5,
	);
	assert.equal(commits[0].title, "fix: thing");
	assert.equal(commits[0].url, `https://github.com/${O}/${R}/commits/abcdef1234567`);
});

test("actions: the workflow_runs object body unwraps instead of yielding nothing", () => {
	// Recurrence prevented: /actions/runs returns `{ total_count, workflow_runs }`
	// (verified live against apmantza/pi-webaio), but the array check ran before
	// the unwrap, so `github-api:actions` was permanently empty.
	const body = {
		total_count: 2,
		workflow_runs: [
			{ id: 1, display_title: "CI", html_url: "https://github.com/o/r/actions/runs/1", conclusion: "success" },
			{ id: 2, display_title: "Release", html_url: "https://github.com/o/r/actions/runs/2", conclusion: "failure" },
		],
	};
	const runs = mapFeatureItems(O, R, "actions", body, 20);
	assert.equal(runs.length, 2, "the wrapper object must unwrap to its run list");
	assert.deepEqual(runs.map((r) => r.title), ["CI", "Release"]);
	assert.deepEqual(runs.map((r) => r.state), ["success", "failure"]);
});

test("non-array payloads yield no links", () => {
	assert.deepEqual(mapFeatureItems(O, R, "issues", null, 5), []);
	assert.deepEqual(mapFeatureItems(O, R, "issues", { message: "Not Found" }, 5), []);
});

// #176 — the repo map emitted `${repoUrl}/blob/${branch}/${p}` for EVERY tree
// entry. The recursive Git Trees API returns directory entries (trailing slash)
// alongside blobs, and GitHub serves /blob/ only for files, so every directory
// URL in an aio-webmap repo result was a 404. The clone-walk path pushes only
// `e.isFile()` results, so the two sources feeding the same `fileUrls` field
// disagreed: the same directory was a URL from one path and absent from the
// other. Recurrence: any caller that clicks a directory URL from a repo map.
test("#176: a directory entry maps to /tree/, never to /blob/", () => {
	assert.equal(
		repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "src/"),
		`https://github.com/${O}/${R}/tree/main/src`,
	);
	assert.equal(
		repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "src/tools/"),
		`https://github.com/${O}/${R}/tree/main/src/tools`,
	);
});

test("#176: a file entry keeps /blob/", () => {
	assert.equal(
		repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "README.md"),
		`https://github.com/${O}/${R}/blob/main/README.md`,
	);
	assert.equal(
		repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "src/tools/webfetch.ts"),
		`https://github.com/${O}/${R}/blob/main/src/tools/webfetch.ts`,
	);
});

test("#176: the tree URL carries no trailing slash and no double slash", () => {
	// GitHub's canonical directory URL is /tree/<branch>/<path>; a trailing
	// slash redirects, and a doubled one from the entry's own slash is a
	// malformed URL that some clients refuse.
	const url = repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "docs/");
	assert.ok(!url.endsWith("/"), `tree URL must not end in a slash: ${url}`);
	assert.ok(!url.includes("//docs"), `no doubled slash: ${url}`);
});

test("#176: the root tree entry maps to the repo tree, not a bare path", () => {
	// The recursive API never yields "" for the root, but listContents can
	// return odd shapes; a URL of /tree/main/ is a redirect to the repo home.
	assert.equal(
		repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "/"),
		`https://github.com/${O}/${R}/tree/main`,
	);
});

test("#176: non-ASCII and space-bearing paths stay escapable", () => {
	// The builder must not pre-encode: GitHub accepts the literal path and the
	// caller decides encoding, so encoding here would double-encode %25.
	const url = repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", "my dir/");
	assert.equal(url, `https://github.com/${O}/${R}/tree/main/my dir`);
});

// #176, second half: the contents-listing fallback was the ONLY reachable way a
// directory entered `paths` (the recursive API filters `type === "blob"`, the
// clone walk filters `e.isFile()`), and it filtered nothing. Reproduced through
// the production call path, not assumed: the issue's own premise that the API
// emits directories turned out to be false, so a fix aimed only at the URL
// builder would have left the live bug in place — a dir from this source has no
// trailing slash, so no slash-based rule can recognise it. `contentEntryPaths`
// therefore normalises the slash on the way in: the representation every
// consumer already reads is established at the boundary instead of being
// re-derived downstream.
// #176 as filed asks for the directory-INCLUSIVE count and names the emitted
// URLs as the defect. A first revision of this fix dropped directories instead,
// which fixed the URL shape by deleting the entries the issue asked to keep —
// and for a repo whose root listing is mostly directories it produced an EMPTY
// tree: no markdown, no URLs, no children. Sourcery caught it on the diff.
// Directories are therefore kept, slash-terminated.
test("#176: the contents fallback keeps directories, slash-terminated", () => {
	assert.deepEqual(
		contentEntryPaths([
			{ path: "README.md", type: "file" },
			{ path: "src", type: "dir" },
			{ path: "docs/guide", type: "dir" },
			{ path: "package.json", type: "file" },
		]),
		["README.md", "src/", "docs/guide/", "package.json"],
	);
});

test("#176: a directory-only root listing still yields a tree", () => {
	// The regression the dropped-directories version caused: entries existed, the
	// map came back empty, and nothing downstream could tell the two apart.
	const entries = [
		{ path: "packages", type: "dir" },
		{ path: "apps", type: "dir" },
	];
	const paths = contentEntryPaths(entries);
	assert.equal(paths.length, 2, "a directory-only root must not map to nothing");
	assert.ok(
		repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", paths[0]).includes("/tree/main/packages"),
		"and the directory must link as /tree/, never /blob/",
	);
});

test("#176: the slash is the one representation every consumer reads", () => {
	// countDirs/countFiles, buildTree and repoTreeEntryUrl all key on the trailing
	// slash. If buildTree stops honouring it, a directory renders as a file leaf
	// while the counters and the URLs say directory.
	const tree = buildTree(["README.md", "src/", "src/index.ts"]);
	const src = tree.children.find((c) => c.name === "src");
	assert.equal(src?.type, "dir", "a slash-terminated entry is a directory node");
	const readme = tree.children.find((c) => c.name === "README.md");
	assert.equal(readme?.type, "file");
});

test("#176: a submodule is not passed through as a file; a symlink is admitted as one", () => {
	// GitHub also reports `type: "symlink"` and `type: "submodule"`. They were lumped
	// together here on the reasoning that neither is "a blob whose contents /blob/ can
	// render", which is TRUE of a gitlink (not cloned into the web tree; both derivable
	// URLs 404) and FALSE of a symlink. Measured live on the entries the API reports for
	// git/git:
	//   200  https://github.com/git/git/blob/master/RelNotes              (file symlink)
	//   200  https://github.com/git/git/blob/master/subprojects/git-gui   (DIRECTORY symlink)
	// Dropping symlinks here also made this source disagree with the recursive trees API
	// and the clone walk about the same repository — #197 surviving its own fix (#199).
	assert.deepEqual(
		contentEntryPaths([
			{ path: "link", type: "symlink" },
			{ path: "vendor/lib", type: "submodule" },
			{ path: "keep.ts", type: "file" },
		]),
		["link", "keep.ts"],
	);
});

// This test used to assert `[]` — i.e. that a directory-only listing maps to
// nothing. That was not in #176 and not in GitHub's semantics; it was the
// over-narrowing this round exists to undo, and it passed because it restated
// the implementation instead of the requirement. The requirement is that a
// directory yields a `/tree/` link, so that is what is asserted now.
test("#176: an all-directory listing yields /tree/ URLs, not an empty map", () => {
	const paths = contentEntryPaths([
		{ path: "a", type: "dir" },
		{ path: "b", type: "dir" },
	]);
	assert.deepEqual(paths, ["a/", "b/"]);
	const urls = paths.map((p) => repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", p));
	assert.deepEqual(urls, [
		`https://github.com/${O}/${R}/tree/main/a`,
		`https://github.com/${O}/${R}/tree/main/b`,
	]);
	assert.ok(
		!urls.some((u) => u.includes("/blob/")),
		`no directory may link as /blob/: ${urls.join(" ")}`,
	);
});

// #176, the door the first fix opened. `listContents` used to write
// `type === "dir" ? "dir" : "file"`, and `ApiEntry.type` was declared
// `"file" | "dir"` — the type asserted no other entry could exist, which is what
// made inventing a `file` for a `submodule` type-check. Tested here as a pure
// leaf because `listContents` itself is a network call; without this seam the
// collapse had no offline detector at all.
test("#176: contents types are preserved, and unrecognised ones are not files", () => {
	assert.equal(normalizeContentEntryType("file"), "file");
	assert.equal(normalizeContentEntryType("dir"), "dir");
	assert.equal(normalizeContentEntryType("symlink"), "symlink");
	assert.equal(normalizeContentEntryType("submodule"), "submodule");
	// Fail closed: a GitHub entry type nobody has seen must not default to the
	// shape that produces a `/blob/` link.
	for (const weird of [undefined, null, "", "blob", "tree", "Directory"]) {
		assert.equal(
			normalizeContentEntryType(weird),
			"unknown",
			`${JSON.stringify(weird)} must not be trusted as a file`,
		);
	}
});

test("#176: end to end, a raw contents listing fabricates no links for unreachable kinds", () => {
	const raw = [
		{ path: "README.md", type: "file" },
		{ path: "src", type: "dir" },
		{ path: "link", type: "symlink" },
		{ path: "vendor/lib", type: "submodule" },
		{ path: "mystery", type: "who-knows" },
	];
	const paths = contentEntryPaths(raw.map((e) => ({ ...e, type: normalizeContentEntryType(e.type) })));
	// `link` is IN. The original version of this test excluded it with the gitlink on the
	// shared assumption that a `/blob/` link cannot render either kind; that assumption is
	// false for a symlink, measured live on git/git (200 for /blob/master/RelNotes and 200
	// for the DIRECTORY symlink /blob/master/subprojects/git-gui), and keeping it excluded
	// left this source disagreeing with the trees API and the clone walk (#197 via #199).
	// The fail-closed rule still governs the two kinds that genuinely 404: a gitlink and
	// any entry type GitHub has not told us about.
	assert.deepEqual(paths, ["README.md", "src/", "link"]);
	const urls = paths.map((p) => repoTreeEntryUrl(`https://github.com/${O}/${R}`, "main", p));
	// Nothing whose type is unrenderable may appear in the URL list at all, and the one
	// directory entry must be `/tree/`. (Asserting "no /blob/ anywhere" here would be
	// wrong: README.md is a real file and its blob link is correct.)
	assert.ok(
		!urls.some((u) => /vendor|mystery/.test(u)),
		`an unreachable entry leaked a URL: ${urls.join(" ")}`,
	);
	assert.ok(
		urls.some((u) => u === `https://github.com/${O}/${R}/blob/main/link`),
		`the symlink must get its reachable blob link: ${urls.join(" ")}`,
	);
	assert.ok(urls.some((u) => u.includes("/tree/main/src")), "the directory must still be mapped");
	assert.ok(
		urls.some((u) => u === `https://github.com/${O}/${R}/blob/main/README.md`),
		"the real file must keep its blob link",
	);
});

// The leaf above is pure, but the defect lived in how `listContents` WIRES the
// API response to it — and that function is a network call with no offline
// path. Reverting the wiring to `type === "dir" ? "dir" : "file"` would leave
// every leaf test green while shipping the bug, so the wiring itself is pinned by
// shape over blanked source (comments and strings cannot satisfy it).
test("#176: the contents wiring may not collapse entry types back to file", async () => {
	const src = await blankCommentsAndStrings(
		join(HERE, "..", "src", "github-map.ts"),
	);
	const fn = src.match(/async function listContents[\s\S]*?\n}/)?.[0];
	assert.ok(fn, "listContents must exist in src/github-map.ts");
	assert.ok(
		fn.includes("normalizeContentEntryType("),
		"listContents must map entry types through the tested leaf",
	);
	assert.ok(
		!/["']dir["']\s*\?\s*["']dir["']\s*:\s*["']file["']/.test(fn),
		"the `dir ? dir : file` collapse is the #176 fabrication and must not return",
	);
});

// ─── #184: the recursive Git Trees API is the NORMAL source, and it emitted no
// directories at all, so repo.totalDirs was a constant 0 for every repo mapped
// through it while the last-resort contents listing counted dirs correctly. The
// count read a representation its own source never produced.
//
// Fixture below is the shape GET /repos/{o}/{r}/git/trees/{ref}?recursive=1
// actually returns (verified against apmantza/pi-webaio), including the entry
// kinds the endpoint mixes in: symlink, submodule and the "commit" entry a
// gitlink becomes.

const RECURSIVE_FIXTURE = [
	{ path: "README.md", mode: "100644", type: "blob" },
	{ path: "src", mode: "040000", type: "tree" },
	{ path: "src/github-map.ts", mode: "100644", type: "blob" },
	{ path: "src/tools", mode: "040000", type: "tree" },
	{ path: "src/tools/webmap.ts", mode: "100644", type: "blob" },
	{ path: "docs", mode: "040000", type: "tree" },
	// A symlink is a BLOB with mode 120000 (verified on git/git and torvalds/linux);
	// `type: "symlink"` is a contents-API word and never appears in this response.
	{ path: "legacy", mode: "120000", type: "blob" },
	// A gitlink is type "commit" and its /blob/ URL 404s.
	{ path: "vendor/lib", mode: "160000", type: "commit" },
];

test("#184: the recursive tree source keeps directories, slash-terminated", () => {
	const paths = recursiveTreePaths(RECURSIVE_FIXTURE);
	const dirs = paths.filter((p) => p.endsWith("/"));
	assert.deepEqual(dirs, ["src/", "src/tools/", "docs/"], `dirs from the API source: ${dirs}`);
	// The defect: this count was 0 for every repo on the normal path.
	assert.ok(dirs.length > 0, "the API source produced no directory entries");
});

test("#184: the gitlink is excluded, the symlink blob is kept", () => {
	const paths = recursiveTreePaths(RECURSIVE_FIXTURE);
	// Verified: a gitlink's /blob/ URL 404s (git/git/blob/master/sha1collisiondetection),
	// a symlink's resolves (torvalds/linux/blob/master/AGENTS.md -> 200). Only the first
	// is therefore excluded.
	for (const bad of ["vendor/lib", "vendor/lib/"]) {
		assert.ok(!paths.includes(bad), `a gitlink leaked into the URL list: ${bad}`);
	}
	assert.ok(paths.includes("legacy"), "a reachable symlink blob was dropped");
	// Files are unchanged, and never carry the slash.
	assert.ok(paths.includes("src/github-map.ts") && paths.includes("src/tools/webmap.ts"));
});

test("#184: the API-sourced paths satisfy every consumer the contents source does", () => {
	const paths = recursiveTreePaths(RECURSIVE_FIXTURE).filter((p) => !p.startsWith("vendor/"));
	// The dispatcher's own census, not a re-implementation of its rule in the test:
	// copying the rule is what let `countDirs` return 0 with every test green.
	// 4 files because the symlink blob is reachable and therefore kept.
	assert.deepEqual(repoEntryCensus(paths), { files: 4, dirs: 3 });
	// buildTree must not render a directory as a file leaf.
	const tree = buildTree(paths);
	const src = tree.children.find((c) => c.name === "src");
	assert.equal(src.type, "dir", "src rendered as a file leaf");
	const docs = tree.children.find((c) => c.name === "docs");
	assert.equal(docs.type, "dir", "a directory with no files inside rendered as a file leaf");
	// repoTreeEntryUrl must route directories to /tree/.
	assert.equal(
		repoTreeEntryUrl("https://github.com/o/r", "main", "docs/"),
		"https://github.com/o/r/tree/main/docs",
	);
});

test("#184: the recursive source and the contents source spell entries identically", () => {
	// Same entries, two sources. The two listings cover different depths (the
	// contents endpoint is per-directory), so what must match is the SPELLING of a
	// given entry and which entries are admitted at all — that is the single
	// representation #176 and #184 are about.
	const fromTree = recursiveTreePaths([
		{ path: "README.md", type: "blob" },
		{ path: "src", type: "tree" },
		{ path: "docs", type: "tree" },
	]);
	const fromContents = contentEntryPaths([
		{ path: "README.md", type: "file" },
		{ path: "src", type: "dir" },
		{ path: "docs", type: "dir" },
	]);
	assert.deepEqual([...fromTree].sort(), [...fromContents].sort());
	assert.ok(fromTree.includes("src/") && fromTree.includes("docs/"));
	// The endpoints still differ on symlinks: the contents API excludes them (#176's
	// settled decision) while a trees symlink is a reachable blob. That divergence is
	// out of #184's scope and is recorded as a named remainder rather than papered
	// over by claiming the sources are identical for every entry kind.
});

// The path field comes off the network and is typed `unknown` on purpose. A gate at
// that boundary admits the shapes it recognises and refuses everything else, so a
// malformed entry must vanish rather than reach the URL builder as "undefined".
test("#184: an entry without a usable path is dropped, not stringified", () => {
	const paths = recursiveTreePaths([
		{ path: null, type: "blob" },
		{ path: 42, type: "tree" },
		{ path: { nested: true }, type: "blob" },
		{ type: "blob" },
		{ path: "", type: "blob" },
		{ path: "real/file.ts", type: "blob" },
	]);
	assert.deepEqual(paths, ["real/file.ts"], `malformed entries leaked: ${JSON.stringify(paths)}`);
	assert.ok(!paths.some((p) => String(p).includes("undefined")), "undefined reached the path list");
});
