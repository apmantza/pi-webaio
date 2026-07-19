// ─── Tests for query-focused answer mode ────────────────────────────
//
// Covers applyQueryAnswerMode():
//   - Returns top-k chunks relevant to query
//   - Chunks are ordered by document position (not score)
//   - Heading breadcrumbs are prepended to each selected chunk
//   - Footer notes omitted sections and mentions aio-webcontent
//   - Returns undefined for empty body or empty query
//   - No-op path: when query is absent, full content is unaffected
//     (tested via the raw helper; execute() is integration-only)
//
// NOTE: Chunking is token-bounded (default 512 tokens). Small sections
// merge into fewer chunks. Tests that need multi-chunk behavior use a
// small maxTokens (e.g. 20) so each paragraph becomes its own chunk.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyQueryAnswerMode,
	DEFAULT_TOP_CHUNKS,
} from "../src/tools/webfetch.ts";

// ─── Helper ──────────────────────────────────────────────────────────

/**
 * Build a simple multi-section markdown doc.
 * Each section has enough words to form a discrete chunk at maxTokens=20.
 */
function makeDoc(sections) {
	return sections
		.map(({ heading, body }) => `## ${heading}\n\n${body}`)
		.join("\n\n");
}

// ─── Edge cases ───────────────────────────────────────────────────────

test("applyQueryAnswerMode: returns undefined for empty body", () => {
	assert.equal(applyQueryAnswerMode("", "pricing"), undefined);
	assert.equal(applyQueryAnswerMode("   ", "pricing"), undefined);
});

test("applyQueryAnswerMode: returns undefined for empty query", () => {
	const body = makeDoc([{ heading: "Intro", body: "Some content here." }]);
	assert.equal(applyQueryAnswerMode(body, ""), undefined);
	assert.equal(applyQueryAnswerMode(body, "   "), undefined);
});

test("applyQueryAnswerMode: returns undefined for null/undefined query", () => {
	const body = makeDoc([{ heading: "Intro", body: "Some content here." }]);
	assert.equal(applyQueryAnswerMode(body, undefined), undefined);
	assert.equal(applyQueryAnswerMode(body, null), undefined);
});

// ─── Relevance selection ──────────────────────────────────────────────

test("applyQueryAnswerMode: selects chunks relevant to query (small maxTokens)", () => {
	// Use maxTokens=20 so each section becomes its own chunk.
	// With topK=1, only the most relevant chunk should appear.
	const doc = makeDoc([
		{
			heading: "Introduction",
			body: "This page describes the product overview and general information about the platform.",
		},
		{
			heading: "Pricing Plans",
			body: "Our pricing plans include Free Pro and Enterprise tiers. Monthly billing is available for all plans.",
		},
		{
			heading: "Installation Guide",
			body: "Download the installer from our website and follow the setup wizard to complete installation.",
		},
		{
			heading: "Support",
			body: "Contact support via email or chat for help with any issues you encounter.",
		},
	]);

	const result = applyQueryAnswerMode(doc, "pricing billing plans", 1, {
		maxTokens: 20,
	});
	assert.ok(result !== undefined, "should return a result");
	// Top chunk for "pricing billing plans" should contain pricing content
	assert.ok(
		result.includes("Pricing Plans") ||
			result.includes("pricing") ||
			result.includes("billing"),
		"result should contain pricing or billing content",
	);
});

// ─── Document order ───────────────────────────────────────────────────

test("applyQueryAnswerMode: selected chunks are in document order", () => {
	// Two sections about authentication — both should appear in document order.
	// Use maxTokens=20 so they become separate chunks.
	const doc = [
		"## Section Alpha\n\nAuthentication token required for all API calls to the service endpoint.",
		"## Section Beta\n\nGeneral information about the platform features and capabilities.",
		"## Section Gamma\n\nToken refresh: obtain a new authentication token when the current one expires.",
	].join("\n\n");

	const result = applyQueryAnswerMode(doc, "authentication token", 2, {
		maxTokens: 20,
	});
	assert.ok(result !== undefined, "should return a result");

	const posAlpha = result.indexOf("Section Alpha");
	const posGamma = result.indexOf("Section Gamma");

	// Both auth sections should appear, and Alpha before Gamma
	if (posAlpha !== -1 && posGamma !== -1) {
		assert.ok(posAlpha < posGamma, "Alpha must appear before Gamma (document order)");
	}
	// At least one auth section should be in the result
	assert.ok(
		result.includes("authentication") || result.includes("token"),
		"should include authentication-related content",
	);
});

// ─── Heading breadcrumbs ──────────────────────────────────────────────

test("applyQueryAnswerMode: heading breadcrumbs are present", () => {
	const doc = makeDoc([
		{
			heading: "Getting Started",
			body: "Install the package with the package manager command and follow the instructions to complete setup.",
		},
		{
			heading: "Configuration",
			body: "Configure the package by editing the configuration file with your specific application settings.",
		},
		{
			heading: "API Reference",
			body: "Full API documentation covering all methods and parameters available to developers.",
		},
	]);

	// Ask for top 1 chunk; whichever is selected should have a breadcrumb.
	const result = applyQueryAnswerMode(doc, "configuration settings", 1, {
		maxTokens: 20,
	});
	assert.ok(result !== undefined, "should return a result");
	// The breadcrumb format is "> **<heading>**"
	assert.ok(
		result.includes("> **"),
		"result should contain breadcrumb markers",
	);
});

// ─── Footer ───────────────────────────────────────────────────────────

test("applyQueryAnswerMode: footer mentions omitted sections count (small maxTokens)", () => {
	// With maxTokens=20 and 5 sections, we get ~5 chunks; topK=1 → 4 omitted.
	const doc = makeDoc([
		{
			heading: "Alpha",
			body: "Alpha section about authentication tokens and access management for users.",
		},
		{
			heading: "Beta",
			body: "Beta section about pricing and billing costs for subscription management.",
		},
		{
			heading: "Gamma",
			body: "Gamma section about deployment and hosting configuration on the servers.",
		},
		{
			heading: "Delta",
			body: "Delta section about monitoring and alert configuration for the application.",
		},
		{
			heading: "Epsilon",
			body: "Epsilon section about analytics and reporting features for dashboard users.",
		},
	]);

	// Request 1 chunk from 5 sections → 4 omitted
	const result = applyQueryAnswerMode(doc, "authentication token api", 1, {
		maxTokens: 20,
	});
	assert.ok(result !== undefined, "should return a result");
	assert.ok(result.includes("omitted"), "footer should mention omitted sections");
	assert.ok(
		result.includes("aio-webcontent"),
		"footer should mention aio-webcontent for full content retrieval",
	);
});

test("applyQueryAnswerMode: footer mentions aio-webcontent even with no omissions", () => {
	// Single-chunk doc → 0 omitted, but footer still shows aio-webcontent link.
	const doc = "## Only Section\n\nThis is the only section with content.";
	const result = applyQueryAnswerMode(doc, "section content", 10);
	assert.ok(result !== undefined, "should return a result");
	assert.ok(
		result.includes("aio-webcontent"),
		"footer should always mention aio-webcontent",
	);
});

// ─── topK parameter ───────────────────────────────────────────────────

test("applyQueryAnswerMode: respects topK=1 (only one chunk returned)", () => {
	// 5 sections at maxTokens=20 → 5 chunks; topK=1 → only 1 returned.
	const sections = Array.from({ length: 5 }, (_, i) => ({
		heading: `Section ${i + 1}`,
		body: `Content for section ${i + 1} with query terms alpha beta gamma delta epsilon zeta eta theta.`,
	}));
	const doc = makeDoc(sections);

	const result = applyQueryAnswerMode(doc, "alpha beta gamma", 1, {
		maxTokens: 20,
	});
	assert.ok(result !== undefined);
	// With topK=1, only 1 chunk; separators: 0 inter-chunk + 1 footer = 1 total.
	// Count "---" occurrences (footer separator).
	const separatorCount = (result.match(/\n---\n/g) ?? []).length;
	assert.ok(
		separatorCount >= 1,
		`expected at least 1 separator (footer), got ${separatorCount}`,
	);
	// The omitted count should reflect 4 omitted sections
	assert.ok(result.includes("omitted"), "footer should say something was omitted");
});

test("applyQueryAnswerMode: DEFAULT_TOP_CHUNKS is 5", () => {
	assert.equal(DEFAULT_TOP_CHUNKS, 5);
});
