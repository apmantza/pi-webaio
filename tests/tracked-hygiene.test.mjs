// ─── Tracked-artifact gate is fail-closed (#165, F5) ────────────────
//
// The old CI step matched `inspirat|observability-gaps|perf-improvements` — an
// enumeration of known-bad spellings. This repo shipped a committed
// `aio-webresearch` bundle (`research-paramtest/`, 14 files) and four scratch
// docs that none of those words matched, and the gate reported clean.
//
// The gate now admits a short allow-list and refuses everything else, so the
// next unknown scratch file fails without anyone remembering to add its name to
// a blocklist. These tests are the detector for the detector.
import assert from "node:assert";
import test from "node:test";
import {
	findViolations,
	listTrackedFiles,
	ALLOWED_ROOT_FILES,
	ALLOWED_TOP_DIRS,
} from "../scripts/check-tracked-hygiene.mjs";

const ok = (paths) => {
	const v = findViolations(paths);
	return (
		v.unknownRootFiles.length === 0 &&
		v.unknownRootDirs.length === 0 &&
		v.internalNotes.length === 0
	);
};

test("F5: an unknown root scratch file is a violation", () => {
	for (const name of [
		"speed.md",
		"newfeatures.md",
		"implementationplan.md",
		"roadmap_0_5.md",
		"test-youtube.mjs",
		"inspiration.md",
		"whatever-the-next-spelling-is.md",
	]) {
		const v = findViolations([name]);
		assert.deepEqual(
			v.unknownRootFiles,
			[name],
			`${name} must be refused without being named in a blocklist`,
		);
	}
});

test("F5: an unknown top-level directory is a violation", () => {
	// The exact shape that shipped: a research bundle at the repo root.
	const v = findViolations([
		"research-paramtest/STATUS.md",
		"research-paramtest/reports/CLAIMS.md",
		"research-paramtest/data/evidence.json",
	]);
	assert.deepEqual(v.unknownRootDirs, ["research-paramtest"]);
	assert.equal(
		v.unknownRootFiles.length,
		0,
		"nested paths are judged by their top-level directory",
	);
});

test("F5: case is significant — a capitalised spelling cannot slip past", () => {
	assert.deepEqual(findViolations(["SPEED.MD"]).unknownRootFiles, ["SPEED.MD"]);
	assert.deepEqual(findViolations(["README.MD"]).unknownRootFiles, ["README.MD"]);
	assert.deepEqual(findViolations(["Src/index.ts"]).unknownRootDirs, ["Src"]);
});

test("F5: the shipped allow-list passes", () => {
	const shipped = [
		...[...ALLOWED_ROOT_FILES],
		...[...ALLOWED_TOP_DIRS].map((d) => `${d}/anything/deep.ts`),
	];
	assert.ok(ok(shipped), JSON.stringify(findViolations(shipped)));
});

test("F5: real tracked paths inside allowed dirs are fine at any depth", () => {
	assert.ok(
		ok([
			"src/tools/webfetch.ts",
			"tests/unit.test.mjs",
			".github/workflows/ci.yml",
			"docs/features.md",
			"tla/queue.mjs",
		]),
	);
});

test("F5: the known internal-note class is still caught at any depth and extension", () => {
	// The allow-list only judges top-level structure, so this second axis must
	// survive: dropping it would silently lose coverage the old gate had.
	for (const name of [
		"docs/inspiration7.md",
		"src/notes/inspiration.txt",
		"INSPIRATION.MD",
		"docs/observability-gaps.md",
		"docs/perf-improvements.md",
	]) {
		assert.deepEqual(
			findViolations([name]).internalNotes,
			[name],
			`${name} must be flagged as an internal note`,
		);
	}
});

test("F5: a nested note inside an allowed directory still fails the gate", () => {
	// `docs/` is allow-listed, so only the note axis can catch this.
	assert.equal(ok(["docs/inspiration.md"]), false);
	assert.deepEqual(findViolations(["docs/inspiration.md"]).unknownRootDirs, []);
});

test("F5: empty and whitespace entries are not invented violations", () => {
	assert.ok(ok(["", "   ", "\t"]));
});

test("F5: the repository itself satisfies the gate", (t) => {
	// Integration: the real index must pass, otherwise CI is red for everyone.
	// A sandbox that denies the `git` child process (EPERM) is not evidence the
	// gate is wrong, so the test names its skip instead of failing — the GATE
	// itself still fails closed on the same error, which is what CI needs.
	let files;
	try {
		files = listTrackedFiles(new URL("../", import.meta.url).pathname);
	} catch (err) {
		const signal = `${err?.code ?? ""} ${err?.message ?? ""}`;
		if (/EPERM|ENOENT|EACCES/.test(signal)) {
			t.skip(`git unavailable in this sandbox (${err?.code ?? err?.message})`);
			return;
		}
		throw err;
	}
	assert.ok(files.length > 100, `expected a real index, got ${files.length}`);
	const v = findViolations(files);
	assert.deepEqual(
		v,
		{ unknownRootFiles: [], unknownRootDirs: [], internalNotes: [] },
		`the tracked tree must respect its own allow-list: ${JSON.stringify(v)}`,
	);
});
