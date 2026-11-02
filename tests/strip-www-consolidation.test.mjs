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
import { fileURLToPath } from "node:url";
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

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

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
 *
 * Blank LINE comments first, then block comments. The opposite order silently
 * eats code: `src/research.ts:5` is a line comment containing `reports/` plus a
 * stray star, and a block-comment regex run first takes that as an opening
 * delimiter and sweeps everything up to the next closing delimiter — so real
 * source disappears and the guard passes because there is nothing left to match.
 * A detector that blanks too much looks identical to one that found nothing.
 */
function stripComments(src) {
	return src.replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

async function blankCommentsOnly(path) {
	return stripComments(await readFile(path, "utf8"));
}

async function blankCommentsAndStrings(path) {
	const src = await readFile(path, "utf8");
	return stripComments(src)
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
			offenders.push(file.replace(`${SRC_DIR}/`, ""));
			continue;
		}
		// Second needle, DIFFERENT blanking policy. The missed spelling was
		// `domain.startsWith("www.") ? domain.slice(4) : domain` (source-trust.ts,
		// found in review) — and the string-blanking above rewrites that into
		// `startsWith("")`, so the regex could never match it. A needle whose
		// evidence is a string literal must run over string-PRESERVED text.
		// Trade-off stated: a comment quoting `startsWith("www.")` now trips the
		// guard. That is the acceptable direction — a false positive reds loudly
		// and is fixed in seconds, whereas prose silently re-admitting a duplicate
		// is the failure that costs a round.
		const commentsOnly = await blankCommentsOnly(file);
		// `slice(4)` on its own is far too broad — any unrelated `array.slice(4)`
		// would red this guard. Require it to co-occur with the `www.` literal on
		// the same line, which is the actual shape of the missed spelling.
		const startsWithWww = /startsWith\(\s*["'`]www\./.test(commentsOnly);
		const sliceFourWithWww =
			/\.slice\(\s*4\s*\)/.test(commentsOnly) && /www\./.test(commentsOnly);
		if (startsWithWww || sliceFourWithWww) {
			offenders.push(file.replace(`${SRC_DIR}/`, ""));
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

// Self-check on the blanker itself. `src/research.ts:5` is a line comment that
// contains a `reports/` path followed by a star; with block comments blanked
// FIRST the regex treats that as an opening delimiter and sweeps real code away,
// so the scan reports "clean" because it is looking at an emptied file. A guard
// that passes by destroying its input is the worst kind of green.
test("#167: the blanker preserves code in the file that trips it", async () => {
	const file = join(SRC_DIR, "research.ts");
	const blanked = await blankCommentsOnly(file);
	const original = await readFile(file, "utf8");
	// Every non-comment line of the original must survive blanking.
	const codeLines = original
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
	const blankedSet = new Set(blanked.split("\n").map((l) => l.trim()));
	// Compare the CODE part of each line: a trailing `// note` is legitimately
	// blanked, so exact line equality would report a false loss on every line
	// that carries an end-of-line comment.
	const codePart = (l) => l.replace(/(^|[^:])\/\/[^\n]*/g, "$1").trim();
	const lost = codeLines.filter((l) => {
		const want = codePart(l);
		return want !== "" && !blankedSet.has(want);
	});
	assert.deepEqual(
		lost.slice(0, 3),
		[],
		`blanking deleted ${lost.length} real code line(s) from research.ts, e.g.: ${lost[0]}`,
	);
});
