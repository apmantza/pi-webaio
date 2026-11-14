#!/usr/bin/env node
// Generate or check CHANGELOG-USER.md (pi-lens style: count-only recent releases).
//
//   node scripts/changelog-user.mjs           # write CHANGELOG-USER.md
//   node scripts/changelog-user.mjs --check   # exit 1 if stale

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderUserChangelog } from "./lib/changelog.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(rootDir, "CHANGELOG.md");
const userPath = join(rootDir, "CHANGELOG-USER.md");

function main() {
	const check = process.argv.includes("--check");
	const source = readFileSync(changelogPath, "utf8");
	const rendered = renderUserChangelog(source);
	if (check) {
		let current = "";
		try {
			current = readFileSync(userPath, "utf8");
		} catch {
			current = "";
		}
		if (current !== rendered) {
			console.error(
				"CHANGELOG-USER.md is stale; run node scripts/changelog-user.mjs",
			);
			process.exit(1);
		}
		console.log("CHANGELOG-USER.md is up to date.");
		return;
	}
	writeFileSync(userPath, rendered, "utf8");
	console.log(`Wrote ${userPath}`);
}

main();
