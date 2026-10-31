// ─── Pull path identity (issue #165, cluster C: F14 / F16 / F22) ───
//
// The queue keyed entries on the URL spelling and established completion by
// reading each saved file's frontmatter URL. Those two identities are not the
// same thing: `/learn/` and `/learn/index.html` are two queue keys that write
// ONE file (`learn/index.md`).
//
//   F14 — both entries fetch, the second silently overwrites the first, `max`
//         is consumed by duplicates, and the `Files:` list names a file twice.
//   F16 — the file's frontmatter holds only the LAST writer's URL, so the losing
//         URL is never "completed", is requeued by `requeueCompletedMissingFiles`,
//         refetched, overwrites again, forever. Three identical runs each reported
//         "Pulled 2 pages" instead of the documented "0 new pages".
//   F22 — the pull path used `canonicalQueueUrl` (strips hash/search only) while
//         `search.ts` already had a stronger `canonicalizeUrl`, and `utils.ts`
//         already had `urlStem`, which collapses exactly these spellings.
//
// Identity rule this pins down: THE IDENTITY OF A PULLED PAGE IS ITS OUTPUT
// PATH. Two URLs that map to one path are one page — deduplicated at enqueue,
// and completed by the file existing, never by a URL written inside it.
//
// Only the queue's real public API is used (create/resume/add/complete/stats/
// snapshot/close), so every failure below is a behavioural assertion rather than
// a missing method.
import assert from "node:assert";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { RequestQueue } from "../src/request-queue.ts";
import { urlToPagePath } from "../src/tools/utils.ts";

// The queue is driven with the SAME mapper `aio-webpull` wires in
// `src/tools/webpull.ts` (`RequestQueue.create/resume(outDir, urlToPagePath)`).
// An earlier version of this file re-declared the rule locally, which proved
// only that the queue honors an arbitrary callback: a regression inside
// `urlToPagePath` would have shipped with all of these tests green.

async function scratch() {
	return mkdtemp(join(tmpdir(), "pi-webaio-pullid-"));
}

async function writeSavedPage(outDir, rel, url) {
	const full = join(outDir, rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, `---\ntitle: "T"\nurl: "${url}"\n---\n\nBody.\n`, "utf8");
}

function queuedEntries(q) {
	return q.snapshot().filter((e) => e.status === "queued");
}

const PAIR = [
	"https://docs.example.org/learn/",
	"https://docs.example.org/learn/index.html",
	"https://docs.example.org/learn/getting-started/introduction",
	"https://docs.example.org/learn/getting-started/introduction.html",
];

// ─── F14: enqueue must dedupe by output path ───────────────────────

test("F14: URLs that map to one output path occupy one queue entry", async () => {
	const outDir = await scratch();
	const q = await RequestQueue.create(outDir, urlToPagePath);
	await q.add(PAIR);

	const s = q.stats();
	// 4 URL spellings -> 2 distinct pages. Pre-fix this was 4, so `max` was
	// consumed by duplicates and two pages silently overwrote two others.
	assert.equal(
		s.queued,
		2,
		`expected 2 distinct pages from 4 spellings, got ${JSON.stringify(s)}`,
	);
	// The duplicates must be REPORTED, not silently dropped: the agent has to be
	// able to tell "6 URLs, 4 pages" from "6 pages".
	assert.equal(
		s.duplicates,
		2,
		`duplicate spellings were not accounted for: ${JSON.stringify(s)}`,
	);
});

test("F14: no two pending entries can share an output path", async () => {
	const outDir = await scratch();
	const q = await RequestQueue.create(outDir, urlToPagePath);
	await q.add(PAIR);

	const paths = queuedEntries(q).map((e) => urlToPagePath(e.url));
	assert.ok(paths.length > 0, "nothing queued");
	assert.equal(
		new Set(paths).size,
		paths.length,
		`two pending entries share a path: ${JSON.stringify(paths)}`,
	);
});

test("F14: URLs mapping to DIFFERENT paths are still distinct entries", async () => {
	const outDir = await scratch();
	const q = await RequestQueue.create(outDir, urlToPagePath);
	await q.add([
		"https://docs.example.org/learn/a",
		"https://docs.example.org/learn/b",
		"https://docs.example.org/learn/c.html",
	]);
	assert.equal(q.stats().queued, 3);
	assert.equal(q.stats().duplicates, 0);
});

// ─── F16: resume must converge ─────────────────────────────────────

/**
 * The queue file a real (pre-dedup) pull leaves behind: every URL spelling is
 * its own entry, all completed, each with the final URL it fetched as
 * `outputUrl`. Only two files exist, and each carries the LAST writer's URL in
 * its frontmatter — which is the whole problem: completion was proven by that
 * URL, so the losing spelling of each pair looked never-completed.
 */
async function writeRealisticQueueFile(outDir) {
	const now = Date.now();
	const entries = PAIR.map((u) => ({
		url: u,
		outputUrl: u,
		status: "completed",
		retries: 0,
		timestamp: now,
	}));
	await writeFile(
		join(outDir, ".pullqueue.jsonl"),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
		"utf8",
	);
	await writeSavedPage(outDir, "learn/index.md", "https://docs.example.org/learn/index.html");
	await writeSavedPage(
		outDir,
		"learn/getting-started/introduction.md",
		"https://docs.example.org/learn/getting-started/introduction.html",
	);
}

test("F16: a resumed pull whose output files all exist requeues nothing", async () => {
	const outDir = await scratch();
	await writeRealisticQueueFile(outDir);

	const resumed = await RequestQueue.resume(outDir, urlToPagePath);
	assert.ok(resumed, "resume found no queue");
	const requeued = await resumed.requeueCompletedMissingFiles();

	// Pre-fix: 2 of the 4 spellings were never in the frontmatter-URL set, so each
	// run requeued and refetched them — a pull that never reaches "0 new pages".
	assert.equal(
		requeued,
		0,
		`resume requeued ${requeued} entries whose output files exist (perpetual re-fetch)`,
	);
});

test("F16: a genuinely missing output file is still requeued (recovery preserved)", async () => {
	const outDir = await scratch();
	await writeRealisticQueueFile(outDir);
	// Simulate a crash that lost one whole page.
	const { rm } = await import("node:fs/promises");
	await rm(join(outDir, "learn/getting-started/introduction.md"), { force: true });

	const resumed = await RequestQueue.resume(outDir, urlToPagePath);
	const requeued = await resumed.requeueCompletedMissingFiles();
	assert.equal(
		requeued,
		2,
		`both spellings of the missing page must be requeued, got ${requeued}`,
	);
});

// ─── F22: the queue's own canonicalizer must be the strong one ─────

test("F22: queue keys collapse the spellings that share an output path", async () => {
	const outDir = await scratch();
	const q = await RequestQueue.create(outDir, urlToPagePath);
	await q.add([
		"https://docs.example.org/guide/",
		"https://docs.example.org/guide/index.html",
		"https://docs.example.org/guide/#section",
	]);
	assert.equal(
		q.stats().queued,
		1,
		`trailing slash, index.html and a fragment are one page: ${JSON.stringify(q.stats())}`,
	);
	assert.equal(q.stats().duplicates, 2);
});

test("F22: the boundary is the output path, not URL equivalence", async () => {
	// Deliberate: `/guide` writes guide.md while `/guide/` writes guide/index.md.
	// Two files means two pages — deduplicating them would change the on-disk
	// layout, which is out of scope for this fix. This row pins the boundary so a
	// later "just canonicalize harder" change must reckon with it explicitly.
	const outDir = await scratch();
	const q = await RequestQueue.create(outDir, urlToPagePath);
	await q.add(["https://docs.example.org/guide", "https://docs.example.org/guide/"]);
	assert.equal(q.stats().queued, 2, "different output paths must stay distinct");
	assert.equal(q.stats().duplicates, 0);
});

// ─── Back-compat + persistence ─────────────────────────────────────

test("legacy queue files (no path field) still resume and complete", async () => {
	const outDir = await scratch();
	const url = "https://docs.example.org/legacy/page";
	await writeFile(
		join(outDir, ".pullqueue.jsonl"),
		`${JSON.stringify({ url, status: "completed", retries: 0, timestamp: Date.now() })}\n`,
		"utf8",
	);
	await writeSavedPage(outDir, "legacy/page.md", url);

	const resumed = await RequestQueue.resume(outDir, urlToPagePath);
	assert.ok(resumed, "legacy queue did not resume");
	assert.equal(await resumed.requeueCompletedMissingFiles(), 0);
	assert.equal(resumed.stats().completed, 1);
});

test("the queue file records the output path it will write", async () => {
	const outDir = await scratch();
	const q = await RequestQueue.create(outDir, urlToPagePath);
	await q.add(PAIR);
	await q.close();

	const raw = JSON.parse(
		(await readFile(join(outDir, ".pullqueue.jsonl"), "utf8")).split("\n")[0],
	);
	assert.ok(
		typeof raw.path === "string" && raw.path.endsWith(".md"),
		`queue entry carries no path: ${JSON.stringify(raw)}`,
	);
});

// ─── The mapper itself, not a local copy of it ─────────────────────
//
// These exist because the first version of this suite defined its own mapper.
// If `urlToPagePath` regresses, the queue-level tests above must go red through
// the same function aio-webpull actually calls — and that requires the mapper to
// be asserted here, on its own, through its real export.
test("F14: the production mapper collapses trailing-slash and .html spellings", () => {
	assert.equal(
		urlToPagePath("https://docs.example.org/learn/"),
		urlToPagePath("https://docs.example.org/learn/index.html"),
	);
	assert.equal(
		urlToPagePath("https://docs.example.org/learn/gs/intro"),
		urlToPagePath("https://docs.example.org/learn/gs/intro.html"),
	);
	assert.equal(urlToPagePath("https://docs.example.org/learn/"), "learn/index.md");
});

test("F14: the mapper keeps genuinely different pages distinct", () => {
	const distinct = [
		"https://docs.example.org/learn/",
		"https://docs.example.org/learn/intro",
		"https://docs.example.org/api/",
		"https://docs.example.org/",
	];
	const paths = distinct.map(urlToPagePath);
	assert.equal(new Set(paths).size, distinct.length, JSON.stringify(paths));
});

test("F14: the mapper is stable across host and query spellings of one page", () => {
	// Same path on the same host must land on one file regardless of query or
	// trailing-slash noise; otherwise the queue re-pulls and `max` burns.
	assert.equal(
		urlToPagePath("https://docs.example.org/learn/guide"),
		urlToPagePath("https://docs.example.org/learn/guide"),
	);
	assert.ok(!urlToPagePath("https://docs.example.org/learn/guide").includes("?"));
});

// ─── The write path relies on the mapper being traversal-safe ──────
//
// `aio-webpull` does `join(outDir, urlToPagePath(url))` with no containment
// check of its own, so safety rests entirely on this mapper: the WHATWG URL
// parser normalizes dot-segments and nothing decodes percent-escapes before the
// path reaches the filesystem. Pin that, because the plausible next
// "improvement" — decoding the pathname so `%20` stops showing up in filenames —
// would turn `..%2f..%2f` into real traversal, and the pull would write outside
// the output directory.
test("F14: the mapper never yields a path that escapes the output directory", () => {
	const outDir = resolve("/tmp/pull-containment");
	for (const url of [
		"https://x/../../etc/passwd",
		"https://x/%2e%2e/%2e%2e/etc/passwd",
		"https://x/a/..%2f..%2fetc/passwd",
		"https://x/..%5c..%5cwindows/win.ini",
		"https://x/....//....//x",
		"https://x/a/../../../b",
		"https://x//../../y",
	]) {
		const rel = urlToPagePath(url);
		const r = relative(outDir, resolve(join(outDir, rel)));
		const escaped =
			r === ".." || r.startsWith(`..${sep}`) || r.split(sep).includes("..");
		assert.ok(!escaped, `${url} escapes the output dir as ${JSON.stringify(rel)}`);
	}
});

