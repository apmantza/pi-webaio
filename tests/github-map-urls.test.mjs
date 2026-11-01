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
import test from "node:test";
import { mapFeatureItems } from "../src/github-map.ts";

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
