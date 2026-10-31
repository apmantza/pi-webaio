// ─── Yahoo titles + cross-engine dedup key (issue #165, F1) ───
//
// On the current Yahoo SERP the `<li>`'s first `<a>` wraps the WHOLE citation
// block — favicon, site span, breadcrumb URL, then `<h3 class="title">`. Reading
// `a.textContent` therefore produced, for every Yahoo result:
//
//   "zustand.sitehttps://zustand.site › en › docsPersist Middleware - Zustand - …"
//
// Polluted titles defeat the title-overlap matching in
// `dropGoogleRedirectDuplicates`, mislead `classifySourceType`'s title
// heuristics, and waste tokens on every search Yahoo contributes to.
//
// Second half: `canonicalizeUrl` is documented as "only ever a dedup key", but
// it keyed on `u.host`, so `www.foo.com/a` (DDG) and `foo.com/a` (Brave) were
// two buckets — cross-engine corroboration was diluted for the single most
// common spelling difference between engines.
//
// Recurrence prevented: Yahoo results arriving with the citation block glued to
// the title, and a page found by two engines scoring as two separate findings.
import assert from "node:assert";
import test from "node:test";
import { parseYahooResults, canonicalizeUrl, buildResultBuckets } from "../src/search.ts";

// Shape captured from the live SERP (2026-10-31, query "zustand persist
// middleware migrate version"). Real anchor textContent was:
//   "zustand.sitehttps://zustand.site › en › docsPersist Middleware - Zustand - …"
// and every organic result carried the clean title in `h3.title`. The href form
// is Yahoo's own `/RU=<encoded>/RK=2/RS=…` path encoding (no query string).
const SERP = `
<div id="web"><ol class="vi01Th">
  <li class="dd algo wa-Pr">
    <div class="ca">
      <div class="c-20q">
        <div class="c-title">
          <a class="d-20q" href="https://r.search.yahoo.com/_ylt=Awr;_ylu=Y29sbw/RV=2/RE=1794661149/RO=10/RU=https%3a%2f%2fzustand.site%2fen%2fdocs%2f/RK=2/RS=Wm6KnQaRsUFTm5-">
            <div class="thumb"><img src="/favicon.ico" alt="" width="32" height="32"/></div>
            <div class="meta">
              <div class="title"><span class="title">zustand.site</span></div>
              <div class="url">https://zustand.site › en › docs</div>
            </div>
            <h3 class="title"><span>Persist Middleware - Zustand - Simple and Scalable State</span></h3>
          </a>
        </div>
        <div class="c-paragraph">The persist middleware helps you store changes in your Zustand store.</div>
      </div>
    </div>
  </li>
  <li class="dd algo wa-Pr">
    <div class="ca">
      <div class="c-title">
        <a href="https://r.search.yahoo.com/_ylt=Q1/RV=2/RE=1/RO=10/RU=https%3a%2f%2fgithub.com%2fpmndrs%2fzustand/RK=2/RS=Edk_">
          <div class="meta">
            <div class="title"><span class="title">github.com</span></div>
            <div class="url">https://github.com › pmndrs › zustand</div>
          </div>
          <h3 class="title"><span>pmndrs/zustand: Bear hooks for state</span></h3>
        </a>
        <div class="c-paragraph">A small, fast and scalable bearbones state management.</div>
      </div>
    </div>
  </li>
</ol></div>`;

test("F1: Yahoo titles are the h3.title text, not the whole citation block", () => {
	const results = parseYahooResults(SERP);
	assert.equal(results.length, 2, `expected 2 results, got ${results.length}`);

	const titles = results.map((r) => r.title);
	assert.deepEqual(titles, [
		"Persist Middleware - Zustand - Simple and Scalable State",
		"pmndrs/zustand: Bear hooks for state",
	]);

	// The exact defect shapes, asserted positively so a layout drift fails loudly.
	for (const t of titles) {
		assert.ok(!t.includes("›"), `breadcrumb URL leaked into the title: ${t}`);
		assert.ok(!/zustand\.sitehttps|github\.comhttps/.test(t), `citation glued to title: ${t}`);
		assert.ok(!t.startsWith("zustand.site"), `site name prefixed the title: ${t}`);
	}
});

test("F1: the Yahoo /RU= path redirect is still resolved", () => {
	const results = parseYahooResults(SERP);
	assert.equal(results[0].url, "https://zustand.site/en/docs/");
	assert.equal(results[1].url, "https://github.com/pmndrs/zustand");
});

test("F1: a SERP without h3.title still yields a title (no regression)", () => {
	// Older / alternate Yahoo markup: the anchor text IS the title.
	const html = `<div id="web"><ol><li>
		<a href="https://r.search.yahoo.com/X/RV=2/RU=https%3a%2f%2fexample.com%2fpage/RK=2/RS=Z/">
			Plain legacy title
		</a>
		<div class="c-paragraph">Snippet.</div>
	</li></ol></div>`;
	const results = parseYahooResults(html);
	assert.equal(results.length, 1);
	assert.equal(results[0].title, "Plain legacy title");
	assert.equal(results[0].url, "https://example.com/page");
});

// ─── Dedup key: the www spelling must not split a bucket ───

test("F1: www and apex spellings share one canonical key", () => {
	assert.equal(
		canonicalizeUrl("https://www.react.dev/reference/react"),
		canonicalizeUrl("https://react.dev/reference/react"),
	);
	assert.equal(
		canonicalizeUrl("http://WWW.Example.COM/a/"),
		canonicalizeUrl("http://example.com/a"),
	);
});

test("F1: the www collapse is a KEY change only — display URL is untouched", () => {
	const buckets = buildResultBuckets(
		[
			{ title: "Docs", url: "https://www.react.dev/a", snippet: "s", domain: "www.react.dev" },
			{ title: "Docs", url: "https://react.dev/a", snippet: "s", domain: "react.dev" },
		],
		"brave",
	);
	assert.equal(buckets.size, 1, "the two spellings should corroborate into one bucket");
	const bucket = [...buckets.values()][0];
	assert.equal(bucket.length, 2);
	// Display/fetch must keep the original spellings, per the canonicalizer's contract.
	assert.deepEqual(
		bucket.map((e) => e.result.url).sort(),
		["https://react.dev/a", "https://www.react.dev/a"],
	);
});

test("F1: only the literal www label collapses — subdomains stay distinct", () => {
	// `docs.example.com` and `example.com` are genuinely different pages and must
	// stay in separate buckets.
	assert.notEqual(
		canonicalizeUrl("https://docs.example.com/a"),
		canonicalizeUrl("https://example.com/a"),
	);
	// `www.` is a label, not a host, so it strips at any depth — that is the same
	// rule, applied consistently, and it is what the assertion used to get wrong.
	assert.equal(
		canonicalizeUrl("https://www.sub.example.com/a"),
		canonicalizeUrl("https://sub.example.com/a"),
	);
	// A host that merely CONTAINS "www." is untouched.
	assert.notEqual(
		canonicalizeUrl("https://notwww.example.com/a"),
		canonicalizeUrl("https://example.com/a"),
	);
});

test("F1: a bare www host keeps a usable key", () => {
	assert.equal(
		canonicalizeUrl("https://www.example.com/"),
		canonicalizeUrl("https://example.com/"),
	);
});
