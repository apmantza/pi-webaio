#!/usr/bin/env node
/**
 * Fail if package-lock.json's root entry drifts from package.json's declared
 * dependency specs. Catches the class of bug where someone edits
 * package.json (e.g. pinning a dep) without regenerating the lock. A
 * committed lock that disagrees with package.json makes `npm ci` wipe
 * node_modules and hard-fail for downstream users.
 *
 * Compares dependency SPEC STRINGS (not resolved transitive versions) so
 * it never flags spurious upstream republishes. Fix any failure with
 * `npm install` (which rewrites the lock) and commit the result.
 */
import * as fs from "node:fs";

function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
}

const pkg = read("package.json");
const lock = read("package-lock.json");
const root = lock.packages?.[""] ?? {};

const SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

const problems = [];

/**
 * Does an EXACT resolved version satisfy a declared range?
 *
 * The cross-section exemption (issue #161) accepts a package npm recorded in a
 * different lock section at an exact pin. Keying on the section name alone meant
 * it also accepted a pin that CANNOT satisfy the declared range - e.g. `^2.0.0`
 * declared against `1.64.1` resolved - which is precisely the drift this gate
 * exists to catch, so the exemption now has to prove satisfaction.
 *
 * Deliberately NOT a general semver implementation: it recognises the spellings
 * npm actually writes for a resolved dependency and returns false for everything
 * else, so an unforeseen range narrows nothing. Fail-closed by construction
 * rather than by enumerating known-bad forms.
 */
function parseVersion(value) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
	if (!m) return null; // prereleases and builds are out of scope: unprovable
	return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function compareVersions(a, b) {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function pinSatisfiesRange(pin, range) {
	const resolved = parseVersion(pin);
	if (!resolved) return false;
	const spec = String(range).trim();
	if (spec === "*") return true;

	let m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(spec);
	if (m) {
		const base = { major: +m[1], minor: +m[2], patch: +m[3] };
		if (compareVersions(resolved, base) < 0) return false;
		if (base.major > 0) return resolved.major === base.major;
		// ^0.B.C allows no minor movement; ^0.0.C allows none at all.
		if (base.minor > 0) return resolved.major === 0 && resolved.minor === base.minor;
		return compareVersions(resolved, base) === 0;
	}

	m = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
	if (m) {
		if (resolved.major !== +m[1]) return false;
		if (m[2] === undefined) return true;
		if (resolved.minor !== +m[2]) return false;
		if (m[3] === undefined) return true;
		return resolved.patch >= +m[3];
	}

	m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(spec);
	if (m) {
		return compareVersions(resolved, { major: +m[1], minor: +m[2], patch: +m[3] }) >= 0;
	}

	const exact = parseVersion(spec);
	if (exact) return compareVersions(resolved, exact) === 0;

	return false; // ||, ranges, git:, workspace:, link:, anything unrecognised
}

// Issue #161: npm records an OPTIONAL dependency in the lockfile's root
// `dependencies` block at an exact pin, while package.json declares it under
// `optionalDependencies` with a range:
//
//   packages[""].dependencies.playwright = "1.64.1"
//   optionalDependencies.playwright      = "^1.55.0"
//
// Both are legitimate and `npm ci` accepts them, but the gate read the lock's
// `dependencies` entry as a package nobody declared and failed every weekly
// grouped Dependabot PR that touched an optional dep.
//
// Membership is narrowed, specs are not: a name may be RECORDED in any lock
// section, but a spec mismatch inside the section package.json actually declares
// it in is still drift. A gate that must be worked around stops being trusted;
// a gate that stops catching real drift is worse, so both halves are tested.
const lockIndex = new Map();
for (const section of SECTIONS) {
	for (const [name, spec] of Object.entries(root[section] ?? {})) {
		if (!lockIndex.has(name)) lockIndex.set(name, { section, spec });
	}
}
for (const section of SECTIONS) {
	const pkgDeps = pkg[section] ?? {};
	const lockDeps = root[section] ?? {};
	for (const [name, spec] of Object.entries(pkgDeps)) {
		if (name in lockDeps) {
			if (lockDeps[name] !== spec) {
				problems.push(
					`${section}.${name}: package.json="${spec}" lock="${lockDeps[name]}"`,
				);
			}
			continue;
		}
		const elsewhere = lockIndex.get(name);
		if (
			section === "optionalDependencies" &&
			elsewhere &&
			pinSatisfiesRange(elsewhere.spec, spec)
		) {
			// Declared optional, recorded under another lock section, and the
			// resolved pin satisfies the declared range: npm's own shape (#161).
			continue;
		}
		problems.push(
			`${section}.${name}: package.json="${spec}" lock="${
				elsewhere
					? `in ${elsewhere.section} (${elsewhere.spec})${
						section === "optionalDependencies"
							? " - does not satisfy the range"
							: ""
					}`
					: "(missing)"
			}`,
		);
	}
	for (const name of Object.keys(lockDeps)) {
		const declaredSomewhere = SECTIONS.some((s) => name in (pkg[s] ?? {}));
		if (!declaredSomewhere) {
			problems.push(`${section}.${name}: in lock but not package.json`);
		}
	}
}

if (problems.length === 0) {
	console.log("Lockfile in sync with package.json ✓");
	process.exit(0);
} else {
	console.error("Lockfile drift detected:");
	for (const p of problems) console.error("  - " + p);
	console.error("\nFix: run `npm install` to regenerate the lock, then commit.");
	process.exit(1);
}
