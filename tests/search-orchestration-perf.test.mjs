import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakes, sample, tool } from "../scripts/bench-search.mjs";

// #97: the full tool's orchestration cost and deadline containment, measured
// offline through the real registered `execute`.
//
// Why these two properties and not "search is fast": the issue's investigation
// list asks whether ranking/dedup/rendering and abandoned lanes are what keep
// the tool off a 2-3s p50. Measured here with instant fakes, orchestration is
// ~0.2ms p50, so it is NOT the bottleneck — the tool's floor is its slowest
// DEFAULT provider lane. A bound that generous relative to the measurement is
// deliberate: it stays green on a loaded CI box while still reddening if
// aggregation or ranking regresses into something quadratic.
//
// The deadlines are shrunk through the tool's own dependency seam so the
// containment property is exercised in well under a second, deterministically,
// with no network and no Chrome.

const TIGHT = { searchDeadlineMs: 400, responseTargetMs: 300, httpEngineDeadlineMs: 250, googleLaneMaxMs: 350 };

test("#97: orchestration (fan-out, aggregate, dedup, rank, render) is not the bottleneck", async () => {
	const { deps, calls } = makeFakes({ cdp: true });
	const execute = tool({ ...deps, ...TIGHT }).execute;
	const r = await sample(execute, {
		n: 8,
		args: { google: true, reddit: true },
		queryPrefix: "orchestration-cost",
	});
	// Every lane is eligible and every fake resolves immediately, so this is
	// the tool's own cost and nothing else.
	assert.equal(calls.http, 8, "the HTTP lane must actually run, or the sample measures nothing");
	assert.equal(calls.google, 8, "the Google lane must actually run");
	assert.equal(calls.reddit, 8, "the Reddit lane must actually run");
	assert.ok(
		r.p50 < 50,
		`orchestration p50 was ${r.p50.toFixed(1)}ms (measured ~0.2ms); a regression here is the aggregation/ranking cost the issue asks about`,
	);
	assert.ok(r.results > 8, `expected merged multi-lane results, got ${r.results}`);
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

test("#97: a slow lane delays the result, so lane latency is the real target", async () => {
	const fast = makeFakes({ cdp: true });
	const slow = makeFakes({ cdp: true, latency: { google: 120 } });
	const fastR = await sample(tool({ ...fast.deps, ...TIGHT }).execute, {
		n: 6,
		args: { google: true, reddit: false },
		queryPrefix: "lane-fast",
	});
	const slowR = await sample(tool({ ...slow.deps, ...TIGHT }).execute, {
		n: 6,
		args: { google: true, reddit: false },
		queryPrefix: "lane-slow",
	});
	// The tool waits for a DEFAULT provider rather than returning HTTP-only at
	// ~0ms, so the tool's floor is the slowest default lane. This is the
	// measured reason the 2-3s target is a lane-latency problem, not an
	// aggregation one.
	assert.ok(
		slowR.p50 >= 100 && fastR.p50 < 50,
		`expected the 120ms lane to move the tool (slow p50 ${slowR.p50.toFixed(1)}ms vs fast ${fastR.p50.toFixed(1)}ms)`,
	);
});
