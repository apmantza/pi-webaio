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
