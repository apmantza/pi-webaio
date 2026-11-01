// ─── Cited answer mode: one framing, whole-chunk budgeting (#165, F18) ───
//
// Live: `aio-webfetch(urls:[persist, issue#984], query:"How do you migrate
// persisted state between store versions?", budgetTokens:320)` printed
//
//   [Multi-source answer mode: top 5 cited chunk(s)… ]   <- added by the tool
//   Cited answer: top 5 chunk(s) across 2 source(s)…     <- added by the library
//   Each block is verbatim supporting text labeled with  <- again, both layers
//   its source URL — verify against that source.
//
// …then `applyTokenBudget` pruned INSIDE the verbatim quotes and reported
// "6 sections omitted", listing the wrapper title `pmndrs/zustand — issues/984`
// as a "section". A block the tool promises is "verbatim supporting text" must
// not be cut mid-sentence, and framing must not be a pruning candidate.
//
// Recurrence prevented: duplicated framing burning the budget it claims to
// conserve, and a "verbatim" quote that is silently truncated.
import assert from "node:assert";
import test from "node:test";
import { formatMultiSourceAnswer } from "../src/multi-answer.ts";
import { buildMultiAnswerText, composeMultiAnswerText } from "../src/tools/webfetch.ts";
import { estimateTokens } from "../src/token-count.ts";

const mk = (n, url, text) => ({
	url,
	title: `Doc ${n}`,
	heading: `Heading ${n}`,
	score: 10 - n,
	text,
});

const RANKED = [
	mk(1, "https://a.dev/persist", "Alpha " .repeat(60)),
	mk(2, "https://b.dev/issues/984", "Bravo ".repeat(60)),
	mk(3, "https://a.dev/migrate", "Charlie ".repeat(60)),
];

// ─── One owner of the framing ───

test("F18: the answer states its mode exactly once", () => {
	const out = formatMultiSourceAnswer(RANKED, "How do you migrate persisted state?");
	const headerCount = (out.match(/Cited answer:/g) ?? []).length;
	assert.equal(headerCount, 1, `expected one header, found ${headerCount}`);
	const verifyCount = (
		out.match(/verify against that source/gi) ?? []
	).length;
	assert.equal(
		verifyCount,
		1,
		`the verify note must appear once, found ${verifyCount}`,
	);
});

// The earlier version of this test read `src/tools/webfetch.ts` and asserted
// two literal strings were absent. That is brittle (any rewording reds it) and
// weak (duplicate framing assembled from different fragments would pass). This
// drives the real composition seam with the library's real output and counts
// framing in the assembled text.
test("F18: the tool layer adds the tally and query, not a second framing", () => {
	const displayContent = formatMultiSourceAnswer(RANKED, "How do you migrate persisted state?", {
		sourcesCount: 2,
	});
	const out = composeMultiAnswerText({
		header: "Fetched 2/2 URLs.",
		notice: '\n[Query: "persist"]',
		displayContent,
		localKnowledgeNote: "",
	});
	// The library's framing survives exactly once…
	assert.equal(
		(out.match(/Cited answer:/g) ?? []).length,
		1,
		`cited-answer header must appear once: ${out}`,
	);
	assert.equal(
		(out.match(/verify against that source/gi) ?? []).length,
		1,
		"verify note must appear once",
	);
	// …and the tool's own contribution appears once and does not restate it.
	assert.equal((out.match(/Fetched 2\/2 URLs\./g) ?? []).length, 1);
	assert.equal((out.match(/\[Query: "persist"\]/g) ?? []).length, 1);
	assert.equal(
		/Each chunk is labeled/.test(out),
		false,
		"the tool must not restate the per-source labeling note",
	);
	assert.equal(
		/Multi-source answer mode/.test(out),
		false,
		"the tool must not restate the mode notice the library already prints",
	);
});

// ─── Budget selects whole chunks; quotes stay verbatim ───

test("F18: a tight budget drops whole chunks instead of cutting them", () => {
	// 200 fits framing + one chunk but not three (the full answer is ~306
	// tokens), so this exercises selection rather than an impossible ask.
	const budget = 200;
	const out = formatMultiSourceAnswer(RANKED, "migrate persisted state", {
		budgetTokens: budget,
	});
	assert.ok(
		estimateTokens(out) <= budget,
		`output ${estimateTokens(out)} tokens exceeds the ${budget} budget`,
	);
	// Whatever survived is verbatim; whatever did not is named as dropped chunks.
	const included = RANKED.filter((r) => out.includes(r.text));
	const excluded = RANKED.filter((r) => !out.includes(r.text));
	assert.ok(included.length >= 1, "at least the top chunk must survive");
	assert.equal(
		included.length + excluded.length,
		RANKED.length,
		"a chunk must be either fully present or fully absent — never partial",
	);
	// The old behaviour: a section-prune footer that invents "sections".
	assert.ok(
		!/section[s]? omitted/i.test(out),
		`the answer reports pruned sections, i.e. it cut inside quotes: ${out.slice(-260)}`,
	);
	assert.match(
		out,
		/chunks?\(s\)? (omitted|dropped)/i,
		"the answer must name how many chunks the budget displaced",
	);
});

test("F18: a generous budget keeps every chunk verbatim", () => {
	const out = formatMultiSourceAnswer(RANKED, "migrate persisted state", {
		budgetTokens: 4000,
	});
	for (const r of RANKED) {
		assert.ok(out.includes(r.text), `chunk ${r.url} must be verbatim`);
	}
	assert.ok(!/omitted|dropped/i.test(out), "nothing was dropped, nothing to report");
});

test("F18: framing never costs the top chunk its place", () => {
	// A budget equal to a bare one-chunk answer is smaller than the same chunk
	// rendered inside a 3-chunk answer (which carries an omission line), so the
	// honest contract is: the top quote is always shown, and if even that does
	// not fit the answer says so rather than silently overrunning.
	const oneChunk = estimateTokens(
		formatMultiSourceAnswer([RANKED[0]], "q", { budgetTokens: 100000 }),
	);
	const out = formatMultiSourceAnswer(RANKED, "q", {
		budgetTokens: oneChunk,
	});
	assert.ok(
		out.includes(RANKED[0].text),
		`the top chunk must survive at the ${oneChunk}-token budget: ${out.slice(0, 200)}`,
	);
	const tokens = estimateTokens(out);
	assert.ok(
		tokens <= oneChunk || /exceeds the \d+ token budget/i.test(out),
		`either fits (${tokens} <= ${oneChunk}) or declares the overage: ${out.slice(-200)}`,
	);
});

test("F18: an impossible budget says so instead of claiming to fit", () => {
	// Smaller than framing plus the smallest possible chunk. The answer must keep
	// the top quote verbatim and state that the budget could not be honoured.
	const out = formatMultiSourceAnswer(RANKED, "q", { budgetTokens: 40 });
	assert.ok(out.includes(RANKED[0].text), "the top chunk must survive");
	assert.ok(
		/exceeds the 40 token budget/i.test(out),
		`must not imply the budget was honoured: ${out.slice(-220)}`,
	);
});

test("F18: the safety wrap is inside the budget, not outside it", () => {
	// Measuring the bare inner text under-counted by the wrap markers, so a
	// budget that looked honoured was not.
	const budget = 260;
	const out = formatMultiSourceAnswer(RANKED, "q", { budgetTokens: budget });
	assert.ok(out.includes("UNTRUSTED WEB CONTENT"), "safety markers must be present");
	assert.ok(
		estimateTokens(out) <= budget,
		`wrapped output ${estimateTokens(out)} exceeds ${budget}`,
	);
});

test("F18: no-chunk mode keeps its single honest line", () => {
	const out = formatMultiSourceAnswer([], "nothing matched", {
		budgetTokens: 200,
	});
	assert.match(out, /no relevant chunks found/i);
	assert.equal((out.match(/Multi-source answer mode/g) ?? []).length, 1);
});

// ─── budgetTokens is a ceiling on the ANSWER, not just on the chunks ──
//
// `formatMultiSourceAnswer` fits the cited chunks to the budget, then the tool
// prepends the batch tally and the query notice and appends the local-knowledge
// note — all outside the budget. Measured before the fix, two sources, a query
// that ranks cleanly:
//
//   budget 100 -> library 98 (honoured) -> composed 107   OVER by 7
//   budget 100 -> with a local-knowledge note -> composed 119  OVER by 19
//
// `budgetTokens` is documented as a hard output-size ceiling, so the framing has
// to be paid for out of it rather than added on top.
//
// Recurrence prevented: a caller that sets budgetTokens=N and receives more than
// N tokens of answer text.
test("F18: budgetTokens bounds the composed answer, framing included", () => {
	// Chunks small enough that the library's documented floor — a single chunk too
	// big for the budget is shown anyway, with a notice — is not what is under
	// test. At budgets below ~130 that floor is what you hit, framing or no framing.
	const small = "alpha beta gamma persist delta epsilon zeta eta.";
	const sources = [
		mk(1, "https://a.com/", small),
		mk(2, "https://b.com/", small.replace("persist", "storage")),
	];
	const note = "\n[Local knowledge: 2 related notes found in your pulled corpus]";

	for (const localKnowledgeNote of ["", note]) {
		for (const budgetTokens of [140, 200, 300]) {
			const text = buildMultiAnswerText({
				ranked: sources,
				query: "persist storage",
				sourcesCount: 2,
				header: "Fetched 2/2 URLs.",
				notice: `\n[Query: "persist storage"]`,
				localKnowledgeNote,
				budgetTokens,
			});
			assert.ok(
				estimateTokens(text) <= budgetTokens,
				`budget ${budgetTokens}${localKnowledgeNote ? " +LK" : ""} returned ${estimateTokens(text)} tokens`,
			);
		}
	}
});

// The framing must be actually charged, not merely tolerated. This needs a budget
// that decides something — more than one chunk, so the budget picks how many are
// kept. With a single chunk the answer size is bimodal (it fits, or the library's
// floor shows it anyway with a LONGER "still exceeds" notice) and no budget exists
// where the framing is decisive.
//
// The control half reproduces what the handler used to do — hand the library the
// raw budget, then compose — using only public seams. At 140 the cited block is
// 126 and the framing is 15, so the naive composition lands at 141: over by
// exactly the framing that was never paid for.
test("F18: the framing is charged against the budget rather than added to it", () => {
	const small = "alpha beta gamma persist delta epsilon zeta eta.";
	const sources = [
		mk(1, "https://a.com/", small),
		mk(2, "https://b.com/", small.replace("persist", "storage")),
	];
	const header = "Fetched 2/2 URLs.";
	const notice = `\n[Query: "persist storage"]`;
	const localKnowledgeNote =
		"\n[Local knowledge: 2 related notes found in your pulled corpus]";
	const budgetTokens = 140;
	const args = {
		ranked: sources,
		query: "persist storage",
		sourcesCount: 2,
		header,
		notice,
		localKnowledgeNote,
	};

	const throughSeam = estimateTokens(
		buildMultiAnswerText({ ...args, budgetTokens }),
	);
	// What the handler did before: budget the block, then add framing on top.
	const framingOnTop = estimateTokens(
		composeMultiAnswerText({
			header,
			notice,
			localKnowledgeNote,
			displayContent: formatMultiSourceAnswer(sources, "persist storage", {
				sourcesCount: 2,
				budgetTokens,
			}),
		}),
	);

	assert.ok(
		throughSeam <= budgetTokens,
		`seam returned ${throughSeam} tokens for a ${budgetTokens} budget`,
	);
	assert.ok(
		framingOnTop > budgetTokens,
		`control no longer reproduces the overshoot (${framingOnTop} tokens at raw ${budgetTokens})`,
	);

	// Omitting budgetTokens imposes no budget at all: the ceiling stays opt-in.
	assert.ok(
		estimateTokens(buildMultiAnswerText(args)) >= throughSeam,
		"an unbudgeted answer came back smaller than the budgeted one",
	);
});

// A budget smaller than the framing must not silently turn into NO budget.
// `formatMultiSourceAnswer` reads `budget > 0` as "a budget exists", so an
// unclamped negative content budget is a fail-OPEN: the caller asked for the
// tightest possible answer and received the entire corpus. The schema floors
// budgetTokens at 100, so this is unreachable through the tool — but the seam is
// not the schema, and the failure it prevents is the loud kind turning silent.
test("F18: a budget smaller than the framing stays a budget, not unlimited", () => {
	const small = "alpha beta gamma persist delta epsilon zeta eta.";
	const sources = Array.from({ length: 6 }, (_, i) =>
		mk(i, `https://s${i}.com/`, `${small} source ${i}`),
	);
	const args = {
		ranked: sources,
		query: "persist storage",
		sourcesCount: sources.length,
		header: "Fetched 6/6 URLs.",
		notice: `\n[Query: "persist storage"]`,
		localKnowledgeNote:
			"\n[Local knowledge: 2 related notes found in your pulled corpus]",
	};

	const tiny = buildMultiAnswerText({ ...args, budgetTokens: 20 });
	const unlimited = buildMultiAnswerText(args);
	assert.ok(
		estimateTokens(tiny) < estimateTokens(unlimited),
		`a 20-token answer came back no smaller than the unbounded one (${estimateTokens(tiny)} vs ${estimateTokens(unlimited)})`,
	);
});
