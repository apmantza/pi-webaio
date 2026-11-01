// ─── Issue #162: offline detector for markdown-shape drift ────────────
//
// Recurrence named per the issue: a defuddle/linkedom patch bump changing
// markdown shape, see #160. Before this file, `npm run test:all` stayed green
// through a defuddle 0.19.4 -> 0.19.5 + linkedom 0.18.13 -> 0.18.14 bump that
// changed actual markdown output. The only end-to-end assertion was phrase-level
// (`/enough useful words/`) and the scored benchmark is weekly, live-network and
// ends in `|| true`.
//
// The corpus is four saved HTML pages run through the REAL seam
// (`articleHtmlToMarkdown` -> Defuddle), asserting STRUCTURE rather than prose:
// heading depth, list nesting, fence languages, table pipes, link syntax.
// Prose-level assertions survive almost any shape change, which is exactly the
// property the issue says we were missing.
//
// Building the corpus paid for itself immediately. It found a live defect that
// had nothing to do with dependency drift and everything to do with our own
// post-processing — see the two `cleanText` tests below. They are written first
// and are red on the current master, because a drift detector that codifies
// today's output as golden would have pinned the corruption in place and called
// it correct.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { articleHtmlToMarkdown } from "../src/content.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "markdown-shape");

function fixture(name) {
	return readFileSync(join(FIX, `${name}.html`), "utf8");
}

// ─── Live defects found while building this corpus ────────────────────
//
// `articleHtmlToMarkdown` runs Defuddle's result through `cleanText`, which
// trims every line and drops blank ones. That is right for prose and
// destructive for pre-formatted content. Verified against Defuddle directly:
// its raw output already contains the correct indentation and blank line, so
// this is OUR post-processing, not an upstream limitation.
//
// Recurrence prevented: returned code blocks that are not the code that was on
// the page — silently wrong for indentation-sensitive languages.

test("code blocks keep their indentation (Python is not valid without it)", async () => {
	const md = await articleHtmlToMarkdown(fixture("math"), "https://example.com/math");
	const block = /```python\n([\s\S]*?)```/.exec(md ?? "");
	assert.ok(block, "expected a python fenced block");
	assert.ok(
		/^ {4}scores = q @ k\.T/m.test(block[1]),
		`fence body lost its indentation; returned code is not runnable:\n${block[1]}`,
	);
});

test("YAML in a fence keeps nesting AND its blank lines", async () => {
	const md = await articleHtmlToMarkdown(
		`<article><h1>Config</h1><p>This paragraph is long enough that the extractor keeps the article body instead of rejecting the page as too thin, which is what the local extraction threshold checks before it hands the result back.</p><pre><code class="language-yaml">server:\n  port: 8080\n\n  keep: yes</code></pre><p>Trailing paragraph so the document does not end on the fence.</p></article>`,
		"https://example.com/yaml",
	);
	const block = /```yaml\n([\s\S]*?)```/.exec(md ?? "");
	assert.ok(block, "expected a yaml fenced block");
	assert.match(block[1], /^ {2}port: 8080$/m, "nested key flattened to top level");
	assert.match(
		block[1],
		/\n\n {2}keep: yes/,
		"blank line inside the fence was dropped — in YAML that changes grouping",
	);
});

test("nested lists stay nested (a single leading space is not nesting)", async () => {
	const md = await articleHtmlToMarkdown(
		`<article><h1>Nested</h1><p>Long enough paragraph for the extractor to keep this as the article body instead of rejecting the page as too thin for local extraction heuristics used by the pipeline.</p><ul><li>Top level one<ul><li>Nested child A</li></ul></li><li>Top level two</li></ul></article>`,
		"https://example.com/nested",
	);
	const child = /^([ \t]+)-\s+Nested child A/m.exec(md ?? "");
	assert.ok(
		child,
		`nested item lost its indent and became a sibling:\n${md}`,
	);
	// CommonMark: a nested list under a "- " marker needs at least two spaces.
	// One space is a lazy continuation of the previous item, not a child.
	assert.ok(
		child[1].length >= 2,
		`nested item indented by ${child[1].length} column(s); CommonMark needs >= 2`,
	);
});

// ─── Shape assertions (the actual drift detector) ─────────────────────

test("article corpus: heading depth, markers, quote and image syntax survive", async () => {
	const md = await articleHtmlToMarkdown(fixture("article"), "https://example.com/article");
	assert.ok(md);
	assert.match(md, /^## List behaviour$/m, "h2 must stay an h2");
	assert.match(md, /- First item with `inline code`/, "bullet marker changed");
	assert.match(md, /^1\. Alpha step$/m, "ordered marker changed");
	assert.match(md, /^> A quoted passage/m, "blockquote flattened to prose");
	assert.match(md, /\[link to the spec\]\(https:\/\/example\.com\/spec\)/, "link lost its URL");
	assert.match(md, /!\[A diagram of the pipeline\]\(/, "image lost its alt text");
	assert.match(md, /\*\*bold\*\*/, "strong emphasis lost");
	assert.match(md, /\*emphasis\*/, "emphasis lost");
	// Chrome must stay out: nav/aside/footer are not the article.
	assert.doesNotMatch(md, /Subscribe to our newsletter/i, "page chrome leaked in");
	assert.doesNotMatch(md, /Copyright 2026/i, "footer leaked in");
});

test("docs corpus: fence languages and heading depth survive", async () => {
	const md = await articleHtmlToMarkdown(fixture("docs"), "https://example.com/docs");
	assert.ok(md);
	assert.match(md, /^```bash$/m, "bash fence lost its language");
	assert.match(md, /^```js$/m, "js fence lost its language");
	assert.match(md, /^### Nested heading$/m, "h3 flattened");
	assert.doesNotMatch(md, /Docs\s+\[?Install/i, "nav bar leaked into the body");
});

test("table corpus: pipe table shape survives and prose pipes are not tabled", async () => {
	const md = await articleHtmlToMarkdown(fixture("table"), "https://example.com/table");
	assert.ok(md);
	assert.match(md, /^\| Strategy \| Speed \| Fidelity \|$/m, "header row changed");
	assert.match(md, /^\| --- \| --- \| --- \|$/m, "alignment row changed");
	assert.match(md, /^\| Defuddle \| Slow \| High \|$/m, "a row is missing");
	const rows = (md ?? "").split("\n").filter((l) => /^\|/.test(l));
	assert.equal(rows.length, 5, `expected 5 table lines, got ${rows.length}`);
});

// ─── Golden shape signature ───────────────────────────────────────────
//
// Exact markdown goldens are brittle in the wrong way: a legitimate improvement
// fails them and the fix is to paste the new output, so the file silently
// re-certifies whatever the library does now. A SHAPE signature is brittle in the
// useful way — it changes only when the document's structure changes, which is
// the thing #160 drifted on. When it fails, the diff names the construct.

function shapeOf(md) {
	const shape = [];
	let fence = null;
	for (const line of (md ?? "").split("\n")) {
		const f = /^\s*(```|~~~)(.*)$/.exec(line);
		if (fence) {
			if (line.trim().startsWith(fence)) fence = null;
			continue;
		}
		if (f) {
			fence = f[1];
			shape.push(`fence:${f[2].trim() || "none"}`);
			continue;
		}
		const h = /^(#{1,6})\s/.exec(line);
		if (h) shape.push(`h${h[1].length}`);
		else if (/^\s*[-*+]\s/.test(line)) shape.push("ul");
		else if (/^\s*\d+[.)]\s/.test(line)) shape.push("ol");
		else if (/^>/.test(line)) shape.push("quote");
		else if (/^\|/.test(line)) shape.push("table");
		else if (line.trim()) shape.push("p");
	}
	return shape;
}

test("shape signature matches the committed golden", async () => {
	const golden = JSON.parse(
		readFileSync(join(FIX, "shape-golden.json"), "utf8"),
	);
	for (const name of ["article", "docs", "table", "math"]) {
		const md = await articleHtmlToMarkdown(fixture(name), `https://example.com/${name}`);
		const shape = shapeOf(md);
		assert.deepEqual(
			shape,
			golden[name],
			`#162 markdown SHAPE drifted for "${name}" — a defuddle/linkedom change alters document structure. Diff the two arrays; update shape-golden.json only if the new shape is the one you want.`,
		);
	}
});
