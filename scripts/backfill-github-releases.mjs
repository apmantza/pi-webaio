#!/usr/bin/env node
// Retroactively set every GitHub release body to its curated CHANGELOG section.
//
// The release history was created with `gh release create --generate-notes`, so
// each body is a thin auto-generated PR-title list (and misses everything that
// landed as a direct commit). The curated prose already lives in CHANGELOG.md;
// this pushes it into the release bodies so the whole history reads meaningfully.
//
//   node scripts/backfill-github-releases.mjs            # DRY RUN (default): show plan
//   node scripts/backfill-github-releases.mjs --apply    # actually edit releases
//   node scripts/backfill-github-releases.mjs --apply --only v0.6.0,v0.5.0
//   node scripts/backfill-github-releases.mjs --apply --full   # full prose, not summary
//   node scripts/backfill-github-releases.mjs --repo owner/name --apply
//
// By default the release body is the scannable summary (bold titles, grouped) —
// the same form `release.yml` posts for new releases; `--full` writes the whole
// CHANGELOG section instead. Requires the `gh` CLI authenticated. Releases
// without a CHANGELOG section are skipped (reported), never blanked.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSection,
  summarizeSection,
  normalizeVersion,
} from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");

function log(message = "") {
  process.stdout.write(`${message}\n`);
}

function err(message) {
  process.stderr.write(`${message}
`);
}

function parseArgs(argv) {
  const args = { apply: false, full: false, repo: undefined, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--full") args.full = true;
    else if (a === "--repo") {
      const value = argv[++i];
      if (!value) throw new Error("--repo requires a value.");
      args.repo = value;
    } else if (a === "--only") {
      const value = argv[++i];
      if (!value) throw new Error("--only requires a comma-separated list.");
      args.only = new Set(
        value.split(",").map((s) => normalizeVersion(s.trim())),
      );
    }
  }
  return args;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function listReleases(repo) {
  const args = ["release", "list", "--limit", "200", "--json", "tagName"];
  if (repo) args.push("--repo", repo);
  const raw = gh(args);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON from gh release list: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid gh release list payload: expected an array.");
  }
  return parsed
    .map((r) => (typeof r?.tagName === "string" ? r.tagName : null))
    .filter(Boolean);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    err(String(err.message || err));
    process.exit(2);
  }
  const changelog = readFileSync(CHANGELOG_PATH, "utf8");

  let tags;
  try {
    tags = listReleases(args.repo);
  } catch (err) {
    err("Failed to list releases via `gh`. Is it installed/authed?");
    err(String(err.message || err));
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "piwebaio-relnotes-"));
  const plan = [];
  for (const tag of tags) {
    if (args.only && !args.only.has(normalizeVersion(tag))) continue;
    const full = extractSection(changelog, tag);
    if (full === null || full.trim().length === 0) {
      plan.push({ tag, action: "skip", reason: "no CHANGELOG section" });
      continue;
    }
    const body = args.full ? full : summarizeSection(full);
    plan.push({ tag, action: "update", body });
  }

  const updates = plan.filter((p) => p.action === "update");
  const skips = plan.filter((p) => p.action === "skip");

  log(
    `${args.apply ? "APPLYING" : "DRY RUN"} — ${updates.length} release(s) to update, ${skips.length} skipped.\n`,
  );
  for (const p of skips) log(`  skip   ${p.tag}  (${p.reason})`);
  for (const p of updates) {
    const firstLine = p.body.split("\n").find((l) => l.trim()) ?? "";
    log(`  update ${p.tag}  ${firstLine.slice(0, 70)}`);
  }

  if (!args.apply) {
    log("\nRe-run with --apply to write these release bodies.");
    return;
  }

  let ok = 0;
  for (const p of updates) {
    const notesFile = join(tmp, `${normalizeVersion(p.tag)}.md`);
    writeFileSync(notesFile, p.body + "\n", "utf8");
    const editArgs = ["release", "edit", p.tag, "--notes-file", notesFile];
    if (args.repo) editArgs.push("--repo", args.repo);
    try {
      gh(editArgs);
      ok++;
      log(`  ok     ${p.tag}`);
    } catch (err) {
      err(`  FAIL   ${p.tag}: ${String(err.message || err)}`);
    }
  }
  log(`\nUpdated ${ok}/${updates.length} release bodies.`);
}

main();
