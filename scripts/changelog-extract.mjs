#!/usr/bin/env node
// Print the curated CHANGELOG.md section body for a version to stdout.
//
//   node scripts/changelog-extract.mjs 0.6.1          # to stdout
//   node scripts/changelog-extract.mjs v0.6.1 -o out   # to a file
//
// Used by .github/workflows/release.yml to feed `gh release create
// --notes-file`, so the GitHub release body IS the curated section (single
// source of truth). Exits non-zero with a clear message if the section is
// missing or empty, which fails the release before it tags anything.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractSection, summarizeSection } from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");

function err(message) {
  process.stderr.write(`${message}
`);
}

function parseArgs(argv) {
  const args = { version: undefined, out: undefined, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") {
      const value = argv[++i];
      if (!value) throw new Error(`${a} requires a file path.`);
      args.out = value;
    } else if (a === "--summary") args.summary = true;
    else if (!args.version) args.version = a;
  }
  return args;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    err(String(err.message || err));
    process.exit(2);
  }
  const { version, out, summary } = parsed;
  if (!version) {
    err("usage: changelog-extract.mjs <version> [--summary] [-o <file>]");
    process.exit(2);
  }
  const text = readFileSync(CHANGELOG_PATH, "utf8");
  const full = extractSection(text, version);
  if (full === null || full.trim().length === 0) {
    err(`No CHANGELOG section for version "${version}".`);
    process.exit(1);
  }
  // The release body is a scannable summary (bold titles, grouped) — the full
  // prose stays in CHANGELOG.md. `--summary` is what release.yml passes.
  const body = summary ? summarizeSection(full) : full;
  if (out) writeFileSync(out, body + "\n", "utf8");
  else process.stdout.write(body + "\n");
}

main();
