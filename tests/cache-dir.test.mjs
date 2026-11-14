/**
 * Cache location + bounded sweep tests (issue #221).
 *
 * Recurrence: the whole disk cache lived under os.tmpdir()/pi-webaio —
 * RAM-backed tmpfs on Linux — and nothing ever swept it. 2026-11-06
 * measurement: 2.3 GB (2,344 MB github clones), 8 GB swap full. Fixes:
 * platform cache dir + PI_WEBAIO_CACHE_DIR override (fail-closed), a
 * bounded heavy-artifact sweep (7d age + 500 MB LRU cap) over the
 * clone/log/download dirs only, expired storage blobs unlinked on index
 * load, and a legacy-corpus fallback in webquery.
 *
 * No live network, no real cache writes: every fixture lives under a
 * mkdtemp dir and the sweep runs against explicit dirs.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Pin the cache root BEFORE importing modules: session-store kicks a
// module-level sweeper (setImmediate) against BASE_TEMP on import, so an
// unpinned import would scan/sweep the real user cache (#227 review).
// Prove it targeted the PINNED root (not a hard-coded/real path) by
// pre-creating a stale swept artifact under it and asserting the module-load
// sweep removes it — an observable effect that only this root can produce.
const _testCacheRoot = mkdtempSync(join(tmpdir(), "webaio-cache-root-"));
process.env.PI_WEBAIO_CACHE_DIR = _testCacheRoot;

const _probeDir = join(_testCacheRoot, "github", "probe--stale");
mkdirSync(_probeDir, { recursive: true });
writeFileSync(join(_probeDir, "f"), "x");
{
	const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	utimesSync(_probeDir, past, past);
}

const cacheDir = await import("../src/cache-dir.ts");
const storage = await import("../src/storage.ts");
await import("../src/session-store.ts");
const { resolveCorpusDir } = await import("../src/tools/webquery.ts");

// The module-load sweep is fire-and-forget; poll for its observable effect.
for (let i = 0; i < 50 && existsSync(_probeDir); i++) {
	await new Promise((r) => setTimeout(r, 20));
}
assert.ok(
	!existsSync(_probeDir),
	"module-load sweeper must remove stale artifacts under the pinned cache root",
);

test.after(() => {
	rmSync(_testCacheRoot, { recursive: true, force: true });
	delete process.env.PI_WEBAIO_CACHE_DIR;
});

/** Make a fake cache artifact ENTRY under one of the swept dirs, matching
 * the real layout: <base>/<swept-dir>/<entry> (e.g. github/<owner>--<repo>). */
function makeEntry(base, sweptDir, name, files = 1, bytes = 100, ageMs = 0) {
	const dir = join(base, sweptDir, name);
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < files; i++) {
		writeFileSync(join(dir, `f${i}.bin`), Buffer.alloc(bytes));
	}
	if (ageMs > 0) {
		const past = new Date(Date.now() - ageMs);
		utimesSync(dir, past, past);
	}
	return dir;
}

test("resolveCacheDir: unset override → platform default", () => {
	// Linux default honors XDG_CACHE_HOME; others use their own roots.
	const env = {};
	const dir = cacheDir.resolveCacheDir(env);
	assert.ok(
		dir.endsWith(join("pi-webaio")),
		"default ends with pi-webaio",
	);
	assert.ok(!dir.startsWith(tmpdir()), "default is NOT under os.tmpdir() (#221)");
});

test("resolveCacheDir: absolute override honored; blank → default; relative → fail closed", () => {
	const abs = join(tmpdir(), "webaio-cache-fixture");
	assert.equal(cacheDir.resolveCacheDir({ PI_WEBAIO_CACHE_DIR: abs }), abs);
	assert.equal(
		cacheDir.resolveCacheDir({ PI_WEBAIO_CACHE_DIR: "  " }),
		cacheDir.resolveCacheDir({}),
		"blank override falls back to default",
	);
	assert.throws(
		() => cacheDir.resolveCacheDir({ PI_WEBAIO_CACHE_DIR: "relative/path" }),
		(err) => err.message.includes("must be an absolute path"),
	);
	// ~ expansion (the same contract as chrome-profile).
	const home = cacheDir.resolveCacheDir({ PI_WEBAIO_CACHE_DIR: "~/cache-x" });
	assert.equal(home, join(homedir(), "cache-x"));
});

test("sweep: age-expired entries removed, fresh entries kept", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-sweep-"));
	try {
		const oldDir = makeEntry(base, "github", "old--clone", 1, 100, 8 * 24 * 60 * 60 * 1000);
		const freshDir = makeEntry(base, "downloads", "fresh--log", 1, 100, 0);
		const summary = await cacheDir.sweepHeavyArtifacts(base, {
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
			maxBytes: 500 * 1024 * 1024,
			activeGraceMs: 0,
		});
		assert.equal(summary.removed, 1, "exactly the expired entry removed");
		assert.ok(!existsSync(oldDir), "expired clone dir deleted");
		assert.ok(existsSync(freshDir), "fresh dir kept");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("sweep: LRU cap evicts oldest-first until under budget", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-sweep-cap-"));
	try {
		// 3 fresh entries under swept dirs, oldest touched first.
		const a = makeEntry(base, "github", "a--repo", 2, 400); // 800 B
		const b = makeEntry(base, "downloads", "b--run", 2, 400); // 800 B
		const c = makeEntry(base, "github-maps", "c--repo", 2, 400); // 800 B
		const now = Date.now();
		const fs = await import("node:fs");
		fs.utimesSync(a, new Date(now - 3000), new Date(now - 3000));
		fs.utimesSync(b, new Date(now - 2000), new Date(now - 2000));
		fs.utimesSync(c, new Date(now - 1000), new Date(now - 1000));
		const summary = await cacheDir.sweepHeavyArtifacts(base, {
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
			maxBytes: 1000, // keep only the newest artifact under 1000 B total
			activeGraceMs: 0,
		});
		assert.equal(summary.removed, 2, "two oldest evicted by the cap");
		assert.equal(summary.capped, 2);
		assert.ok(!existsSync(a), "oldest evicted first");
		assert.ok(!existsSync(b), "second-oldest evicted");
		assert.ok(existsSync(c), "newest survives the cap");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("sweep: never touches content caches or pulled corpora", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-sweep-safe-"));
	try {
		// Content/corpus-like dirs are NOT in SWEEP_DIR_NAMES.
		const corpus = makeEntry(base, "unsloth.ai", "page", 1, 100, 30 * 24 * 60 * 60 * 1000);
		const content = makeEntry(base, "example.com", "page", 1, 100, 30 * 24 * 60 * 60 * 1000);
		const results = makeEntry(base, "results", "blob", 1, 100, 30 * 24 * 60 * 60 * 1000);
		await cacheDir.sweepHeavyArtifacts(base, {
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
			maxBytes: 0,
		});
		assert.ok(existsSync(corpus), "pulled corpus untouched (user data)");
		assert.ok(existsSync(content), "content cache untouched (restart survival)");
		assert.ok(existsSync(results), "results dir untouched (own TTL logic)");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("sweep: summary is returned even when nothing exists (idempotent)", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-sweep-empty-"));
	try {
		const summary = await cacheDir.sweepHeavyArtifacts(base);
		assert.deepEqual(summary, { removed: 0, bytes: 0, capped: 0 });
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("storage loadIndex: expired blobs are UNLINKED, not just filtered", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-blobs-"));
	try {
		// Build an index file with one live and one expired entry, plus blobs.
		const resultsDir = join(base, "results");
		mkdirSync(resultsDir, { recursive: true });
		const liveBlob = join(resultsDir, "live.md");
		const deadBlob = join(resultsDir, "dead.md");
		writeFileSync(liveBlob, "live");
		writeFileSync(deadBlob, "dead");
		const index = {
			live: {
				id: "live", url: "https://a/", blobPath: liveBlob,
				createdAt: Date.now(), expiresAt: Date.now() + 60000,
				source: "webfetch", contentHash: "x",
			},
			dead: {
				id: "dead", url: "https://b/", blobPath: deadBlob,
				createdAt: Date.now() - 60000, expiresAt: Date.now() - 1000,
				source: "webfetch", contentHash: "y",
			},
		};
		writeFileSync(join(resultsDir, "index.json"), JSON.stringify(index), "utf8");

		// Redirect the storage root and reset the module's index cache, then
		// load through the public surface (getResult → loadIndex). Restore in
		// finally so the process-global redirect never leaks (#227 review).
		const restore = storage._setStorageDirForTest(resultsDir);
		try {
			await storage.getResult("dead");
			// Wait out the fire-and-forget unlink.
			await new Promise((r) => setTimeout(r, 100));
			assert.ok(!existsSync(deadBlob), "expired blob unlinked (#221)");
			assert.ok(existsSync(liveBlob), "live blob kept");
		} finally {
			restore();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("webquery resolveCorpusDir: new base first, legacy tmpdir fallback", () => {
	// Indexed corpus exists under the new base → used.
	const base = mkdtempSync(join(tmpdir(), "webaio-wq-new-"));
	const legacyBase = mkdtempSync(join(tmpdir(), "webaio-wq-legacy-"));
	try {
		mkdirSync(join(base, "fresh.corpus"), { recursive: true });
		writeFileSync(join(base, "fresh.corpus", ".webaio-index.json"), "{}");
		assert.equal(
			resolveCorpusDir("fresh.corpus", base, legacyBase),
			join(base, "fresh.corpus"),
		);
		// Missing under the new base but present under the legacy base → the
		// legacy copy wins (old corpora stay queryable after the move).
		mkdirSync(join(legacyBase, "old.corpus"), { recursive: true });
		assert.equal(
			resolveCorpusDir("old.corpus", base, legacyBase),
			join(legacyBase, "old.corpus"),
		);
		// Absolute paths pass through unchanged (no fallback rewriting).
		assert.equal(
			resolveCorpusDir(join(base, "fresh.corpus"), base, legacyBase),
			join(base, "fresh.corpus"),
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
		rmSync(legacyBase, { recursive: true, force: true });
	}
});

test("sweep: a lone truncated (walk-capped) entry is evicted by the size cap (#227)", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-sweep-trunc-"));
	try {
		// > MAX_FILES_PER_ENTRY files → walk truncates. Measured bytes stay tiny
		// but effective size must exceed maxBytes so the lone entry cannot
		// survive the `total <= maxBytes` break.
		const dir = makeEntry(base, "github", "huge--clone", 0, 0, 0);
		for (let i = 0; i < 20010; i++) {
			writeFileSync(join(dir, `f${i}`), "");
		}
		const past = new Date(Date.now() - 10 * 60 * 1000); // past grace, within age
		utimesSync(dir, past, past);
		const summary = await cacheDir.sweepHeavyArtifacts(base, {
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
			maxBytes: 100,
			activeGraceMs: 0,
		});
		assert.equal(summary.capped, 1, "truncated lone entry evicted by cap");
		assert.ok(!existsSync(dir), "oversized truncated entry removed");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("sweep: eviction continues after an individual removal failure (#227)", async () => {
	const base = mkdtempSync(join(tmpdir(), "webaio-sweep-fail-"));
	try {
		const a = makeEntry(base, "github", "a--repo", 1, 200, 0);
		const b = makeEntry(base, "downloads", "b--run", 1, 200, 0);
		const now = Date.now();
		const fs = await import("node:fs");
		fs.utimesSync(a, new Date(now - 3000), new Date(now - 3000));
		fs.utimesSync(b, new Date(now - 2000), new Date(now - 2000));
		const doomed = a;
		const removed = [];
		const summary = await cacheDir.sweepHeavyArtifacts(base, {
			maxAgeMs: 7 * 24 * 60 * 60 * 1000,
			maxBytes: 0, // evict everything by cap
			activeGraceMs: 0,
			sweep: async (p) => {
				if (p === doomed) throw new Error("injected failure");
				removed.push(p);
				fs.rmSync(p, { recursive: true, force: true });
			},
		});
		assert.ok(removed.includes(b), "later entry still removed after earlier failure");
		assert.ok(existsSync(a), "failed entry left in place");
		assert.ok(!existsSync(b), "reclaimable entry removed");
		assert.ok(summary.capped >= 1);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
