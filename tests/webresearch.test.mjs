// ─── Tests for aio-webresearch bundle logic (issue #64) ───────────────
// research.ts is deterministic (no LLM/network calls) — everything here
// runs offline against in-memory/fixture data. No live internet is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	slugify,
	timestampForBundle,
	bundleDirName,
	clampMaxSources,
	classifyReachability,
	isPrimarySource,
	rankSources,
	extractEvidence,
	buildStatusMd,
	buildEvidenceMd,
	buildClaimsMdScaffold,
	buildGapsMd,
	buildManifest,
	buildSourcesJson,
	buildEvidenceJson,
	writeBundle,
} from "../src/research.ts";

async function makeTempDir() {
	return mkdtemp(join(tmpdir(), "webresearch-test-"));
}

// ─── slugify / naming ───────────────────────────────────────────────────

test("slugify: lowercases, hyphenates, and truncates", () => {
	assert.equal(slugify("What is BM25 Ranking?"), "what-is-bm25-ranking");
	assert.equal(slugify("  leading/trailing--spaces  "), "leading-trailing-spaces");
	assert.ok(slugify("a".repeat(200)).length <= 48);
	assert.equal(slugify(""), "query");
});

test("timestampForBundle: filesystem-safe, sortable UTC format", () => {
	const ts = timestampForBundle(new Date("2026-07-20T15:30:05.000Z"));
	assert.equal(ts, "20260720-153005");
	assert.ok(!/[:.]/.test(ts), "no colons or dots in timestamp");
});

test("bundleDirName: combines timestamp and slug", () => {
	const name = bundleDirName("React Server Components", new Date("2026-07-20T15:30:05.000Z"));
	assert.equal(name, "20260720-153005_react-server-components");
});

test("clampMaxSources: clamps into [3, 12], defaults to 6", () => {
	assert.equal(clampMaxSources(undefined), 6);
	assert.equal(clampMaxSources(1), 3);
	assert.equal(clampMaxSources(100), 12);
	assert.equal(clampMaxSources(8), 8);
	assert.equal(clampMaxSources(Number.NaN), 6);
});

// ─── Reachability / citation audit ──────────────────────────────────────

test("classifyReachability: ok fetch is 'ok'", () => {
	assert.equal(classifyReachability({ ok: true }), "ok");
});

test("classifyReachability: 403 (anti-bot) is 'skipped', not 'dead'", () => {
	assert.equal(classifyReachability({ ok: false, statusCode: 403 }), "skipped");
});

test("classifyReachability: 429 and paywall/bot error codes are 'skipped'", () => {
	assert.equal(classifyReachability({ ok: false, statusCode: 429 }), "skipped");
	assert.equal(classifyReachability({ ok: false, errorCode: "bot_detected" }), "skipped");
	assert.equal(classifyReachability({ ok: false, errorCode: "paywall" }), "skipped");
});

test("classifyReachability: 404/5xx and other errors are 'dead'", () => {
	assert.equal(classifyReachability({ ok: false, statusCode: 404 }), "dead");
	assert.equal(classifyReachability({ ok: false, statusCode: 500 }), "dead");
	assert.equal(classifyReachability({ ok: false, errorCode: "dns_error" }), "dead");
});

test("classifyReachability: no status/error info is 'unknown'", () => {
	assert.equal(classifyReachability({ ok: false }), "unknown");
});

// ─── Primary-source heuristic ────────────────────────────────────────────

test("isPrimarySource: recognizes official/standards domains", () => {
	assert.ok(isPrimarySource("docs.python.org"));
	assert.ok(isPrimarySource("developer.mozilla.org"));
	assert.ok(isPrimarySource("www.w3.org"));
	assert.ok(isPrimarySource("example.gov"));
});

test("isPrimarySource: does not flag an arbitrary blog domain", () => {
	assert.ok(!isPrimarySource("myrandomblog.example.com"));
	assert.ok(!isPrimarySource(undefined));
});

// ─── rankSources: multi-query merge/dedupe ──────────────────────────────

test("rankSources: dedupes the same URL across sub-queries and boosts consensus", () => {
	const perQuery = [
		{
			query: "q1",
			results: [
				{ title: "A", url: "https://a.example.com/", snippet: "a", domain: "a.example.com", sources: ["ddg"] },
				{ title: "B", url: "https://b.example.com/", snippet: "b", domain: "b.example.com", sources: ["bing"] },
			],
		},
		{
			query: "q2",
			results: [
				{ title: "A", url: "https://a.example.com/", snippet: "a", domain: "a.example.com", sources: ["brave"] },
			],
		},
	];
	const ranked = rankSources(perQuery);
	assert.equal(ranked.length, 2, "two unique URLs after dedupe");

	const a = ranked.find((r) => r.url === "https://a.example.com/");
	const b = ranked.find((r) => r.url === "https://b.example.com/");
	assert.ok(a && b);
	assert.deepEqual(a.queries.sort(), ["q1", "q2"]);
	assert.deepEqual(a.engines.sort(), ["brave", "ddg"]);
	// A appeared in both sub-queries at rank 1 each time (plus consensus bonus) — should outrank B.
	assert.ok(a.score > b.score, `expected A (${a.score}) to outrank B (${b.score})`);
	assert.equal(ranked[0].id, "S1");
	assert.equal(ranked[1].id, "S2");
});

test("rankSources: trailing slash / hash differences still dedupe", () => {
	const perQuery = [
		{
			query: "q1",
			results: [
				{ title: "A", url: "https://a.example.com/page", snippet: "", domain: "a.example.com" },
				{ title: "A again", url: "https://a.example.com/page/#section", snippet: "", domain: "a.example.com" },
			],
		},
	];
	const ranked = rankSources(perQuery);
	assert.equal(ranked.length, 1, "hash/trailing-slash variants should dedupe to one source");
});

// ─── extractEvidence: deterministic BM25 quote selection ────────────────

test("extractEvidence: picks the best-matching chunk for the query", () => {
	// Padded so the two sections land in separate BM25-scored chunks
	// (chunkMarkdown merges short adjacent paragraphs into one chunk).
	const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40);
	const markdown = [
		"## Introduction",
		"",
		`This page is about gardening tips for beginners. ${filler}`,
		"",
		"## API Rate Limits",
		"",
		"The API enforces a rate limit of 100 requests per minute per API key.",
	].join("\n");

	const entry = extractEvidence("S1", "https://example.com/docs", "Docs", markdown, "API rate limit requests per minute");
	assert.ok(entry, "should return an evidence entry");
	assert.equal(entry.sourceId, "S1");
	assert.match(entry.quote, /rate limit/i);
	assert.equal(entry.heading, "API Rate Limits");
});

test("extractEvidence: returns undefined for empty content", () => {
	assert.equal(extractEvidence("S1", "https://example.com", "T", "", "query"), undefined);
});

// ─── Bundle markdown renderers (pure) ────────────────────────────────────

function makeSummary() {
	return {
		query: "How does BM25 ranking work?",
		queries: ["How does BM25 ranking work?", "BM25 formula explained"],
		startedAt: "2026-07-20T15:00:00.000Z",
		finishedAt: "2026-07-20T15:00:05.000Z",
		maxSources: 3,
		consulted: 4,
		fetched: [
			{
				id: "S1",
				url: "https://a.example.com/",
				title: "A",
				domain: "a.example.com",
				primary: false,
				ok: true,
				reachability: "ok",
			},
			{
				id: "S2",
				url: "https://blocked.example.com/",
				title: "Blocked",
				domain: "blocked.example.com",
				primary: false,
				ok: false,
				statusCode: 403,
				errorCode: undefined,
				errorMessage: "Forbidden",
				reachability: "skipped",
			},
			{
				id: "S3",
				url: "https://gone.example.com/",
				title: "Gone",
				domain: "gone.example.com",
				primary: false,
				ok: false,
				statusCode: 404,
				errorMessage: "Not found",
				reachability: "dead",
			},
		],
		unfetchedRanked: [
			{ id: "S4", url: "https://d.example.com/", title: "D", engines: [], queries: [], bestRank: 4, score: 0.1, primary: false },
		],
	};
}

test("buildStatusMd: reports counts and the fetch ledger", () => {
	const md = buildStatusMd(makeSummary());
	assert.match(md, /Sources consulted:\*\* 4/);
	assert.match(md, /1 ok, 1 skipped \(anti-bot\), 1 dead/);
	assert.match(md, /S1/);
	assert.match(md, /S4/); // unfetched-but-ranked section
});

test("buildEvidenceMd: renders each evidence entry with source id and quote", () => {
	const evidence = [
		{ sourceId: "S1", url: "https://a.example.com/", title: "A", heading: "Intro", quote: "Some evidence text.", score: 1.234 },
	];
	const md = buildEvidenceMd(evidence, makeSummary().fetched);
	assert.match(md, /\[S1\] A/);
	assert.match(md, /Some evidence text\./);
});

test("buildEvidenceMd: handles no evidence gracefully", () => {
	const md = buildEvidenceMd([], []);
	assert.match(md, /No evidence extracted/);
});

test("buildClaimsMdScaffold: lists only ok sources and leaves claims for the agent", () => {
	const md = buildClaimsMdScaffold("query", makeSummary().fetched);
	assert.match(md, /S1/);
	assert.doesNotMatch(md, /S2:/);
	assert.match(md, /Claims \(fill in\)/);
});

test("buildGapsMd: lists zero-result sub-queries and skipped/dead sources", () => {
	const md = buildGapsMd(makeSummary(), ["some obscure sub-query"]);
	assert.match(md, /some obscure sub-query/);
	assert.match(md, /S2 \(skipped\)/);
	assert.match(md, /S3 \(dead\)/);
});

// ─── JSON builders ───────────────────────────────────────────────────────

test("buildManifest: shape is valid and citation audit classifies 403 as skipped", () => {
	const summary = makeSummary();
	const manifest = buildManifest({
		query: summary.query,
		queries: summary.queries,
		maxSources: summary.maxSources,
		startedAt: summary.startedAt,
		finishedAt: summary.finishedAt,
		consulted: summary.consulted,
		fetched: summary.fetched,
		bundleDir: "/tmp/bundle",
	});

	assert.equal(manifest.version, 1);
	assert.equal(manifest.tool, "aio-webresearch");
	assert.equal(manifest.stopReason, "single_round_complete");
	assert.equal(manifest.counts.sourcesFetched, 3);
	assert.equal(manifest.counts.sourcesOk, 1);
	assert.equal(manifest.counts.sourcesSkipped, 1);
	assert.equal(manifest.counts.sourcesDead, 1);

	assert.equal(manifest.citationAudit.checked, 3);
	assert.equal(manifest.citationAudit.ok, 1);
	assert.equal(manifest.citationAudit.skipped, 1);
	assert.equal(manifest.citationAudit.dead, 1);

	const s2 = manifest.citationAudit.details.find((d) => d.id === "S2");
	assert.equal(s2.statusCode, 403);
	assert.equal(s2.classification, "skipped", "403 must be classified as skipped, not dead");

	const s3 = manifest.citationAudit.details.find((d) => d.id === "S3");
	assert.equal(s3.classification, "dead");
});

test("buildSourcesJson: registry entries carry rank + reachability data", () => {
	const ranked = [
		{ id: "S1", url: "https://a.example.com/", title: "A", engines: ["ddg"], queries: ["q"], bestRank: 1, score: 1, primary: false },
	];
	const fetched = [
		{ id: "S1", url: "https://a.example.com/", title: "A", ok: true, reachability: "ok", statusCode: undefined, file: "sources/01-a.md", wordCount: 42 },
	];
	const json = buildSourcesJson(ranked, fetched);
	assert.equal(json.version, 1);
	assert.equal(json.sources.length, 1);
	assert.equal(json.sources[0].fetched, true);
	assert.equal(json.sources[0].reachability, "ok");
	assert.equal(json.sources[0].wordCount, 42);
});

test("buildEvidenceJson: wraps evidence array with a version", () => {
	const json = buildEvidenceJson([{ sourceId: "S1", url: "u", title: "t", quote: "q", score: 1 }]);
	assert.equal(json.version, 1);
	assert.equal(json.evidence.length, 1);
});

// ─── writeBundle: end-to-end disk layout ────────────────────────────────

test("writeBundle: writes STATUS.md, reports/, and data/ with parseable JSON", async () => {
	const dir = await makeTempDir();
	const bundleDir = join(dir, "20260720-150000_test-query");
	try {
		const summary = makeSummary();
		const manifest = buildManifest({
			query: summary.query,
			queries: summary.queries,
			maxSources: summary.maxSources,
			startedAt: summary.startedAt,
			finishedAt: summary.finishedAt,
			consulted: summary.consulted,
			fetched: summary.fetched,
			bundleDir,
		});

		await writeBundle({
			bundleDir,
			statusMd: buildStatusMd(summary),
			evidenceMd: buildEvidenceMd([], summary.fetched),
			claimsMd: buildClaimsMdScaffold(summary.query, summary.fetched),
			gapsMd: buildGapsMd(summary, []),
			manifest,
			sourcesJson: buildSourcesJson([], summary.fetched),
			evidenceJson: buildEvidenceJson([]),
		});

		const expectedFiles = [
			"STATUS.md",
			join("reports", "EVIDENCE.md"),
			join("reports", "CLAIMS.md"),
			join("reports", "GAPS.md"),
			join("data", "manifest.json"),
			join("data", "sources.json"),
			join("data", "evidence.json"),
		];
		for (const rel of expectedFiles) {
			const st = await stat(join(bundleDir, rel));
			assert.ok(st.isFile(), `${rel} should exist`);
		}

		const manifestOnDisk = JSON.parse(
			await readFile(join(bundleDir, "data", "manifest.json"), "utf8"),
		);
		assert.equal(manifestOnDisk.tool, "aio-webresearch");
		assert.ok(Array.isArray(manifestOnDisk.citationAudit.details));

		const sourcesOnDisk = JSON.parse(
			await readFile(join(bundleDir, "data", "sources.json"), "utf8"),
		);
		assert.ok(Array.isArray(sourcesOnDisk.sources));

		const evidenceOnDisk = JSON.parse(
			await readFile(join(bundleDir, "data", "evidence.json"), "utf8"),
		);
		assert.ok(Array.isArray(evidenceOnDisk.evidence));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
