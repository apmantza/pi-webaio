// #212 follow-up: WHY the lone-MDX-tag rule cannot be applied to the pipeline's
// fence-free branches -- a decision pin, not a behaviour request.
//
// After #212 merged I re-fetched react.dev, counted 45 stray tag lines in the saved output,
// and concluded the fix did nothing. Both halves of that were wrong:
//   - the extracted body is clean (`output === cleanMarkdown(output)` is true); the lone-tag
//     lines I counted are all INSIDE code fences, i.e. the JSX examples #212 deliberately
//     preserves. My probe never tracked fence state -- the one thing the issue is about.
//   - the 45 came from the ANSWER-MODE composition, where chunk stitching split a fence
//     (218 fence markers -- an odd count). Filed separately as #216.
//
// The tempting follow-up was to route the remaining body sources -- Readability's flat
// `textContent` (which `chooseArticleBody` may return when the markdown conversion loses
// words, per #165), the RSC branch, and `fallbackExtract` -- through `cleanMarkdown` too.
// That is wrong, and the reason is the rule's own premise.
//
// The rule distinguishes scaffolding from a code example by FENCE STATE. `textContent`
// carries no fences: a `<pre>` in the source HTML arrives as bare lines. So on those
// branches the distinguishing information does not exist, and the rule classifies every
// lone tag as scaffolding -- deleting the reader's code examples along with the markup.
// Deleting document content is the failure #212 exists to prevent, so a leak of
// `<Note>`-style scaffolding is the lesser defect here.
import assert from "node:assert";
import test from "node:test";
import { chooseArticleBody } from "../src/content.ts";
import { cleanMarkdown } from "../src/markdown-clean.ts";

const FLAT = ["Suspense", "<Note>", "A caveat about the API.", "</Note>", "<Button />", "Real article prose explaining the component."].join("\n");

test("the rule cannot tell scaffolding from a code example without fences", () => {
	// The measured reason the branches stay uncleaned. If someone later makes `textContent`
	// carry fence information, THIS is the assertion to invert -- not the one below.
	assert.ok(!cleanMarkdown(FLAT).includes("<Button />"), "premise: on fence-free text the rule deletes the example");
});

test("#212: the flat-text branch keeps its examples rather than being cleaned", () => {
	// `markdown` deliberately carries far fewer words than `flat`, which is exactly when
	// chooseArticleBody returns `flat` -- the fence-free source.
	const body = chooseArticleBody("# Suspense\n\nShort.", FLAT);
	assert.ok(body.includes("Real article prose"), "premise: the flat body is the one chosen");
	assert.ok(body.includes("<Button />"), "the code example must survive the fence-free branch");
});

test("the markdown branch still gets the rule (where fence state exists)", () => {
	const cleaned = cleanMarkdown("# T\n\n<Note>\n\nCaveat.\n\n</Note>\n\n```\n<Button />\n```\n");
	assert.ok(!cleaned.includes("<Note>"), "scaffolding outside a fence is removed");
	assert.ok(cleaned.includes("<Button />"), "the fenced example is preserved");
});
