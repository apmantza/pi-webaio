// ─── Frontmatter + safety-marker hygiene (issue #165, cluster B: F8/F10/F17/F19/F20/F21) ───
//
// Every page body is stored as `---\n<yaml>\n---\n\n` + `[UNTRUSTED WEB CONTENT
// START]` + content + `[UNTRUSTED WEB CONTENT END]`. Only outline.ts knew how to
// remove that prefix, so the layers that did not either corrupted it (prune /
// budgetTokens emitted an unterminated `---` block, or moved the block to the end
// of the document), leaked it into derived products (RAG chunks, research evidence
// quotes), or failed to read it back at all (session-store's `url:` reader, LF-only
// and quoted-only — the reader the disk cache warm-up uses to re-index saved pages).
//
// Every test here drives a PRODUCTION input through the production function. The
// two tests that used to strip the wrapper in the fixture were rewritten: proving
// `stripWrapper()` works is not evidence the chunker calls it.
//
// Recurrence each test prevents:
//  - F8  — `aio-webfetch(..., budgetTokens:250)` returning an unterminated header
//          (live: arxiv.org/pdf/2005.11401), or the block reordered to the end.
//  - F10 — the same corruption surfaced through `aio-webcontent`.
//  - F17 — `[UNTRUSTED WEB CONTENT START]` quoted as research evidence.
//  - F19 — CHUNK 0 containing only frontmatter + markers, zero page words.
//  - F20 — `budgetTokens` silently exceeded by the frontmatter it re-emits.
//  - F21 — four disagreeing frontmatter parsers; CRLF / unquoted `url:` invisible.
import assert from "node:assert";
import test from "node:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneMarkdown, applyTokenBudget, buildOmittedSectionsToc } from "../src/prune-markdown.ts";
import { chunkMarkdown } from "../src/chunker.ts";
import {
	splitFrontmatter,
	withFrontmatter,
	stripWrapper,
	extractFrontmatterUrl,
} from "../src/markdown-frontmatter.ts";
import { estimateTokens } from "../src/token-count.ts";

const FM = '---\ntitle: "Example Domain"\nurl: "https://example.com/"\nsite: example.com\n---\n\n';

// The shape that reproduces F8 (and the shape aio-webfetch actually emits):
// frontmatter, then the body immediately, with no preamble paragraph to absorb it.
function bareDoc(sections = 2) {
	let body = "";
	for (let i = 1; i <= sections; i++) {
		body += `## Section ${i}\n\n${"word ".repeat(200)}\n\n`;
	}
	return `---\ntitle: "T"\nurl: "https://e.com"\n---\n\n# Alpha\n\n${body}`;
}

function storedDoc(sections = 6) {
	let body = "This domain is for use in illustrative examples in documents.\n\n";
	for (let i = 1; i <= sections; i++) {
		body += `## Section ${i}\n\n${"Padding prose for section ".repeat(18)} number ${i}.\n\n`;
	}
	return `${FM}[UNTRUSTED WEB CONTENT START]\n\n${body.trim()}\n\n[UNTRUSTED WEB CONTENT END]\n`;
}

// A terminated, leading, still-complete frontmatter block.
const COMPLETE_FM = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const DOCS = { bare: bareDoc, stored: storedDoc };

// ─── F8 / F10: prune and budget must preserve the block, not corrupt it ───

for (const [name, make] of Object.entries(DOCS)) {
	test(`F8: pruneMarkdown keeps a complete frontmatter block on the ${name} doc`, () => {
		for (const maxTokens of [120, 200, 400]) {
			const out = pruneMarkdown(make(), { maxTokens }).content;
			assert.ok(
				out.startsWith("---"),
				`${name}/${maxTokens}: frontmatter no longer leads the document\n${out.slice(0, 120)}`,
			);
			assert.ok(
				COMPLETE_FM.test(out),
				`${name}/${maxTokens}: closing --- destroyed (unterminated block)\n${out.slice(0, 120)}`,
			);
			assert.match(out, /^title: "T"|^title: "Example Domain"/m, "title field lost");
		}
	});

	test(`F8: applyTokenBudget keeps a complete frontmatter block on the ${name} doc`, () => {
		for (const budget of [120, 200, 400]) {
			const out = applyTokenBudget(make(), budget);
			assert.ok(
				out.startsWith("---"),
				`${name}/${budget}: frontmatter reordered behind the body\n${out.slice(0, 120)}`,
			);
			assert.ok(
				COMPLETE_FM.test(out),
				`${name}/${budget}: closing --- destroyed\n${out.slice(0, 120)}`,
			);
		}
	});
}

// ─── F20: the budget is a hard ceiling including what we re-emit ───

// The shape that actually breaks the ceiling: many sections with long headings.
// The footer then carries a large omitted-sections TOC, and when no heading
// survives pruning the skeleton is prepended AFTER the budget was computed. The
// final safety trim cut at a rough `maxTokens * 4` characters and never
// re-measured, so markdown (short lines, many tokens per char) landed over.
// Measured on the pre-fix code: budget 250 -> 273 tokens.
function manySectionsDoc() {
	let md = '---\ntitle: "T"\nurl: "https://e.com"\n---\n\n';
	for (let i = 1; i <= 14; i++) {
		md += `## Section ${i} covering an unusually long heading title for the omitted list\n\n${"word ".repeat(120)}\n\n`;
	}
	return md;
}

test("F20: applyTokenBudget output fits the budget on the many-sections doc", () => {
	for (const budget of [100, 150, 250, 400]) {
		const out = applyTokenBudget(manySectionsDoc(), budget);
		const used = estimateTokens(out);
		assert.ok(used <= budget, `budget ${budget}: emitted ${used} tokens`);
	}
});

for (const [name, make] of Object.entries(DOCS)) {
	test(`F20: applyTokenBudget output fits the budget on the ${name} doc`, () => {
		for (const budget of [150, 250, 400]) {
			const out = applyTokenBudget(make(), budget);
			const used = estimateTokens(out);
			assert.ok(
				used <= budget,
				`${name}/${budget}: emitted ${used} tokens (${out.length} chars)`,
			);
		}
	});
}

test("F10: a document with no frontmatter is untouched by the split", () => {
	const body = "# Plain\n\nNo frontmatter here at all.\n";
	assert.equal(splitFrontmatter(body).frontmatter, "");
	assert.equal(splitFrontmatter(body).body, body);
	assert.equal(withFrontmatter("", body), body);
	// And pruning it must not invent a frontmatter block.
	assert.ok(!pruneMarkdown(body, 120).content.startsWith("---"));
});

test("F20: a token-capped TOC still renders one entry per line", () => {
	// Recurrence prevented: the capped TOC was first built by concatenating entries
	// with no separator, so the whole heading list collapsed onto a single line
	// ("...omitted list  - Section 9 ..."). The budget contract still held, so the
	// budget test stayed green and only the TOC-shape suite caught it.
	const omitted = Array.from({ length: 30 }, (_, i) => ({
		heading: `Section ${i} with a fairly long heading to consume tokens`,
		level: 2,
	}));
	const toc = buildOmittedSectionsToc(omitted, 60);
	assert.ok(toc.length > 0, "a tiny cap should still emit what fits");
	const lines = toc.split("\n").filter((l) => l.trim().startsWith("- "));
	assert.ok(lines.length >= 2, `expected multiple TOC lines, got ${lines.length}`);
	for (const line of lines) {
		assert.match(line, /^\s*- /, `TOC line is malformed: ${JSON.stringify(line)}`);
		assert.ok(
			!/\S\s+- /.test(line),
			`two TOC entries collapsed onto one line: ${JSON.stringify(line)}`,
		);
	}
	// Entries that did not fit must be counted, not silently dropped.
	assert.match(toc, /more/);
});

test("F20: an impossible cap emits no TOC rather than a header with no entries", () => {
	const omitted = [{ heading: "A very long omitted section heading indeed", level: 2 }];
	assert.equal(buildOmittedSectionsToc(omitted, 1), "");
});

// ─── F19: chunks must carry page content, not the storage envelope ───

for (const [name, make] of Object.entries(DOCS)) {
	test(`F19: chunkMarkdown(${name} stored body) yields page content in chunk 0`, () => {
		// Production input: exactly what is stored, wrapper and all. No stripping
		// in the fixture — that was the bug.
		const chunks = chunkMarkdown(make(), { maxTokens: 120, overlapTokens: 0 });
		assert.ok(chunks.length > 0, "no chunks produced");

		for (const c of chunks) {
			assert.ok(
				!c.text.includes("UNTRUSTED WEB CONTENT"),
				`${name}: safety markers leaked into a chunk`,
			);
			assert.ok(!c.text.includes('title: "T"'), `${name}: frontmatter leaked into a chunk`);
			assert.ok(
				!c.text.includes('title: "Example Domain"'),
				`${name}: frontmatter leaked into a chunk`,
			);
		}
		const all = chunks.map((c) => c.text).join("\n");
		assert.match(all, /Section 1|Alpha/, `${name}: no page content in any chunk`);
	});
}

// ─── F17: the wrapper must be removable for quote/evidence consumers ───

test("F17: stripWrapper removes frontmatter and both marker lines", () => {
	const clean = stripWrapper(storedDoc());
	assert.ok(!clean.includes("UNTRUSTED WEB CONTENT"), "markers survived");
	assert.ok(!clean.startsWith("---"), "frontmatter survived");
	assert.ok(clean.includes("## Section 1"), "real content was dropped");
});

test("F17: research evidence quotes never contain the safety markers", async () => {
	const { extractEvidence } = await import("../src/research.ts");
	// Production input: exactly what a fetched source body looks like on disk.
	const stored = `---
title: "React Docs"
url: "https://react.dev/reference/react/useState"
---

[UNTRUSTED WEB CONTENT START]

URL Source: https://react.dev/reference/react/useState

## useState

useState is a React Hook that lets you add a state variable to your component.

[UNTRUSTED WEB CONTENT END]
`;
	const evidence = extractEvidence(
		"S1",
		"https://react.dev/reference/react/useState",
		"React Docs",
		stored,
		"what does useState do",
	);
	assert.ok(evidence, "no evidence extracted");
	assert.ok(
		!evidence.quote.includes("UNTRUSTED WEB CONTENT"),
		`markers leaked into the evidence quote: ${JSON.stringify(evidence.quote.slice(0, 160))}`,
	);
	assert.ok(
		!evidence.quote.includes("title: "),
		`frontmatter leaked into the evidence quote: ${JSON.stringify(evidence.quote.slice(0, 160))}`,
	);
	assert.match(evidence.quote, /useState is a React Hook/);
});

// ─── F21: one parser, CRLF-tolerant and quote-agnostic ───

test("F21: CRLF frontmatter parses identically to LF", () => {
	const crlf = storedDoc().replace(/\n/g, "\r\n");
	const split = splitFrontmatter(crlf);
	assert.ok(split.frontmatter.startsWith("---\r\n"), "CRLF block not recognised");
	assert.ok(!split.body.includes("site: example.com"), "frontmatter leaked into body");
	assert.equal(extractFrontmatterUrl(crlf), "https://example.com/");
});

test("F21: an unquoted url: scalar is readable", () => {
	assert.equal(
		extractFrontmatterUrl("---\ntitle: Example\nurl: https://example.com/\n---\n\nBody.\n"),
		"https://example.com/",
	);
});

test("F21: a lone --- thematic break is not mistaken for frontmatter", () => {
	const md = "---\n\n# Real heading\n\nA thematic break, not a YAML block.\n";
	const split = splitFrontmatter(md);
	assert.equal(split.frontmatter, "", "thematic break swallowed the document");
	assert.ok(split.body.includes("# Real heading"));
	assert.equal(extractFrontmatterUrl(md), null);
});

test("F21: extractFrontmatterUrl returns null without frontmatter or without url:", () => {
	assert.equal(extractFrontmatterUrl("# Just a page\n"), null);
	assert.equal(extractFrontmatterUrl('---\ntitle: "T"\n---\n\nBody.\n'), null);
});

// ─── F21 through the real consumer: the disk cache warm-up ───
//
// `loadContentCacheFromDisk()` re-indexes saved .md files by their frontmatter url.
// A file it cannot read is a page the agent saved and then cannot retrieve, and a
// pulled page the resume logic never counts as completed.

test("F21: a CRLF saved page is re-indexed by the disk cache warm-up", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-webaio-fm-"));
	process.env.TMPDIR = scratch;
	process.env.TMP = scratch;
	process.env.TEMP = scratch;
	// BASE_TEMP is computed from tmpdir() at module load: import after pinning.
	const store = await import("../src/session-store.ts");
	const dir = store.BASE_TEMP;
	await mkdir(dir, { recursive: true });

	// The saved-page file IS the production format aio-webfetch writes into
	// BASE_TEMP; loadContentCacheFromDisk() scans it recursively and re-indexes
	// each .md by its frontmatter url.
	async function roundTrip(name, url, eol) {
		const md = [
			"---",
			`title: "${name}"`,
			`url: "${url}"`,
			"site: example.org",
			"---",
			"",
			`Real page body for ${name}.`,
			"",
		].join(eol);
		await writeFile(join(dir, `${name}.md`), md, "utf8");
		store.sessionStore.clear();
		await store.loadContentCacheFromDisk();
		return store.getStoredContentAnyAge(url);
	}

	// Control: the LF spelling always worked.
	const lf = await roundTrip("lf-page", "https://lf.example.org/page", "\n");
	assert.ok(lf, "LF saved page was not re-indexed (control broken)");

	// The defect: the same file with CRLF endings. The old reader required
	// `startsWith("---\n")` and a `\n---` terminator, so it returned no URL and
	// the warm-up silently skipped the file.
	const crlf = await roundTrip("crlf-page", "https://crlf.example.org/page", "\r\n");
	assert.ok(
		crlf,
		"CRLF saved page was not re-indexed: the frontmatter url reader is LF-only",
	);
	assert.match(crlf.content, /Real page body for crlf-page/);
});

test("withFrontmatter re-attaches a stripped block verbatim", () => {
	const md = storedDoc();
	const { frontmatter, body } = splitFrontmatter(md);
	const rebuilt = withFrontmatter(frontmatter, body);
	assert.ok(rebuilt.startsWith(FM), "rebuilt document does not start with the block");
});

// ─── A fence is a whole line, or a thematic break eats the page ──────
//
// The closing side of FRONTMATTER_RE was `\r?\n---`, which matches any line that
// merely *starts* with three dashes. `----` is a perfectly ordinary markdown
// horizontal rule, so a document with no frontmatter at all — one that opens
// with a thematic `---` and rules a section further down — had its heading
// swallowed into the "frontmatter" and left a stray `-` behind as the body.
// `chunkMarkdown` then dropped that text via stripWrapper, so content vanished.
// This contradicts the contract stated in the module header: an unclosed `---`
// is a thematic break and must not swallow the document.
//
// Recurrence prevented: a page whose body contains a `----` rule losing every
// heading above it from chunks and from the pruned output.
test("F21: a longer dash rule is not a closing fence", () => {
	for (const closer of ["----", "-----", "---foo", "--- -"]) {
		const doc = `---\ntitle: T\n${closer}\n\nBody\n`;
		const r = splitFrontmatter(doc);
		if (closer.startsWith("---foo") || closer === "--- -") {
			// Not a fence at all: the whole document stays body.
			assert.equal(r.frontmatter, "", `${closer} was taken as a fence`);
			assert.equal(r.body, doc);
		} else {
			assert.equal(r.frontmatter, "", `${closer} was taken as a fence`);
		}
	}
});

test("F21: a body containing a horizontal rule keeps its headings", () => {
	// No frontmatter: a thematic break at the top and a rule further down.
	const doc = "---\n\n# Heading\n\n----\n\ntext\n";
	const r = splitFrontmatter(doc);
	assert.equal(r.frontmatter, "", "a thematic break was read as frontmatter");
	assert.ok(r.body.includes("# Heading"), `heading lost: ${JSON.stringify(r.body)}`);
	assert.ok(r.body.includes("text"), "body text lost");
});

test("F21: an empty frontmatter block is recognised", () => {
	const r = splitFrontmatter("---\n---\n\nBody\n");
	assert.equal(r.frontmatter, "---\n---\n");
	assert.equal(r.body, "\nBody\n");
});

// The ordinary case must not regress while the pathological ones are fixed,
// including CRLF and a block that ends at end-of-string with no trailing newline.
test("F21: real frontmatter still splits, with and without a trailing newline", () => {
	const doc = FM + "# H\n\ntext\n";
	const r = splitFrontmatter(doc);
	// The block is the fence lines plus ONE newline; the blank line after it is
	// body, which is what the module header documents.
	assert.equal(r.frontmatter, FM.replace(/\n$/, ""));
	assert.equal(r.body, "\n# H\n\ntext\n");
	const crlf = '---\r\ntitle: "T"\r\n---\r\nBody';
	const rc = splitFrontmatter(crlf);
	assert.equal(rc.frontmatter, '---\r\ntitle: "T"\r\n---\r\n');
	assert.equal(rc.body, "Body");
	const noNewline = '---\ntitle: "T"\n---';
	assert.equal(splitFrontmatter(noNewline).frontmatter, '---\ntitle: "T"\n---');
});

// ─── originalTokens and prunedTokens must share a base ───────────────
//
// `pruneMarkdown` hands the BODY to `pruneBody` (so `originalTokens` counts the
// body) but then overrides `prunedTokens` with the token count of the full
// document, frontmatter included. The two numbers therefore describe different
// things, and the pair is reported as if they were a before/after: a caller
// printing "pruned from X to Y" shows the document getting BIGGER.
//
// Reproduced before the fix, on a body of 180 tokens with 18 tokens of
// frontmatter and a budget nobody needed:
//   with frontmatter    original=180  pruned=198  truncated=false
//   without frontmatter original=180  pruned=180  truncated=false
//
// Recurrence prevented: a budget/prune report that claims the output grew.
test("F21: prune token accounting uses one base for original and pruned", () => {
	const body = Array.from(
		{ length: 20 },
		(_, i) => `## Section ${i}\n\n${"word ".repeat(5)}`,
	).join("\n\n");
	const doc = FM + body;
	const withFm = pruneMarkdown(doc, { maxTokens: 2000 });
	const plain = pruneMarkdown(body, { maxTokens: 2000 });

	assert.ok(
		withFm.prunedTokens <= withFm.originalTokens,
		`nothing was truncated yet the document reports growing: ${withFm.originalTokens} -> ${withFm.prunedTokens}`,
	);
	// Frontmatter is part of the document that was pruned, so it belongs in the
	// original count; that is what makes the two numbers comparable.
	assert.ok(
		withFm.originalTokens > plain.originalTokens,
		`originalTokens ignores frontmatter (${withFm.originalTokens} vs ${plain.originalTokens})`,
	);
	assert.equal(withFm.truncated, false);
});

// And the budget must still be honoured when it is actually tight: the body
// budget is reduced by the frontmatter cost, so the FULL document (not just the
// body) has to fit.
test("F21: a tight budget keeps the whole document inside the limit", () => {
	const body = Array.from(
		{ length: 40 },
		(_, i) => `## Section ${i}\n\n${"word ".repeat(20)}`,
	).join("\n\n");
	const doc = FM + body;
	const budget = 200;
	const r = pruneMarkdown(doc, { maxTokens: budget });
	assert.equal(r.truncated, true, "a 40-section body must not fit 200 tokens");
	assert.ok(
		r.prunedTokens <= budget,
		`pruned document is ${r.prunedTokens} tokens, over the ${budget} budget`,
	);
});

// The overshoot is not a frontmatter effect — it reproduces on a plain body, so
// it is pinned separately: frontmatter must not be load-bearing for the bug.
// Measured before the fix: a 40-section body at a 200-token budget came back at
// 226, because the body was packed to 157 (its share) and the omitted-sections
// TOC then added 69 on top of the 20 tokens reserved for it.
test("F21: pruneMarkdown's own footer cannot push it past its budget", () => {
	for (const sections of [10, 20, 40, 80]) {
		const body = Array.from(
			{ length: sections },
			(_, i) => `## Section ${i}\n\n${"word ".repeat(20)}`,
		).join("\n\n");
		for (const budget of [100, 200, 400]) {
			const r = pruneMarkdown(body, { maxTokens: budget });
			assert.ok(
				r.prunedTokens <= budget,
				`${sections} sections at budget ${budget} returned ${r.prunedTokens} tokens`,
			);
		}
	}
});

// The ceiling passed to `buildOmittedSectionsToc` is not what enforces the budget
// — the guarantee below it does that on its own. What the ceiling buys is the
// heading LIST surviving instead of being dropped by the guarantee, which is the
// whole point of the footer ("know what was left out", F7). Measured over the
// sweep: 78 truncated outputs keep a TOC with the ceiling, 62 without it.
// 40 sections at a 100-token budget is one of the cases where it is the
// difference between a list and a bare count.
test("F21: a footer that fits keeps its heading list rather than a bare count", () => {
	const body = Array.from(
		{ length: 40 },
		(_, i) => `## Section ${i}\n\n${"word ".repeat(20)}`,
	).join("\n\n");
	const r = pruneMarkdown(body, { maxTokens: 100 });
	assert.equal(r.truncated, true);
	assert.ok(r.prunedTokens <= 100, `over budget: ${r.prunedTokens}`);
	assert.ok(
		r.content.includes("*Omitted sections:*"),
		"the omitted-heading list was dropped even though the footer had room for it",
	);
	assert.match(r.content, /^\s+- Section \d+$/m, "no headings actually listed");
});

