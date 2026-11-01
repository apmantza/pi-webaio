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
		fileUrlsIncluded: 100,
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
		fileUrlsIncluded: 100,
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
		fileUrlsIncluded: 100,
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
		fileUrlsIncluded: 10,
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
		fileUrlsIncluded: 0,
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
