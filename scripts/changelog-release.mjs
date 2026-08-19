#!/usr/bin/env node
// Promote the `## [Unreleased]` section to a dated version section, and open a
// fresh empty `## [Unreleased]` above it. Run this at version-bump time so the
// CHANGELOG never falls behind the tag again.
//
//   node scripts/changelog-release.mjs            # version from package.json, today's date
//   node scripts/changelog-release.mjs 0.6.1     # explicit version
//   node scripts/changelog-release.mjs 0.6.1 --date 2026-07-03
//   node scripts/changelog-release.mjs --check     # verify [Unreleased] is non-empty; no write
//
// The release workflow's "Verify changelog entry exists" step already fails CI
// if `## [VERSION]` is missing, so forgetting to run this is caught before tag.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promoteUnreleased, unreleasedHasEntries } from "./lib/changelog.mjs";
import { parseArgsOrExit } from "./lib/cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");
const PKG_PATH = join(__dirname, "..", "package.json");

function log(message) {
	process.stdout.write(`${message}\n`);
}

function logError(message) {
	process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
	const args = { version: undefined, date: undefined, check: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--check") args.check = true;
		else if (a === "--date") {
			const value = argv[++i];
			if (!value) throw new Error("--date requires a value.");
			args.date = value;
		} else if (!args.version) args.version = a;
	}
	return args;
}

function readPackageVersion() {
	try {
		const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
		if (typeof pkg.version === "string" && pkg.version.trim()) {
			return pkg.version;
		}
	} catch (err) {
		throw new Error(`Could not read package.json version: ${err.message}`);
	}
	throw new Error("package.json does not contain a string version.");
}

function main() {
	const args = parseArgsOrExit(parseArgs, process.argv.slice(2));
	const text = readFileSync(CHANGELOG_PATH, "utf8");

	if (args.check) {
		if (!unreleasedHasEntries(text)) {
			logError("`## [Unreleased]` has no entries to release.");
			process.exit(1);
		}
		log("[Unreleased] has entries — ready to release.");
		return;
	}

	let version;
	try {
		version = args.version ?? readPackageVersion();
	} catch (err) {
		logError(String(err.message || err));
		process.exit(1);
	}
	const date = args.date ?? new Date().toISOString().slice(0, 10);

	let next;
	try {
		next = promoteUnreleased(text, version, date);
	} catch (err) {
		logError(String(err.message || err));
		process.exit(1);
	}
	writeFileSync(CHANGELOG_PATH, next, "utf8");
	log(`Promoted [Unreleased] -> [${version}] - ${date}.`);
}

main();
