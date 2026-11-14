import test from "node:test";
import assert from "node:assert/strict";
import { countSectionBuckets, userCountLine } from "../scripts/lib/changelog.mjs";

test("counts column-0 bullets per ### bucket", () => {
	const body = "### Added\n- one\n- two\n### Fixed\n- three\n";
	assert.equal(userCountLine(body), "2 features, 1 fix.");
});

test("counts unbucketed column-0 bullets as other changes", () => {
	const body = "- unbucketed fix\n### Added\n- feat\n";
	assert.equal(userCountLine(body), "1 feature, 1 other change.");
});

test("ignores nested/indented bullets and #### detail bullets inside bucket", () => {
	const body = "### Added\n- top\n  - nested\n#### Details\n- detail\n";
	assert.equal(userCountLine(body), "1 feature.");
});

test("ignores #### deeper-heading bullets before first ###", () => {
	const body = "#### Details\n- implementation detail\n### Added\n- feature\n";
	assert.equal(userCountLine(body), "1 feature.");
});

test("transitions from #### subheading back to ### bucket", () => {
	const body = "### Added\n#### Details\n- ignored detail\n### Fixed\n- fix\n";
	assert.equal(userCountLine(body), "1 fix.");
});

test("empty/unbucketed-only-empty body yields no user-facing changes", () => {
	assert.equal(userCountLine("### Added\n\n### Fixed\n"), "No user-facing changes.");
});
