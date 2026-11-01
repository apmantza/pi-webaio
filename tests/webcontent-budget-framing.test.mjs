// ─── aio-webcontent: budgetTokens bounds the COMPOSED output (#165, F18 sibling)
//
// Found by sweeping the pattern CodeRabbit reported at `multi-answer.ts:324`
// (framing text composed outside `budgetTokens`) across every other call site
// that takes the same parameter. `aio-webcontent` was the remaining member.
//
// The handler pruned the body to exactly `budgetTokens` with `applyTokenBudget`,
// then prepended a header block (`Retrieved content for …`, `Title: …`,
// `Length: … chars`, `Content hash: …`, `Unchanged since …`, `\n---\n`) that was
// never counted. Measured on the pre-fix code:
//
//   budget=100   body=97   framing=25   composed=122   OVER
//   budget=300   body=270  framing=25   composed=295   ok
//   budget=500   body=478  framing=25   composed=503   OVER
//   budget=2000  body=1801 framing=25   composed=1826  ok
//
// 22% over at budget 100. Whether a row lands over depends on how much slack the
// pruner happens to leave, which is exactly why an unmeasured budget is not a
// ceiling.
//
// The tool's own description promises a "Hard token budget for the content
// returned to the agent" — and the header is returned to the agent. It also
// contradicts `aio-webfetch`, whose `budgetTokens` is documented (and now
// actually enforced) as a hard output-size ceiling: the same parameter name,
// spelled identically in the schemas, meant two different things on two tools.
//
// Recurrence prevented: a `budgetTokens` ceiling that silently drifts whenever
// someone adds another line to the header block.
import assert from "node:assert";
import test from "node:test";
import {
	bodyBudgetForFraming,
	buildWebcontentText,
} from "../src/tools/webcontent.ts";
import { applyTokenBudget } from "../src/prune-markdown.ts";
import { estimateTokens } from "../src/token-count.ts";

const LONG = Array.from(
	{ length: 60 },
	(_, i) => `## Section ${i}\n\n${"word ".repeat(30)}`,
).join("\n");

const HEADER = (url = "https://example.com/page") => [
	`Retrieved content for ${url}`,
	"Title: Some Page Title Here",
	`Length: ${LONG.length} chars`,
	"Content hash: a1b2c3d4e5f6",
];

// The handler's real composition path: budget the body for what the header
// leaves, then compose. Asserting through these two seams (the same ones the
// handler calls) is what keeps this honest — a test that subtracted the framing
// itself would be true no matter what the handler does.
function composed(budget, url = "https://example.com/page") {
	const header = HEADER(url);
	const body = applyTokenBudget(
		LONG,
		bodyBudgetForFraming(budget, header),
		undefined,
		url,
	);
	return buildWebcontentText(header, body);
}

test("budgetTokens bounds the composed output, header included", () => {
	for (const budget of [100, 150, 300, 500, 2000]) {
		const out = composed(budget);
		const used = estimateTokens(out);
		assert.ok(
			used <= budget,
			`budget ${budget}: composed output is ${used} tokens (${used - budget} over)`,
		);
	}
});

test("the pre-fix composition overruns, so the seam is what fixes it", () => {
	// Guards against the seam silently becoming a no-op: reproduce the old
	// handler arithmetic and show it really does overrun at the same budget the
	// first test pins.
	const header = HEADER();
	const naive = applyTokenBudget(
		LONG,
		100,
		undefined,
		"https://example.com/page",
	);
	const old = `${header.join("\n")}\n---\n${naive}`;
	assert.ok(
		estimateTokens(old) > 100,
		"old arithmetic now fits — the first test would pass without the seam",
	);
});

test("a longer header costs body tokens, not budget tokens", () => {
	// The header grows when a title, a hash and the "unchanged" note are all
	// present. That growth must come out of the body, never push the total over.
	const header = [
		...HEADER(),
		"Unchanged since previous version (ffee1234aa56)",
	];
	const out = buildWebcontentText(
		header,
		applyTokenBudget(
			LONG,
			bodyBudgetForFraming(200, header),
			undefined,
			"https://example.com/page",
		),
	);
	assert.ok(
		estimateTokens(out) <= 200,
		`with the full header the composed output is ${estimateTokens(out)} > 200`,
	);
});

test("a budget smaller than the header still produces output", () => {
	// Fail-open check: an impossible budget must not collapse to "no budget"
	// (the `budget > 0` reading that made a negative content budget mean
	// unlimited in the cited-answer path).
	const header = HEADER("https://example.com/x");
	const body = applyTokenBudget(
		LONG,
		bodyBudgetForFraming(5, header),
		undefined,
		"https://example.com/x",
	);
	assert.ok(body.length > 0, "an impossible budget produced no body at all");
	assert.ok(
		bodyBudgetForFraming(5, header) >= 1,
		"the body budget must stay positive, never zero-or-negative",
	);
});

test("a long URL and title cannot push the total past the budget", () => {
	// The reachable worst case, and the reason charging the header is not enough
	// on its own. A deep URL plus a verbose title makes the header 83 tokens, so
	// the smallest legal `budgetTokens: 100` leaves a 17-token body — smaller than
	// the truncation notice. Before the notice was stepped down this came back at
	// 153 tokens against a budget of 100 (measured), because the body went to zero
	// and the notice alone was ~30.
	const longUrl = `https://docs.example.com/${Array.from(
		{ length: 14 },
		(_, i) => `segment-${i}`,
	).join("/")}`;
	const header = [
		`Retrieved content for ${longUrl}`,
		"Title: An extremely long page title that goes on and on about the topic",
		`Length: ${LONG.length} chars`,
		"Content hash: a1b2c3d4e5f6",
		"Unchanged since previous version (ffee1234aa56)",
	];
	const body = applyTokenBudget(
		LONG,
		bodyBudgetForFraming(100, header),
		undefined,
		longUrl,
	);
	const out = buildWebcontentText(header, body);
	assert.ok(
		estimateTokens(out) <= 100,
		`composed ${estimateTokens(out)} tokens against budgetTokens: 100`,
	);
});
