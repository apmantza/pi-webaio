import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWebsearchTool } from "../src/tools/websearch.ts";

// #201: when the Google lane consumes the response budget, the Reddit lane is never
// started — and was then reported as `timeout` with the full budget as its latency.
// Reproduced through the registered tool, so this asserts the CONTRACT a caller reads,
// not the branch that writes it: `searchReddit()` call count and the reported status are
// asserted together, which is what makes a future re-labelling fail instead of agreeing.

function harness({ googleSettles = false }) {
	const registered = [];
	const calls = { reddit: 0, google: 0 };
	registerWebsearchTool(
		{ registerTool(t) { registered.push(t); } },
		{
			loadGoggles: async () => ({ name: "t", rules: [] }),
			searchWeb: async () => ({
				results: [{ title: "H", url: "https://example.com/h", snippet: "s", domain: "example.com" }],
				ddgCount: 1, braveCount: 0, yahooCount: 0, bingCount: 0, redditCount: 0,
			}),
			ensureChrome: async () => ({ running: true, ready: true }),
			googleSearch: async () => {
				calls.google++;
				if (!googleSettles) return new Promise(() => {});
				return { results: [], elapsed: 1 };
			},
			searchReddit: async () => {
				calls.reddit++;
				return { ok: true, query: "x", count: 1, results: [{ title: "R", url: "https://reddit.com/r/x", snippet: "s", domain: "reddit.com" }], elapsed: 5 };
			},
			cdpAvailable: () => true,
			providerAvailable: () => true,
			// The deadlines are chosen so the gated path is STRUCTURAL, not timing-lucky.
			// The first version used `responseTargetMs: 60` with `googleLaneMaxMs: 50`, which
			// put the Google lane's own cap 10ms INSIDE the response target: the lane could
			// settle just before the gate asked `Date.now() >= responseDeadlineAt`, Reddit
			// started, and the test failed its own premise under `test:all` load while passing
			// in isolation. A gate that only holds when the scheduler is idle is not a
			// detector, so the lane cap now sits far outside the response target and the only
			// deadline in play is the one the gate reads.
			searchDeadlineMs: 600,
			responseTargetMs: 40,
			httpEngineDeadlineMs: 20,
			googleLaneMaxMs: 5000,
		},
	);
	return { registered, calls };
}

test("#201: a Reddit lane gated behind Google is reported as not attempted, not timeout", async () => {
	const { registered, calls } = harness({ googleSettles: false });
	const r = await registered[0].execute("c", { query: "gate-probe", reddit: true, google: true, max: 10 });

	// The premise, asserted so the test cannot silently stop exercising the gate.
	assert.equal(calls.reddit, 0, "premise broken: Reddit ran, so this is not the gated path");

	assert.doesNotMatch(
		r.details.redditStatus,
		/^timeout/,
		`a lane that never started must not report timeout: ${r.details.redditStatus}`,
	);
	assert.match(r.details.redditStatus, /not attempted|gated/, `status must name the gate: ${r.details.redditStatus}`);

	const row = r.details.providers.find((p) => p.id === "reddit");
	assert.ok(row, "reddit row missing from providers");
	assert.notEqual(row.status, "timeout", `providers row still claims timeout: ${JSON.stringify(row)}`);
	// Not merely "not timeout": it must be the provider surface's own word for a lane that
	// did not run. Without this, routing the case to `empty` ("Reddit answered with
	// nothing") is a second mislabel that the assertion above would happily accept.
	assert.equal(row.status, "skipped", `providers row must say skipped: ${JSON.stringify(row)}`);
	// The fabricated measurement: 60ms of Reddit latency for zero requests.
	assert.ok(
		!row.latencyMs || row.latencyMs === 0,
		`a lane that made no request must not report latency: ${JSON.stringify(row)}`,
	);
});

test("#201: the genuine Reddit budget miss still reports timeout", async () => {
	// The other side of the same seam. If the fix widened the not-attempted label to
	// every late Reddit, it would erase a real provider failure — which is the opposite
	// defect and equally bad for a caller deciding whether the result set is complete.
	const registered = [];
	registerWebsearchTool(
		{ registerTool(t) { registered.push(t); } },
		{
			loadGoggles: async () => ({ name: "t", rules: [] }),
			searchWeb: async () => ({ results: [{ title: "H", url: "https://example.com/h", snippet: "s", domain: "example.com" }], ddgCount: 1, braveCount: 0, yahooCount: 0, bingCount: 0, redditCount: 0 }),
			ensureChrome: async () => ({ running: true, ready: true }),
			googleSearch: async () => ({ results: [], elapsed: 1 }),
			searchReddit: async () => ({ ok: false, query: "x", count: 0, results: [], elapsed: 40, error: "Reddit search missed the aio-websearch response budget" }),
			cdpAvailable: () => true,
			providerAvailable: () => true,
			searchDeadlineMs: 500, responseTargetMs: 50, httpEngineDeadlineMs: 40, googleLaneMaxMs: 40,
		},
	);
	const r = await registered[0].execute("c", { query: "real-timeout", reddit: true, google: true, max: 10 });
	assert.match(r.details.redditStatus, /^timeout \(response budget/, JSON.stringify(r.details.redditStatus));
});
