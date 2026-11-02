// Issue #132: `aio-webpull max=5` on blog.rust-lang.org pulled the five OLDEST
// posts (2014) because discovery returned sitemap document order and the pull
// capped at `max` before ever reaching recent content.
//
// The root cause is concrete, not stylistic: `parseLocs` matched only `<loc>` and
// threw `<lastmod>` away. The recency information was in the response body and
// was discarded at the parse step, so no downstream ranking could have used it.
//
// Recurrence prevented: a sitemap-ordered pull whose budget lands entirely on the
// archive floor.

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseLocs, rankByRecency } = await import("../src/discovery.ts");

// Oldest-first, the shape rust-lang.org serves.
const OLD_FIRST = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://blog.rust-lang.org/2014/03/28/This-is-a-blog-post.html</loc><lastmod>2014-03-28</lastmod></url>
  <url><loc>https://blog.rust-lang.org/2016/01/01/Old.html</loc><lastmod>2016-01-01</lastmod></url>
  <url><loc>https://blog.rust-lang.org/2020/05/04/Mid.html</loc><lastmod>2020-05-04</lastmod></url>
  <url><loc>https://blog.rust-lang.org/2024/09/09/Newer.html</loc><lastmod>2024-09-09</lastmod></url>
  <url><loc>https://blog.rust-lang.org/2026/10/01/Newest.html</loc><lastmod>2026-10-01</lastmod></url>
</urlset>`;

test("#132: parseLocs keeps the lastmod the sitemap actually carries", () => {
	const entries = parseLocs(OLD_FIRST);
	assert.equal(entries.length, 5);
	// Shape changed from string[] to {loc,lastmod}[] — the information that was
	// being thrown away is now retained.
	assert.equal(
		entries[0].loc,
		"https://blog.rust-lang.org/2014/03/28/This-is-a-blog-post.html",
	);
	assert.equal(entries[0].lastmod, "2014-03-28");
});

test("#132: an oldest-first sitemap is ranked newest-first by lastmod", () => {
	const ordered = rankByRecency(parseLocs(OLD_FIRST)).map((e) => e.loc);
	assert.equal(ordered[0], "https://blog.rust-lang.org/2026/10/01/Newest.html");
	assert.equal(
		ordered[ordered.length - 1],
		"https://blog.rust-lang.org/2014/03/28/This-is-a-blog-post.html",
	);
	// The regression this pins: with a budget smaller than the discovered set,
	// the pull used to return the 2014 archive. A budget of 2 must now be the two
	// most recent posts.
	const budget2 = ordered.slice(0, 2);
	assert.deepEqual(budget2, [
		"https://blog.rust-lang.org/2026/10/01/Newest.html",
		"https://blog.rust-lang.org/2024/09/09/Newer.html",
	]);
	assert.ok(
		!budget2.some((u) => u.includes("2014")),
		`oldest post survived a budget of 2: ${budget2}`,
	);
});

test("#132: a sitemap with no lastmod at all keeps document order", () => {
	// Non-goal from the issue: no aggressive content-based recency detection.
	// A wrong "recency" guess is worse than an old page, so with no cheap signal
	// the order must be exactly what the site gave us.
	const xml = `<urlset>
  <url><loc>https://ex.com/a</loc></url>
  <url><loc>https://ex.com/b</loc></url>
  <url><loc>https://ex.com/c</loc></url>
</urlset>`;
	assert.deepEqual(rankByRecency(parseLocs(xml)).map((e) => e.loc), [
		"https://ex.com/a",
		"https://ex.com/b",
		"https://ex.com/c",
	]);
});

test("#132: URL date pattern is used when lastmod is absent", () => {
	// The issue's second cheap signal: conservative /YYYY/MM/ slugs.
	const xml = `<urlset>
  <url><loc>https://blog.ex.com/2015/03/hello</loc></url>
  <url><loc>https://blog.ex.com/2026/02/hello</loc></url>
  <url><loc>https://blog.ex.com/about</loc></url>
</urlset>`;
	const ordered = rankByRecency(parseLocs(xml)).map((e) => e.loc);
	assert.equal(ordered[0], "https://blog.ex.com/2026/02/hello");
	assert.equal(ordered[1], "https://blog.ex.com/2015/03/hello");
	// Undated pages keep their relative order and sit after the dated ones.
	assert.equal(ordered[2], "https://blog.ex.com/about");
});

test("#132: an unparseable lastmod does not outrank a real date", () => {
	// Sitemaps are untrusted input: "not-a-date", "0000-00-00" and epoch-zero
	// must not sort as if they were recent.
	//
	// Three dated entries so the sitemap IS date-structured (a strict majority);
	// otherwise the majority gate preserves document order and this test would
	// be measuring the gate rather than date validation.
	const xml = `<urlset>
  <url><loc>https://ex.com/junk</loc><lastmod>not-a-date</lastmod></url>
  <url><loc>https://ex.com/zero</loc><lastmod>0000-00-00</lastmod></url>
  <url><loc>https://ex.com/real1</loc><lastmod>2024-01-01</lastmod></url>
  <url><loc>https://ex.com/real2</loc><lastmod>2025-06-01</lastmod></url>
  <url><loc>https://ex.com/real3</loc><lastmod>2023-01-01</lastmod></url>
</urlset>`;
	const ordered = rankByRecency(parseLocs(xml)).map((e) => e.loc);
	assert.equal(ordered[0], "https://ex.com/real2", `a malformed stamp outranked real dates: ${ordered}`);
	// The two malformed stamps fall to the undated tail, in document order.
	assert.deepEqual(ordered.slice(-2), ["https://ex.com/junk", "https://ex.com/zero"]);
});

test("#132: an entry with no lastmod does not inherit its neighbour's date", () => {
	// This is why parseLocs matches per <url> BLOCK instead of two independent
	// global regexes. Zipping a loc list against a lastmod list would give the
	// undated page the previous entry's date and silently invent recency for it.
	const xml = `<urlset>
  <url><loc>https://ex.com/dated</loc><lastmod>2020-06-01</lastmod></url>
  <url><loc>https://ex.com/undated</loc></url>
</urlset>`;
	const entries = parseLocs(xml);
	assert.equal(entries[1].loc, "https://ex.com/undated");
	assert.equal(entries[1].lastmod, undefined);
	// And it must rank AFTER the dated page, not be treated as recent.
	assert.deepEqual(
		rankByRecency(entries).map((e) => e.loc),
		["https://ex.com/dated", "https://ex.com/undated"],
	);
});

test("#132: a malformed sitemap with no <url> wrappers still yields entries", () => {
	// The pre-#132 parser tolerated bare <loc> tags. Real-world malformed
	// sitemaps are still served today, so a ranking improvement must not become
	// a discovery regression.
	const xml = `<?xml version="1.0"?><urlset>
  <loc>https://ex.com/a</loc>
  <loc>https://ex.com/b</loc>
</urlset>`;
	assert.deepEqual(parseLocs(xml).map((e) => e.loc), ["https://ex.com/a", "https://ex.com/b"]);
	// Undated, so document order is preserved.
	assert.deepEqual(rankByRecency(parseLocs(xml)).map((e) => e.loc), [
		"https://ex.com/a",
		"https://ex.com/b",
	]);
});

// ─── Adversarial review round 1 (independent reviewer, PR #178) ───────

test("#132 review: lastmod alone must drive ordering when URLs carry no date slug", () => {
	// The fixture used by the "ranked newest-first by lastmod" test has
	// /YYYY/MM/ slugs, so the URL fallback reproduces the same order and the
	// test passes even with `lastmod` ignored — proven by mutation. This fixture
	// removes the slug signal so lastmod is the ONLY thing that can order it.
	const xml = `<urlset>
  <url><loc>https://ex.com/post-one</loc><lastmod>2019-04-02</lastmod></url>
  <url><loc>https://ex.com/post-two</loc><lastmod>2025-11-30</lastmod></url>
  <url><loc>https://ex.com/post-three</loc><lastmod>2021-07-19</lastmod></url>
</urlset>`;
	assert.deepEqual(
		rankByRecency(parseLocs(xml)).map((e) => e.loc),
		["https://ex.com/post-two", "https://ex.com/post-three", "https://ex.com/post-one"],
	);
});

test("#132 review: a mixed docs sitemap must not spend its whole budget on dated changelog posts", () => {
	// P1 regression: a docs site whose sitemap mixes a handful of dated
	// changelog entries with undated evergreen /api pages. Ranking dated-first
	// unconditionally makes a budget-2 pull spend everything on the changelog
	// and drop the reference pages, which master served in document order.
	// Rule: only re-order when the sitemap is actually date-structured, i.e. a
	// strict majority of entries carry a usable date. A blog is ~100% dated;
	// a docs site is not.
	const xml = `<urlset>
  <url><loc>https://docs.ex.com/api/auth</loc></url>
  <url><loc>https://docs.ex.com/changelog/2026-01</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://docs.ex.com/api/core</loc></url>
  <url><loc>https://docs.ex.com/changelog/2025-12</loc><lastmod>2025-12-01</lastmod></url>
</urlset>`;
	assert.deepEqual(
		rankByRecency(parseLocs(xml)).map((e) => e.loc),
		[
			"https://docs.ex.com/api/auth",
			"https://docs.ex.com/changelog/2026-01",
			"https://docs.ex.com/api/core",
			"https://docs.ex.com/changelog/2025-12",
		],
	);
});

test("#132 review: a wholly dated sitemap still reorders", () => {
	// Guards the majority rule from being "fixed" into never reordering,
	// which would leave issue #132 unfixed.
	const xml = `<urlset>
  <url><loc>https://blog.ex.com/old</loc><lastmod>2014-01-01</lastmod></url>
  <url><loc>https://blog.ex.com/new</loc><lastmod>2026-01-01</lastmod></url>
</urlset>`;
	assert.deepEqual(
		rankByRecency(parseLocs(xml)).map((e) => e.loc),
		["https://blog.ex.com/new", "https://blog.ex.com/old"],
	);
});

test("#132 review: bare <loc> entries are kept alongside wrapped ones", () => {
	// P1: `if (out.length > 0) return out` meant the loose fallback only ran
	// when NOTHING wrapped parsed, so a sitemap mixing both silently dropped
	// every bare entry — the opposite of the tolerance the fallback claims.
	const xml = `<urlset><url><loc>https://x/dated</loc><lastmod>2024-01-01</lastmod></url><loc>https://x/bare</loc></urlset>`;
	assert.deepEqual(parseLocs(xml).map((e) => e.loc), ["https://x/dated", "https://x/bare"]);
});

test("#132 review: two <loc> in one <url> block keeps both", () => {
	// P2: the old parser matched every <loc>; the per-block version kept only
	// the first, so malformed multi-loc input silently lost a page.
	const xml = `<urlset><url><loc>https://x/a</loc><loc>https://x/b</loc><lastmod>2024-01-01</lastmod></url></urlset>`;
	assert.deepEqual(parseLocs(xml).map((e) => e.loc), ["https://x/a", "https://x/b"]);
});

test("#132 review: a calendar-impossible lastmod is treated as absent", () => {
	// P2: Date.UTC normalizes 2024-02-31 to a March date, so a bogus stamp could
	// outrank a genuine 2024-03-01. The "untrusted input" premise requires
	// rejecting a date that does not exist on a calendar.
	const xml = `<urlset>
  <url><loc>https://x/real</loc><lastmod>2024-03-01</lastmod></url>
  <url><loc>https://x/bad</loc><lastmod>2024-02-31</lastmod></url>
</urlset>`;
	const entries = parseLocs(xml);
	assert.equal(entries[1].lastmod, "2024-02-31", "parse keeps the raw stamp");
	const ordered = rankByRecency(entries).map((e) => e.loc);
	assert.equal(ordered[0], "https://x/real", `impossible date outranked a real one: ${ordered}`);
});

// ─── CodeRabbit round 1 on PR #178 (4 findings, all real) ─────────────

test("#132 cr1: bare <loc> BEFORE a wrapped one keeps document order", () => {
	// The additive fix appended bare entries after wrapped ones, so a sitemap
	// that lists a bare <loc> first no longer round-trips its own order — and
	// when the majority gate preserves input order, a small budget picks the
	// wrong page.
	const xml = `<urlset><loc>https://x/first</loc><url><loc>https://x/second</loc><lastmod>2024-01-01</lastmod></url></urlset>`;
	assert.deepEqual(parseLocs(xml).map((e) => e.loc), ["https://x/first", "https://x/second"]);
});

test("#132 cr1: wrapped spans lookup stays linear on a large sitemap", () => {
	// `wrapped.some(...)` restarted a scan per bare <loc>, which is O(bare x
	// wrapped). With 50k wrapped entries that is billions of comparisons before
	// any cap runs. Time-boxed so a quadratic regression fails rather than hangs.
	// Measured on the quadratic version: 20k -> 237ms, 40k -> 758ms,
	// 80k -> 3263ms. A 20k fixture sat just below the knee and passed, so the
	// threshold has to sit above it to actually catch the regression.
	const n = 60000;
	const parts = [];
	for (let i = 0; i < n; i++) parts.push(`<url><loc>https://x/${i}</loc></url>`);
	const xml = `<urlset>${parts.join("")}<loc>https://x/bare</loc></urlset>`;
	const t0 = Date.now();
	const entries = parseLocs(xml);
	const ms = Date.now() - t0;
	assert.equal(entries.length, n + 1);
	assert.equal(entries[entries.length - 1].loc, "https://x/bare");
	assert.ok(ms < 1200, `parseLocs took ${ms}ms on ${n} wrapped entries — quadratic scan`);
});

test("#132 cr1: ranking happens before the MAX_SITEMAP_URLS cap, not after", async () => {
	// The cap predates this PR, but ranking only the survivors means a sitemap
	// larger than the cap loses its newest pages before rankByRecency ever sees
	// them — the same bug class as #132, one level up.
	const { capRanked, MAX_SITEMAP_URLS } = await import("../src/discovery.ts");
	const total = MAX_SITEMAP_URLS + 50;
	const entries = [];
	for (let i = 0; i < total; i++) {
		// Oldest first, so a cap-before-rank keeps only ancient pages.
		const y = 1990 + Math.floor(i / 12);
		const mo = String((i % 12) + 1).padStart(2, "0");
		entries.push({ loc: `https://x/p/${i}`, lastmod: `${y}-${mo}-01` });
	}
	const capped = capRanked(entries);
	assert.equal(capped.length, MAX_SITEMAP_URLS);
	// The single newest entry must survive the cap.
	assert.ok(
		capped.some((e) => e.loc === `https://x/p/${total - 1}`),
		"newest page was cut by the cap before ranking could promote it",
	);
});

test("#132 cr1: two strategies of equal length are chosen by recency, not by arrival order", async () => {
	// `discover` kept the FIRST candidate on a length tie, so an earlier
	// strategy serving max old pages beat a later one serving max newer pages.
	const { newestRecency } = await import("../src/discovery.ts");
	const oldPages = [
		{ loc: "https://x/a", lastmod: "2001-01-01" },
		{ loc: "https://x/b", lastmod: "2002-01-01" },
	];
	const newPages = [
		{ loc: "https://x/c", lastmod: "2026-05-05" },
		{ loc: "https://x/d", lastmod: "2019-01-01" },
	];
	assert.ok(newestRecency(newPages) > newestRecency(oldPages));
	assert.equal(newestRecency([{ loc: "https://x/undated" }]), undefined);
});

// ─── CodeRabbit round 2 on PR #178 ────────────────────────────────────
// Both findings are one root cause: recency was computed over the RAW sitemap
// entries while eligibility (host/scope/IGNORED) and the `max` cap are applied
// afterwards. So the majority gate could see hundreds of out-of-scope undated
// entries and refuse to reorder a scoped set that was entirely dated.

test("#132 cr2: the majority gate evaluates the SCOPED entries, not the whole sitemap", async () => {
	const { selectRankedEntries } = await import("../src/discovery.ts");
	const entries = [];
	// 30 out-of-scope undated entries on another host. These are what broke the
	// global gate: counted in the majority, they made a wholly dated scoped set
	// look "not date-structured" and left it un-reordered.
	for (let i = 0; i < 30; i++) entries.push({ loc: `https://other.example/x/${i}` });
	// The scoped set: 2 undated + 5 dated = a strict MAJORITY dated, so this is a
	// date-structured sitemap even though the raw file is not.
	entries.push({ loc: "https://d.example/docs/intro" });
	entries.push({ loc: "https://d.example/docs/faq" });
	for (const [name, year] of [
		["a", 2015],
		["e", 2018],
		["c", 2020],
		["d", 2023],
		["b", 2026],
	]) {
		entries.push({ loc: `https://d.example/docs/${name}`, lastmod: `${year}-01-01` });
	}

	const picked = selectRankedEntries(
		entries,
		new Set(["d.example"]),
		"/docs/",
		3,
	).map((e) => e.loc);
	// Newest first among the scoped entries; the two undated ones fall behind.
	assert.deepEqual(picked, [
		"https://d.example/docs/b",
		"https://d.example/docs/d",
		"https://d.example/docs/c",
	]);
});

test("#132 cr2: strategy recency comes from the SELECTED entries", async () => {
	const { selectRankedEntries, newestRecency } = await import("../src/discovery.ts");
	const entries = [
		// Out of scope, and much newer — must not be able to win a tie.
		{ loc: "https://other.example/2099", lastmod: "2099-01-01" },
		{ loc: "https://d.example/docs/old", lastmod: "2001-01-01" },
		{ loc: "https://d.example/docs/newer", lastmod: "2020-01-01" },
	];
	const picked = selectRankedEntries(entries, new Set(["d.example"]), "/docs/", 5);
	assert.deepEqual(picked.map((e) => e.loc), [
		"https://d.example/docs/newer",
		"https://d.example/docs/old",
	]);
	// The excluded 2099 page must not leak into the tie-break score.
	const newest = newestRecency(picked);
	assert.ok(newest < Date.UTC(2099, 0, 1), "an out-of-scope page drove the tie-break");
});

test("#132 cr2: dedupe by pathname still keeps only the first variant", async () => {
	const { selectRankedEntries } = await import("../src/discovery.ts");
	const entries = [
		{ loc: "https://d.example/docs/a?utm=1", lastmod: "2026-01-01" },
		{ loc: "https://d.example/docs/a#frag", lastmod: "2026-01-01" },
		{ loc: "https://d.example/docs/b", lastmod: "2024-01-01" },
	];
	const picked = selectRankedEntries(entries, new Set(["d.example"]), "/docs/", 5);
	assert.deepEqual(picked.map((e) => e.loc), [
		"https://d.example/docs/a?utm=1",
		"https://d.example/docs/b",
	]);
});

// ─── CodeRabbit round 3 on PR #178 ────────────────────────────────────

test("#132 cr3: a disallowed entry cannot suppress the eligible one it shares a pathname with", async () => {
	// Matching the filtered result back by pathname alone picks whichever entry
	// appears FIRST with that pathname — here an out-of-host entry, which then
	// goes out as a real result while the in-scope page is suppressed.
	const { selectRankedEntries } = await import("../src/discovery.ts");
	const entries = [
		{ loc: "https://evil.example/docs/a", lastmod: "2026-01-01" },
		{ loc: "https://d.example/docs/a", lastmod: "2025-01-01" },
		{ loc: "https://d.example/docs/b", lastmod: "2024-01-01" },
	];
	const picked = selectRankedEntries(entries, new Set(["d.example"]), "/docs/", 5);
	assert.deepEqual(picked.map((e) => e.loc), [
		"https://d.example/docs/a",
		"https://d.example/docs/b",
	]);
});

test("#132 cr3: the tie-break scores only pages that survive seed insertion", async () => {
	// includeSeed can insert the requested page and drop the last picked one.
	// Scoring `picked` rather than what survived let a strategy win a tie on a
	// page it is not actually going to serve.
	const { newestRecencyForUrls, newestRecency } = await import("../src/discovery.ts");
	const entries = [
		{ loc: "https://d.example/a", lastmod: "2020-01-01" },
		{ loc: "https://d.example/b", lastmod: "2026-01-01" },
	];
	// Candidate only contains /a (b was dropped to make room for the seed).
	const candidate = ["https://d.example/a"];
	const scored = newestRecencyForUrls(candidate, entries);
	assert.equal(scored, Date.UTC(2020, 0, 1));
	assert.notEqual(scored, newestRecency(entries), "score must come from surviving pages");
});
