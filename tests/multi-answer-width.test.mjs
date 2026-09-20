// Multi-answer composed-line width guard (crash: pi TuiMainScreen.doRender
// "Rendered line 6034 exceeds terminal width (206 > 205)").
//
// Recurrence this prevents: pi's Markdown wrapper measures lines by code
// points, but its host validator measures visible width — East Asian wide
// glyphs (CJK, emoji) count 2 columns each. A generated line with wide
// glyphs whose CODE-POINT length fits the terminal therefore renders wider
// than the terminal and hard-crashes the host TUI. The observed crash was
// the cited-answer header echoing a raw CJK-mixed query. Every line the
// composer generates that contains wide glyphs is now hard-capped at 76
// visible columns (CJK-aware); pure narrow lines are safe at any width
// because pi's code-point wrap is exact for them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMultiSourceAnswer } from "../src/multi-answer.ts";

// Independent visible-width oracle (does NOT reuse the implementation under
// test): strips ANSI escapes, counts East Asian Wide/Fullwidth code points
// as 2 columns.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g");

function measureVisibleWidth(text) {
	const plain = text.replace(ANSI_RE, "");
	let width = 0;
	for (const ch of plain) {
		const cp = ch.codePointAt(0);
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals .. Yi
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
			(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
			(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x20000 && cp <= 0x3fffd); // CJK Extension B+
		width += wide ? 2 : 1;
	}
	return width;
}

const QUERY = "solution workaround 解决 tls fingerprint embedded secret opencode free tier third party proxy 解决方案 headers 重试";

const ranked = [
	{
		url: "https://example.com/a",
		heading: "解释：解决方案与重试策略的完整说明解释：解决方案与重试策略的完整说明解释：解决方案与重试策略",
		title: "解释：解决方案与重试策略的完整说明解释：解决方案与重试策略的完整说明",
		text: "Short verbatim body line.\nSecond body line.",
		score: 3.405,
	},
	{
		url: "https://example.com/b",
		heading: "(no heading)",
		title: "ASCII title that is quite long but has no wide glyphs so wrapping handles it fine anyway",
		text: "Body B.",
		score: 2.1,
	},
];

test("no composed line carries wide glyphs beyond 76 visible columns", () => {
	const out = formatMultiSourceAnswer(ranked, QUERY, {
		sourcesCount: 2,
		wrap: false,
	});
	const offenders = [];
	for (let i = 0; i < out.split("\n").length; i++) {
		const line = out.split("\n")[i];
		const vw = measureVisibleWidth(line);
		const cp = [...line].length;
		// The crash condition: a line with wide glyphs whose visible width
		// exceeds its code-point length crashes at any terminal width in
		// [cp, visible). Narrow lines (vw == cp) wrap correctly — safe.
		if (vw > cp && vw > 76) {
			offenders.push(`line ${i} (vw=${vw}, cp=${cp}): ${line.slice(0, 60)}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"no generated line may contain wide glyphs beyond 76 visible columns",
	);
});

test("the header still names the query (truncated, not dropped) and keeps the verify note", () => {
	const out = formatMultiSourceAnswer(ranked, QUERY, {
		sourcesCount: 2,
		wrap: false,
	});
	assert.match(out, /Cited answer: top 2 chunk\(s\) across 2 source\(s\)/);
	assert.match(out, /solution workaround/);
	assert.match(out, /verify against that source/);
	// The CJK query echo is truncated with an ellipsis marker.
	assert.match(out, /…/);
});

test("ASCII queries pass through untruncated when they fit", () => {
	const out = formatMultiSourceAnswer(ranked, "short ascii query", {
		sourcesCount: 2,
	});
	assert.match(out, /for "short ascii query"/);
	assert.doesNotMatch(out.split("\n")[0], /…/);
});
