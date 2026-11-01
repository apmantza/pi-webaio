// ─── Issue #167: one canonical `stripWww`, six private spellings folded ───
//
// `stripWww` was exported from `src/search.ts` and documented as a MATCHING rule
// (not a display rule). The correctness fix routed cross-engine dedup,
// `dropGoogleRedirectDuplicates` and `research.isPrimarySource` through it, but
// six call sites kept re-spelling the one-liner — including `stripWwwLocal`, a
// named local duplicate of the exported seam in `goggles.ts`, which is the
// clearest drift hazard in the set because it looks intentional.
//
// The seam now lives in `src/domain.ts` (a leaf), not `src/search.ts`: search.ts
// imports goggles.ts, so having goggles import search.ts back would cycle.
//
// Consolidation verdict: FOLD. Deleting the helper and inlining the one-liner at
// six sites would concentrate nothing — it would relocate the same line and
// re-create the drift hazard the export exists to prevent. The deciding test is
// deletion, and it says fold.
//
// Recurrence prevented: a future change to the canonical rule (collapsing `m.`,
// IDN handling, case folding) silently not reaching six call sites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { stripWww } from "../src/domain.ts";
import { stripWww as stripWwwViaSearch } from "../src/search.ts";

// ─── Behaviour of the canonical rule ──────────────────────────────────

test("#167: strips a leading www.", () => {
	assert.equal(stripWww("www.example.com"), "example.com");
	assert.equal(stripWww("example.com"), "example.com");
});

test("#167: does not strip an embedded www (only a leading label)", () => {
	assert.equal(stripWww("notwww.example.com"), "notwww.example.com");
	assert.equal(stripWww("a.www.example.com"), "a.www.example.com");
});

test("#167: case-folds, so a host harvested from a URL cannot miss the rule", () => {
	assert.equal(stripWww("WWW.Example.COM"), "example.com");
	assert.equal(stripWww("WWW.Example.COM"), stripWww("www.example.com"));
});

test("#167: search.ts re-exports the same function object (no second copy)", () => {
	assert.equal(
		stripWwwViaSearch,
		stripWww,
		"search.ts must re-export the leaf, not keep its own implementation",
	);
});

// ─── Detector: nobody re-spells the rule ──────────────────────────────

const SRC_DIR = new URL("../src", import.meta.url).pathname;

function collectTsFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectTsFiles(full, out);
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * Blank comments and string literals so a comment that QUOTES the needle can
 * never satisfy or defeat the scan. The needle here is a regex literal in code,
 * so blanking strings is safe and required: the doc comment on `stripWww`
 * mentions the rule in prose.
 */
async function blankCommentsAndStrings(path) {
	const src = await readFile(path, "utf8");
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

test("#167: no module re-spells the www-stripping regex", async () => {
	const files = collectTsFiles(SRC_DIR);
	assert.ok(files.length > 10, "sanity: expected a real src tree");

	const offenders = [];
	for (const file of files) {
		if (file.endsWith("src/domain.ts")) continue; // the seam itself
		const blanked = await blankCommentsAndStrings(file);
		if (/replace\(\s*\/\^www\\?\./.test(blanked)) {
			offenders.push(file.replace(SRC_DIR + "/", ""));
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"these modules re-spell the canonical rule instead of importing stripWww",
	);
});

test("#167: the detector can actually fail (self-check on the blanking)", async () => {
	// If the blanker destroyed everything, the detector above would pass
	// vacuously. Prove the blanked text still contains code.
	const blanked = await blankCommentsAndStrings(join(SRC_DIR, "search.ts"));
	assert.ok(
		/export function|function |=>/.test(blanked),
		"the blanker removed too much — the detector would pass vacuously",
	);
});
