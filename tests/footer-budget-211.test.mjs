// #211 — the truncation footer quoted a budget the caller never asked for.
//
// `aio-webfetch` sizes the body below the caller's number because the header spends
// part of the same ceiling. That arithmetic is correct. The defect is that
// `applyTokenBudget` stamped its footer with its OWN effective budget, so a caller who
// passed `budgetTokens: 150` read "truncated to fit 108-token budget" — a number that
// appears nowhere in their request and cannot be reconciled.
//
// The seam already exists: `src/multi-answer.ts` renders `displayBudgetTokens ?? budget`.
// This is the same rule applied to the second and third callers, not a new mechanism.
import assert from "node:assert";
import test from "node:test";
import { applyTokenBudget } from "../src/prune-markdown.ts";
import { registerWebcontentTool } from "../src/tools/webcontent.ts";
import { storeContent } from "../src/session-store.ts";
import { composeBudgetedFetchText } from "../src/tools/webfetch.ts";
import { estimateTokens } from "../src/token-count.ts";

const BODY =
	"# Section One\n\n" +
	"Real article prose that should survive the trim here. ".repeat(40) +
	"\n\n## Section Two\n\n" +
	"More prose here to matter at larger budgets indeed. ".repeat(30);

/** The budget number a footer states, or null when it states none. */
function footerBudget(text) {
	const m = /(?:fits|to fit) (?:the )?(\d+)[- ]token/i.exec(text);
	return m ? Number(m[1]) : null;
}

test("#211: displayBudgetTokens restates the caller's number, not the internal one", () => {
	// 108 is the body budget a `budgetTokens: 150` call produces with ~42 tokens of
	// framing; the caller asked for 150 and must read 150.
	const out = applyTokenBudget(BODY, 108, "q", "https://example.test/a", {
		displayBudgetTokens: 150,
	});
	assert.equal(footerBudget(out), 150, `footer did not quote the caller's budget: ${out.slice(-140)}`);
});

test("#211: omitting displayBudgetTokens keeps today's behaviour exactly", () => {
	// Backward-compatibility pin: every other caller (and the direct unit tests in
	// prune-markdown.test.mjs) must keep seeing the effective budget.
	const out = applyTokenBudget(BODY, 108, "q", "https://example.test/a");
	assert.equal(footerBudget(out), 108, `default footer changed: ${out.slice(-140)}`);
});

test("#211: the terse rungs keep the number whenever a number can fit at all", () => {
	// The old rung list was hardcoded without a number, so a slightly tighter room made
	// the footer say "truncated to fit the token budget" — the same confusion wearing a
	// different face: a truncation claim with no budget the caller can check.
	const out = applyTokenBudget(BODY, 46, "q", "https://example.test/a", {
		displayBudgetTokens: 120,
	});
	const stated = footerBudget(out);
	assert.equal(stated, 120, `terse rung dropped the caller's number: ${out.slice(-120)}`);
});

test("#211: the display number never inflates the answer past the real budget", () => {
	// The whole point is that the displayed number is a label, not a second contract.
	// A display of 5000 against a real budget of 108 must not unlock 5000 tokens.
	const out = applyTokenBudget(BODY, 108, "q", "https://example.test/a", {
		displayBudgetTokens: 5000,
	});
	assert.ok(
		estimateTokens(out) <= 108,
		`display budget leaked into the ceiling: ${estimateTokens(out)} > 108`,
	);
});

test("#211: the composed fetch answer quotes the caller's budgetTokens", () => {
	// The real tool path: webfetch hands the body a reduced budget so the header fits
	// inside the same ceiling. That is where "150 -> 108" was observed.
	const { text } = composeBudgetedFetchText({
		parts: {
			title: "A Document Title Long Enough To Cost Real Tokens",
			url: "https://react.dev/reference/rsc/server-components",
			formatLabel: "markdown",
			outPath: "/tmp/pi-webaio/react.dev/server-components.md",
			site: "react.dev",
		},
		body: BODY,
		budgetTokens: 150,
		query: "prose",
	});
	assert.ok(estimateTokens(text) <= 150, `ceiling broken: ${estimateTokens(text)} > 150`);
	assert.equal(footerBudget(text), 150, `footer still quotes an internal budget: ${text.slice(-160)}`);
});

test("#211: a display budget of zero or absent is not treated as a real budget", () => {
	// Guard against a caller passing `undefined`/0 through and producing "0-token budget".
	const out = applyTokenBudget(BODY, 108, "q", "https://example.test/a", { displayBudgetTokens: 0 });
	assert.equal(footerBudget(out), 108, `zero display produced: ${out.slice(-140)}`);
});

test("#211: no notice ever claims the answer ENDS at the budget", () => {
	// "truncated to N tokens" asserts a truncation POINT. The answer is at most N and
	// usually fewer, so that wording restates the #211 confusion -- a number the caller
	// cannot reconcile with what they received. Every rung must read as a LIMIT.
	//
	// The budget range is measured, not guessed. The first version of this test swept
	// 46..140 and PASSED BOTH MUTANTS: at those rooms an earlier rung always wins, so the
	// rung under test never ran and the assertion was vacuous. Measured on this fixture the
	// short rung wins at exactly budgets 20 and 21 — a narrow window, because it only wins
	// where the longer forms no longer fit and the numberless ones are not yet needed. It is
	// reachable, which is what makes it worth pinning rather than dead.
	for (const budget of [20, 21]) {
		const out = applyTokenBudget(BODY, budget, "q", "https://example.test/a", {
			displayBudgetTokens: 120,
		});
		assert.ok(
			!/truncated to \d+ tokens/i.test(out),
			`rung claims an endpoint at budget ${budget}: ${out.slice(-100)}`,
		);
		// Present, not merely "null is acceptable": asserting only the absence of an endpoint
		// lets the whole rung be deleted and still pass.
		assert.equal(
			footerBudget(out),
			120,
			`the number-bearing rung was skipped at budget ${budget}: ${out.slice(-100)}`,
		);
	}
	// And nowhere in the whole range does any rung state an endpoint.
	for (let budget = 1; budget <= 200; budget++) {
		const out = applyTokenBudget(BODY, budget, "q", "https://example.test/a", {
			displayBudgetTokens: 120,
		});
		assert.ok(
			!/truncated to \d+ tokens/i.test(out),
			`endpoint wording reachable at budget ${budget}: ${out.slice(-100)}`,
		);
	}
});

test("#211: the registered aio-webcontent handler quotes the caller's budgetTokens", async () => {
	// The second caller, driven the way the harness drives it. A seam test on
	// `applyTokenBudget` alone stays green while a handler forgets to pass the number —
	// the same reason the ceiling work needed a handler-seam test, and the reason this
	// mutant was reported as surviving until this test existed.
	const registered = [];
	registerWebcontentTool({ registerTool: (t) => registered.push(t) });
	assert.equal(registered.length, 1);
	const url = `https://docs.example.test/${Array.from({ length: 24 }, (_, i) => `page-${i}-slug`).join("/")}`;
	storeContent(url, "A long page title ".repeat(5), BODY);
	const result = await registered[0].execute("call-211", { url, budgetTokens: 200 });
	const text = result.content[0].text;
	assert.ok(estimateTokens(text) <= 200, `ceiling broken: ${estimateTokens(text)} > 200`);
	assert.match(text, /Real article prose/, "the handler returned no page prose");
	assert.equal(footerBudget(text), 200, `footer quoted an internal budget: ${text.slice(-160)}`);
});
