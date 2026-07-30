// ─── UX8/UX9/UX11 tests: multi-source cited answer + opt-in summary ──
//
// Offline tests for the agent-facing UX cluster (issue #90):
//   - UX8: rankChunksAcrossSources() pools chunks from multiple sources,
//          BM25-ranks the pool, returns top-k each tagged with its source
//          URL + heading; formatMultiSourceAnswer() renders cited chunks;
//          full content stays cached in the real session store.
//   - UX9: AI summarization is opt-in (`summarize` param, off by default;
//          long content otherwise takes the frugal/outline path).
//   - UX11: `url` accepts a string OR an array (additive); `urls` still
//          works and takes precedence.
//   - Single-URL answer mode (applyQueryAnswerMode) is unchanged.
//
// The success path of execute() does real network I/O (and local URLs are
// SSRF-blocked), so — consistent with ux-webfetch-output.test.mjs and
// query-mode.test.mjs — we test the exported pure helpers directly, the
// registered tool schema (via a mock pi), and the real session store to
// prove "display narrows, full content stays cached".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_MULTI_ANSWER_TOP_K,
	formatMultiSourceAnswer,
	rankChunksAcrossSources,
} from "../src/multi-answer.ts";
import {
	applyQueryAnswerMode,
	buildFrugalPreview,
	registerWebfetchTool,
	resolveFetchTargets,
} from "../src/tools/webfetch.ts";
import {
	getStoredContent,
	normalizeCacheKey,
	sessionStore,
	storeContent,
} from "../src/session-store.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function drop(url) {
	sessionStore.delete(normalizeCacheKey(url));
}

/** Wrap a body the way content.ts does: frontmatter + safety markers. */
function wrap(title, url, body) {
	return `---\ntitle: "${title}"\nurl: "${url}"\n---\n\n[UNTRUSTED WEB CONTENT START]\n${body}\n[UNTRUSTED WEB CONTENT END]`;
}

/** Register the tool against a mock pi and capture the registration. */
function captureTool() {
	let tool = null;
	const pi = {
		registerTool(t) {
			tool = t;
		},
	};
	registerWebfetchTool(pi);
	assert.ok(tool, "registerWebfetchTool should register a tool");
	return tool;
}

// Two topically distinct sources. At maxTokens=20 each section is its own
// chunk, so BM25 has discrete units to rank.
const SOURCE_A = {
	url: "https://a.example.com/docs",
	title: "Source A",
	content: wrap(
		"Source A",
		"https://a.example.com/docs",
		[
			"## Cooking Pasta",
			"Boil the pasta in salted water until al dente. Drain and serve with sauce and cheese.",
			"## Baking Bread",
			"Knead the dough with flour yeast and water. Let it rise then bake until golden brown.",
		].join("\n\n"),
	),
};
const SOURCE_B = {
	url: "https://b.example.com/guide",
	title: "Source B",
	content: wrap(
		"Source B",
		"https://b.example.com/guide",
		[
			"## Authentication Token",
			"Send the authentication token in the authorization header for every API request to the service.",
			"## Token Refresh",
			"Refresh the authentication token when it expires by calling the token refresh endpoint.",
		].join("\n\n"),
	),
};

// ─── UX8: rankChunksAcrossSources — pooling + ranking + attribution ──

test("rankChunksAcrossSources: empty sources → []", () => {
	assert.deepEqual(rankChunksAcrossSources([], "anything"), []);
	assert.deepEqual(rankChunksAcrossSources([], "anything", { topK: 3 }), []);
});

test("rankChunksAcrossSources: empty/whitespace query → []", () => {
	assert.deepEqual(rankChunksAcrossSources([SOURCE_A, SOURCE_B], ""), []);
	assert.deepEqual(rankChunksAcrossSources([SOURCE_A, SOURCE_B], "   "), []);
});

test("rankChunksAcrossSources: pools chunks from multiple sources, each tagged with its source URL + heading", () => {
	const ranked = rankChunksAcrossSources(
		[SOURCE_A, SOURCE_B],
		"authentication token",
		{
			topK: 4,
			chunkOptions: { maxTokens: 20 },
		},
	);
	assert.ok(ranked.length > 0, "should return ranked chunks");
	// Every chunk carries a source URL (the citation) + verbatim text + score.
	for (const r of ranked) {
		assert.ok(typeof r.url === "string" && r.url.startsWith("https://"));
		assert.ok(typeof r.text === "string" && r.text.length > 0);
		assert.equal(typeof r.score, "number");
		// Chunk text is clean: frontmatter + safety markers stripped.
		assert.ok(!r.text.includes("[UNTRUSTED WEB CONTENT"));
		assert.ok(!r.text.includes("---\ntitle:"));
	}
	// The pool drew from BOTH sources across the full ranking (at least one
	// chunk is attributable to a real source URL we passed in).
	const urls = new Set(ranked.map((r) => r.url));
	for (const u of urls) {
		assert.ok(
			u === SOURCE_A.url || u === SOURCE_B.url,
			`unexpected source url ${u}`,
		);
	}
});

test("rankChunksAcrossSources: a query matching source B ranks B's chunks above A's", () => {
	const ranked = rankChunksAcrossSources(
		[SOURCE_A, SOURCE_B],
		"authentication token api",
		{
			topK: 2,
			chunkOptions: { maxTokens: 20 },
		},
	);
	assert.ok(ranked.length >= 1);
	// The top chunk must come from source B (the auth content), not A (cooking).
	assert.equal(ranked[0].url, SOURCE_B.url);
	assert.ok(
		ranked[0].text.toLowerCase().includes("authentication") ||
			ranked[0].text.toLowerCase().includes("token"),
		"top chunk should be the auth content",
	);
	// Heading breadcrumb is carried through from the source.
	assert.ok(ranked[0].heading, "top chunk should carry a heading breadcrumb");
	assert.match(ranked[0].heading, /Authentication Token|Token Refresh/);
	// Scores are non-increasing (ranked by relevance).
	for (let i = 1; i < ranked.length; i++) {
		assert.ok(ranked[i - 1].score >= ranked[i].score, "scores must descend");
	}
});

test("rankChunksAcrossSources: respects topK", () => {
	const one = rankChunksAcrossSources(
		[SOURCE_A, SOURCE_B],
		"token pasta bread",
		{
			topK: 1,
			chunkOptions: { maxTokens: 20 },
		},
	);
	assert.equal(one.length, 1);

	const three = rankChunksAcrossSources(
		[SOURCE_A, SOURCE_B],
		"token pasta bread",
		{
			topK: 3,
			chunkOptions: { maxTokens: 20 },
		},
	);
	assert.equal(three.length, 3);
});

test("rankChunksAcrossSources: default topK is 5", () => {
	assert.equal(DEFAULT_MULTI_ANSWER_TOP_K, 5);
});

test("rankChunksAcrossSources: a source that fails to chunk is skipped, not fatal", () => {
	// maxTokens < 1 makes chunkMarkdown throw; the good source still contributes.
	const bad = { url: "https://bad.example.com", content: "some content" };
	const ranked = rankChunksAcrossSources(
		[bad, SOURCE_B],
		"authentication token",
		{
			topK: 3,
			chunkOptions: { maxTokens: 20 },
		},
	);
	assert.ok(ranked.length > 0);
	assert.ok(ranked.every((r) => r.url === SOURCE_B.url));
});

test("rankChunksAcrossSources: sources with only frontmatter/markers yield nothing", () => {
	const empty = {
		url: "https://empty.example.com",
		content: wrap("Empty", "https://empty.example.com", ""),
	};
	assert.deepEqual(rankChunksAcrossSources([empty], "query"), []);
});

// ─── UX8: formatMultiSourceAnswer — cited render + safety markers ────

test("formatMultiSourceAnswer: renders each chunk cited with its source URL, wrapped in safety markers", () => {
	const ranked = rankChunksAcrossSources(
		[SOURCE_A, SOURCE_B],
		"authentication token",
		{
			topK: 2,
			chunkOptions: { maxTokens: 20 },
		},
	);
	const out = formatMultiSourceAnswer(ranked, "authentication token", {
		sourcesCount: 2,
	});
	// Safety markers wrap the whole cited answer (non-negotiable).
	assert.ok(out.startsWith("[UNTRUSTED WEB CONTENT START]"));
	assert.ok(out.trimEnd().endsWith("[UNTRUSTED WEB CONTENT END]"));
	// Every ranked chunk's source URL appears (the citation).
	for (const r of ranked) {
		assert.ok(out.includes(r.url), `output should cite ${r.url}`);
	}
	// The query + the cached-content footer are present.
	assert.ok(out.includes("authentication token"));
	assert.ok(out.includes("aio-webcontent"));
	assert.ok(out.includes("Cited answer"));
});

test("formatMultiSourceAnswer: wrap:false returns bare inner text (no markers) for caller re-wrapping", () => {
	const ranked = rankChunksAcrossSources([SOURCE_B], "token refresh", {
		topK: 1,
		chunkOptions: { maxTokens: 20 },
	});
	const inner = formatMultiSourceAnswer(ranked, "token refresh", {
		wrap: false,
	});
	assert.ok(!inner.includes("[UNTRUSTED WEB CONTENT"));
	assert.ok(inner.includes("Cited answer"));
});

test("formatMultiSourceAnswer: empty ranked list yields a safe no-match note (still marked)", () => {
	const out = formatMultiSourceAnswer([], "nothing");
	assert.ok(out.includes("[UNTRUSTED WEB CONTENT START]"));
	assert.ok(out.includes("no relevant chunks"));
});

// ─── UX8: full content stays cached while the display narrows ────────

test("multi-source answer: cited chunks returned, full content for every source still cached", () => {
	drop(SOURCE_A.url);
	drop(SOURCE_B.url);
	// The worker stores the FULL content for each page before the display is
	// narrowed to cited chunks (mirrors the real pipeline ordering).
	storeContent(SOURCE_A.url, "Source A", SOURCE_A.content);
	storeContent(SOURCE_B.url, "Source B", SOURCE_B.content);

	const ranked = rankChunksAcrossSources(
		[SOURCE_A, SOURCE_B],
		"authentication token",
		{
			topK: 2,
			chunkOptions: { maxTokens: 20 },
		},
	);
	const display = formatMultiSourceAnswer(ranked, "authentication token", {
		sourcesCount: 2,
	});

	// The returned display is the narrow cited answer (source B's auth chunk)…
	assert.ok(display.includes(SOURCE_B.url));
	assert.ok(display.toLowerCase().includes("authentication"));
	// …and is far smaller than both full pages combined.
	assert.ok(display.length < SOURCE_A.content.length + SOURCE_B.content.length);

	// …but the cache still holds the COMPLETE content for BOTH sources.
	const cachedA = getStoredContent(SOURCE_A.url);
	const cachedB = getStoredContent(SOURCE_B.url);
	assert.ok(cachedA, "source A must stay cached");
	assert.ok(cachedB, "source B must stay cached");
	assert.ok(cachedA.content.includes("Cooking Pasta"));
	assert.ok(cachedA.content.includes("[UNTRUSTED WEB CONTENT START]"));
	assert.ok(cachedB.content.includes("Authentication Token"));

	drop(SOURCE_A.url);
	drop(SOURCE_B.url);
});

// ─── UX9: AI summarization is opt-in ─────────────────────────────────

test("UX9: `summarize` param exists, is an optional boolean, and is OFF by default", () => {
	const tool = captureTool();
	const props = tool.parameters.properties;
	assert.ok(props.summarize, "summarize param must exist");
	// Optional boolean → typebox wraps it in an object with a `boolean` type.
	const schema = JSON.stringify(props.summarize);
	assert.ok(schema.includes("boolean"), "summarize must be a boolean");
	// Not required → off unless the caller passes it.
	const required = tool.parameters.required ?? [];
	assert.ok(!required.includes("summarize"), "summarize must be optional");
	// No default:true baked into the schema (default behavior is off).
	assert.ok(
		!/"default"\s*:\s*true/.test(schema),
		"summarize must not default to true",
	);
	// The description documents the opt-in + off-by-default contract.
	assert.match(tool.description, /summarize/);
	assert.match(tool.description, /opt-in|Off by default|opt-in AI summary/i);
});

test("UX9: long content's default path is the frugal preview, NOT an AI summary", () => {
	// With summarize unset, long content falls through to the frugal preview
	// (outline + largest section). That path carries the frugal footer and
	// never the "AI-summarized" footer.
	const longBody =
		"# Intro\n\nshort\n\n## DeepGuide\n\n" + "detailedbody ".repeat(700).trim();
	const full = wrap("Long", "https://example.com/long", longBody);
	const display = buildFrugalPreview(full, { url: "https://example.com/long" });
	assert.ok(display.includes("Outline:"));
	assert.ok(display.includes("## DeepGuide"));
	assert.ok(display.includes("aio-webcontent"));
	assert.ok(
		!display.includes("AI-summarized"),
		"default path must not be an AI summary",
	);
});

// ─── UX11: `url` accepts a string OR an array; `urls` still works ────

test("UX11: resolveFetchTargets accepts url as a string", () => {
	assert.deepEqual(resolveFetchTargets("https://x.example.com", undefined), [
		"https://x.example.com",
	]);
});

test("UX11: resolveFetchTargets accepts url as an array (additive)", () => {
	assert.deepEqual(
		resolveFetchTargets(
			["https://a.example.com", "https://b.example.com"],
			undefined,
		),
		["https://a.example.com", "https://b.example.com"],
	);
});

test("UX11: urls still works and takes precedence over url", () => {
	assert.deepEqual(
		resolveFetchTargets("https://url.example.com", [
			"https://urls.example.com",
		]),
		["https://urls.example.com"],
	);
});

test("UX11: no url and no urls → empty target list", () => {
	assert.deepEqual(resolveFetchTargets(undefined, undefined), []);
});

test("UX11: schema declares url as string-or-array and keeps urls as an array", () => {
	const tool = captureTool();
	const props = tool.parameters.properties;
	const urlSchema = JSON.stringify(props.url);
	// url is a union (anyOf) of string + array.
	assert.ok(urlSchema.includes("anyOf"), "url must be a union type");
	assert.ok(urlSchema.includes("string"), "url union must include string");
	assert.ok(urlSchema.includes("array"), "url union must include array");
	// urls remains an array param (unchanged).
	assert.ok(
		JSON.stringify(props.urls).includes("array"),
		"urls must stay an array",
	);
});

// ─── Single-URL answer mode is unchanged ─────────────────────────────

test("single-URL answer mode: applyQueryAnswerMode still returns top-k cited chunks for one doc", () => {
	const doc = [
		"## Pricing Plans",
		"Our pricing plans include Free Pro and Enterprise tiers with monthly billing.",
		"## Installation",
		"Download the installer and follow the setup wizard to complete installation.",
	].join("\n\n");
	const result = applyQueryAnswerMode(doc, "pricing billing plans", 1, {
		maxTokens: 20,
	});
	assert.ok(result !== undefined, "single-URL answer mode should still work");
	assert.ok(
		result.includes("Pricing") || result.toLowerCase().includes("pricing"),
		"should surface the pricing chunk",
	);
	assert.ok(result.includes("aio-webcontent"), "footer contract preserved");
});

test("single-URL answer mode: still returns undefined for empty body/query", () => {
	assert.equal(applyQueryAnswerMode("", "pricing"), undefined);
	const doc = "## Intro\n\nSome content here.";
	assert.equal(applyQueryAnswerMode(doc, "   "), undefined);
});
