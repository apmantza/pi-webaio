// ─── A test suite that never runs is not a detector ───────────────────
//
// Recurrence prevented: TWICE in this session I added a regression suite, stated
// in the PR body that it was wired into `test:all`, and was wrong both times —
// the first was caught only because the total test count did not move, the second
// was caught by an independent reviewer (`tests/strip-www-consolidation.test.mjs`
// and `tests/webmap-count-labels.test.mjs` were both absent). A guard that only
// runs when someone remembers to invoke it by name guards nothing, and CI reports
// green either way.
//
// This is a ratchet over the DIRECTORY, not over a list of files I remembered:
// every `tests/*.test.mjs` on disk must be referenced by some package.json script,
// or be listed below with a reason. Adding a suite without wiring it fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(ROOT, "tests");

// Suites that are deliberately NOT in `test:all`, each with the reason. Adding a
// name here is a visible decision, not an accident.
const OPT_IN = new Map([
	// Hits the network to build dist via the real `prepare` path.
	["prepare.test.mjs", "live npm install path; network-blocked in CI sandboxes"],
	// Drives the MCP stdio server as a child process; owns its own harness.
	["mcp-server.test.mjs", "run by its own `test:mcp` script"],
	// Opt-in live probes: they contact external services and must not gate a PR.
	["fingerprint.test.mjs", "opt-in live TLS diagnostics"],
	["jina-envelope.test.mjs", "opt-in live Jina probe"],
	["perf-extraction.test.mjs", "opt-in timing probe; timing is not a gate signal"],
]);

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const allScripts = Object.values(scripts).join(" ");

test("every tests/*.test.mjs is wired into a package.json script", () => {
	const orphans = [];
	for (const entry of readdirSync(TESTS)) {
		if (!entry.endsWith(".test.mjs")) continue;
		if (OPT_IN.has(entry)) continue;
		if (!allScripts.includes(`tests/${entry}`)) orphans.push(entry);
	}
	assert.deepEqual(
		orphans,
		[],
		`${orphans.length} suite(s) exist but no script runs them: ${orphans.join(", ")}. ` +
			`Wire them into test:all, or add them to OPT_IN in this file with a reason. ` +
			`An unwired suite is a guard that never fires and CI stays green anyway.`,
	);
});

test("the opt-in list does not rot: every entry still exists", () => {
	const present = new Set(readdirSync(TESTS));
	const stale = [...OPT_IN.keys()].filter((name) => !present.has(name));
	assert.deepEqual(
		stale,
		[],
		`OPT_IN lists suites that no longer exist: ${stale.join(", ")} — remove the rows`,
	);
});

test("the two #173 suites specifically are wired (the finding this came from)", () => {
	for (const f of ["tests/strip-www-consolidation.test.mjs", "tests/webmap-count-labels.test.mjs"]) {
		assert.ok(
			(scripts["test:all"] ?? "").includes(f),
			`${f} must run in test:all — it is the only guard for the #173 fixes`,
		);
	}
});
