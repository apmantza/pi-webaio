// #197 — the clone walk skips symlinks that the git trees API counts, so the same
// repository reports different totals depending on which source answered, and the
// clone total arrives labelled EXACT (no cap tripped, no read failure) rather than
// as a bound. Reviewer probe F on #196: one file plus one symlink, census says one.
//
// The policy is not a taste call: in git a symlink is ALWAYS a blob (mode 120000) —
// there is no directory-symlink type — so `git ls-tree -r -t`, which is the same view
// the recursive trees API serves, reports every symlink as a blob. Parity therefore
// means: count every symlink as a file entry, and never recurse into one. Not recursing
// is also what keeps a cycle and ELOOP out of the walk, which was the walk's excuse for
// ignoring them.
//
// Verified against the live API rather than asserted from git, 2026-11-03:
//   gh api repos/git/git/git/trees/master?recursive=1
//     120000 blob  RelNotes
//     120000 blob  subprojects/git-gui     <- a symlink to a DIRECTORY, still a blob
//     120000 blob  subprojects/gitk
// So the API counted all three and the clone walk counted none of them.
//
// Parity is asserted against git's own output rather than a hand-shaped tree API
// response: shaping the API JSON by hand would only prove the fixture agrees with my
// assumption about it.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { walkRepo, repoEntryCensus, isExcludedPath, dropExcludedPaths, recursiveTreePaths, contentEntryPaths, walkSummaryLine } =
	await import("../src/github-map.ts");

// Windows needs SeCreateSymbolicLink privilege; a CI runner without it must not read
// this as "symlinks are not a defect" — the skip names itself.
let symlinkCapable = true;
try {
	const probe = mkdtempSync(join(tmpdir(), "p197-cap-"));
	symlinkSync("x", join(probe, "l"));
	rmSync(probe, { recursive: true, force: true });
} catch {
	symlinkCapable = false;
}
const syms = symlinkCapable ? test : test.skip;

/** A committed repository, so `git ls-tree` answers about real index entries. */
function fixtureRepo(t, spec) {
	const root = mkdtempSync(join(tmpdir(), "p197-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const dir of spec.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
	for (const f of spec.files ?? []) {
		mkdirSync(join(root, f.split("/").slice(0, -1).join("/") || "."), { recursive: true });
		writeFileSync(join(root, f), "content\n");
	}
	for (const [link, target] of spec.links ?? []) symlinkSync(target, join(root, link));
	// A dangling symlink is a legitimate blob in git, so it must be counted too.
	for (const link of spec.dangling ?? []) symlinkSync("nowhere-at-all", join(root, link));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync(
		"git",
		["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"],
		{ cwd: root },
	);
	return root;
}

/**
 * The upstream source of truth for the recursive trees API: mode, type and path per
 * entry, `-t` so tree entries are listed as well as recursed into, then THIS project's
 * own exclusion filter — the same `dropExcludedPaths` the API branch applies. Comparing
 * the walk against RAW ls-tree instead would compare a filtered number to an unfiltered
 * one and report a defect that is not there (it did, first time: `docs/` is excluded by
 * policy here, so both sources legitimately drop that subtree).
 *
 * Classified by the TYPE column, never by a name suffix — ls-tree prints a tree as `src`
 * with no slash, and a suffix test silently reports every directory as a file.
 */
function apiCensus(root) {
	const raw = execFileSync("git", ["ls-tree", "-r", "-t", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	});
	const entries = [];
	for (const line of raw.trim().split("\n").filter(Boolean)) {
		const [head, path] = line.split("\t");
		const [, type] = head.split(/\s+/);
		entries.push({ path, type });
	}
	// THE API's OWN RULE, not a restatement of it. Hand-classifying `type` here counted a
	// gitlink (`type: "commit"`) as a file, while `recursiveTreePaths` deliberately drops
	// gitlinks because their `/blob/` URL 404s — so the helper was the one part of this
	// test that could drift from the thing it is supposed to mirror (adversarial review P3).
	const eligible = dropExcludedPaths(recursiveTreePaths(entries));
	const c = repoEntryCensus(eligible);
	return { ...c, total: c.files + c.dirs, paths: eligible };
}

// ─── the reported defect ──────────────────────────────────────────────────────

syms("a file-mode and a directory-mode symlink are both counted (#197 probe F)", async (t) => {
	const root = fixtureRepo(t, {
		dirs: ["src"],
		files: ["a.ts", "src/b.ts"],
		links: [
			["link-to-file", "a.ts"],
			["link-to-dir", "src"],
		],
	});
	const walk = await walkRepo(root);
	// Neither bound fired, so this total is presented as the exact full tree: it has
	// to be the right number, not a plausible-looking smaller one.
	assert.equal(walk.hitCap, false);
	assert.equal(walk.readFailed, false);
	assert.equal(
		walk.paths.length,
		apiCensus(root).total,
		`census disagrees with git's own view: ${JSON.stringify(walk.paths)}`,
	);
});

syms("the clone census equals the API census over the same repository", async (t) => {
const root = fixtureRepo(t, {
dirs: ["src", "docs"],
files: ["a.ts", "src/b.ts", "src/deep/c.ts", "docs/read.md"],
links: [
["link-to-file", "a.ts"],
["link-to-dir", "src"],
// A symlink inside a KEPT subdirectory. Every fixture link was at the repository
// root, so a mutant that counts only top-level links passed all of them while
// putting `subprojects/git-gui` — the very evidence this PR cites — back to being
// skipped (adversarial review P2).
["src/nested-link", "b.ts"],
["src/deep/deep-link", "c.ts"],
],
dangling: ["broken-link"],
});
const walk = await walkRepo(root);
const api = apiCensus(root);
// PATHS, not counts. Two sources can hold the same number of entries and still
// disagree about which ones: a symlink recorded without its folder path (`l` instead
// of `src/l`) kept the count identical and produced a URL that 404s (review P2).
assert.deepEqual(
walk.paths.slice().sort(),
api.paths.slice().sort(),
"the two sources must enumerate the same entries, not merely the same number",
);
const clone = repoEntryCensus(walk.paths);
assert.deepStrictEqual(clone, { files: api.files, dirs: api.dirs }, "census parity");
assert.equal(
walk.paths.filter((p) => !p.endsWith("/")).length,
api.files,
"symlinks must land on the FILE side — git stores them as blobs",
);
// Named explicitly so the nested case cannot be satisfied by a root-level lookalike.
assert.ok(walk.paths.includes("src/nested-link"), JSON.stringify(walk.paths));
assert.ok(walk.paths.includes("src/deep/deep-link"), JSON.stringify(walk.paths));
});

// ─── the policy's edges ───────────────────────────────────────────────────────

syms("a symlink to a directory is not recursed into", async (t) => {
	const root = fixtureRepo(t, { dirs: ["src"], files: ["src/b.ts"], links: [["mirror", "src"]] });
	const walk = await walkRepo(root);
	assert.ok(
		!walk.paths.some((p) => p.startsWith("mirror/")),
		`the walk descended through a symlink: ${JSON.stringify(walk.paths)}`,
	);
	// git lists the link as a blob and lists src/b.ts once, under src.
	assert.deepEqual(walk.paths.filter((p) => p.includes("b.ts")), ["src/b.ts"]);
});

syms("a symlink cycle terminates instead of hanging", async (t) => {
	const root = fixtureRepo(t, { files: ["a.ts"], links: [["loop-a", "loop-b"], ["loop-b", "loop-a"]] });
	const walk = await Promise.race([
		walkRepo(root),
		new Promise((_, rej) => setTimeout(() => rej(new Error("walk did not terminate")), 5000)),
	]);
	assert.equal(walk.readFailed, false, "a cycle must not be reached via a failed read");
	// Both links are blobs in git; the walk may not invent children for them.
	assert.equal(walk.paths.filter((p) => p.startsWith("loop-")).length, 2);
});

syms("a dangling symlink is counted, because git stores it as a blob", async (t) => {
	const root = fixtureRepo(t, { files: ["a.ts"], dangling: ["broken-link"] });
	const walk = await walkRepo(root);
	assert.ok(walk.paths.includes("broken-link"), JSON.stringify(walk.paths));
});

syms("a symlink with an EXCLUDED NAME is dropped where the walk actually visits it", async (t) => {
	// Parity cuts both ways: if the walk keeps an excluded symlink the clone count
	// overshoots the API count, which is the same disagreement in the other direction.
	// The link sits at the ROOT with an excluded NAME, because the earlier version put
	// it inside `vendor/` — a directory the walk prunes before it ever looks at the link,
	// so the test passed on master and stayed green when the exclusion check for symlinks
	// was removed (adversarial review P2).
	const root = fixtureRepo(t, { files: ["a.ts", "keep.md"], links: [["logo.png", "a.ts"]] });
	assert.ok(isExcludedPath("logo.png"), "fixture assumption: this NAME is excluded");
	const walk = await walkRepo(root);
	assert.ok(!walk.paths.includes("logo.png"), JSON.stringify(walk.paths));
	assert.equal(walk.symlinks, 0, "an excluded symlink must not even be counted");
	assert.deepEqual(walk.paths.slice().sort(), apiCensus(root).paths.slice().sort());
});

syms("a symlink inside a pruned directory is dropped by BOTH sources", async (t) => {
	// Kept as the OTHER direction: the walk prunes `vendor/`, the API filter drops its
	// entries. Same result, arrived at differently, so it is asserted separately.
	const root = fixtureRepo(t, { dirs: ["vendor"], files: ["a.ts"], links: [["vendor/l", "a.ts"]] });
	const walk = await walkRepo(root);
	assert.ok(!walk.paths.some((p) => p.startsWith("vendor")), JSON.stringify(walk.paths));
	assert.deepEqual(walk.paths.slice().sort(), apiCensus(root).paths.slice().sort());
});

// The walk PRUNES an excluded directory (one `continue`, checked on the slash-terminated
// entry form); the API branch FILTERS each entry. For the EXCLUSION LIST those are the
// same set, and only because exclusion is a substring match, which is monotone under path
// extension. The entry form matters: `docs` is NOT excluded here while `docs/` is, because
// the patterns are slash-anchored -- asserting on the bare name would test a string the
// walk never checks.
//
// Scope, stated honestly after review: this guard covers the EXCLUSION LIST only. The walk
// prunes on a SECOND axis the list does not describe -- its `skipDirs` set and its blanket
// "starts with a dot" rule -- and on that axis the two sources genuinely diverge. That is
// #200, pinned by its own test at the bottom of this file; this guard does not cover it and
// must not be read as if it did.
// Named recurrence: if exclusion ever became exact-segment matching, `docs/` could stop
// matching while `docs/read.md` still did, and the two sources would diverge by whole
// subtrees with no other test failing.
const MONOTONE_DIRS = ["docs/", "vendor/", "node_modules/", "assets/", "src/", "dist/", "build/"];
test("exclusion is monotone under path extension, so prune equals filter", () => {
	for (const dirEntry of MONOTONE_DIRS) {
		if (!isExcludedPath(dirEntry)) continue; // not pruned by policy; nothing to prove
		const bare = dirEntry.slice(0, -1);
		for (const child of [`${bare}/x`, `${bare}/x/y.js`, `${bare}/.hidden`]) {
			assert.ok(
				isExcludedPath(child),
				`"${dirEntry}" is excluded but its child "${child}" is not: the walk prunes a `
					+ `subtree the per-entry API filter keeps entries from, so the sources diverge`,
			);
		}
	}
	// The shape an earlier probe found, pinned: slash-anchored patterns mean the bare
	// directory name and its entry form are different questions.
	assert.equal(isExcludedPath("docs"), false, "bare name is not the checked form");
	assert.ok(isExcludedPath("docs/"), "docs/ is excluded");
	assert.ok(isExcludedPath("docs/read.md"), "and so is everything under it");
});

syms("a symlink spends a cap slot, like the blob it matches", async (t) => {
	const root = fixtureRepo(t, { files: ["a.ts", "b.ts"], links: [["l", "a.ts"]] });
	const walk = await walkRepo(root, { maxEntries: 2 });
	// Three retainable entries, budget two: the third was refused, so the number is
	// a floor and must be labelled as one.
	assert.equal(walk.paths.length, 2);
	assert.equal(walk.hitCap, true, "a symlink refused at the cap did not lower the bound");
});

// ─── the label ────────────────────────────────────────────────────────────────

syms("the summary line names the symlink policy", async (t) => {
	const root = fixtureRepo(t, { files: ["a.ts"], links: [["l1", "a.ts"], ["l2", "a.ts"]] });
	const walk = await walkRepo(root);
	assert.equal(walk.symlinks, 2, "the walk must report how many entries are symlinks");
	const line = walkSummaryLine(walk);
	assert.match(line, /Files: 3/, line);
	// "2 symlinks counted as files" is the policy sentence; a bare Files: 3 leaves a
	// reader comparing 3 against an API count without knowing what the 3 included.
	assert.match(line, /2 symlink/, line);
});

syms("a repository with no symlinks does not claim any", async (t) => {
	const root = fixtureRepo(t, { files: ["a.ts"] });
	const walk = await walkRepo(root);
	assert.equal(walk.symlinks, 0);
	assert.doesNotMatch(walkSummaryLine(walk), /symlink/, "no symlinks, no sentence about them");
});

syms("a repository whose entire content is symlinks says so", async (t) => {
	// The shape where a bare `Files: 2` misleads most: there are no regular files at
	// all, and git still calls both entries blobs.
	const root = fixtureRepo(t, { links: [["a", "b"], ["b", "a"]] });
	const walk = await walkRepo(root);
	assert.equal(walk.files, 2);
	assert.equal(walk.symlinks, 2);
	const line = walkSummaryLine(walk);
	assert.match(line, /Files: 2 \(incl\. 2 symlinks; counted as files\)/, line);
});

syms("the symlink note reads correctly for one symlink", async () => {
	const line = walkSummaryLine({ paths: ["l"], files: 1, dirs: 0, symlinks: 1, hitCap: false, readFailed: false });
	// "1 symlink as files" was the first draft and is not English.
	assert.match(line, /incl\. 1 symlink; counted as files/, line);
	assert.doesNotMatch(line, /1 symlinks/, line);
});

// ─── named residual: #200 ─────────────────────────────────────────────────────
// The #197 sweep found a sibling divergence at a different seam and it is NOT fixed
// here, because it needs a policy decision rather than a patch. This test pins the
// divergence as it stands so that fixing #200 must deliberately invert an assertion
// that says "this is currently wrong", instead of a green suite quietly agreeing.
syms("RESIDUAL #200: a hidden directory is pruned by the walk but counted by the API", async (t) => {
	const root = fixtureRepo(t, { dirs: [".config"], files: [".config/c", "a.ts"] });
	const walk = await walkRepo(root);
	const api = apiCensus(root);
	// The walk's blanket dot-rule prunes .config/; dropExcludedPaths does not exclude it.
	assert.ok(!walk.paths.some((p) => p.startsWith(".config")), "walk prunes it");
	assert.ok(
		api.paths.some((p) => p.startsWith(".config/")),
		"API filter keeps it — the two sources disagree, and neither bound fires",
	);
	assert.equal(walk.hitCap, false);
	assert.equal(walk.readFailed, false);
	assert.notEqual(walk.paths.length, api.total, "#200: exact-labelled totals differ");
	// Flip this line to `assert.equal(...)` when #200 lands; that flip IS the decision.
});

syms("the composed counts line reads as one sentence", async (t) => {
	// The caller used to splice the "Total entries" sentence in with a hand-placed comma,
	// so the line a reader actually sees existed in no function and was tested by nothing
	// (adversarial review P3). It is now built in one place and asserted here.
	const root = fixtureRepo(t, { dirs: ["src"], files: ["a.ts", "src/b.ts"], links: [["l", "a.ts"]] });
	const walk = await walkRepo(root);
	const line = walkSummaryLine(walk, "\nTotal entries: 4 in the full tree (uncapped; 4 as URLs)");
	assert.equal(
		line,
		"\nFiles: 3 (incl. 1 symlink; counted as files), Dirs: 1, Total entries: 4 in the full tree (uncapped; 4 as URLs)",
	);
	// No doubled comma, and no dangling comma when there is no entries sentence.
	assert.doesNotMatch(line, /,,/);
	assert.doesNotMatch(walkSummaryLine(walk), /,$/);
});

// ─── the third source ─────────────────────────────────────────────────────────
// The repo map has THREE sources, and #197 as first filed covered two of them. The
// contents-listing fallback (used when the API tree fails entirely and the clone also
// failed) spells a symlink `type: "symlink"`, and `contentEntryPaths` dropped it along
// with submodules. Fixing only the clone walk left that source still undercounting —
// found by CodeRabbit on this PR, not by me, which is the value of the second pair of
// eyes. The two kinds were lumped together on the reasoning "a /blob/ link 404s", which
// is true of a gitlink and FALSE of a symlink, measured live on the entries the API
// itself reports:
//   200  https://github.com/git/git/blob/master/RelNotes              (file symlink)
//   200  https://github.com/git/git/blob/master/subprojects/git-gui   (DIRECTORY symlink)
test("the contents-listing source counts symlinks too (three-way parity)", () => {
	const entries = [
		{ path: "keep.ts", type: "file" },
		{ path: "src", type: "dir" },
		{ path: "link", type: "symlink" },
		{ path: "vendor/lib", type: "submodule" },
	];
	const paths = contentEntryPaths(entries);
	// A symlink is a blob with a reachable /blob/ URL, so it is admitted as a file.
	assert.ok(paths.includes("link"), JSON.stringify(paths));
	// A gitlink is NOT: it is not cloned into the web tree and both derivable URLs 404.
	assert.ok(!paths.includes("vendor/lib"), JSON.stringify(paths));
	assert.deepEqual(paths, ["keep.ts", "src/", "link"]);
});

test("the trees-API source is unchanged by admitting contents symlinks", () => {
	// The two callers share one admission rule but keep their own vocabulary. Widening
	// the CONTENTS spelling must not silently widen the trees one.
	assert.deepEqual(
		recursiveTreePaths([
			{ path: "a.ts", type: "blob" },
			{ path: "src", type: "tree" },
			{ path: "link", type: "blob" },
			{ path: "lib", type: "commit" },
		]),
		["a.ts", "src/", "link"],
	);
});
