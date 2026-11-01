import { test } from "node:test";
import assert from "node:assert/strict";
import { composeFetchText } from "../src/tools/webfetch.ts";
import { applyTokenBudget } from "../src/prune-markdown.ts";
import { contentBudgetForFraming } from "../src/tools/utils.ts";
import { estimateTokens } from "../src/token-count.ts";

// Independent review dlg-c3e2aa89 on #169: aio-webfetch charged budgetTokens against the
// BODY only, then added the fetch header and the local-knowledge note on top. The tool
// documents budgetTokens as a hard output-size ceiling.
const PARTS = {
	formatLabel: "✓ Fetched and saved to /tmp/pi-webaio/example/com/page.md",
	title: "A fairly long real page title here",
	url: "https://example.com/some/path",
	format: "markdown",
};
const NOTE =
	"\n\n> Local knowledge: 2 related pulled pages exist (corpus: docs.example.com).";

test("budgetTokens bounds the COMPOSED aio-webfetch answer, not just the body", () => {
	for (const budget of [100, 200, 400]) {
		const body = "word ".repeat(1200);
		// Mirror the handler: reserve the framing that composeFetchText and the
		// local-knowledge note will add, then budget the body against what is left.
		const framing =
			composeFetchText({ ...PARTS, displayContent: "" }) + NOTE;
		const display = applyTokenBudget(
			body,
			contentBudgetForFraming(budget, framing),
			undefined,
			PARTS.url,
		);
		const composed =
			composeFetchText({ ...PARTS, displayContent: display }) + NOTE;
		assert.ok(
			estimateTokens(composed) <= budget,
			`budget ${budget}: composed answer is ${estimateTokens(composed)} tokens (${JSON.stringify(composed.slice(0, 60))}…)`,
		);
	}
});

test("without the reserve the ceiling is breached (documents the defect)", () => {
	// Guards against a later "simplification" that drops the reserve: this is the
	// pre-fix composition, and it must NOT satisfy the ceiling.
	const budget = 100;
	const display = applyTokenBudget("word ".repeat(1200), budget, undefined, PARTS.url);
	const composed =
		composeFetchText({ ...PARTS, displayContent: display }) + NOTE;
	assert.ok(
		estimateTokens(composed) > budget,
		`expected the unreserved composition to exceed ${budget}, got ${estimateTokens(composed)}`,
	);
});

// Independent review dlg-4e01c1e1 on #169 found my framing fix covered ONE of two sites
// and left the framing itself unbounded. Both are pinned here through the single seam both
// paths now use, so neither can drift back.
import { composeBudgetedFetchText } from "../src/tools/webfetch.ts";

const LONG_PATH =
	"/tmp/pi-webaio/" +
	"a/very/deep/saved/path/segment/".repeat(8) +
	"page.md";
const LONG_TITLE = `${"A ".repeat(80)}extremely long document title that nobody shortened`;
const SHAPES = {
	normal: {
		formatLabel: "✓ Fetched and saved to /tmp/pi-webaio/x/page.md",
		title: "Short Title",
		url: "https://example.com/p",
	},
	longFraming: {
		formatLabel: `✓ Fetched and saved to ${LONG_PATH}`,
		title: LONG_TITLE,
		url: `https://example.com/${"some/long/".repeat(9)}p`,
	},
};
for (const [name, parts] of Object.entries(SHAPES)) {
	for (const noteOn of [false, true]) {
		test(`ceiling holds for ${name} framing (note ${noteOn ? "on" : "off"})`, () => {
			for (const budget of [100, 200, 400]) {
				const out = composeBudgetedFetchText({
					parts: { ...parts, format: "markdown" },
					body: "word ".repeat(1200),
					budgetTokens: budget,
					note: noteOn ? NOTE : "",
				}).text;
				// Contract, in priority order: the body always keeps its share, so a
				// header that cannot fit even after being shortened overflows the budget
				// RATHER than return an answer with none of the page — and says so.
				// Everything else is a strict ceiling breach.
				const over = estimateTokens(out) - budget;
				if (over > 0) {
					assert.ok(
						/Header needed \d+ of the \d+-token budget/.test(out),
						`${name} budget ${budget}: overflowed by ${over} tokens WITHOUT stating it — ${JSON.stringify(out.slice(0, 70))}`,
					);
					assert.ok(
						over <= 40,
						`${name} budget ${budget}: stated overflow is ${over} tokens, larger than the header it blames`,
					);
				} else {
					assert.ok(
						!/Header needed \d+ of the \d+-token budget/.test(out),
						`${name} budget ${budget}: states an overflow that did not happen`,
					);
				}
				assert.match(out, /word word/, "no page prose survived");
			}
		});
	}
}

test("the seam keeps the framing that identifies the document at every budget", () => {
	// Shrinking the header must not silently stop saying which page this is; the full
	// path and title stay in `details`.
	const out = composeBudgetedFetchText({
		parts: { ...SHAPES.longFraming, format: "markdown" },
		body: "word ".repeat(1200),
		budgetTokens: 100,
		note: NOTE,
	}).text;
	assert.match(out, /Fetched|http|example|page/, `header lost its identity: ${JSON.stringify(out.slice(0, 80))}`);
});

test("the overflow notice is stated exactly when the budget is exceeded", () => {
	// A 61-token answer-mode header at budget 200 left the answer at 196 — inside the
	// ceiling — while still announcing that the header had eaten the budget. The notice
	// must track the measured answer, not the header's share of the budget.
	const shapes = {
		longFraming: {
			parts: { ...SHAPES.longFraming, format: "markdown" },
			body: "word ".repeat(1200),
		},
		answerMode: {
			parts: {
				formatLabel: `✓ Fetched and saved to /tmp/pi-webaio/x/page.md\n[Answer mode: top 100 chunks for "pricing billing". Full content (48000 chars) saved to /tmp/pi-webaio/x/page.md.]`,
				title: "Pricing",
				url: "https://example.com/pricing",
				format: "markdown",
				chunkHeader: "## Chunks (12)",
			},
			body: "billing price ".repeat(1200),
		},
		normal: {
			parts: { ...SHAPES.normal, format: "markdown" },
			body: "word ".repeat(1200),
		},
	};
	for (const [name, { parts, body }] of Object.entries(shapes)) {
		for (const budget of [100, 200, 400, 600]) {
			for (const note of ["", NOTE]) {
				const out = composeBudgetedFetchText({
					parts,
					body,
					budgetTokens: budget,
					note,
				}).text;
				const over = estimateTokens(out) - budget;
				const stated = /Header needed \d+ of the \d+-token budget/.test(out);
				assert.equal(
					stated,
					over > 0,
					`${name} budget ${budget}: over=${over} stated=${stated} — ${JSON.stringify(out.slice(0, 70))}`,
				);
			}
		}
	}
});
