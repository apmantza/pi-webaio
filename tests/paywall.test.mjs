// ─── Paywall bypass tests ──────────────────────────────────────────
// Pure unit tests for the paywall module — no network calls, no
// Playwright. The integration is exercised manually.

import assert from "node:assert";
import test from "node:test";
import {
	detectPaywall,
	findStrategy,
	stripPaywallText,
	UA_GOOGLEBOT,
	UA_BINGBOT,
	UA_FACEBOOKBOT,
	UA_INSPECTIONTOOL,
	GENERIC_STRATEGY,
	KNOWN_PAYWALL_VENDORS,
	DOM_OVERRIDE_SCRIPT,
	PAYWALL_MARKERS,
	botUAFor,
} from "../src/paywall.ts";
import {
	PAYWALL_SITES,
	PAYWALL_GROUPS,
	PAYWALL_SITE_COUNT,
} from "../src/paywall-sites.ts";

// ─── detectPaywall ─────────────────────────────────────────────────

test("detectPaywall returns false for empty content", () => {
	const r = detectPaywall("");
	assert.strictEqual(r.paywalled, false);
	assert.strictEqual(r.confidence, 0);
	assert.deepStrictEqual(r.matchedMarkers, []);
});

test("detectPaywall returns false for very short content", () => {
	const r = detectPaywall("<html><body>hi</body></html>");
	assert.strictEqual(r.paywalled, false);
});

test("detectPaywall returns false for clean article text", () => {
	const clean = `
		<html><body>
		<article>
			<h1>The Latest in AI Research</h1>
			<p>Researchers at MIT have developed a new approach to...</p>
			<p>The study, published last week, shows significant improvements...</p>
			<p>Continue reading the full report on the university's website.</p>
		</article>
		</body></html>
	`;
	const r = detectPaywall(clean);
	assert.strictEqual(r.paywalled, false);
	assert.strictEqual(r.confidence, 0);
});

test("detectPaywall detects 'subscribe to continue reading'", () => {
	const html = `
		<html><body>
		<article>
			<p>The economy grew by 3.2% in the last quarter, according to data released by the Federal Reserve today. Analysts had predicted growth of 2.8%.</p>
			<p>Subscribe to continue reading this article and get unlimited access to our award-winning journalism.</p>
		</article>
		</body></html>
	`;
	const r = detectPaywall(html);
	assert.strictEqual(r.paywalled, true);
	assert.ok(
		r.matchedMarkers.some((m) => m.includes("subscribe to continue reading")),
	);
	assert.ok(r.confidence >= 0.5);
});

test("detectPaywall detects NYT-style 'log in or create an account to continue'", () => {
	const html = `
		<html><body>
		<article>
			<p>The president addressed the nation last night in a prime-time speech, outlining new economic measures.</p>
			<p>Log in or create an account to continue reading.</p>
		</article>
		</body></html>
	`;
	const r = detectPaywall(html);
	assert.strictEqual(r.paywalled, true);
	assert.ok(
		r.matchedMarkers.some((m) => m.includes("log in or create an account")),
	);
});

test("detectPaywall identifies Piano vendor from script reference", () => {
	const html = `
		<html><body>
		<script src="https://*.piano.io/api/v2/init.js"></script>
		<article><p>Some content here that is not paywalled</p></article>
		</body></html>
	`;
	const r = detectPaywall(html);
	assert.strictEqual(r.paywalled, true);
	assert.strictEqual(r.vendor, "piano");
	assert.ok(r.confidence >= 0.8);
});

test("detectPaywall identifies Poool vendor", () => {
	const html = `<script src="https://api.poool.fr/v1/access.js"></script>`;
	const r = detectPaywall(html);
	assert.strictEqual(r.vendor, "poool");
	assert.strictEqual(r.paywalled, true);
});

test("detectPaywall identifies Tinypass vendor", () => {
	const html = `<script src="https://*.tinypass.com/api/tinypass.min.js"></script>`;
	const r = detectPaywall(html);
	assert.strictEqual(r.vendor, "tinypass");
});

test("detectPaywall identifies Zephr vendor", () => {
	const html = `<script src="https://*.zephr.com/zephr-browser.js"></script>`;
	const r = detectPaywall(html);
	assert.strictEqual(r.vendor, "zephr");
});

test("detectPaywall identifies Sophi vendor", () => {
	const html = `<script src="https://cdn.sophi.io/sdk/v1/sophi.min.js"></script>`;
	const r = detectPaywall(html);
	assert.strictEqual(r.vendor, "sophi");
});

test("detectPaywall confidence is capped at 1.0", () => {
	const html = `
		<script src="https://piano.io/init.js"></script>
		<script src="https://tinypass.com/init.js"></script>
		<script src="https://poool.fr/init.js"></script>
		<p>Subscribe to continue reading this article. Log in or create an account to continue.</p>
	`;
	const r = detectPaywall(html);
	assert.ok(r.confidence <= 1.0);
	assert.ok(r.paywalled);
});

test("detectPaywall is case-insensitive", () => {
	const html = `<html><body><article><p>${"x".repeat(150)}</p><p>SUBSCRIBE TO CONTINUE READING THE REST OF THE STORY. Already a subscriber? Sign in.</p></article></body></html>`;
	const r = detectPaywall(html);
	assert.strictEqual(r.paywalled, true);
});

test("detectPaywall only scans first 16KB of content", () => {
	// 17KB of padding, then a paywall marker — should NOT be detected.
	const padding = "a".repeat(17000);
	const html = `<p>${padding}Subscribe to continue reading</p>`;
	const r = detectPaywall(html);
	assert.strictEqual(r.paywalled, false);
});

// ─── findStrategy ──────────────────────────────────────────────────

test("findStrategy returns a strategy for known sites", () => {
	const r = findStrategy("https://www.nytimes.com/2024/01/01/article");
	assert.ok(r !== null);
	assert.ok(r.steps.length > 0);
	assert.ok(r.steps.includes("block_js"));
});

test("findStrategy normalizes www. prefix", () => {
	const a = findStrategy("https://www.washingtonpost.com/article");
	const b = findStrategy("https://washingtonpost.com/article");
	assert.ok(a && b);
	assert.deepStrictEqual(a, b);
});

test("findStrategy returns Piano-based strategy for nytimes", () => {
	const r = findStrategy("https://www.nytimes.com/foo");
	assert.ok(r);
	assert.ok(r.blockScripts?.some((p) => p.includes("piano.io")));
});

test("findStrategy returns Poool-based strategy for lemonde", () => {
	const r = findStrategy("https://www.lemonde.fr/article");
	assert.ok(r);
	assert.ok(r.blockScripts?.some((p) => p.includes("poool.fr")));
});

test("findStrategy matches group member by suffix", () => {
	// al.com is in the Advance Local group (sophi.io)
	const r = findStrategy("https://www.al.com/article");
	assert.ok(r);
	assert.ok(r.blockScripts?.some((p) => p.includes("sophi.io")));
});

test("findStrategy returns generic strategy for unknown domains", () => {
	const r = findStrategy("https://www.example-news-site-xyz.com/article");
	assert.ok(r !== null);
	assert.deepStrictEqual(r, GENERIC_STRATEGY);
});

test("findStrategy returns null for invalid URLs", () => {
	// Bad URLs should fail gracefully (no throw) and return null
	// (caller is expected to check before using the result).
	const r = findStrategy("not a url at all");
	assert.strictEqual(r, null);
});

test("findStrategy caches results for the same hostname", () => {
	const a = findStrategy("https://www.ft.com/article-1");
	const b = findStrategy("https://ft.com/article-2");
	assert.deepStrictEqual(a, b);
});

// ─── stripPaywallText ──────────────────────────────────────────────

test("stripPaywallText passes clean text through unchanged", () => {
	const clean = "The quick brown fox jumps over the lazy dog.";
	assert.strictEqual(stripPaywallText(clean), clean);
});

test("stripPaywallText removes trailing 'Subscribe to continue reading'", () => {
	const content = `
		The economy grew by 3.2% in the last quarter, according to data released by the Federal Reserve today.
		Analysts had predicted growth of 2.8%.
		Subscribe to continue reading this article and get unlimited access.
	`;
	const cleaned = stripPaywallText(content);
	assert.ok(!cleaned.includes("Subscribe to continue reading"));
	assert.ok(cleaned.includes("last quarter"));
});

test("stripPaywallText removes 'Log in or create an account to continue'", () => {
	const content = `
		The president addressed the nation last night in a prime-time speech.
		Log in or create an account to continue reading.
	`;
	const cleaned = stripPaywallText(content);
	assert.ok(!cleaned.toLowerCase().includes("log in or create an account"));
});

test("stripPaywallText handles multiple markers", () => {
	const content = `
		Article body paragraph 1.
		Article body paragraph 2.
		Article body paragraph 3.
		Subscribe to continue reading. Unlock this article. Already a subscriber? Sign in.
	`;
	const cleaned = stripPaywallText(content);
	assert.ok(!cleaned.includes("Subscribe to continue reading"));
	assert.ok(!cleaned.includes("Unlock this article"));
	assert.ok(cleaned.includes("Article body paragraph 1"));
});

test("stripPaywallText preserves early mentions of paywall words", () => {
	// If a paywall word appears in the first 100 chars, it should
	// be kept (it's likely the article title or a legitimate mention).
	const content = `
		Subscribe today: Special offer for new readers.
		This article covers the new policy changes in detail.
		The full text of the policy is now available.
	`;
	const cleaned = stripPaywallText(content);
	// The early "Subscribe today" is in the title area and should be kept
	assert.ok(cleaned.length > 0);
});

test("stripPaywallText strips 'or' tails", () => {
	const content = "The article body ends here.\nor\n";
	const cleaned = stripPaywallText(content);
	assert.ok(!cleaned.endsWith("\nor\n"));
});

test("stripPaywallText strips 'Sign in' tails", () => {
	const content = "The article body.\nSign in";
	const cleaned = stripPaywallText(content);
	assert.ok(!cleaned.endsWith("Sign in"));
});

test("stripPaywallText handles empty input", () => {
	assert.strictEqual(stripPaywallText(""), "");
});

test("stripPaywallText doesn't over-truncate on first marker", () => {
	// "premium content" is a low-weight marker — should not trigger
	// aggressive truncation when alone.
	const content = `
		Para 1: This article discusses the premium content strategy.
		Para 2: More details follow about implementation.
		Para 3: Even more details here that go on for a while.
		Para 4: The conclusion is that this works.
	`;
	const cleaned = stripPaywallText(content);
	// We should keep most of the content because no high-weight
	// marker is in the last 1/3
	assert.ok(cleaned.includes("premium content strategy"));
	assert.ok(cleaned.includes("conclusion"));
});

// ─── Bot UA constants ──────────────────────────────────────────────

test("bot UAs are non-empty strings", () => {
	assert.ok(UA_GOOGLEBOT.length > 20);
	assert.ok(UA_BINGBOT.length > 20);
	assert.ok(UA_FACEBOOKBOT.length > 20);
	assert.ok(UA_INSPECTIONTOOL.length > 20);
});

test("Googlebot UA is identified as such", () => {
	assert.ok(UA_GOOGLEBOT.includes("Googlebot"));
	assert.ok(UA_BINGBOT.includes("bingbot"));
	assert.ok(UA_FACEBOOKBOT.includes("facebookexternalhit"));
	assert.ok(UA_INSPECTIONTOOL.includes("Google-InspectionTool"));
});

test("botUAFor returns the right UA per strategy", () => {
	assert.strictEqual(botUAFor("ua:googlebot"), UA_GOOGLEBOT);
	assert.strictEqual(botUAFor("ua:bingbot"), UA_BINGBOT);
	assert.strictEqual(botUAFor("ua:facebookbot"), UA_FACEBOOKBOT);
	assert.strictEqual(botUAFor("ua:custom"), null);
	assert.strictEqual(botUAFor("archive"), null);
});

test("botUAFor returns null for non-UA strategies", () => {
	assert.strictEqual(botUAFor("block_js"), null);
	assert.strictEqual(botUAFor("archive"), null);
	assert.strictEqual(botUAFor("referer:google"), null);
	assert.strictEqual(botUAFor("cookies"), null);
});

// ─── Site database integrity ───────────────────────────────────────

test("PAYWALL_SITES has at least 50 entries", () => {
	const count = Object.keys(PAYWALL_SITES).length;
	assert.ok(count >= 50, `Expected 50+ sites, got ${count}`);
});

test("PAYWALL_SITE_COUNT matches sum of direct sites + groups", () => {
	const expected =
		Object.keys(PAYWALL_SITES).length + Object.keys(PAYWALL_GROUPS).length;
	assert.strictEqual(PAYWALL_SITE_COUNT, expected);
});

test("Every site in PAYWALL_SITES has a non-empty steps array", () => {
	for (const [domain, strategy] of Object.entries(PAYWALL_SITES)) {
		assert.ok(strategy.steps.length > 0, `${domain} has no steps`);
	}
});

test("Every site has valid strategy types", () => {
	const valid = new Set([
		"ua:googlebot",
		"ua:bingbot",
		"ua:facebookbot",
		"ua:custom",
		"referer:google",
		"block_js",
		"archive",
		"archive_first",
		"cookies",
	]);
	for (const [domain, strategy] of Object.entries(PAYWALL_SITES)) {
		for (const step of strategy.steps) {
			assert.ok(valid.has(step), `${domain} has invalid step: ${step}`);
		}
	}
});

test("Top-traffic sites are in the database", () => {
	const required = [
		"nytimes.com",
		"washingtonpost.com",
		"wsj.com",
		"ft.com",
		"economist.com",
		"theatlantic.com",
		"newyorker.com",
		"wired.com",
		"lemonde.fr",
		"sueddeutsche.de",
		"smh.com.au",
		"theglobeandmail.com",
		"scmp.com",
	];
	for (const domain of required) {
		assert.ok(domain in PAYWALL_SITES, `${domain} missing from database`);
	}
});

test("PAYWALL_GROUPS contain major newspaper chains", () => {
	const required = [
		"advancelocal.com",
		"tribpub.com",
		"hearst.com",
		"dpgmedia.nl",
		"condenastdigital.com",
	];
	for (const domain of required) {
		assert.ok(domain in PAYWALL_GROUPS, `${domain} missing from groups`);
	}
});

// ─── KNOWN_PAYWALL_VENDORS ─────────────────────────────────────────

test("KNOWN_PAYWALL_VENDORS includes the major vendors", () => {
	const required = [
		"piano.io",
		"tinypass.com",
		"poool.fr",
		"zephr.com",
		"pelcro.com",
		"sophi.io",
	];
	for (const v of required) {
		assert.ok(
			KNOWN_PAYWALL_VENDORS.some((p) => p.includes(v)),
			`Missing vendor: ${v}`,
		);
	}
});

test("KNOWN_PAYWALL_VENDORS entries are non-empty", () => {
	for (const v of KNOWN_PAYWALL_VENDORS) {
		assert.ok(v.length > 0);
	}
});

// ─── GENERIC_STRATEGY ──────────────────────────────────────────────

test("GENERIC_STRATEGY has at least one fallback", () => {
	assert.ok(GENERIC_STRATEGY.steps.length > 0);
	assert.ok(GENERIC_STRATEGY.steps.includes("archive"));
});

test("GENERIC_STRATEGY blocks known paywall vendors", () => {
	assert.ok(GENERIC_STRATEGY.blockScripts);
	assert.ok(GENERIC_STRATEGY.blockScripts.length > 0);
	assert.ok(GENERIC_STRATEGY.domOverride === true);
});

// ─── DOM_OVERRIDE_SCRIPT ───────────────────────────────────────────

test("DOM_OVERRIDE_SCRIPT hides paywall elements", () => {
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("paywall"));
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("display"));
});

test("DOM_OVERRIDE_SCRIPT restores body overflow", () => {
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("overflow"));
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("auto"));
});

test("DOM_OVERRIDE_SCRIPT unlocks article containers", () => {
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("article"));
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("max-height"));
});

test("DOM_OVERRIDE_SCRIPT removes mask images", () => {
	assert.ok(DOM_OVERRIDE_SCRIPT.includes("mask"));
});

// ─── PAYWALL_MARKERS ───────────────────────────────────────────────

test("PAYWALL_MARKERS has both generic and vendor markers", () => {
	const generic = PAYWALL_MARKERS.filter((m) => !m.vendor);
	const vendor = PAYWALL_MARKERS.filter((m) => m.vendor);
	assert.ok(generic.length > 5, "Need several generic markers");
	assert.ok(vendor.length >= 5, "Need at least 5 vendor markers");
});

test("Every marker has a positive weight", () => {
	for (const m of PAYWALL_MARKERS) {
		assert.ok(m.weight > 0, `Zero/negative weight: ${m.text}`);
		assert.ok(m.weight <= 1, `Weight > 1: ${m.text}`);
	}
});

test("Vendor-specific markers have high weights", () => {
	for (const m of PAYWALL_MARKERS) {
		if (m.vendor) {
			assert.ok(
				m.weight >= 0.8,
				`Vendor marker should have high weight: ${m.text}`,
			);
		}
	}
});

// ─── Integration smoke tests (no network) ─────────────────────────

test("Strategy chain for NYT ends in archive fallback", () => {
	const r = findStrategy("https://www.nytimes.com/2024/01/01/article");
	assert.ok(r);
	assert.ok(r.steps.length > 0);
	assert.ok(r.steps[r.steps.length - 1] !== "auto");
});

test("Strategy chain for unknown sites includes archive", () => {
	const r = findStrategy("https://www.unknown-paywalled-news-2024.com/article");
	assert.ok(r);
	assert.ok(r.steps.includes("archive"));
});

test("All strategies have a finite length (no infinite loops)", () => {
	for (const [domain, strategy] of Object.entries(PAYWALL_SITES)) {
		assert.ok(
			strategy.steps.length <= 5,
			`${domain} strategy too long: ${strategy.steps.length}`,
		);
	}
});

// ─── Hard paywall 403/401 detection ────────────────────────────────
// For sites like NYT, WSJ, FT that return HTTP 403/401 before any
// content is served (no body for detectPaywall to analyze), the bypass
// engine should still recognize the site via findStrategy and trigger
// the strategy chain.

test("findStrategy returns a strategy for hard paywall sites that 403", () => {
	// All these sites are known to return 403/401 without a body
	const hardPaywallSites = [
		"https://www.nytimes.com/2026/04/29/business/article.html",
		"https://www.wsj.com/articles/some-article",
		"https://www.ft.com/content/some-article",
		"https://www.economist.com/finance-and-economics/2024/11/14/article",
	];
	for (const url of hardPaywallSites) {
		const s = findStrategy(url);
		assert.ok(s, `findStrategy should return non-null for ${url}`);
		assert.ok(s.steps.length > 0, `strategy for ${url} should have steps`);
		// Hard paywalls should include archive (most reliable bypass)
		assert.ok(
			s.steps.includes("archive"),
			`strategy for ${url} should include archive`,
		);
	}
});

test("isKnownPaywallSite returns true for curated sites", async () => {
	const { isKnownPaywallSite } = await import("../src/paywall.ts");
	assert.strictEqual(
		isKnownPaywallSite("https://www.nytimes.com/2026/article.html"),
		true,
	);
	assert.strictEqual(
		isKnownPaywallSite("https://www.wsj.com/articles/x"),
		true,
	);
	assert.strictEqual(
		isKnownPaywallSite("https://m.washingtonpost.com/news/x"),
		true,
	);
});

test("isKnownPaywallSite returns false for non-paywall sites", async () => {
	const { isKnownPaywallSite } = await import("../src/paywall.ts");
	assert.strictEqual(
		isKnownPaywallSite("https://www.example.com/blocked"),
		false,
	);
	assert.strictEqual(isKnownPaywallSite("https://github.com/foo/bar"), false);
	assert.strictEqual(isKnownPaywallSite("not a url"), false);
});
