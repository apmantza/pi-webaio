// ─── Issue #161: check:lockfile rejected Dependabot's optional-dep shape ───
//
// Every weekly `npm-minor-patch` group PR that included an OPTIONAL dependency
// went red on `Lint & type-check`. Not the audit gate — our own drift gate:
//
//   $ npm run check:lockfile
//   Lockfile drift detected:
//     - dependencies.playwright: in lock but not package.json
//
// npm records an optional package in the lockfile's root `dependencies` block at
// an EXACT pin, while package.json declares it under `optionalDependencies` with a
// range:
//
//   package-lock.json  packages[""].dependencies.playwright = "1.64.1"
//   package.json       optionalDependencies.playwright      = "^1.55.0"
//
// Both are legitimate and `npm ci` accepts them. The gate was rejecting a shape the
// installer accepts, which meant every grouped Dependabot PR needed a human to
// hand-edit the lock — and a gate that must be worked around is a gate that stops
// being trusted.
//
// The gate must still catch the defect it was written for: a real edit to
// package.json with no lock regeneration. That case is asserted here too, so this
// is a narrowing of the rule, not a loosening of it.
//
// Recurrence prevented: weekly dependency PRs red on a false-positive drift report.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// `fileURLToPath`, not `.pathname`: on Windows `.pathname` yields `/C:/Users/...`
// and leaves spaces percent-encoded, so `spawnSync` cannot find the script and
// every test here fails before it exercises the checker. Not reproducible on
// Linux — named as an unverified-on-this-platform fix rather than claimed green.
const SCRIPT = fileURLToPath(new URL("../scripts/check-lockfile-sync.mjs", import.meta.url));

function run(pkg, lock) {
	const dir = mkdtempSync(join(tmpdir(), "lockfile-sync-"));
	try {
		writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
		writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
		const r = spawnSync(
			process.execPath,
			[SCRIPT],
			{ cwd: dir, encoding: "utf8" },
		);
		return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── The shape Dependabot produces, which must now PASS ───────────────

test("#161: an optional dep recorded in the lock's dependencies block is in sync", () => {
	const r = run(
		{
			name: "x",
			dependencies: { linkedom: "^0.18.12" },
			optionalDependencies: { playwright: "^1.55.0" },
		},
		{
			name: "x",
			packages: {
				"": {
					name: "x",
					dependencies: { linkedom: "^0.18.12", playwright: "1.64.1" },
				},
			},
		},
	);
	assert.equal(r.code, 0, `expected sync, got:\n${r.out}`);
});

test("#161: the same dep need not also appear in the lock's optionalDependencies", () => {
	const r = run(
		{ name: "x", optionalDependencies: { playwright: "^1.55.0" } },
		{ name: "x", packages: { "": { name: "x", dependencies: { playwright: "1.64.1" } } } },
	);
	assert.equal(r.code, 0, `expected sync, got:\n${r.out}`);
});

// ─── The defect the gate exists for, which must still FAIL ────────────

test("#161: a real package.json edit with no lock regeneration is still drift", () => {
	const r = run(
		{ name: "x", dependencies: { linkedom: "^0.19.0" } },
		{ name: "x", packages: { "": { name: "x", dependencies: { linkedom: "^0.18.12" } } } },
	);
	assert.equal(r.code, 1, "a spec mismatch must still be drift");
	assert.match(r.out, /linkedom/);
});

test("#161: a package removed from package.json but left in the lock is drift", () => {
	const r = run(
		{ name: "x", dependencies: {} },
		{ name: "x", packages: { "": { name: "x", dependencies: { ghost: "^1.0.0" } } } },
	);
	assert.equal(r.code, 1, "a lock-only non-optional package must still be drift");
	assert.match(r.out, /ghost/);
});

test("#161: drift on an OPTIONAL dep's own section is still caught", () => {
	const r = run(
		{ name: "x", optionalDependencies: { playwright: "^2.0.0" } },
		{
			name: "x",
			packages: { "": { name: "x", optionalDependencies: { playwright: "^1.55.0" } } },
		},
	);
	assert.equal(r.code, 1, "a mismatch inside optionalDependencies must still fail");
	assert.match(r.out, /playwright/);
});

test("#161: the real repo state passes (regression guard on the fix itself)", () => {
	const repo = fileURLToPath(new URL("..", import.meta.url));
	const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: "utf8" });
	assert.equal(r.status, 0, `repo lockfile must pass:\n${r.stdout}${r.stderr}`);
});

// Mutation-found gap (M2): the membership narrowing must apply to OPTIONAL deps
// only. Widening it to every section passed all the tests above, which would let a
// regular dependency recorded under the wrong lock section (e.g. devDependencies)
// slip through as "declared somewhere". That is the exact drift class this gate
// exists to catch, so the exemption's boundary is asserted explicitly.
//
// Recurrence prevented: a runtime dependency quietly recorded as a dev dependency
// in the lock, which `npm ci` installs differently.
test("#161: a NON-optional dep recorded only under another lock section is drift", () => {
	const r = run(
		{ name: "x", dependencies: { linkedom: "^0.18.12" } },
		{
			name: "x",
			packages: { "": { name: "x", devDependencies: { linkedom: "^0.18.12" } } },
		},
	);
	assert.equal(
		r.code,
		1,
		"only optional deps get the cross-section exemption; a regular dep in the wrong section is drift",
	);
	assert.match(r.out, /linkedom/);
});

// ─── Review round 1 on #174: the exemption accepted an out-of-range pin ──
//
// The cross-section exemption keyed on the SECTION name alone, so it accepted
// this, verified against the real script:
//
//   package.json  optionalDependencies.playwright = "^2.0.0"
//   package-lock  packages[""].dependencies.playwright = "1.64.1"
//   $ node scripts/check-lockfile-sync.mjs
//   Lockfile in sync with package.json ✓      exit=0
//
// That is exactly the drift class the gate exists for: the resolved version
// cannot satisfy the declared range, so `npm ci` installs something the manifest
// forbids. Accepting an exact pin is only safe if it SATISFIES the range, so the
// exemption now checks that. Ranges it cannot reason about are refused
// (fail closed) rather than waved through.
//
// Recurrence prevented: a Dependabot or hand-edited lock whose optional pin fell
// out of the declared range, reported as "in sync".

function pair(pkgSpec, lockSpec) {
	return run(
		{ name: "x", optionalDependencies: { pw: pkgSpec } },
		{ name: "x", packages: { "": { name: "x", dependencies: { pw: lockSpec } } } },
	);
}

test("#174: an optional pin outside the declared caret range is drift", () => {
	const r = pair("^2.0.0", "1.64.1");
	assert.equal(r.code, 1, "lock 1.64.1 cannot satisfy ^2.0.0");
	assert.match(r.out, /pw/);
});

test("#174: a satisfying optional pin is still in sync", () => {
	const r = pair("^1.55.0", "1.64.1");
	assert.equal(r.code, 0, `1.64.1 satisfies ^1.55.0:\n${r.out}`);
});

test("#174: caret on a 0.x major also constrains the minor", () => {
	// ^0.15.0 means >=0.15.0 <0.16.0 is wrong (^0.B.C => >=0.B.C <0.(B+1).0);
	// 0.18.14 is outside ^0.15.0 because the minor moved.
	assert.equal(pair("^0.15.0", "0.18.14").code, 1, "minor moved for a 0.x caret");
	assert.equal(pair("^0.15.0", "0.15.4").code, 0, "patch bump satisfies ^0.15.0");
	assert.equal(pair("^0.18.0", "0.15.0").code, 1, "older minor must not pass");
});

test("#174: a tilde range rejects a minor bump", () => {
	assert.equal(pair("~1.55.0", "1.64.1").code, 1, "~1.55.0 pins the minor to 55");
	assert.equal(pair("~1.55.0", "1.55.9").code, 0, "patch bump satisfies ~1.55.0");
});

test("#174: an exact declared spec must match exactly", () => {
	assert.equal(pair("1.64.1", "1.64.1").code, 0);
	assert.equal(pair("1.64.1", "1.64.0").code, 1);
});

test("#174: unreasonably-shaped ranges FAIL CLOSED rather than passing", () => {
	// Anything the checker cannot prove is refused, so an unforeseen spelling
	// cannot silently widen the exemption.
	for (const spec of ["workspace:*", "github:foo/pw", ">=1.0.0 <2.0.0", "1.x", ""]) {
		const r = pair(spec, "1.64.1");
		assert.equal(
			r.code,
			1,
			`spec "${spec}" is not provably satisfiable and must not be waved through`,
		);
	}
});

test("#174: the wildcard range accepts any pin", () => {
	assert.equal(pair("*", "1.64.1").code, 0, "* declares no constraint");
});

// ─── Review round 2 on #174 ───────────────────────────────────────────

// The reviewer asked to also require lock.packages["node_modules/<name>"].version
// to EQUAL the root mirror. Taken literally that false-reds whenever an optional
// package has no top-level resolution entry (platform-conditional optionals,
// pruned locks) — i.e. it would re-break the Dependabot shape this fix exists for.
// Adopted in softened form: when a resolution entry IS present it must satisfy
// the declared range; when it is absent nothing is denied.
test("#174: a recorded resolution outside the declared range is drift", () => {
	const r = run(
		{ name: "x", optionalDependencies: { pw: "^2.0.0" } },
		{
			name: "x",
			packages: {
				"": { name: "x", dependencies: { pw: "2.4.0" } },
				"node_modules/pw": { version: "1.64.1" },
			},
		},
	);
	assert.equal(
		r.code,
		1,
		"root mirror says 2.4.0 but the recorded resolution is 1.64.1 — that is drift",
	);
	assert.match(r.out, /pw/);
});

test("#174: a matching resolution is still in sync", () => {
	const r = run(
		{ name: "x", optionalDependencies: { pw: "^1.55.0" } },
		{
			name: "x",
			packages: {
				"": { name: "x", dependencies: { pw: "1.64.1" } },
				"node_modules/pw": { version: "1.64.1" },
			},
		},
	);
	assert.equal(r.code, 0, `expected sync:\n${r.out}`);
});

test("#174: an absent resolution entry does not deny the exemption", () => {
	// Platform-conditional optional deps legitimately have no top-level entry.
	const r = pair("^1.55.0", "1.64.1");
	assert.equal(r.code, 0, `absent node_modules entry must not false-red:\n${r.out}`);
});
