// #212 — MDX component tags leaked into extracted markdown as prose.
//
// The destructive fix is the obvious one: a global /<\/?[A-Z][a-zA-Z]*\b…>/ strip.
// Measured on the real react.dev page that corrupts 13 legitimate JSX lines inside code
// fences to clean 9 stray lines in prose. So every assertion here is paired: the SAME tag
// must be removed in prose and preserved inside a fence, in one fixture.
//
// The rule that makes this safe is a property, not an allowlist: a line that is NOTHING
// BUT a component tag carries no prose at all. Prose that documents a component reads
// "Use `<Suspense>` to defer…" — the tag is inline and the line has other text, so it is
// never a lone-tag line and never touched.
import assert from "node:assert";
import test from "node:test";
import { cleanMarkdown } from "../src/markdown-clean.ts";

const DOC = [
	"Intro paragraph that explains the feature.",
	"",
	"<Note>",
	"",
	"The important explanation the caller actually wants.",
	"",
	"</Note>",
	"",
	"Closing paragraph.",
].join("\n");

test("#212: a lone MDX tag line is dropped, its content survives", () => {
	const out = cleanMarkdown(DOC);
	assert.ok(!/^<Note>\s*$/m.test(out), `<Note> survived in prose:\n${out}`);
	assert.ok(!/^<\/Note>\s*$/m.test(out), `</Note> survived in prose:\n${out}`);
	assert.match(out, /The important explanation the caller actually wants\./);
	assert.match(out, /Intro paragraph that explains the feature\./);
	assert.match(out, /Closing paragraph\./);
});

test("#212: the SAME tag inside a fence is preserved verbatim", () => {
	// The paired half of the assertion. Without it the naive global strip passes this
	// file and silently eats every JSX example on a framework docs page.
	const doc = [
		"Prose before.",
		"",
		"<Note>",
		"",
		"```jsx",
		"function A() {",
		"  return <Note>child</Note>;",
		"}",
		"```",
	].join("\n");
	const out = cleanMarkdown(doc);
	assert.ok(!/^<Note>\s*$/m.test(out), "prose-side tag should be dropped");
	assert.ok(
		out.includes("  return <Note>child</Note>;"),
		`fenced JSX was altered:\n${out}`,
	);
	// Indentation inside the fence is the program's, not decoration.
	assert.ok(out.includes("function A() {"), "fence body lost its structure");
});

test("#212: a tag with attributes is dropped when the line is nothing but the tag", () => {
	const out = cleanMarkdown(["Aa.", "", '<Expandable title="Why this exists">', "", "Bb."].join("\n"));
	assert.ok(!/Expandable/.test(out), `attributed tag survived:\n${out}`);
	assert.match(out, /Aa\./);
	assert.match(out, /Bb\./);
});

test("#212: inline tags in prose are NEVER touched", () => {
	// This is the case an allowlist cannot get right and a property can: a page that
	// documents <Suspense> has the tag in the sentence, and the sentence is content.
	const line = "Wrap the deferred subtree in `<Suspense>` to avoid blocking the note.";
	assert.equal(cleanMarkdown(line), line, "prose documenting a component was rewritten");
});

test("#212: lowercase HTML is not the target", () => {
	// HTML→markdown already handles these; claiming them would widen the rule into
	// ordinary markup with no evidence it is needed.
	const line = "A sentence with an inline <abbr title=\"x\">term</abbr> in it.";
	assert.equal(cleanMarkdown(line), line);
	// The sharper half: `<details>` / `<summary>` are legitimate STANDALONE HTML in
	// markdown and carry disclosure semantics a renderer acts on. A lone uppercase-only
	// rule must leave them alone; widening the character class to lowercase breaks this.
	const block = ["Prose.", "", "<details>", "", "<summary>Hidden answer</summary>", "", "Body.", "", "</details>"].join("\n");
	const out = cleanMarkdown(block);
	assert.ok(out.includes("<details>"), `semantic HTML dropped:\n${out}`);
	assert.ok(out.includes("</details>"), `closing semantic HTML dropped:\n${out}`);
	assert.ok(out.includes("<summary>Hidden answer</summary>"), "summary content lost");
});

test("#212: a lone tag line carrying a JSX expression is preserved", () => {
	// `<Suspense fallback={<Spinner />}>` contains an element child, so it is code-like
	// rather than scaffolding. This is what the `<`/`>` exclusion in the attribute part of
	// the rule buys; removing it would let the pattern swallow lines with real content.
	const line = "<Suspense fallback={<Spinner />}>";
	assert.equal(cleanMarkdown(line), line, "a tag carrying a JSX child was dropped");
});

test("#212: a fence whose BODY is lone tag lines is preserved verbatim", () => {
	// The strongest form of the fence requirement, and the one the first version of this
	// suite missed: a JSX example that SHOWS the component as scaffolding has `<Note>` on a
	// line of its own inside the fence — textually identical to the prose leaks the rule
	// removes. Only fence state tells them apart. A strip that ignores fence state passes
	// every other test in this file and still corrupts the example.
	const doc = [
		"Use the note component like this:",
		"",
		"```jsx",
		"<Note>",
		"  hello",
		"</Note>",
		"```",
	].join("\n");
	const out = cleanMarkdown(doc);
	assert.ok(/^<Note>$/m.test(out), `fenced opener dropped:\n${out}`);
	assert.ok(/^<\/Note>$/m.test(out), `fenced closer dropped:\n${out}`);
	assert.ok(out.includes("  hello"), "fenced body lost its indentation");
	// And the prose-side tag in the same document is still removed.
	assert.ok(!/\n<Note>\n/.test(out.replace(/```[\s\S]*```/g, "")), "prose-side tag survived");
});

test("#212: a sentence that merely CONTAINS a tag is never dropped", () => {
	// Two shapes that a loosened anchor or a trailing `.*` would eat, both added because
	// the corresponding mutants survived without them.
	//   - the tag at the END of the line (kills an unanchored-start mutant)
	//   - the tag at the START of the line, prose after it (kills a trailing-`.*` mutant)
	const endsWithTag = "Wrap the deferred subtree in <Suspense>";
	assert.equal(cleanMarkdown(endsWithTag), endsWithTag, "prose ending in a tag was dropped");
	const startsWithTag = "<Note> A caveat the reader must keep.";
	assert.equal(cleanMarkdown(startsWithTag), startsWithTag, "prose after a tag was dropped");
	// And they must still be dropped when the line is ONLY the tag.
	assert.ok(!cleanMarkdown("Aa.\n\n<Note>\n\nBb.").includes("<Note>"), "lone tag not dropped");
});

test("#212: fence bookkeeping is unchanged by the strip", () => {
	// A dropped tag line must not be allowed to flip fence state for the lines after it.
	const doc = ["<Note>", "", "```sh", "echo hi", "```", "", "After the fence."].join("\n");
	const out = cleanMarkdown(doc);
	assert.ok(out.includes("```sh") && out.includes("echo hi"), `fence damaged:\n${out}`);
	assert.match(out, /After the fence\./);
	// Balanced: an even number of marker lines.
	assert.equal((out.match(/^(```|~~~)/gm) ?? []).length % 2, 0, "fence parity broken");
});

test("#212: the react.dev shape is cleaned end to end", () => {
	// The observed page leaked 9 lone-tag lines of 6 distinct components. This fixture is
	// that shape, not a copy of the page.
	const doc = [
		"## Server Components with a Server",
		"",
		"<Author>",
		"",
		"Real explanation of streaming on the server.",
		"",
		"</Author>",
		"",
		"<Note>",
		"",
		"A caveat worth keeping.",
		"",
		"</Note>",
		"",
		"<Comments />",
	].join("\n");
	const out = cleanMarkdown(doc);
	for (const t of ["<Author>", "</Author>", "<Note>", "</Note>", "<Comments />"]) {
		assert.ok(!out.includes(t), `${t} survived`);
	}
	assert.match(out, /Real explanation of streaming on the server\./);
	assert.match(out, /A caveat worth keeping\./);
	assert.match(out, /## Server Components with a Server/);
});
