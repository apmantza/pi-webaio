import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { blankCommentsAndStrings } from "./helpers.mjs";

// #97: the full-tool search benchmark must not re-declare the timing budget it
// is meant to measure.
//
// Recurrence this guards: `scripts/bench-full-search.mjs` reimplemented the
// tool's orchestration ("mirrors registerWebsearchTool.execute") and copied its
// deadline constants. When production moved the hard cap from 7000ms to 3500ms
// the copy stayed at 7000, and the Google lane cap drifted 3000 -> 2900. The
// harness went on printing "FULL aio-websearch benchmark" tables for a tool that
// no longer existed: a benchmark allowed to run twice as long as the thing it
// measures cannot show progress toward a 2-3s target, and nothing failed.
//
// Fail-closed on shape, not on a list of known-bad numbers: a benchmark script
// may obtain the budget by IMPORTING it, and may not bind a name that looks like
// a search timing budget to a numeric literal. Any new spelling (7000, 3_500,
// 3.5 * 1000, a constant forwarded from a config object) is a hit, not a pass.

const BENCH_SCRIPTS = ["scripts/bench-full-search.mjs"];

// Names that denote the tool's own response budget. Anything matching this and
// bound to a literal is a copy that can drift.
const TIMING_NAME =
	/^(SEARCH_DEADLINE_MS|SEARCH_RESPONSE_TARGET_MS|GOOGLE_LANE_MAX_MS|HTTP_ENGINE_RESPONSE_DEADLINE_MS|RESPONSE_TARGET_MS|HARD_DEADLINE_MS)$/;

test("#97: search benchmark imports the budget instead of copying it", async () => {
	for (const rel of BENCH_SCRIPTS) {
		const code = await blankCommentsAndStrings(new URL(`../${rel}`, import.meta.url));

		const offenders = [];
		for (const line of code.split("\n")) {
			const decl = line.match(
				/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*;?\s*$/,
			);
			if (!decl) continue;
			const [, name, value] = decl;
			if (!TIMING_NAME.test(name)) continue;
			// Importing is the only legal way to obtain the value.
			if (/^import\b/.test(value)) continue;
			offenders.push(`${rel}: ${name} = ${value}`);
		}
		assert.deepEqual(
			offenders,
			[],
			"benchmark scripts must import the tool's timing budget; a local copy silently keeps measuring the old budget when production changes it",
		);
	}
});

test("#97: the benchmark names the module it takes the budget from", async () => {
	for (const rel of BENCH_SCRIPTS) {
		// Per-needle policy: this needle's evidence IS a string literal (the
		// module specifier), so it runs on raw source. The dangerous direction is
		// prose making a guard pass, and an import path cannot be satisfied by a
		// comment — the neighbouring test blanks comments and strings for exactly
		// that reason; blanking here would only erase the thing being checked.
		const src = await readFile(new URL(`../${rel}`, import.meta.url), "utf8");
		assert.match(
			src,
			/import\s*\{[^}]*SEARCH_DEADLINE_MS[^}]*\}\s*from\s*["'][^"']*tools\/websearch/,
			`${rel} must import SEARCH_DEADLINE_MS from the tool module, so the harness and the tool cannot drift apart`,
		);
	}
});

test("#97: the tool exports the budget the benchmark consumes", async () => {
	const src = await readFile(
		new URL("../src/tools/websearch.ts", import.meta.url),
		"utf8",
	);
	for (const name of [
		"SEARCH_DEADLINE_MS",
		"SEARCH_RESPONSE_TARGET_MS",
		"GOOGLE_LANE_MAX_MS",
		"HTTP_ENGINE_RESPONSE_DEADLINE_MS",
	]) {
		assert.match(
			src,
			new RegExp(`export\\s+const\\s+${name}\\b`),
			`${name} must be exported so the benchmark measures the real budget rather than a copy`,
		);
	}
});

test("#97: the hard deadline is the documented 3.5s, not the retired 7s", async () => {
	const mod = await import("../src/tools/websearch.ts");
	assert.equal(
		mod.SEARCH_DEADLINE_MS,
		3500,
		"the public hard cap is 3500ms; a benchmark still reporting 7000 is measuring a retired contract",
	);
	assert.ok(
		mod.SEARCH_RESPONSE_TARGET_MS < mod.SEARCH_DEADLINE_MS,
		"the response target must sit inside the hard cap",
	);
	assert.ok(
		mod.GOOGLE_LANE_MAX_MS <= mod.SEARCH_DEADLINE_MS,
		"the Google lane cap must fit inside the hard cap",
	);
});
