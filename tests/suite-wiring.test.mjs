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

/**
 * What CI ACTUALLY runs - not what some script happens to name.
 *
 * The first version accepted a suite referenced by ANY package.json script, and
 * that was wrong in exactly the way this file exists to catch:
 * `tests/cli.test.mjs` is named by `test:cli`, but CI never invokes `test:cli`,
 * so the guard waved through a suite that still never runs. A wiring check that
 * trusts the manifest instead of the workflow is not a wiring check.
 *
 * So: read the workflow, take every `npm run <script>` it executes, expand each
 * one level, and collect the test files reachable from there.
 */
const ciYaml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
/**
 * `npm run <script>` invocations that CI actually EXECUTES.
 *
 * YAML comments are stripped first. A commented-out `# npm run test:cli` is not a
 * step that runs, and matching raw YAML would let a comment make an unwired suite
 * look wired - the same false green this file exists to catch, arriving from the
 * opposite direction: someone un-wires a suite by commenting its step and the
 * guard keeps reporting coverage.
 */
function ciCommands(yaml) {
	const executable = yaml
		.split("\n")
		.filter((line) => !/^[\s-]*#/.test(line))
		// An inline trailing comment cannot introduce a second `npm run`, because
		// everything after `#` on a step line is prose.
		.map((line) => line.replace(/\s#.*$/, ""));
	const found = new Set();
	for (const line of executable) {
		for (const m of line.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) found.add(m[1]);
	}
	return found;
}

const ciScripts = ciCommands(ciYaml);
const ciRanFiles = new Set();
for (const name of ciScripts) {
	for (const delegate of [name, scripts[name]]) {
		const body = typeof delegate === "string" ? delegate : "";
		for (const m of body.matchAll(/tests\/[\w.-]+\.test\.mjs/g)) ciRanFiles.add(m[0]);
	}
	const body = scripts[name] ?? "";
	for (const nested of body.matchAll(/npm (?:run )?([a-zA-Z0-9:_-]+)/g)) {
		const nestedBody = nested[1] !== name ? scripts[nested[1]] : undefined;
		if (!nestedBody) continue;
		for (const m of nestedBody.matchAll(/tests\/[\w.-]+\.test\.mjs/g)) {
			ciRanFiles.add(m[0]);
		}
	}
}

test("every tests/*.test.mjs is reachable from a script CI executes", () => {
	const orphans = [];
	for (const entry of readdirSync(TESTS)) {
		if (!entry.endsWith(".test.mjs")) continue;
		if (OPT_IN.has(entry)) continue;
		if (!ciRanFiles.has(`tests/${entry}`)) orphans.push(entry);
	}
	assert.deepEqual(
		orphans,
		[],
		`${orphans.length} suite(s) exist but CI never runs them: ${orphans.join(", ")}. ` +
			`The reachable set comes from the \`npm run\` invocations in ci.yml, not from ` +
			`any script that happens to name the file. Wire them into test:all, or list ` +
			`them in OPT_IN here with a reason. An unwired suite is a guard that never ` +
			`fires while CI still reports green.`,
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

// The reachable set must come from EXECUTABLE steps. A commented-out
// `# npm run test:cli` line is not CI running anything, and matching the raw YAML
// would let a comment make an unwired suite look wired — the exact false-green
// this file exists to prevent, arriving from the other direction.
//
// Recurrence prevented: a suite quietly unwired by commenting out its step while
// the guard keeps reporting coverage.
// The reachable set must come from EXECUTABLE steps. A commented-out
// `# npm run test:cli` is not CI running anything, and matching the raw YAML
// would let a comment make an unwired suite look wired — the exact false-green
// this file exists to prevent, arriving from the other direction.
//
// Recurrence prevented: a suite quietly unwired by commenting out its step while
// the guard keeps reporting coverage.
test("#173: commented-out workflow commands do not count as CI coverage", () => {
	const yaml = [
		"      - run: npm run test:all",
		"      # npm run test:cli",
		"      #   npm run test:mcp",
		"      - run: echo done # npm run test:models",
		].join("\n");
	const cmds = ciCommands(yaml);
	assert.deepEqual(
		[...cmds].sort(),
		["test:all"],
		`expected only the executable step, got ${JSON.stringify([...cmds])} — a commented \`npm run\` must not extend the reachable set`,
	);
});

test("#173: the real ci.yml still yields the suites the ratchet depends on", () => {
	// Guards against "fixed" the extractor into matching nothing.
	assert.ok(ciScripts.has("test:all"), "test:all must remain reachable from ci.yml");
	assert.ok(ciRanFiles.has("tests/prune-storage.test.mjs") || ciRanFiles.size > 20,
		"the extractor must still resolve real test files");
});

// `node --test <path>` does NOT fail on a path that does not exist — it reports
// the other files' results and exits 0. Observed directly while resolving a merge
// conflict: `node --test tests/lockfile-optional-deps.test.mjs
// tests/suite-wiring.test.mjs` returned "18 pass, 0 fail" with the second file
// absent from disk, because 18 was the first file's count alone.
//
// So a typo'd or renamed suite inside `test:all` is a silent hole: CI stays green
// and the suite stops running. Reachability alone cannot see it — the name is
// present in the script, it just points at nothing.
//
// Recurrence prevented: a suite renamed in one place and not the other, leaving
// the guard counting a file that is not there.
test("#173: every suite named by a package.json script exists on disk", () => {
	const present = new Set(readdirSync(TESTS));
	const missing = [];
	for (const [name, body] of Object.entries(scripts)) {
		if (typeof body !== "string") continue;
		for (const m of body.matchAll(/tests\/[\w.-]+\.test\.mjs/g)) {
			if (!present.has(basename(m[0]))) missing.push(`${name} -> ${m[0]}`);
		}
	}
	assert.deepEqual(
		missing,
		[],
		`${missing.length} script(s) name a test file that does not exist: ` +
			`${missing.join(", ")}. node --test ignores missing paths and still ` +
			`exits 0, so CI would keep passing while that suite silently stops running.`,
	);
});
