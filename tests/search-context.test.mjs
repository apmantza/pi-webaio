// ─── Tests for search-context summary bias fixes ───────────────────
//
// Covers the three guards added around the "bridge the last websearch
// query into the AI summary" feature:
//   (a) relatedness gate SKIPS context on ~zero overlap
//   (b) relatedness gate INJECTS context on clear overlap
//   (c) focused-summary annotation present when injected, absent when not
//   (d) summary cache keyed by URL+context so a biased (with-context)
//       summary is never served for a no-context request, and vice versa

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	focusedSummaryAnnotation,
	SEARCH_CONTEXT_RELATEDNESS_THRESHOLD,
	shouldInjectSearchContext,
	summaryCache,
	summaryCacheKey,
} from "../src/session-store.ts";

// ─── (a) gate skips on ~zero overlap ────────────────────────────────

test("gate: skips context when query has ~zero overlap with the page", () => {
	// Reproduced bug: a TypeScript search biased an unrelated
	// information-retrieval article. No shared terms → must NOT inject.
	assert.equal(
		shouldInjectSearchContext("typescript 7 release notes", {
			url: "https://blog.example.com/information-retrieval-basics",
			title: "Information Retrieval Basics",
			heading: "How search engines rank documents",
		}),
		false,
	);
});

test("gate: skips on empty query or empty page", () => {
	assert.equal(shouldInjectSearchContext("", { title: "Anything" }), false);
	assert.equal(shouldInjectSearchContext("   ", { title: "Anything" }), false);
	assert.equal(shouldInjectSearchContext("typescript release", {}), false);
});

test("gate: skips on a single weak/ambiguous term overlap", () => {
	// Only one generic term overlaps; below the conservative threshold.
	assert.equal(
		shouldInjectSearchContext("typescript compiler internals", {
			url: "https://example.com/docs",
			title: "General documentation overview",
			heading: "typescript",
		}),
		false,
	);
});

// ─── (b) gate injects on clear overlap ──────────────────────────────

test("gate: injects context when query clearly overlaps the page", () => {
	assert.equal(
		shouldInjectSearchContext("typescript 7 release notes", {
			url: "https://devblogs.microsoft.com/typescript/announcing-typescript-7-0",
			title: "Announcing TypeScript 7.0",
			heading: "TypeScript 7.0 Release Notes",
		}),
		true,
	);
});

test("gate: injects on title match alone", () => {
	assert.equal(
		shouldInjectSearchContext("playwright browser automation", {
			url: "https://example.com/x",
			title: "Playwright browser automation guide",
		}),
		true,
	);
});

test("gate: threshold is exported and positive", () => {
	assert.ok(SEARCH_CONTEXT_RELATEDNESS_THRESHOLD > 0);
});

// ─── (c) annotation present when injected, absent when not ──────────

test("annotation: includes the query and is non-empty", () => {
	const note = focusedSummaryAnnotation("typescript 7 release notes");
	assert.ok(note.includes("typescript 7 release notes"));
	assert.ok(note.includes("focused on prior search"));
	assert.ok(note.startsWith("\n\n"), "appends on its own line");
});

test("annotation: empty for empty/whitespace query (nothing appended)", () => {
	assert.equal(focusedSummaryAnnotation(""), "");
	assert.equal(focusedSummaryAnnotation("   "), "");
});

test("annotation: only added on the injected path (integration of gate + annotation)", () => {
	// Simulate the call-site logic: annotate iff the gate passes.
	const query = "typescript 7 release notes";

	const relatedPage = {
		url: "https://devblogs.microsoft.com/typescript/announcing-typescript-7-0",
		title: "Announcing TypeScript 7.0",
	};
	const unrelatedPage = {
		url: "https://blog.example.com/information-retrieval-basics",
		title: "Information Retrieval Basics",
	};

	const base = "- bullet one\n- bullet two";

	const relatedInject = shouldInjectSearchContext(query, relatedPage);
	const relatedSummary = base + (relatedInject ? focusedSummaryAnnotation(query) : "");
	assert.equal(relatedInject, true);
	assert.ok(relatedSummary.includes("focused on prior search"));

	const unrelatedInject = shouldInjectSearchContext(query, unrelatedPage);
	const unrelatedSummary =
		base + (unrelatedInject ? focusedSummaryAnnotation(query) : "");
	assert.equal(unrelatedInject, false);
	assert.ok(!unrelatedSummary.includes("focused on prior search"));
	assert.equal(unrelatedSummary, base, "no-context path is byte-for-byte unchanged");
});

// ─── (d) cache keyed by URL + context ───────────────────────────────

test("cache key: no-context and with-context keys are distinct", () => {
	const url = "https://example.com/article";
	const noCtx = summaryCacheKey(url);
	const withCtx = summaryCacheKey(url, "typescript 7 release notes");
	assert.notEqual(noCtx, withCtx);
});

test("cache key: no-context key is the bare normalized URL", () => {
	assert.equal(
		summaryCacheKey("https://example.com/article"),
		"https://example.com/article",
	);
	assert.equal(summaryCacheKey("https://example.com/article", "   "), "https://example.com/article");
});

test("cache key: context is normalized (case + whitespace)", () => {
	assert.equal(
		summaryCacheKey("https://example.com/a", "TypeScript   7"),
		summaryCacheKey("https://example.com/a", "typescript 7"),
	);
});

test("cache key: different contexts produce different keys", () => {
	assert.notEqual(
		summaryCacheKey("https://example.com/a", "typescript 7"),
		summaryCacheKey("https://example.com/a", "rust async"),
	);
});

test("cache: a biased (with-context) summary is NOT served for a no-context request, and vice versa", () => {
	const url = "https://example.com/article";
	const ctx = "typescript 7 release notes";
	const ctxKey = summaryCacheKey(url, ctx);
	const noCtxKey = summaryCacheKey(url);

	// Store a biased summary under the with-context key.
	summaryCache.set(ctxKey, "- biased summary\n\n_[focused on prior search: \"typescript 7 release notes\"]_");
	// Store a neutral summary under the no-context key.
	summaryCache.set(noCtxKey, "- neutral summary");

	// A no-context request must get the neutral summary, never the biased one.
	assert.equal(summaryCache.get(noCtxKey), "- neutral summary");
	assert.ok(!summaryCache.get(noCtxKey).includes("focused on prior search"));

	// A with-context request must get the biased summary, never the neutral one.
	assert.ok(summaryCache.get(ctxKey).includes("focused on prior search"));

	// A request with a DIFFERENT context must miss both (no collision).
	assert.equal(summaryCache.get(summaryCacheKey(url, "rust async")), undefined);

	// Cleanup so we don't leak state into other tests.
	summaryCache.delete(ctxKey);
	summaryCache.delete(noCtxKey);
});

test("cache: no-context key can never collide with any context key", () => {
	// The separator is a null byte, which cannot appear in a real URL, so
	// the bare-URL (no-context) key is always distinct from context keys.
	const url = "https://example.com/article";
	assert.ok(!summaryCacheKey(url).includes("\u0000ctx:"));
	assert.ok(summaryCacheKey(url, "anything").includes("\u0000ctx:"));
});
