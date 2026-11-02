// Issue #154: `aio-webfetch` returned navigation instead of the article for SPA
// docs pages. Reported on https://www.typescriptlang.org/tsconfig/noCheck.html.
//
// Premise (both fixtures in fixtures/spa-nav/ are captured from the live page,
// not hand-written — a fixture that exists only to hit the bug proves nothing):
//
//   1. `extractReadability()` returns NULL on this page, so the local chain
//      falls through to its last-resort pass and returns a CORRECT but short
//      body: "## noCheck / Disable full type checking (only critical parse and
//      emit errors will be reported)." — 15 words.
//   2. 15 < MIN_LOCAL_WORDS (50), so the Jina reader fallback runs. For this SPA
//      it serves the sidebar: 177 words of "Customize / Site Colours / Popular
//      Documentation Pages", and the option's own definition appears ZERO times.
//   3. The ladder asked "is Jina longer?" — 177 > 15 — and served the sidebar.
//
// The defect is therefore NOT that local extraction could not read the page. It
// could, correctly. The defect is that the ladder compared VOLUME where its own
// comment says it prefers "more content": a body that drops the article to add a
// sidebar is not more of the article, it is a different document.
//
// Recurrence prevented: a short, correct local article being displaced by a
// longer, wrong fallback body on any page whose prose is genuinely brief
// (reference pages, option/flag docs, changelog one-liners).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	MIN_LOCAL_WORDS,
	JINA_MIN_LOCAL_PRESERVATION,
	JINA_MIN_PRESERVATION_SAMPLE,
	runLocalExtraction,
	preCleanHtml,
	wordCount,
	shouldPreferJinaFallback,
} from "../src/content.ts";
import { parseJinaBody } from "../src/fetch-jina.ts";
import { blankCommentsAndStrings } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (f) => join(HERE, "fixtures", "spa-nav", f);
const PAGE_URL = "https://www.typescriptlang.org/tsconfig/noCheck.html";
const DEFINITION = "Disable full type checking";

async function localResult() {
	const raw = gunzipSync(await readFile(FIX("nocheck.html.gz"))).toString("utf8");
	return runLocalExtraction(preCleanHtml(raw), raw, PAGE_URL, raw, null);
}

async function jinaResult() {
	return parseJinaBody(await readFile(FIX("nocheck-jina.txt"), "utf8"), PAGE_URL);
}

// ─── Premise: the two facts that made the wrong body win ───

test("#154 premise: the local chain extracts the real article, correctly", async () => {
	const local = await localResult();
	assert.ok(
		local.content.includes(DEFINITION),
		`the page's own extraction must contain the definition, got:\n${local.content.slice(0, 300)}`,
	);
	assert.equal(local.title, "TSConfig Option: noCheck");
});

test("#154 premise: that correct article is short enough to trigger escalation", async () => {
	const local = await localResult();
	const words = wordCount(local.content);
	assert.ok(
		words < MIN_LOCAL_WORDS,
		`expected < ${MIN_LOCAL_WORDS} words (that is what sends the page to the reader proxy), got ${words}`,
	);
});

test("#154 premise: the captured reader body is navigation that omits the definition", async () => {
	const jina = await jinaResult();
	const words = wordCount(jina.content);
	assert.ok(
		words > wordCount((await localResult()).content),
		"the wrong body must out-volume the right one, or this fixture tests nothing",
	);
	assert.ok(
		!jina.content.includes(DEFINITION),
		"the captured reader body unexpectedly contains the definition — re-capture the fixture",
	);
	assert.match(jina.content, /Customize|Site Colours|Popular Documentation Pages/);
});

// ─── The decision ───

test("#154: navigation never displaces a correct short article", async () => {
	const local = await localResult();
	const jina = await jinaResult();
	assert.equal(
		shouldPreferJinaFallback(local.content, jina.content),
		false,
		"the sidebar was chosen over the article",
	);
});

test("#154: a reader body that genuinely recovered the article is still preferred", async () => {
	// The escalation exists for JS-heavy pages. When the proxy body CONTAINS
	// what the local pass found, plus more, it is more content and must win.
	const local = "## noCheck\nDisable full type checking (only critical parse and emit errors).";
	const better = [
		"## noCheck",
		"Disable full type checking (only critical parse and emit errors will be reported).",
		"This option skips type checking across the project while still reporting",
		"critical parse and emit errors. Use it to speed up a migration without",
		"losing syntax diagnostics, and pair it with a separate type-check job.",
	].join(" ");
	assert.ok(
		wordCount(better) > wordCount(local),
		"sanity: the fallback must be longer for the ladder to consider it",
	);
	assert.equal(shouldPreferJinaFallback(local, better), true);
});

test("#154: a page where local extraction found nothing still escalates", async () => {
	// The requirement is vacuous when there is nothing to preserve. Blocking
	// here would disable the reader proxy on exactly the JS-heavy pages it
	// exists for, turning a wrong-article bug into a no-article bug.
	assert.equal(shouldPreferJinaFallback("", "Full article text from the proxy reader."), true);
	assert.equal(shouldPreferJinaFallback("## \n\n- - -", "Full article text."), true);
});

test("#154: the preservation bar is a majority and is exported for tuning", () => {
	assert.equal(JINA_MIN_LOCAL_PRESERVATION, 0.5);
	assert.equal(JINA_MIN_PRESERVATION_SAMPLE, 6);
	// Just over the bar preserves; just under does not. Derived from the real
	// local article (12 significant words) rather than an invented string.
	const local = "nocheck disable full type checking only critical parse emit errors will reported";
	const words = local.split(" ");
	assert.equal(words.length, 12);
	const justOver = words.slice(0, 7).join(" ") + " prose continues here";
	const justUnder = words.slice(0, 5).join(" ") + " prose continues here";
	assert.equal(shouldPreferJinaFallback(local, justOver), true);
	assert.equal(shouldPreferJinaFallback(local, justUnder), false);
});

test("#154: a degenerate local body never blocks a real article", () => {
	// Below the sample floor the overlap ratio is not evidence of anything: a
	// one-word placeholder scores 0.0 against an unrelated article and would keep
	// the placeholder while rejecting the proxy's real text — turning this fix into
	// a no-article bug. Recurrence prevented: a spinner/placeholder body outranking
	// the only copy of the article we can reach.
	const article =
		"## noCheck\nDisable full type checking (only critical parse and emit errors will be reported). " +
		"Skip type checking project-wide while keeping syntax diagnostics.";
	for (const junk of ["", "## loading", "## loading spinner", "## nocheck disabled fully"]) {
		const words = new Set((junk.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []));
		assert.ok(
			words.size < JINA_MIN_PRESERVATION_SAMPLE,
			`fixture sanity: "${junk}" has ${words.size} significant words, expected below the floor`,
		);
		assert.equal(
			shouldPreferJinaFallback(junk, article),
			true,
			`placeholder body ${JSON.stringify(junk)} blocked the real article`,
		);
	}
});

test("#154: the real page sits above the sample floor, so the guard still applies", async () => {
	// Without this, raising the floor would silently disable the fix for #154.
	const local = await localResult();
	const words = new Set((local.content.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []));
	assert.ok(
		words.size >= JINA_MIN_PRESERVATION_SAMPLE,
		`the #154 body has ${words.size} significant words; the floor must stay at or below it`,
	);
});

// ─── Wiring: the ladder must actually consult the guard ───

test("#154: the fetch ladder gates the length comparison on preservation", async () => {
	// Blanked so this comment and any doc prose cannot satisfy the scan.
	// Recurrence prevented: someone restoring the bare `wordCount(jina) > localWords`
	// condition, which reads as harmless but re-opens the whole bug.
	const src = await blankCommentsAndStrings(join(HERE, "..", "src", "content.ts"));
	const m = src.match(/wordCount\(jina\.content[^)]*\)\s*>\s*localWords\s*&&\s*shouldPreferJinaFallback\(/);
	assert.ok(
		m,
		"the reader-proxy branch must require preservation alongside the length test",
	);
});
