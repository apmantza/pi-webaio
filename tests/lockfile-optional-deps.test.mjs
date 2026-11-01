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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("../scripts/check-lockfile-sync.mjs", import.meta.url)
	.pathname;

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
	const repo = new URL("..", import.meta.url).pathname;
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
