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
//
// The mirror-image recurrence is prevented too, and matters just as much: a
// local body that is NOT this page's article must never shield itself from a
// fallback that has the real text. Both directions are tested below.

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

/** The same significant-word rule the guard uses, so tests can state their own premises. */
const sigWords = (t) => new Set((t.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []));

async function pageHtml() {
	return gunzipSync(await readFile(FIX("nocheck.html.gz"))).toString("utf8");
}

async function localResult() {
	const raw = await pageHtml();
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

test("#154 premise: the fixture pins the definition to exactly one occurrence", async () => {
	// The fixture IS the evidence. If it is ever re-captured or hand-edited into
	// carrying the phrase twice (or zero times), every premise below silently
	// changes meaning — so the count is asserted, not assumed.
	const raw = await pageHtml();
	assert.equal(raw.split(DEFINITION).length - 1, 1, "definition occurrence count drifted");
	const jina = await jinaResult();
	assert.equal(jina.content.split(DEFINITION).length - 1, 0, "reader body must omit the definition");
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
	assert.match(jina.content, /Customize|Site Colours|Popular Documentation Pages/);
});

// ─── The decision: navigation must not displace the article ───

test("#154: navigation never displaces a correct short article", async () => {
	const local = await localResult();
	const jina = await jinaResult();
	assert.equal(
		shouldPreferJinaFallback(local.content, jina.content, local.title),
		false,
		"the sidebar was chosen over the article",
	);
});

test("#154: a reader body that genuinely recovered the article is still preferred", async () => {
	// The escalation exists for JS-heavy pages. When the proxy body CONTAINS
	// what the local pass found, plus more, it is more content and must win.
	const title = "noCheck";
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
	assert.equal(shouldPreferJinaFallback(local, better, title), true);
});

// ─── The mirror image: a body that is not the article must not be shielded ───

test("#154: a degenerate local body never blocks a real article", () => {
	// Below the sample floor the overlap ratio is not evidence of anything: a
	// one-word placeholder scores 0.0 against an unrelated article and would keep
	// the placeholder while rejecting the proxy's real text.
	const title = "TSConfig Option: noCheck";
	const article =
		"## noCheck\nDisable full type checking (only critical parse and emit errors will be reported). " +
		"Skip type checking project-wide while keeping syntax diagnostics.";
	for (const junk of ["", "## loading", "## loading spinner", "## nocheck disabled fully"]) {
		assert.ok(
			sigWords(junk).size < JINA_MIN_PRESERVATION_SAMPLE,
			`fixture sanity: "${junk}" has ${sigWords(junk).size} significant words, expected below the floor`,
		);
		assert.equal(
			shouldPreferJinaFallback(junk, article, title),
			true,
			`placeholder body ${JSON.stringify(junk)} blocked the real article`,
		);
	}
});

test("#154: a generic placeholder AT the sample floor still yields to the article", () => {
	// Adversarial review of PR #180 found the floor was tested from one side only:
	// six generic UI words sit exactly ON the floor and are then judged by the
	// majority rule, scoring 0 and keeping the placeholder over the real article.
	// The count is not identity, so identity is what decides: the body carries no
	// token of the page's own title, so it is not shielded.
	const title = "Compiler Options Handbook";
	const placeholder = "loading spinner content page please wait";
	const article =
		"The handbook explains compiler options, diagnostics, incremental builds, " +
		"project references, and how diagnostics are reported across a solution.";
	assert.equal(
		sigWords(placeholder).size,
		JINA_MIN_PRESERVATION_SAMPLE,
		"the case must sit exactly on the floor, or it no longer tests the boundary",
	);
	assert.equal(shouldPreferJinaFallback(placeholder, article, title), true);
});

test("#154: with no title to anchor on, the fallback is not blocked", () => {
	// Identity cannot be established, so the guard stands aside rather than
	// protecting an arbitrary short body.
	const local = "compiler options diagnostics incremental builds project references";
	assert.ok(sigWords(local).size >= JINA_MIN_PRESERVATION_SAMPLE);
	assert.equal(shouldPreferJinaFallback(local, "unrelated proxy text entirely", ""), true);
	assert.equal(shouldPreferJinaFallback(local, "unrelated proxy text entirely", "Totally Other"), true);
});

test("#154: the real page sits above the sample floor and carries its title", async () => {
	// Without this, raising the floor or tightening the anchor would silently
	// disable the fix for #154 and the suite would stay green.
	const local = await localResult();
	const words = sigWords(local.content);
	assert.ok(
		words.size >= JINA_MIN_PRESERVATION_SAMPLE,
		`the #154 body has ${words.size} significant words; the floor must stay at or below it`,
	);
	const anchor = sigWords(local.title);
	assert.ok(anchor.size > 0, "the captured page must expose a title to anchor on");
	assert.ok(
		[...anchor].some((w) => words.has(w)),
		`the article body must carry a token of its own title (${[...anchor].join(",")})`,
	);
});

test("#154: a non-Latin article is protected too", () => {
	// Recurrence prevented (CodeRabbit on PR #180): the tokenizer was ASCII-only,
	// so `型検査を無効にする` produced an EMPTY significant-word set, which reads as
	// "nothing to preserve" and handed the page to the navigation body — the exact
	// #154 failure, silently reintroduced for every non-Latin page.
	const cases = [
		{
			title: "設定",
			local: "## 設定\n型検査を無効にする。構文エラーのみが報告されます。",
			nav: "### カスタマイズ\nサイトカラー\nコードフォント\n人気ドキュメントページ\n一覧へ戻る",
		},
		{
			title: "설정",
			local: "## 설정\n전체 유형 검사를 비활성화합니다. 구문 오류만 보고됩니다.",
			nav: "### 사용자 지정\n사이트 색상\n코드 글꼴\n인기 문서 페이지\n목록으로 돌아가기",
		},
	];
	for (const { title, local, nav } of cases) {
		// `false` is only reachable if the body produced at least
		// JINA_MIN_PRESERVATION_SAMPLE identity tokens AND carried a token of its
		// own title — an empty set short-circuits to `true`. So the decision itself
		// proves identity was established, without re-spelling the tokenizer here.
		assert.equal(
			shouldPreferJinaFallback(local, nav, title),
			false,
			`navigation displaced the ${title} article (no identity tokens, or no title anchor)`,
		);
	}
});

test("#154: a non-Latin placeholder still yields to a non-Latin article", () => {
	// The other direction, same script: an unanchored placeholder must not shield
	// itself, and an anchored body must still be allowed to grow.
	const title = "コンパイラオプション";
	const placeholder = "読み込み中 スピナー ページ 内容を お待ちください";
	const article =
		"コンパイラオプションのハンドブックでは、診断、増分ビルド、プロジェクト参照、" +
		"ソリューション全体での診断の報告方法について説明します。";
	assert.equal(shouldPreferJinaFallback(placeholder, article, title), true);
	const anchored = "コンパイラオプションの概要";
	assert.equal(shouldPreferJinaFallback(anchored, anchored + "詳細な説明が続きます", title), true);
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
	assert.equal(shouldPreferJinaFallback(local, justOver, "noCheck"), true);
	assert.equal(shouldPreferJinaFallback(local, justUnder, "noCheck"), false);
});

// ─── Wiring: the ladder must actually consult the guard ───

test("#154: the fetch ladder gates the Jina assignment on the guard", async () => {
	// Formatting-tolerant on purpose (adversarial review of PR #180): an earlier
	// version of this guard matched the length test and the call adjacently, and
	// reddened when someone merely reordered the boolean operands — a detector
	// that reds on formatting is a false-positive machine. What must hold is
	// semantic: whatever controls `chosen = jina` consults the guard.
	const src = await blankCommentsAndStrings(join(HERE, "..", "src", "content.ts"));
	const at = src.indexOf("chosen = jina;");
	assert.ok(at > 0, "the Jina assignment is gone — update this guard deliberately, not accidentally");
	const preceding = src.slice(Math.max(0, at - 800), at);
	assert.match(
		preceding,
		/shouldPreferJinaFallback\(/,
		"the reader-proxy branch must consult the guard before assigning Jina",
	);
	assert.match(
		preceding,
		/wordCount\(jina\.content/,
		"the length comparison is still part of the decision",
	);
});
