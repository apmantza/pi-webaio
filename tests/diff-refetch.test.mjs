// ─── Tests for diff-aware refetch (issue #45) ────────────────────────
//
// Covers:
//   - splitSections: splits markdown by H1-H6 headings
//   - diffContent: section-level diff — added/removed/changed
//   - diffContent: unchanged short-circuit (identical content)
//   - diffContent: fallback line diff when no headings present
//   - diffContent: reports "unchanged" for content with same body but whitespace trim

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitSections, diffContent } from "../src/content-diff.ts";

// ─── splitSections ────────────────────────────────────────────────────

test("splitSections: empty string yields no sections", () => {
	const sections = splitSections("");
	assert.equal(sections.length, 0);
});

test("splitSections: content with no headings yields preamble section", () => {
	const md = "Hello world.\nThis is a paragraph.";
	const sections = splitSections(md);
	// Preamble is only emitted when there's body content
	assert.equal(sections.length, 1);
	assert.equal(sections[0].key, "__preamble__");
	assert.ok(sections[0].body.includes("Hello world."));
});

test("splitSections: splits by H2 headings", () => {
	const md = "## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.";
	const sections = splitSections(md);
	assert.equal(sections.length, 2);
	assert.equal(sections[0].key, "alpha");
	assert.equal(sections[1].key, "beta");
	assert.ok(sections[0].body.includes("Alpha body."));
	assert.ok(sections[1].body.includes("Beta body."));
});

test("splitSections: handles H1 through H6", () => {
	const md = [
		"# H1",
		"Body 1.",
		"## H2",
		"Body 2.",
		"### H3",
		"Body 3.",
		"#### H4",
		"Body 4.",
		"##### H5",
		"Body 5.",
		"###### H6",
		"Body 6.",
	].join("\n\n");
	const sections = splitSections(md);
	assert.equal(sections.length, 6);
	assert.equal(sections[0].key, "h1");
	assert.equal(sections[5].key, "h6");
});

test("splitSections: preserves heading text in `heading` field", () => {
	const md = "## My Section Title\n\nContent here.";
	const sections = splitSections(md);
	assert.equal(sections[0].heading, "## My Section Title");
	assert.equal(sections[0].key, "my section title");
});

// ─── diffContent: identical content ───────────────────────────────────

test("diffContent: identical content returns unchanged=true", () => {
	const content = "## Section\n\nSame content.";
	const result = diffContent(content, content);
	assert.equal(result.unchanged, true);
	assert.equal(result.addedSections.length, 0);
	assert.equal(result.removedSections.length, 0);
	assert.equal(result.changedSections.length, 0);
	assert.ok(result.summary.includes("identical"));
});

// ─── diffContent: added sections ──────────────────────────────────────

test("diffContent: detects added section", () => {
	const oldContent = "## Alpha\n\nAlpha body.";
	const newContent = "## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.";
	const result = diffContent(oldContent, newContent);
	assert.equal(result.unchanged, false);
	assert.equal(result.addedSections.length, 1);
	assert.ok(result.addedSections[0].includes("Beta"));
	assert.equal(result.removedSections.length, 0);
	assert.equal(result.changedSections.length, 0);
	assert.ok(result.summary.includes("Added"));
});

// ─── diffContent: removed sections ────────────────────────────────────

test("diffContent: detects removed section", () => {
	const oldContent = "## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.";
	const newContent = "## Alpha\n\nAlpha body.";
	const result = diffContent(oldContent, newContent);
	assert.equal(result.unchanged, false);
	assert.equal(result.removedSections.length, 1);
	assert.ok(result.removedSections[0].includes("Beta"));
	assert.equal(result.addedSections.length, 0);
	assert.equal(result.changedSections.length, 0);
	assert.ok(result.summary.includes("Removed"));
});

// ─── diffContent: changed sections ────────────────────────────────────

test("diffContent: detects changed section body", () => {
	const oldContent = "## Alpha\n\nOriginal alpha body.";
	const newContent = "## Alpha\n\nUpdated alpha body with new info.";
	const result = diffContent(oldContent, newContent);
	assert.equal(result.unchanged, false);
	assert.equal(result.changedSections.length, 1);
	assert.ok(result.changedSections[0].includes("Alpha"));
	assert.equal(result.addedSections.length, 0);
	assert.equal(result.removedSections.length, 0);
	assert.ok(result.summary.includes("Changed"));
});

// ─── diffContent: combined changes ────────────────────────────────────

test("diffContent: handles add + remove + change simultaneously", () => {
	const oldContent = [
		"## Intro\n\nOld intro.",
		"## Features\n\nOld features.",
		"## Deprecated\n\nOld deprecated section.",
	].join("\n\n");
	const newContent = [
		"## Intro\n\nNew intro.",
		"## Features\n\nOld features.",
		"## New Section\n\nBrand new section.",
	].join("\n\n");
	const result = diffContent(oldContent, newContent);
	assert.equal(result.unchanged, false);
	assert.equal(result.changedSections.length, 1); // Intro changed
	assert.equal(result.removedSections.length, 1); // Deprecated removed
	assert.equal(result.addedSections.length, 1);   // New Section added
});

// ─── diffContent: no headings → line diff fallback ────────────────────

test("diffContent: falls back to line diff for plain text", () => {
	const oldContent = "Line one.\nLine two.\nLine three.";
	const newContent = "Line one.\nLine four.\nLine three.";
	const result = diffContent(oldContent, newContent);
	assert.equal(result.unchanged, false);
	// Line diff reports addedSections/removedSections empty (those are section-level)
	assert.ok(result.summary.length > 0, "should produce a non-empty summary");
});

test("diffContent: identical plain text (no headings) returns unchanged", () => {
	const content = "Hello world.\nThis is plain text.";
	const result = diffContent(content, content);
	assert.equal(result.unchanged, true);
});

// ─── diffContent: whitespace-only body differences ────────────────────

test("diffContent: sections with same trimmed body are not marked changed", () => {
	const oldContent = "## Section\n\nBody text.";
	const newContent = "## Section\n\n  Body text.  ";
	const result = diffContent(oldContent, newContent);
	// trimmed body comparison: "Body text." === "Body text." → unchanged
	assert.equal(result.unchanged, true);
});

// ─── diffContent: summary format ──────────────────────────────────────

test("diffContent: summary uses + prefix for added, - for removed, ~ for changed", () => {
	const oldContent = "## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.";
	const newContent = "## Alpha\n\nAlpha updated.\n\n## Gamma\n\nGamma body.";
	const result = diffContent(oldContent, newContent);
	// Alpha changed, Beta removed, Gamma added
	assert.ok(result.summary.includes("+ ## Gamma"), "added uses + prefix");
	assert.ok(result.summary.includes("- ## Beta"), "removed uses - prefix");
	assert.ok(result.summary.includes("~ ## Alpha"), "changed uses ~ prefix");
});
