// ─── Issue #168: webmap printed two counts with different denominators ────
//
// `aio-webmap` on a GitHub repo printed, in one summary:
//
//   Discovered 108 URLs
//   Total entries: 269
//
// "Discovered" counted the URL list, whose file URLs are `paths.slice(0, max)` —
// capped by `max`. "Total entries" counted the full tree, uncapped. Neither line
// said which denominator it used, so "Discovered" read as a total and an agent
// consuming the map could conclude it had seen the whole repository when the URL
// list had stopped at `max`.
//
// Half of the original reviewer note was already fixed by #166: the truncated
// file tree now carries "_showing first 100 of 269 entries_" in
// `renderRepoTreeMarkdown`. This is the other half — the two summary counts.
//
// Recurrence prevented: an agent believing it enumerated a whole repo because a
// capped count looked like a total.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRepoMapCounts } from "../src/github-map.ts";

test("#168: a max-capped URL count says it is capped and names the cap", () => {
	const { discovered } = formatRepoMapCounts({
		totalUrls: 108,
		treeEntries: 269,
		max: 100,
		entriesIncluded: 100,
	});
	assert.match(discovered, /Discovered 108 URLs/);
	assert.match(
		discovered,
		/capped at `max`=100/,
		"a capped count must say it is capped and by what",
	);
});

test("#168: the tree count names the full tree as its denominator", () => {
	const { entries } = formatRepoMapCounts({
		totalUrls: 108,
		treeEntries: 269,
		max: 100,
		entriesIncluded: 100,
	});
	assert.match(entries, /Total entries: 269/);
	assert.match(
		entries,
		/full tree/,
		"the uncapped count must be labelled with its denominator",
	);
});

test("#168: the two lines cannot be mistaken for the same number", () => {
	const out = formatRepoMapCounts({
		totalUrls: 108,
		treeEntries: 269,
		max: 100,
		entriesIncluded: 100,
	});
	// The reported defect is 108 and 269 sitting side by side unlabelled.
	assert.doesNotMatch(out.discovered, /^Discovered 108 URLs$/);
	assert.match(out.discovered, /capped|of /);
	assert.match(out.entries, /full tree|uncapped/);
});

test("#168: nothing is claimed as capped when the cap never bound", () => {
	const out = formatRepoMapCounts({
		totalUrls: 12,
		treeEntries: 10,
		max: 100,
		entriesIncluded: 10,
	});
	assert.doesNotMatch(
		out.discovered,
		/capped/,
		"saying 'capped' when max never bound is its own misleading label",
	);
	assert.match(out.discovered, /Discovered 12 URLs/);
});

test("#168: a repo with no tree still reports the URL count", () => {
	const out = formatRepoMapCounts({
		totalUrls: 5,
		treeEntries: 0,
		max: 100,
		entriesIncluded: 0,
	});
	assert.match(out.discovered, /Discovered 5 URLs/);
	assert.equal(out.entries, "", "no tree means no entries line");
});

// ─── Detector: the summary must actually USE the labelled seam ───────────
//
// The unit tests above exercise `formatRepoMapCounts` in isolation. Reverting
// the two call sites in `mapGitHubRepoFull` to the old unlabelled template
// literals left every one of them GREEN — the pure function was tested, the
// wiring was not. `mapGitHubRepoFull` needs live GitHub I/O, so it cannot be
// driven offline; this detector is what pins that the summary is built through
// the seam instead of re-spelling the old strings.
//
// Per the project rule, a source scan runs over comment-and-string-blanked text.
// These needles ARE string literals (the per-needle exception), so blanking is
// disabled for them and the match is on the exact template shape the defect used.
//
// Recurrence prevented: a refactor restoring `Discovered N URLs` / `Total
// entries: M` beside each other, unlabelled, while the tested helper sits unused.

test("#168: the repo-map summary builds its counts through formatRepoMapCounts", async () => {
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(
		new URL("../src/github-map.ts", import.meta.url),
		"utf8",
	);
	// Strip the helper's own definition; inside it, the literals are correct.
	const body = src.replace(
		/export function formatRepoMapCounts[\s\S]*?\n}\n/,
		"",
	);
	for (const needle of [
		/\$\{totalUrls\}\s+URLs/,
		/Total entries: \$\{/,
		/Discovered \$\{/,
	]) {
		assert.ok(
			!needle.test(body),
			`the summary re-spells an unlabelled count (${needle}); route it through formatRepoMapCounts`,
		);
	}
	assert.match(
		body,
		/formatRepoMapCounts\(/,
		"the summary must call the labelled seam",
	);
});

// ─── Review round 1 on #173: "uncapped" was printed for a capped walk ──
//
// The GitHub recursive-tree API answers `truncated: true` for large repos and the
// code falls back to `walkRepo(clone.path, { maxEntries: maxFiles })`, which stops
// at `maxEntries` (default 2000). That already-bounded length was then handed to
// the formatter as `treeEntries`, producing:
//
//   🗺️  Repo map for o/r (cloned) (tree truncated by API)
//   Total entries: 2000 in the full tree (uncapped; 100 included as URLs)
//
// "truncated by API" and "full tree (uncapped)" in the same header is not a
// denominator, it is a contradiction — and an agent reading "uncapped" will treat
// 2000 as the repository's size. The unit test that should have caught this passed
// a hand-shaped `{ treeEntries: 269 }` and never touched the fallback path.
//
// Recurrence prevented: a count that is a lower bound being reported as exact.

test("#173: a bounded walk is labelled as a lower bound, never as uncapped", () => {
	const out = formatRepoMapCounts({
		totalUrls: 300,
		treeEntries: 2000,
		max: 100,
		entriesIncluded: 100,
		treeEntriesAreLowerBound: true,
	});
	assert.doesNotMatch(
		out.entries,
		/uncapped/i,
		`a walk that stopped at the entry limit cannot be called uncapped:\n${out.entries}`,
	);
	assert.match(out.entries, /at least/i, "must say the count is a floor");
	assert.match(out.entries, /2000/);
});

test("#173: an exact full tree keeps the uncapped wording", () => {
	const out = formatRepoMapCounts({
		totalUrls: 269,
		treeEntries: 269,
		max: 100,
		entriesIncluded: 100,
		treeEntriesAreLowerBound: false,
	});
	assert.match(out.entries, /uncapped/i, "a genuinely complete walk should still say so");
	assert.doesNotMatch(out.entries, /at least/i);
});

test("#173: walkRepo reports when it stopped at maxEntries", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { walkRepo } = await import("../src/github-map.ts");
	const root = mkdtempSync(join(tmpdir(), "walkrepo-"));
	try {
		for (let i = 0; i < 12; i++) {
			mkdirSync(join(root, `d${i}`), { recursive: true });
			writeFileSync(join(root, `d${i}`, "f.txt"), "x");
		}
		const bounded = await walkRepo(root, { maxEntries: 5 });
		assert.equal(bounded.hitCap, true, "stopped at 5 of 12 — that is a lower bound");
		const full = await walkRepo(root, { maxEntries: 1000 });
		assert.equal(full.hitCap, false, "walked everything; the count is exact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// #184 followed through to the label. Now that directories are first-class in
// `paths`, the URL list `paths.slice(0, max)` contains /tree/ links as well as
// /blob/ links, so a count of that slice is not a count of FILE urls. The field
// and the sentence it feeds both claimed "file URLs", which is exactly the
// denominator-mismatch class #168 was about.
test("#184: the included-URL count no longer claims to be files only", () => {
	const out = formatRepoMapCounts({
		totalUrls: 120,
		treeEntries: 301,
		max: 100,
		entriesIncluded: 100,
	});
	assert.ok(!/file URLs/i.test(out.discovered), `label still claims files only: ${out.discovered}`);
	assert.ok(!/file URLs/i.test(out.entries), `label still claims files only: ${out.entries}`);
	assert.ok(/100/.test(out.entries), "the included count disappeared from the label");
});
