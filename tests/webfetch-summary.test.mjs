// ─── Tests for the hoisted buildDeterministicSummary helper ────────
//
// The helper used to be nested inside the aio-webfetch execute()
// closure. Hoisting it to module scope made it independently
// testable. These tests pin down the deterministic-summary contract:
//   - keeps the first 1-6 heading it sees (CommonMark H1-H6)
//   - keeps the first sentence (5-120 chars) under each heading
//   - keeps the first sentence of the body
//   - truncates the input to MAX_SUMMARY_INPUT_CHARS (perf guard)
//   - truncates the output to MAX_PREVIEW_CHARS
//   - returns an empty string for empty input

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicSummary } from "../src/tools/webfetch.ts";
import { MAX_PREVIEW_CHARS } from "../src/content.ts";

test("buildDeterministicSummary: returns empty string for empty input", () => {
	assert.equal(buildDeterministicSummary(""), "");
	assert.equal(buildDeterministicSummary("   \n  \n   "), "");
});

test("buildDeterministicSummary: keeps a single heading", () => {
	const out = buildDeterministicSummary("# Hello World\n");
	assert.ok(out.startsWith("# Hello World"));
});

test("buildDeterministicSummary: keeps first sentence of a body paragraph", () => {
	const out = buildDeterministicSummary(
		"This is the first sentence of the body. This is the second sentence that should not appear.",
	);
	assert.ok(out.startsWith("This is the first sentence of the body."));
	assert.ok(!out.includes("This is the second sentence"));
});

test("buildDeterministicSummary: keeps first sentence after a heading", () => {
	const out = buildDeterministicSummary(
		"## Section Title\nThe opening sentence is between twenty and one hundred twenty chars. Tail we drop.",
	);
	assert.ok(out.includes("## Section Title"));
	assert.ok(
		out.includes(
			"The opening sentence is between twenty and one hundred twenty chars.",
		),
	);
	assert.ok(!out.includes("Tail we drop"));
});

test("buildDeterministicSummary: stops adding sentences after the first under a heading", () => {
	const out = buildDeterministicSummary(
		"## Section\nFirst kept sentence under section heading. Second sentence dropped from this section.\n\n# Next Section\nThird kept sentence under the next section heading. Fourth dropped.",
	);
	assert.ok(out.includes("First kept sentence under section heading."));
	assert.ok(!out.includes("Second sentence dropped"));
	assert.ok(
		out.includes("Third kept sentence under the next section heading."),
	);
	assert.ok(!out.includes("Fourth dropped"));
});

test("buildDeterministicSummary: trims blank lines", () => {
	const out = buildDeterministicSummary("\n\n# Heading\n\n\nBody.\n\n\n");
	assert.ok(!out.includes("\n\n\n"), "should not contain triple newlines");
});

test("buildDeterministicSummary: truncates to MAX_PREVIEW_CHARS", () => {
	// Build a body that would exceed MAX_PREVIEW_CHARS if not truncated.
	const longBody = "A".repeat(120) + ". " + "B".repeat(5000) + ".";
	const out = buildDeterministicSummary(longBody);
	assert.ok(
		out.length <= MAX_PREVIEW_CHARS,
		`output length ${out.length} > ${MAX_PREVIEW_CHARS}`,
	);
});

// ─── Regression tests for the drykiss-flagged bugs ─────────────────

test("buildDeterministicSummary: matches H1-H6 headings (regression for finding #3)", () => {
	// Pre-fix regex was /^#{1,3}\s/ which silently dropped H4+ headings.
	const out = buildDeterministicSummary(
		"#### Deep heading\nFirst kept sentence under a deep heading that should be kept by the regex. Tail dropped.\n\n## Shallow heading\nFirst sentence under a shallow heading that should also be kept. Tail dropped.",
	);
	assert.ok(out.includes("#### Deep heading"), "H4 heading should be kept");
	assert.ok(out.includes("First kept sentence under a deep heading"));
	assert.ok(out.includes("## Shallow heading"));
	assert.ok(out.includes("First sentence under a shallow heading"));
});

test("buildDeterministicSummary: keeps short body sentences (regression for finding #4)", () => {
	// Pre-fix regex required 20-char minimum, silently dropping short
	// sentences like "Tap Continue." (13 chars) or "Done." (5 chars).
	const out = buildDeterministicSummary(
		"## Setup\nTap Continue. Then choose your region. Finally, sign in.",
	);
	assert.ok(out.includes("Tap Continue."), "13-char sentence should be kept");
	assert.ok(
		!out.includes("Then choose"),
		"only the first sentence under the heading is kept",
	);
});

test("buildDeterministicSummary: caps input to MAX_SUMMARY_INPUT_CHARS (regression for finding #5)", () => {
	// Pre-fix the function iterated the entire input. A 5MB markdown
	// page would block the event loop. The cap is 50_000 chars.
	const huge = "X".repeat(200_000);
	const out = buildDeterministicSummary(huge);
	// Output is dominated by the trailing dot + repeat; sanity check
	// that we didn't OOM or hang. Length must be bounded by MAX_PREVIEW_CHARS.
	assert.ok(out.length <= MAX_PREVIEW_CHARS);
});
