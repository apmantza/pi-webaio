// aio-webresearch bundle directory resolution (battery finding 2026-09-19).
//
// Recurrence this prevents: a relative `outDir` used to resolve against the
// process CWD, so a bare name like `outDir: "my-research"` wrote the bundle
// into the repo/working-tree root — polluting it, since only the default
// `.pi/webaio-research/` path is gitignored. Relative outDirs now resolve
// under `.pi/webaio-research/` (same root the default uses); absolute paths
// stay honored verbatim for scripts that own their storage layout.
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveOutDir } from "../src/tools/webresearch.ts";

test("relative outDir resolves under .pi/webaio-research, not the CWD root", () => {
	const dir = resolveOutDir("my-research", "20260101-default");
	assert.match(dir, /\.pi[\/\\]webaio-research[\/\\]my-research$/);
	assert.doesNotMatch(dir, /webaio-research\/\.pi/);
});

test("absolute outDir stays honored verbatim (resolved)", () => {
	const dir = resolveOutDir("/tmp/research-owned-elsewhere", "20260101-default");
	assert.equal(dir, resolveOutDir("/tmp/research-owned-elsewhere", "ignored-name"));
	assert.match(dir, /^\/tmp\/research-owned-elsewhere$/);
});

test("no outDir keeps the default timestamped path under .pi/webaio-research", () => {
	const dir = resolveOutDir(undefined, "20260101-default-name");
	assert.match(dir, /\.pi[\/\\]webaio-research[\/\\]20260101-default-name$/);
});
