import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakes, sample, tool } from "../scripts/bench-search.mjs";

// #97: the full tool's orchestration PROPERTIES, measured offline through the
// real registered `execute`.
//
// What these tests assert are properties, not wall-clock numbers: the lanes
// really run, a late lane is cut at the documented deadline, and a cut lane
// degrades to a status while usable results still ship.
//
// Absolute timing assertions were tried and REMOVED, and the real cause is
// recorded because the first diagnosis of it was wrong. CI measured p50 301ms
// and returned the IDENTICAL 301.1ms for a 0ms lane and a 120ms lane. I
// attributed that to cold process start. It was not: the tool enables the
// FireCrawl lane unconditionally and that lane had no dependency seam, so every
// "instant" sample issued a real network request and waited on it. The floor was
// that lane, and this header claimed the harness made "no network" calls while
// it was making one. Fixed by injecting the bonus lanes rather than by relaxing
// an assertion.
//
// The assertions stay property-shaped anyway: a bound that reddens on the fast
// code under a different machine is not a detector, and the deadline contract is
// what a regression can actually break. The numbers live in
// `npm run bench:search`, which prints them.
//
// The deadlines are shrunk through the tool's own dependency seam so containment
// is exercised in well under a second, deterministically, with no network and no
// Chrome — the last clause now actually true, and asserted by the lane counters
// below rather than only claimed here.

const TIGHT = { searchDeadlineMs: 400, responseTargetMs: 300, httpEngineDeadlineMs: 250, googleLaneMaxMs: 350 };

test("#97: every lane actually runs, and the merge is real", async () => {
	const { deps, calls } = makeFakes({ cdp: true });
	const execute = tool({ ...deps, ...TIGHT }).execute;
	const r = await sample(execute, {
		n: 8,
		args: { google: true, reddit: true },
		queryPrefix: "orchestration-cost",
	});
	assert.equal(calls.http, 8, "the HTTP lane must actually run, or the sample measures nothing");
	assert.equal(calls.google, 8, "the Google lane must actually run");
	assert.equal(calls.reddit, 8, "the Reddit lane must actually run");
	// The bonus API lanes are the ones that used to be unreachable: no seam, so
	// the real FireCrawl client ran and its latency was attributed to the tool.
	assert.equal(calls.firecrawl, 8, "the FireCrawl lane must be faked, not reached live");
	assert.ok(r.results > 8, `expected merged multi-lane results, got ${r.results}`);
	// NO wall-clock upper bound here, on purpose — see the file header. The
	// ceiling that DOES belong in CI is the deadline, asserted by bounds below.
});

test("#97: an abandoned lane cannot hold the tool past the hard deadline", async () => {
	const { deps } = makeFakes({ cdp: true, latency: { google: 5000 } });
	const execute = tool({ ...deps, ...TIGHT }).execute;
	const r = await sample(execute, {
		n: 5,
		args: { google: true, reddit: false },
		queryPrefix: "runaway-google",
	});
	assert.ok(
		r.max <= TIGHT.searchDeadlineMs + 150,
		`tool returned at ${r.max.toFixed(0)}ms with a 5s Google lane and a ${TIGHT.searchDeadlineMs}ms hard cap — a late lane must be cut, not awaited`,
	);
});

test("#97: a cut lane degrades to status, and usable results still ship", async () => {
	const { deps } = makeFakes({ cdp: true, latency: { google: 5000 } });
	const execute = tool({ ...deps, ...TIGHT }).execute;
	const r = await sample(execute, {
		n: 1,
		args: { google: true, reddit: false },
		queryPrefix: "runaway-status",
	});
	const providers = r.details?.providers ?? [];
	const google = providers.find((p) => p.id === "google");
	assert.ok(google, "the Google provider row must still be reported");
	assert.notEqual(
		google.status,
		"ok",
		"a lane that never landed must not be reported as ok",
	);
	assert.ok(r.results > 0, "HTTP results must still ship when the Google lane is cut");
});

test("#97: a default lane is waited for, so lane latency is the real target", async () => {
	const slow = makeFakes({ cdp: true, latency: { google: 120 } });
	const execute = tool({ ...slow.deps, ...TIGHT }).execute;
	const r = await sample(execute, {
		n: 5,
		args: { google: true, reddit: false },
		queryPrefix: "lane-slow",
	});
	// The tool waits for a DEFAULT provider rather than shipping HTTP-only at
	// ~0ms, so the tool's floor is its slowest default lane — the measured reason
	// the 2-3s target is a lane-latency problem, not an aggregation one.
	// Asserted as a LOWER bound plus the deadline: lower bounds survive a slower
	// machine, an upper bound on a warm path does not.
	assert.ok(
		r.min >= 100,
		`a 120ms default lane must not be skipped (fastest sample ${r.min.toFixed(1)}ms)`,
	);
	assert.ok(
		r.max <= TIGHT.searchDeadlineMs + 150,
		`and it must still be cut at the deadline (${r.max.toFixed(0)}ms)`,
	);
	assert.ok(r.results > 0, "and the lane's results must land");
});
