// #97: the benchmark that produces the performance evidence must not report a lane that
// made zero requests as a timeout.
//
// Recurrence this guards: the n=10 baseline run recorded `reddit=0/10 (0%)` with
// `reddit=timeout` in BOTH legacy and broker mode. Read as written, that says "Reddit is
// too slow — tighten or widen its deadline". It was not slow: `searchReddit()` returns
// `null` when `DevToolsActivePort` does not exist for the profile dir, i.e. it made NO
// request. The harness collapsed that null into `budgetMiss: true`, so a lane that never
// ran was billed as a timeout, and the tuning decision a reader would take from the table
// points at the wrong lane.
//
// This is the same defect shape #201 fixed in the tool itself (`src/tools/websearch.ts`
// reports "disabled (not attempted: …)" and `latencyMs: 0` for exactly this case, and
// "unavailable (CDP search returned null)" for the null case). The tool got it right; the
// harness that measures the tool did not, and #97's acceptance evidence is harness output.
import assert from "node:assert";
import test from "node:test";
import { classifyBenchRedditStatus, redditLaneOutcome } from "../scripts/bench-full-search.mjs";

test("#97: the lane mapping gives a null result its own axis, not budgetMiss", () => {
	// This is the line that actually decides the label. Pinning the classifier alone would
	// let `unavailable: r === null` regress to `false` and keep every classifier assertion
	// green while the reported evidence went back to saying `timeout`.
	const o = redditLaneOutcome(null);
	assert.equal(o.unavailable, true, "null must set the unavailable axis");
	assert.equal(o.budgetMiss, false, "a lane that never ran has no measured timeout");
	assert.deepEqual(o.results, []);
	// And end to end through the classifier, which is what the table prints.
	assert.doesNotMatch(classifyBenchRedditStatus({ source: "reddit", ...o }), /^timeout/);
});

test("#97: the lane mapping still reports a real budget miss as a miss", () => {
	const o = redditLaneOutcome({ ok: false, results: [], error: "Reddit search missed the aio-websearch response budget" });
	assert.equal(o.unavailable, false);
	assert.equal(o.budgetMiss, true);
	assert.equal(classifyBenchRedditStatus({ source: "reddit", ...o }), "timeout");
	// A provider error that is not a budget miss must not become a timeout either.
	const e = redditLaneOutcome({ ok: false, results: [], error: "HTTP 500" });
	assert.equal(e.budgetMiss, false);
	assert.equal(classifyBenchRedditStatus({ source: "reddit", ...e }), "error");
});

test("#97: a Reddit lane that returned null is not reported as a timeout", () => {
	// `budgetMiss: true` is what the harness currently sets for null; the classifier must
	// not let that alone decide, because null means "never requested".
	const neverRan = { source: "reddit", results: [], ok: false, budgetMiss: true, unavailable: true };
	assert.doesNotMatch(
		classifyBenchRedditStatus(neverRan),
		/^timeout/,
		`a lane that made zero requests is labelled ${classifyBenchRedditStatus(neverRan)}`,
	);
	assert.match(classifyBenchRedditStatus(neverRan), /unavailable/, "status must name the real cause");
});

test("#97: a genuine Reddit deadline miss STILL reports timeout", () => {
	// The other side. Narrowing the timeout label until it never fires would erase a real
	// provider failure, which is the opposite defect and equally bad for a reader deciding
	// whether the lane is worth its deadline.
	const realMiss = { source: "reddit", results: [], ok: false, budgetMiss: true };
	assert.equal(classifyBenchRedditStatus(realMiss), "timeout");
});

test("#97: provider error and success keep their distinct labels", () => {
	assert.equal(classifyBenchRedditStatus({ results: [1], ok: true, budgetMiss: false }), "ok");
	assert.equal(classifyBenchRedditStatus({ results: [], ok: false, budgetMiss: false }), "error");
	assert.equal(classifyBenchRedditStatus(undefined), "not-settled");
});
