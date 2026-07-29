import assert from "node:assert";
import test from "node:test";
import {
	trustTierForSourceType,
	trustTierBoost,
	profileFor,
	classifySourceProfile,
} from "../src/source-trust.ts";
import { rankSources } from "../src/research.ts";

// ─── trustTierForSourceType: every sourceType maps to a tier ────────────

test("trustTierForSourceType: official-docs/academic are authoritative", () => {
	assert.equal(trustTierForSourceType("official-docs"), "authoritative");
	assert.equal(trustTierForSourceType("academic"), "authoritative");
});

test("trustTierForSourceType: repo/maintainer-blog are credible", () => {
	assert.equal(trustTierForSourceType("repo"), "credible");
	assert.equal(trustTierForSourceType("maintainer-blog"), "credible");
});

test("trustTierForSourceType: news/website are mixed", () => {
	assert.equal(trustTierForSourceType("news"), "mixed");
	assert.equal(trustTierForSourceType("website"), "mixed");
});

test("trustTierForSourceType: community/social are community", () => {
	assert.equal(trustTierForSourceType("community"), "community");
	assert.equal(trustTierForSourceType("social"), "community");
});

test("trustTierForSourceType: unknown falls back to mixed", () => {
	assert.equal(trustTierForSourceType("bogus"), "mixed");
});

// ─── trustTierBoost: purely additive, no penalties ──────────────────────

test("trustTierBoost: authoritative > credible > mixed/community >= 0", () => {
	assert.equal(trustTierBoost("authoritative"), 0.1);
	assert.equal(trustTierBoost("credible"), 0.05);
	assert.equal(trustTierBoost("mixed"), 0);
	assert.equal(trustTierBoost("community"), 0);
	assert.ok(trustTierBoost("authoritative") > trustTierBoost("credible"));
	assert.ok(trustTierBoost("community") >= 0, "never a penalty");
});

// ─── profileFor: reuse, not re-derive ───────────────────────────────────

test("profileFor: trusts an explicit sourceType and maps its tier", () => {
	const p = profileFor({ sourceType: "repo", domain: "example.com" });
	assert.equal(p.sourceType, "repo");
	assert.equal(p.tier, "credible");
	assert.equal(p.domain, "example.com");
});

test("profileFor: derives sourceType via classifySourceType when absent", () => {
	// github.com is classified as "repo" → credible tier.
	const p = profileFor({ url: "https://github.com/foo/bar" });
	assert.equal(p.sourceType, "repo");
	assert.equal(p.tier, "credible");
	assert.equal(p.domain, "github.com");
});

test("profileFor: resolves domain from url when domain missing", () => {
	const p = profileFor({
		url: "https://docs.example.com/guide",
		title: "Guide",
	});
	assert.equal(p.domain, "docs.example.com");
	assert.equal(p.sourceType, "official-docs");
	assert.equal(p.tier, "authoritative");
});

// ─── classifySourceProfile: tier distribution + diversity math ──────────

test("classifySourceProfile: empty set yields zeroed distribution, no caveats", () => {
	const r = classifySourceProfile([]);
	assert.deepEqual(r.tierDistribution, {
		authoritative: 0,
		credible: 0,
		mixed: 0,
		community: 0,
	});
	assert.deepEqual(r.caveats, []);
	assert.deepEqual(r.diversity, { uniqueDomains: 0, topDomainShare: 0 });
});

test("classifySourceProfile: tier distribution counts each tier", () => {
	const r = classifySourceProfile([
		{ sourceType: "official-docs", domain: "a.com" },
		{ sourceType: "academic", domain: "b.org" },
		{ sourceType: "repo", domain: "c.com" },
		{ sourceType: "news", domain: "d.com" },
		{ sourceType: "social", domain: "e.com" },
	]);
	assert.deepEqual(r.tierDistribution, {
		authoritative: 2,
		credible: 1,
		mixed: 1,
		community: 1,
	});
});

test("classifySourceProfile: diversity counts unique domains and top share", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com" },
		{ sourceType: "news", domain: "a.com" },
		{ sourceType: "news", domain: "b.com" },
		{ sourceType: "news", domain: "c.com" },
	]);
	assert.equal(r.diversity.uniqueDomains, 3);
	// a.com holds 2 of 4 → 0.5 (not > 0.5).
	assert.equal(r.diversity.topDomainShare, 0.5);
});

test("classifySourceProfile: www-stripped domains share a bucket", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "www.a.com" },
		{ sourceType: "news", domain: "a.com" },
	]);
	assert.equal(r.diversity.uniqueDomains, 1);
	assert.equal(r.diversity.topDomainShare, 1);
});

// ─── caveat: community-only ─────────────────────────────────────────────

test("community-only: fires when every source is community/social tier", () => {
	const r = classifySourceProfile([
		{ sourceType: "community", domain: "reddit.com" },
		{ sourceType: "social", domain: "x.com" },
	]);
	assert.ok(r.caveats.includes("community-only"));
});

test("community-only: does NOT fire when an authoritative source is present", () => {
	const r = classifySourceProfile([
		{ sourceType: "community", domain: "reddit.com" },
		{ sourceType: "official-docs", domain: "docs.dev" },
	]);
	assert.ok(!r.caveats.includes("community-only"));
});

test("community-only: does NOT fire for a mixed-tier (website) source", () => {
	const r = classifySourceProfile([
		{ sourceType: "community", domain: "reddit.com" },
		{ sourceType: "website", domain: "random.com" },
	]);
	assert.ok(!r.caveats.includes("community-only"));
});

test("community-only: does NOT fire for an empty set", () => {
	assert.ok(!classifySourceProfile([]).caveats.includes("community-only"));
});

// ─── caveat: low-diversity ──────────────────────────────────────────────

test("low-diversity: fires when >half share one domain", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com" },
		{ sourceType: "repo", domain: "a.com" },
		{ sourceType: "official-docs", domain: "b.com" },
	]);
	// a.com = 2/3 > 0.5
	assert.ok(r.caveats.includes("low-diversity"));
});

test("low-diversity: fires when all sources share one sourceType", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com" },
		{ sourceType: "news", domain: "b.com" },
		{ sourceType: "news", domain: "c.com" },
	]);
	assert.ok(r.caveats.includes("low-diversity"));
});

test("low-diversity: does NOT fire at exactly half share with mixed types", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com" },
		{ sourceType: "repo", domain: "a.com" },
		{ sourceType: "official-docs", domain: "b.com" },
		{ sourceType: "academic", domain: "c.com" },
	]);
	// a.com = 2/4 = 0.5 (not > 0.5); 4 distinct types.
	assert.ok(!r.caveats.includes("low-diversity"));
});

test("low-diversity: does NOT fire for a single source", () => {
	const r = classifySourceProfile([{ sourceType: "news", domain: "a.com" }]);
	assert.ok(!r.caveats.includes("low-diversity"));
});

// ─── caveat: bot-check ──────────────────────────────────────────────────

test("bot-check: fires on a source-level 'skipped' reachability", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com", reachability: "ok" },
		{ sourceType: "news", domain: "b.com", reachability: "skipped" },
	]);
	assert.ok(r.caveats.includes("bot-check"));
});

test("bot-check: fires on a 'dead' reachability via reachabilityByUrl", () => {
	const r = classifySourceProfile(
		[
			{ sourceType: "news", domain: "a.com", url: "https://a.com/x" },
			{ sourceType: "news", domain: "b.com", url: "https://b.com/y" },
		],
		{ reachabilityByUrl: { "https://b.com/y": "dead" } },
	);
	assert.ok(r.caveats.includes("bot-check"));
});

test("bot-check: source-level reachability takes precedence over the map", () => {
	const r = classifySourceProfile(
		[
			{
				sourceType: "news",
				domain: "a.com",
				url: "https://a.com/x",
				reachability: "ok",
			},
		],
		{ reachabilityByUrl: { "https://a.com/x": "dead" } },
	);
	assert.ok(!r.caveats.includes("bot-check"));
});

test("bot-check: does NOT fire when all sources are reachable", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com", reachability: "ok" },
		{ sourceType: "news", domain: "b.com", reachability: "unknown" },
	]);
	assert.ok(!r.caveats.includes("bot-check"));
});

test("bot-check: does NOT fire without any reachability data (never invented)", () => {
	const r = classifySourceProfile([
		{ sourceType: "news", domain: "a.com" },
		{ sourceType: "news", domain: "b.com" },
	]);
	assert.ok(!r.caveats.includes("bot-check"));
});

// ─── caveat: possible-conflict ──────────────────────────────────────────

test("possible-conflict: fires when a vendor domain token overlaps the query", () => {
	const r = classifySourceProfile(
		[{ sourceType: "website", domain: "acme.com" }],
		{ query: "is acme widget any good" },
	);
	assert.ok(r.caveats.includes("possible-conflict"));
});

test("possible-conflict: does NOT fire without a query", () => {
	const r = classifySourceProfile([{ sourceType: "website", domain: "acme.com" }]);
	assert.ok(!r.caveats.includes("possible-conflict"));
});

test("possible-conflict: does NOT fire for generic domain labels", () => {
	const r = classifySourceProfile(
		[{ sourceType: "official-docs", domain: "docs.api.com" }],
		{ query: "how do docs and api references work" },
	);
	assert.ok(!r.caveats.includes("possible-conflict"));
});

test("possible-conflict: does NOT fire for short (<4 char) tokens", () => {
	const r = classifySourceProfile(
		[{ sourceType: "website", domain: "acm.com" }],
		{ query: "acm computing reviews" },
	);
	// "acm" is only 3 chars → excluded.
	assert.ok(!r.caveats.includes("possible-conflict"));
});

test("possible-conflict: does NOT fire when there is no token overlap", () => {
	const r = classifySourceProfile(
		[{ sourceType: "website", domain: "acme.com" }],
		{ query: "best widget frameworks" },
	);
	assert.ok(!r.caveats.includes("possible-conflict"));
});

// ─── caveats are deduped and stably ordered ─────────────────────────────

test("caveats: deduped and in a fixed order", () => {
	const r = classifySourceProfile(
		[
			{ sourceType: "community", domain: "reddit.com", reachability: "dead" },
			{ sourceType: "community", domain: "reddit.com", reachability: "skipped" },
		],
		{ query: "reddit alternatives" },
	);
	// community-only, low-diversity (one domain + one type), bot-check,
	// possible-conflict — each exactly once, in this order.
	assert.deepEqual(r.caveats, [
		"community-only",
		"low-diversity",
		"bot-check",
		"possible-conflict",
	]);
});

// ─── single-source edge case ────────────────────────────────────────────

test("single source: distribution, no community-only/low-diversity, share = 1", () => {
	const r = classifySourceProfile([
		{ sourceType: "official-docs", domain: "docs.dev" },
	]);
	assert.deepEqual(r.tierDistribution, {
		authoritative: 1,
		credible: 0,
		mixed: 0,
		community: 0,
	});
	assert.ok(!r.caveats.includes("community-only"));
	assert.ok(!r.caveats.includes("low-diversity"));
	assert.equal(r.diversity.uniqueDomains, 1);
	assert.equal(r.diversity.topDomainShare, 1);
});

// ─── research.ts integration: opt-in trustBoost ─────────────────────────

function buildPerQuery(entries) {
	return [
		{
			query: "q",
			results: entries.map((e, i) => ({
				title: e.url,
				url: e.url,
				snippet: "",
				domain: e.domain,
				sources: ["ddg"],
				sourceType: e.sourceType,
				_rank: i + 1,
			})),
		},
	];
}

test("rankSources: default path is byte-identical to trustBoost:false", () => {
	const perQuery = buildPerQuery([
		{ url: "https://a.com/1", domain: "a.com", sourceType: "official-docs" },
		{ url: "https://b.com/2", domain: "b.com", sourceType: "community" },
	]);
	const def = rankSources(perQuery);
	const explicitOff = rankSources(perQuery, { trustBoost: false });
	assert.deepEqual(def, explicitOff);
});

test("rankSources: trustBoost adds exactly the tier bonus to scores", () => {
	const perQuery = buildPerQuery([
		{ url: "https://a.com/1", domain: "a.com", sourceType: "official-docs" },
		{ url: "https://b.com/2", domain: "b.com", sourceType: "community" },
	]);
	const off = rankSources(perQuery, { trustBoost: false });
	const on = rankSources(perQuery, { trustBoost: true });
	const offA = off.find((s) => s.url === "https://a.com/1");
	const onA = on.find((s) => s.url === "https://a.com/1");
	const offB = off.find((s) => s.url === "https://b.com/2");
	const onB = on.find((s) => s.url === "https://b.com/2");
	// authoritative +0.1, community +0.
	assert.equal(Math.round((onA.score - offA.score) * 1000) / 1000, 0.1);
	assert.equal(onB.score, offB.score);
});

test("rankSources: trustBoost can reorder a close race toward authoritative", () => {
	// 10 filler URLs push the two of interest to ranks 10 and 11, where the
	// reciprocal-rank gap (~0.009) is smaller than the 0.1 authoritative boost.
	const fillers = Array.from({ length: 8 }, (_, i) => ({
		url: `https://fill${i}.com/${i}`,
		domain: `fill${i}.com`,
		sourceType: "website",
	}));
	const perQuery = buildPerQuery([
		...fillers,
		{ url: "https://community.com/x", domain: "community.com", sourceType: "community" }, // rank 9
		{ url: "https://docs.dev/x", domain: "docs.dev", sourceType: "official-docs" }, // rank 10
	]);
	const off = rankSources(perQuery, { trustBoost: false });
	const on = rankSources(perQuery, { trustBoost: true });
	const offComm = off.findIndex((s) => s.url === "https://community.com/x");
	const offDocs = off.findIndex((s) => s.url === "https://docs.dev/x");
	const onComm = on.findIndex((s) => s.url === "https://community.com/x");
	const onDocs = on.findIndex((s) => s.url === "https://docs.dev/x");
	// Without boost the community source (rank 9) outranks docs (rank 10).
	assert.ok(offComm < offDocs, "community ranks ahead without boost");
	// With boost the authoritative docs source moves ahead of community.
	assert.ok(onDocs < onComm, "authoritative docs overtakes with boost");
});
