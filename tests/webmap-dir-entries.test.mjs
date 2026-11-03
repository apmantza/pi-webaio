// ─── #184 review round 1: making directories first-class must not leak into
// every consumer that assumed `paths` held only files.
//
// Findings from the adversarial review of PR #191 at 0ee5c4b:
//  * file-oriented architecture regexes accepted directory names, so an excluded
//    asset directory fabricated a framework signal;
//  * the 20 000-entry local cap now spends slots on directories, so a repo that
//    was complete before silently lost half its files;
//  * the counts were asserted by re-implementing the counter's rule in the test,
//    so `countDirs` could return 0 with the whole suite green;
//  * the third source (the clone walk) still emitted files only, while #184 asks
//    that all three sources obey one convention;
//  * the exclusion comments and fixture named `symlink`/`submodule` as Git Trees
//    entry TYPES. They are not. Verified live: a real symlink is
//    {mode:"120000", type:"blob"} and its /blob/ URL returns 200, while a gitlink
//    is {type:"commit"} and its /blob/ URL returns 404.
import assert from "node:assert";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	detectArchitectureSignals,
	dropExcludedPaths,
	capRepoPaths,
	formatRepoMapCounts,
	renderRepoTreeMarkdown,
	mapWalkToCoverage,
	repoEntryCensus,
	recursiveTreePaths,
	contentEntryPaths,
	walkRepo,
	MAX_TREE_PATHS,
} from "../src/github-map.ts";

// P2: directory existence is evidence of a DIRECTORY, not of a framework. An
// asset directory whose files were excluded must not establish Jest, and an empty
// .github/workflows/ must not establish GitHub Actions.
test("#184 review: directories never fabricate a file-oriented architecture signal", () => {
	const dirsOnly = [".github/", ".github/workflows/", "jest.config.assets/", "Dockerfiles/"];
	const md = detectArchitectureSignals(dirsOnly);
	assert.ok(!/CI\/CD/.test(md), `directory invented a CI signal: ${md}`);
	assert.ok(!/Jest/.test(md), `directory invented a test-framework signal: ${md}`);
	assert.ok(!/Docker:/.test(md), `directory invented a Docker signal: ${md}`);
});

test("#184 review: the same detection still fires on the files themselves", () => {
	const md = detectArchitectureSignals([
		".github/",
		".github/workflows/ci.yml",
		"jest.config.js",
		"Dockerfile",
	]);
	assert.ok(/CI\/CD/.test(md), "the real workflow file no longer establishes CI/CD");
	assert.ok(/Jest/.test(md), "the real config no longer establishes Jest");
	assert.ok(/Docker:/.test(md), "the real Dockerfile no longer establishes Docker");
});

// Directory presence is still a legitimate signal for the one label that means
// "a test directory exists".
test("#184 review: a bare test directory still counts as a test directory", () => {
	const md = detectArchitectureSignals(["tests/", "src/index.ts"]);
	assert.ok(/[Tt]ests?/.test(md), `bare tests/ produced no test signal: ${md}`);
});

// P3: the counters were only ever asserted by copying their rule into the test.
// A named census is the thing the dispatcher actually calls.
test("#184 review: the census is the dispatcher's own counter, not a copy of its rule", () => {
	assert.deepEqual(repoEntryCensus(["src/", "src/tools/", "src/a.ts", "README.md"]), {
		files: 2,
		dirs: 2,
	});
	assert.deepEqual(repoEntryCensus([]), { files: 0, dirs: 0 });
	// A directory is never a file, and a file is never a directory.
	const one = repoEntryCensus(["docs/"]);
	assert.equal(one.files, 0);
	assert.equal(one.dirs, 1);
});

// P2: the local cap must bound what is RETAINED, not what is COUNTED. 11 000
// directories each holding one file was a complete map before this PR; it must
// not silently become a 10 000-file repository.
test("#184 review: the entry cap bounds retained entries without corrupting the census", () => {
	const many = [];
	for (let i = 0; i < MAX_TREE_PATHS + 1000; i++) {
		many.push(`d${i}/`);
		many.push(`d${i}/f.ts`);
	}
	const eligible = dropExcludedPaths(many);
	const census = repoEntryCensus(eligible);
	assert.equal(census.files, MAX_TREE_PATHS + 1000, "files were lost from the census");
	assert.equal(census.dirs, MAX_TREE_PATHS + 1000, "directories were lost from the census");

	const { kept, capped } = capRepoPaths(eligible);
	assert.equal(kept.length, MAX_TREE_PATHS, "the retained list is not bounded");
	assert.equal(capped, true, "a truncated retained list must report itself as capped");
});

test("#184 review: a list that fits the cap is not labelled capped", () => {
	const { kept, capped } = capRepoPaths(["src/", "src/a.ts"]);
	assert.equal(kept.length, 2);
	assert.equal(capped, false, "a complete list must not be reported as a lower bound");
});

// P2: the Git Trees endpoint's entry types are blob / tree / commit. Symlinks are
// blobs with mode 120000 and are reachable at /blob/ (verified 200 on
// torvalds/linux/blob/master/AGENTS.md); gitlinks are type commit and 404
// (verified on git/git/blob/master/sha1collisiondetection).
test("#184 review: real Git Trees shapes — symlink blob kept, gitlink excluded", () => {
	const paths = recursiveTreePaths([
		{ path: "RelNotes", mode: "120000", type: "blob" },
		{ path: "bin/run", mode: "100755", type: "blob" },
		{ path: "docs", mode: "040000", type: "tree" },
		{ path: "sha1collisiondetection", mode: "160000", type: "commit" },
	]);
	assert.ok(paths.includes("RelNotes"), "a reachable symlink was dropped");
	assert.ok(paths.includes("bin/run"));
	assert.ok(paths.includes("docs/"));
	assert.ok(!paths.includes("sha1collisiondetection"), "a gitlink leaked — its /blob/ URL 404s");
});

// P2: #184 asks that all three sources obey the one convention. The clone walk is
// the third.
test("#184 review: the clone walk emits directories in the same representation", async () => {
	const root = await mkdtemp(join(tmpdir(), "webmap-walk-"));
	try {
		await mkdir(join(root, "src/nested"), { recursive: true });
		await mkdir(join(root, "empty-dir"), { recursive: true });
		await writeFile(join(root, "README.md"), "x");
		await writeFile(join(root, "src/nested/a.ts"), "y");
		// `{}` rather than the `{ skipHidden: false, skipDirs: new Set() }` this used to
		// pass: `skipDirs` was never a member of the options type, so it was silently ignored,
		// and `skipHidden` has no behaviour to disable since #200 removed the blanket dot rule.
		// The fixture holds nothing hidden and nothing excluded, so the call is unchanged.
		const walk = await walkRepo(root, {});
		assert.ok(walk.paths.includes("src/"), `clone walk has no directory entry: ${walk.paths}`);
		assert.ok(walk.paths.includes("src/nested/"));
		assert.ok(walk.paths.includes("src/nested/a.ts"));
		assert.equal(walk.files, 2);
		// Directories are counted once each, and the census agrees with the counter.
		assert.deepEqual(repoEntryCensus(walk.paths), { files: walk.files, dirs: walk.dirs });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Verify round 2 on PR #191, finding 1: the two bounds are different claims and
// the summary conflated them. `localCapped` means OUR RETAINED LIST stopped at
// MAX_TREE_PATHS; it says nothing about whether the CENSUS is complete. Feeding a
// complete (not truncated) API response with 22 000 eligible entries produced:
//   Total entries: at least 20000 (the walk stopped at this limit — the repository
//   may hold more; ...)
// No walk ran, and the repository does not hold more: the dispatcher had the exact
// denominator in hand and printed a lower bound instead, concealing a number it
// knew. #173 pinned the opposite direction (never call a lower bound "uncapped");
// this is the symmetric error — calling an exact count a lower bound.
//
// Recurrence prevented: a summary that hides a known denominator behind a bound
// that applies to a different quantity.
test("#191 verify: a bounded retained list does not turn an exact census into a lower bound", () => {
	const out = formatRepoMapCounts({
				coverage: { total: 22000, scope: "recursive", retainedBounded: true },totalUrls: 100,
		entriesIncluded: 100,
		max: 100,
	});
	// The census is exact: say so.
	assert.doesNotMatch(out.entries, /at least/, `exact census reported as a lower bound: ${out.entries}`);
	assert.match(out.entries, /22000/);
	// And the retained bound is still disclosed, as itself.
	assert.match(out.entries, /20000/, `the retained bound is not disclosed: ${out.entries}`);
});

// The direction #173 pinned must survive the fix: an incomplete collection keeps
// its lower-bound wording even though nothing else is bounded.
test("#191 verify: an incomplete collection is still a lower bound", () => {
	const out = formatRepoMapCounts({
				coverage: { total: 20000, scope: "recursive", bound: "walk-cap" },totalUrls: 100,
		entriesIncluded: 100,
		max: 100,
	});
	assert.match(out.entries, /at least 20000/);
	assert.doesNotMatch(out.entries, /uncapped/);
});

// Third distinct wrong claim on this seam, and the reason the two booleans were
// replaced by one coverage value. The last-resort source is the TOP-LEVEL
// contents listing — not the recursive tree — yet with `truncated` false and no
// walk it fell into the exact branch and printed "in the full tree (uncapped)"
// for a repository whose subdirectories were never listed at all. A count that is
// exact ABOUT WHAT WAS COLLECTED and wrong ABOUT WHAT EXISTS is not an exact
// count; `exact` was not the question the caller should have been asked.
//
// Probe (recursive tree stubbed unavailable, root listing of 3 returned):
//   SOURCE : github-api
//   SUMMARY: Total entries: 3 in the full tree (uncapped; 3 included as URLs)
//
// Recurrence prevented: a partial collection described with the vocabulary of a
// complete one.
test("#184: a root-only collection is never called the full tree", () => {
	const out = formatRepoMapCounts({
				coverage: { total: 0, scope: "recursive" },totalUrls: 3,
		entriesIncluded: 3,
		max: 100,
		coverage: { total: 3, scope: "root" },
	});
	assert.doesNotMatch(out.entries, /full tree|uncapped/, `root listing claimed as a full tree: ${out.entries}`);
	assert.match(out.entries, /root/i, `the root-only scope is not disclosed: ${out.entries}`);
	assert.match(out.entries, /3/);
});

// `exact` is DERIVED from scope+bound, so a caller cannot assert both at once.
// The old signature let a caller pass `lowerBound: false` for a partial scope —
// which is precisely how this defect was produced.
test("#184: coverage derives exactness instead of accepting it as an argument", () => {
	const recursive = formatRepoMapCounts({
				coverage: { total: 0, scope: "recursive" },totalUrls: 5,
		entriesIncluded: 5,
		max: 100,
		coverage: { total: 5, scope: "recursive" },
	});
	const apiTruncated = formatRepoMapCounts({
				coverage: { total: 0, scope: "recursive" },totalUrls: 5,
		entriesIncluded: 5,
		max: 100,
		coverage: { total: 5, scope: "recursive", bound: "api-truncated" },
	});
	const walkCapped = formatRepoMapCounts({
				coverage: { total: 0, scope: "recursive" },totalUrls: 5,
		entriesIncluded: 5,
		max: 100,
		coverage: { total: 5, scope: "recursive", bound: "walk-cap" },
	});
	assert.match(recursive.entries, /full tree/);
	assert.doesNotMatch(recursive.entries, /at least/);
	// Both bounds are floors, and each names the reason that actually applied.
	assert.match(apiTruncated.entries, /at least 5/);
	assert.match(apiTruncated.entries, /truncat/i);
	assert.match(walkCapped.entries, /at least 5/);
	assert.match(walkCapped.entries, /walk/i);
	assert.doesNotMatch(walkCapped.entries, /truncat/i, "the walk bound must not borrow the API's reason");
});

// Coverage restoration, proven by mutation rather than by a pre-fix red run: the
// mechanical move from three booleans to one coverage value silently dropped the
// only witness of two properties. Setting `bound: "walk-cap"` unconditionally and
// deleting the heading's root-only label were BOTH green until these existed.
//
// The #173 round-2 property: a clone walk that finished below its own `maxEntries`
// enumerated the whole tree, so its count is exact even when the API tree that led
// us to the walk was truncated. Asserting the composition (walkCoverage -> the
// label) rather than walkCoverage's fields, so the test pins what a reader sees.
test("#173: a completed walk is exact; only the walk's own cap makes it a floor", () => {
	const completed = { paths: ["a.ts", "src/"], files: 1, dirs: 1, hitCap: false };
	const capped = { paths: ["a.ts", "src/"], files: 1, dirs: 1, hitCap: true };
	const exactOut = formatRepoMapCounts({
		totalUrls: 2,
		entriesIncluded: 2,
		max: 100,
		coverage: mapWalkToCoverage(completed).coverage,
	});
	assert.match(exactOut.entries, /full tree/, `completed walk not exact: ${exactOut.entries}`);
	assert.doesNotMatch(exactOut.entries, /at least/);
	const floorOut = formatRepoMapCounts({
		totalUrls: 2,
		entriesIncluded: 2,
		max: 100,
		coverage: mapWalkToCoverage(capped).coverage,
	});
	assert.match(floorOut.entries, /at least 2/);
});

// The heading and the summary must describe the same collection; a summary that
// says "root only" under a heading that says "File Tree (3 entries)" is the same
// contradiction #173 was about.
test("#184: the tree heading carries the root-only scope too", () => {
	const md = renderRepoTreeMarkdown(["a.md", "src/"], 100, { total: 2, scope: "root" });
	assert.match(md, /repository root only/, `heading hides the scope: ${md.split("\n")[0]}`);
	const recursive = renderRepoTreeMarkdown(["a.md", "src/"], 100, {
		total: 2,
		scope: "recursive",
	});
	assert.doesNotMatch(recursive, /root only/, "a recursive map claims root-only scope");
});

// The bounded verify round probed all six coverage cases and found this one: when
// the API truncates the tree AND the clone fallback then fails, nothing was
// collected, `total` is 0, and the formatter returned an empty string — so the
// result was `ok: true` with no count line at all. "I could not collect anything"
// and "this repository has no files" rendered identically. The header's
// "(tree truncated by API)" hints, but does not say the fallback also failed.
//
// Recurrence prevented: a failed collection reported as a successful empty one.
test("#184: a failed collection says so instead of rendering as an empty repo", () => {
	const failed = formatRepoMapCounts({
		totalUrls: 0,
		entriesIncluded: 0,
		max: 100,
		coverage: { total: 0, scope: "recursive", bound: "api-truncated" },
	});
	assert.ok(failed.entries.trim(), "a bound collection with zero entries printed no line at all");
	assert.match(failed.entries, /no entries were collected/i);
	// A genuinely empty repository is a different statement and must not borrow
	// the failure wording.
	const genuinelyEmpty = formatRepoMapCounts({
		totalUrls: 0,
		entriesIncluded: 0,
		max: 100,
		coverage: { total: 0, scope: "recursive" },
	});
	assert.doesNotMatch(genuinelyEmpty.entries, /no entries were collected/i);
});

// ─── CodeRabbit on 6c38a61: four findings, all reproduced ──────────
// 1. The heading handled api-truncated, root and the retention cap but NOT
//    walk-cap, so a capped walk printed "## File Tree (N entries)" with no
//    qualifier while the summary said "at least N" — the same contradiction
//    #173 was about, in a branch the refactor forgot to label.
test("#184: the tree heading carries the walk bound too", () => {
	const md = renderRepoTreeMarkdown(["a.ts"], 100, {
		total: 1,
		scope: "recursive",
		bound: "walk-cap",
	});
	assert.match(md, /walk/i, `walk bound absent from the heading: ${md.split("\n")[0]}`);
	assert.doesNotMatch(md, /truncated by API/, "the walk bound must not borrow the API's label");
});

// 2. The API branch ran dropExcludedPaths; the clone branches did not. walkRepo
//    skips a dozen directory NAMES but no asset files and no `docs/`, so the same
//    repository reported different totals, and got different URLs, depending on
//    which source answered. Pinned on the leaf both branches now share.
test("#184: clone output is exclusion-filtered like the API output", () => {
	// The leaf's job is the census and the coverage; the exclusion itself is applied
	// inside walkRepo so discarded entries cannot spend the entry budget. Parity with
	// the API branch is asserted on walkRepo's own output below.
	const walked = ["README.md", "src/main.ts"];
	const mapped = mapWalkToCoverage({ paths: walked, files: 2, dirs: 0, hitCap: false });
	assert.equal(mapped.coverage.total, 2);
	assert.deepEqual(mapped.paths, dropExcludedPaths(walked));
});

// 3. Architecture detection read the CAPPED list while the census counted the
//    uncapped one, so a Dockerfile past entry 20 000 was invisible to signals but
//    counted in the total — and directories now consume cap slots, so that
//    happens sooner than it used to.
test("#184: architecture signals read the uncapped eligible list", () => {
	const eligible = [];
	for (let i = 0; i < MAX_TREE_PATHS; i++) eligible.push(`src/f${i}.ts`);
	eligible.push("Dockerfile");
	const capped = capRepoPaths(eligible).kept;
	assert.equal(capped.length, MAX_TREE_PATHS, "fixture must cross the cap");
	assert.ok(!capped.includes("Dockerfile"), "fixture guard: Dockerfile must be past the cap");
	const fromCapped = detectArchitectureSignals(capped);
	const fromEligible = detectArchitectureSignals(eligible);
	assert.ok(
		!fromCapped.includes("Docker") && fromEligible.includes("Docker"),
		`signals must come from the list the census counted: capped="${fromCapped}" eligible="${fromEligible}"`,
	);
});

// CodeRabbit round 2 on fb17d1f, both reproduced.
//
// 1. `hitCap: paths.length >= maxEntries` is not "something was refused" — a
//    repository with EXACTLY maxEntries entries fills the budget and then trips the
//    same comparison, so an exact count was reported as "at least N". Directories
//    now consume slots, so an exact fill is more likely than before, not less.
test("#184: a walk that fills the budget exactly is not a lower bound", async () => {
	const root = await mkdtemp(join(tmpdir(), "walk-exact-"));
	try {
		await mkdir(join(root, "src"), { recursive: true });
		// 3 entries total: src/, src/a.ts, README.md — budget equals the content.
		await writeFile(join(root, "src", "a.ts"), "a");
		await writeFile(join(root, "README.md"), "r");
		const exact = await walkRepo(root, { maxEntries: 3 });
		assert.equal(exact.paths.length, 3, `fixture must fill the budget: ${exact.paths}`);
		assert.equal(exact.hitCap, false, "an exact fill reported itself as a floor");
		// And the same tree with a smaller budget MUST be a floor, or the test above
		// passes because hitCap is simply never set.
		const tight = await walkRepo(root, { maxEntries: 2 });
		assert.equal(tight.hitCap, true, "a real truncation must still be a floor");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// 2. Excluded entries used to consume maxEntries slots and only then be dropped by
//    mapWalkToCoverage, so a directory of assets sorting ahead of the sources could
//    end the walk before any real file was reached.
test("#184: excluded entries do not consume the walk's entry budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "walk-noise-"));
	try {
		await mkdir(join(root, "assets"), { recursive: true });
		await mkdir(join(root, "docs"), { recursive: true });
		await mkdir(join(root, "src"), { recursive: true });
		for (let i = 0; i < 6; i++) await writeFile(join(root, "assets", `i${i}.png`), "x");
		// `docs/` is in REPO_PATH_EXCLUSIONS but NOT in walkRepo's skipDirs set, so
		// it is the case that only the exclusion check catches — and the one the
		// directory branch of that check exists for.
		for (let i = 0; i < 6; i++) await writeFile(join(root, "docs", `g${i}.md`), "d");
		await writeFile(join(root, "src", "main.ts"), "m");
		await writeFile(join(root, "README.md"), "r");
		const w = await walkRepo(root, { maxEntries: 3 });
		assert.ok(
			w.paths.includes("src/main.ts"),
			`noise spent the budget and starved the sources: ${w.paths}`,
		);
		assert.ok(!w.paths.some((p) => p.endsWith(".png")), `excluded files were retained: ${w.paths}`);
		assert.ok(
			!w.paths.some((p) => p.startsWith("docs")),
			`an excluded DIRECTORY was retained or walked: ${w.paths}`,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// PR #195 review, finding 1: the PR claimed `admitEntries` was the single writer of
// the directory marker while `walkRepo` appended it inline. The reviewer proved it by
// neutering the canonical writer and watching the two producers diverge. This test is
// the version of that probe that stays in the suite: the same logical tree through the
// API admission path and the filesystem walk path must yield the SAME path set, so a
// second writer cannot come back.
test("#193: the API and clone producers emit one convention, not two", async () => {
	const root = await mkdtemp(join(tmpdir(), "walk-parity-"));
	try {
		await mkdir(join(root, "d", "a"), { recursive: true });
		await writeFile(join(root, "d", "a", "f.ts"), "f");
		await writeFile(join(root, "README.md"), "r");
		const walked = await walkRepo(root, { maxEntries: 100 });
		// The same tree as the contents API would spell it.
		const listed = contentEntryPaths([
			{ path: "d", type: "dir" },
			{ path: "d/a", type: "dir" },
			{ path: "d/a/f.ts", type: "file" },
			{ path: "README.md", type: "file" },
		]);
		assert.deepEqual(
			[...walked.paths].sort(),
			[...listed].sort(),
			"the two producers disagree on the directory convention",
		);
		// And the marker must actually be present, or the assertion above passes by
		// both producers dropping it.
		assert.ok(
			walked.paths.some((p) => p.endsWith("/")),
			"no producer emitted a directory marker at all",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Verify round on master (the round that #191 merged without). Three P2s, one of
// them a regression introduced by the very commit that fixed the mislabeling.

test("#184: a directory holding only excluded files does not make the walk a bound", async () => {
	// 652e5bd reasoned "a git checkout has no empty directory, so an unvisited
	// directory must hold something dropped". True about TRACKED entries, false about
	// RETAINABLE ones: `assets/logo.png` is tracked and excluded, so the directory is
	// non-empty and contributes nothing, and an exact census of one was reported as
	// "at least 1".
	const root = await mkdtemp(join(tmpdir(), "walk-excl-children-"));
	try {
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(join(root, "assets", "logo.png"), "x");
		const full = await walkRepo(root, { maxEntries: 100 });
		const capped = await walkRepo(root, { maxEntries: 1 });
		assert.deepEqual(
			capped.paths,
			full.paths,
			"the capped walk retained everything, so nothing was refused",
		);
		assert.equal(
			capped.hitCap,
			false,
			`an exact census was labelled a lower bound: ${JSON.stringify(capped)}`,
		);
		assert.equal(mapWalkToCoverage(capped).coverage.bound, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("#184: an unreadable directory makes the count a bound, never an exact tree", async (t) => {
	// The `readdir` catch used to `return` silently, so `hitCap` stayed false and a
	// partial enumeration was presented as "N in the full tree (uncapped)".
	//
	// The first version of this test guarded its assertions with `if (w.readFailed)`
	// and therefore passed whether or not the flag was ever set — both surviving
	// mutants proved it. The environment is now PROBED first, and the assertions run
	// unconditionally or the test is skipped by name.
	const root = await mkdtemp(join(tmpdir(), "walk-readfail-"));
	try {
		const locked = join(root, "locked");
		await mkdir(locked, { recursive: true });
		await writeFile(join(locked, "secret.ts"), "s");
		await writeFile(join(root, "README.md"), "r");
		await chmod(locked, 0o000);
		let enforced = false;
		try {
			await readdir(locked, { withFileTypes: true });
		} catch {
			enforced = true;
		}
		if (!enforced) {
			t.skip("readdir was not denied — cannot model a failed read here (root?)");
			return;
		}
		let w;
		try {
			w = await walkRepo(root, { maxEntries: 100 });
		} finally {
			await chmod(locked, 0o755);
		}
		assert.equal(w.readFailed, true, "a denied readdir must be recorded, not swallowed");
		assert.equal(w.hitCap, false, "a read failure is not a cap");
		assert.equal(
			mapWalkToCoverage(w).coverage.bound,
			"read-error",
			"a failed read must be named as the reason the count is a floor",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("#184: read-error outranks walk-cap when both apply", () => {
	// Naming the wrong reason sends a reader to raise `maxFiles`, which cannot fix an
	// unreadable subtree.
	const both = mapWalkToCoverage({ paths: ["a.ts"], files: 1, dirs: 0, hitCap: true, readFailed: true });
	assert.equal(both.coverage.bound, "read-error");
	const capOnly = mapWalkToCoverage({ paths: ["a.ts"], files: 1, dirs: 0, hitCap: true, readFailed: false });
	assert.equal(capOnly.coverage.bound, "walk-cap");
	const clean = mapWalkToCoverage({ paths: ["a.ts"], files: 1, dirs: 0, hitCap: false, readFailed: false });
	assert.equal(clean.coverage.bound, undefined);
});
