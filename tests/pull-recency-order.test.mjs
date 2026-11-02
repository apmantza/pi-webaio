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
