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
for (const section of SECTIONS) {
	const pkgDeps = pkg[section] ?? {};
	const lockDeps = root[section] ?? {};
	for (const [name, spec] of Object.entries(pkgDeps)) {
		if (lockDeps[name] !== spec) {
			problems.push(
				`${section}.${name}: package.json="${spec}" lock="${lockDeps[name] ?? "(missing)"}"`,
			);
		}
	}
	for (const name of Object.keys(lockDeps)) {
		if (!(name in pkgDeps)) {
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
