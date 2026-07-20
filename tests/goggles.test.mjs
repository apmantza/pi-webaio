import assert from "node:assert";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GOGGLES_PRESETS,
	resolveGogglesSync,
	loadGoggles,
	computeGogglesBonus,
} from "../src/goggles.ts";
import { ENGINE_WEIGHTS, scoreAndRankResults } from "../src/search.ts";

// ─── Preset lookup / parsing ────────────────────────────────────────

test("GOGGLES_PRESETS: exposes the three built-in presets", () => {
	assert.ok(GOGGLES_PRESETS["docs-first"]);
	assert.ok(GOGGLES_PRESETS["research"]);
	assert.ok(GOGGLES_PRESETS["news-balanced"]);
	for (const key of Object.keys(GOGGLES_PRESETS)) {
		const profile = GOGGLES_PRESETS[key];
		assert.strictEqual(profile.name, key);
		assert.ok(Array.isArray(profile.rules) && profile.rules.length > 0);
	}
});

test("resolveGogglesSync: resolves a built-in preset name (case-insensitive)", () => {
	assert.strictEqual(resolveGogglesSync("docs-first")?.name, "docs-first");
	assert.strictEqual(resolveGogglesSync("DOCS-FIRST")?.name, "docs-first");
	assert.strictEqual(resolveGogglesSync("  research  ")?.name, "research");
});

test("resolveGogglesSync: resolves an inline JSON string of custom rules", () => {
	const json = JSON.stringify({
		name: "my-custom",
		rules: [{ domains: ["example.com"], weight: 10 }],
	});
	const profile = resolveGogglesSync(json);
	assert.strictEqual(profile?.name, "my-custom");
	assert.strictEqual(profile?.rules.length, 1);
});

test("resolveGogglesSync: resolves a bare JSON array of rules", () => {
	const json = JSON.stringify([{ titleTerms: ["foo"], weight: 3 }]);
	const profile = resolveGogglesSync(json);
	assert.strictEqual(profile?.name, "custom");
	assert.strictEqual(profile?.rules.length, 1);
});

test("resolveGogglesSync: resolves an already-parsed rules object or array", () => {
	assert.strictEqual(
		resolveGogglesSync({ rules: [{ weight: 1 }] })?.name,
		"custom",
	);
	assert.strictEqual(resolveGogglesSync([{ weight: 1 }])?.name, "custom");
});

test("resolveGogglesSync: undefined/null/empty/unknown input resolves to undefined", () => {
	assert.strictEqual(resolveGogglesSync(undefined), undefined);
	assert.strictEqual(resolveGogglesSync(null), undefined);
	assert.strictEqual(resolveGogglesSync(""), undefined);
	assert.strictEqual(resolveGogglesSync("not-a-known-preset"), undefined);
	assert.strictEqual(resolveGogglesSync("{not valid json"), undefined);
});

test("loadGoggles: resolves built-in presets and inline JSON without touching disk", async () => {
	assert.strictEqual((await loadGoggles("research"))?.name, "research");
	const json = JSON.stringify({ rules: [{ weight: 1 }] });
	assert.strictEqual((await loadGoggles(json))?.name, "custom");
});

test("loadGoggles: reads custom rules from a JSON file path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-webaio-goggles-test-"));
	const filePath = join(dir, "my-goggle.json");
	await writeFile(
		filePath,
		JSON.stringify({
			name: "file-goggle",
			rules: [{ domains: ["example.org"], weight: 5 }],
		}),
		"utf8",
	);
	try {
		const profile = await loadGoggles(filePath);
		assert.strictEqual(profile?.name, "file-goggle");
		assert.strictEqual(profile?.rules[0].weight, 5);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadGoggles: nonexistent file path resolves to undefined rather than throwing", async () => {
	const profile = await loadGoggles(
		join(tmpdir(), "pi-webaio-goggles-does-not-exist", "nope.json"),
	);
	assert.strictEqual(profile, undefined);
});

// ─── computeGogglesBonus ────────────────────────────────────────────

test("computeGogglesBonus: no profile is a zero-bonus no-op", () => {
	const result = computeGogglesBonus(undefined, "example.com", "Title", "https://example.com");
	assert.strictEqual(result.bonus, 0);
	assert.deepStrictEqual(result.matches, []);
});

test("computeGogglesBonus: docs-first boosts docs subdomains and demotes news/social", () => {
	const docsFirst = GOGGLES_PRESETS["docs-first"];
	const docsResult = computeGogglesBonus(
		docsFirst,
		"docs.example.org",
		"Example Documentation",
		"https://docs.example.org/reference/api",
	);
	assert.ok(docsResult.bonus > 0, "docs subdomain should get a positive bonus");
	assert.ok(docsResult.matches.length > 0);

	const newsResult = computeGogglesBonus(
		docsFirst,
		"techcrunch.com",
		"Some News Article",
		"https://techcrunch.com/2024/01/01/article",
	);
	assert.ok(newsResult.bonus < 0, "news host should get a negative bonus");
});

test("computeGogglesBonus: sums weights across multiple matching rules", () => {
	const docsFirst = GOGGLES_PRESETS["docs-first"];
	const result = computeGogglesBonus(
		docsFirst,
		"docs.example.org",
		"Example Documentation Reference",
		"https://docs.example.org/reference/getting-started",
	);
	// domain-marker + url-marker + title-term rules should all fire.
	assert.ok(result.matches.length >= 3);
});

// ─── scoreAndRankResults + goggles composition (issue #72) ─────────

function engineSource(engine, result) {
	return { engine, weight: ENGINE_WEIGHTS[engine] || 1, result };
}

test("scoreAndRankResults: docs-first goggle lifts an official-docs result above an equal-consensus news result", () => {
	const docsUrl = "https://docs.example.org/reference/widgets";
	const newsUrl = "https://techcrunch.com/2024/widgets-explainer";

	const buckets = new Map([
		[
			docsUrl,
			[
				engineSource("ddg", {
					title: "Widgets — Documentation",
					url: docsUrl,
					snippet: "",
					domain: "docs.example.org",
				}),
			],
		],
		[
			newsUrl,
			[
				engineSource("ddg", {
					title: "Widgets Explainer",
					url: newsUrl,
					snippet: "",
					domain: "techcrunch.com",
				}),
			],
		],
	]);

	// Without a goggle, both are single-engine, equal consensus. Confirm the
	// baseline still separates them via sourceTypePriority alone (official-docs
	// already outranks news), then confirm the goggle widens that margin
	// additively rather than replacing it.
	const baseline = scoreAndRankResults(buckets, "widgets");
	assert.strictEqual(baseline[0].result.url, docsUrl);
	const baselineMargin = baseline[0].score - baseline[1].score;

	const docsFirst = GOGGLES_PRESETS["docs-first"];
	const withGoggle = scoreAndRankResults(buckets, "widgets", docsFirst);
	assert.strictEqual(withGoggle[0].result.url, docsUrl);
	const goggleMargin = withGoggle[0].score - withGoggle[1].score;

	assert.ok(
		goggleMargin > baselineMargin,
		"docs-first goggle should additively widen the docs-vs-news margin",
	);
	assert.strictEqual(withGoggle[0].result.goggles?.profile, "docs-first");
	assert.ok(withGoggle[0].result.goggles?.bonus > 0);
});

test("scoreAndRankResults: omitting goggles leaves current ranking output unchanged", () => {
	const docsUrl = "https://docs.example.org/reference/widgets";
	const newsUrl = "https://techcrunch.com/2024/widgets-explainer";

	const buckets = () =>
		new Map([
			[
				docsUrl,
				[
					engineSource("ddg", {
						title: "Widgets — Documentation",
						url: docsUrl,
						snippet: "",
						domain: "docs.example.org",
					}),
				],
			],
			[
				newsUrl,
				[
					engineSource("ddg", {
						title: "Widgets Explainer",
						url: newsUrl,
						snippet: "",
						domain: "techcrunch.com",
					}),
				],
			],
		]);

	const withoutGogglesArg = scoreAndRankResults(buckets(), "widgets");
	const withUndefinedGoggles = scoreAndRankResults(buckets(), "widgets", undefined);

	assert.deepStrictEqual(withoutGogglesArg, withUndefinedGoggles);
	for (const entry of withoutGogglesArg) {
		assert.strictEqual(entry.result.goggles, undefined);
	}
});
