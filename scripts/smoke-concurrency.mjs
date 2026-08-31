// Issue #111 latency smoke: cold/warm × single/concurrent on the real
// googleSearchWithDependencies path with the tool's new default (max=8).
//
// Usage:
//   node --experimental-strip-types scripts/smoke-concurrency.mjs            # warm runs
//   node --experimental-strip-types scripts/smoke-concurrency.mjs --cold     # expects Chrome DOWN first, then cold → warm
//
// Phases:
//   1. cold single    (only with --cold; assumes Chrome was killed beforehand)
//   2. warm single    (one search, settled infra)
//   3. warm concurrent (two Promise.all searches, stagger 0)
//
// NOTE: uses real-world queries — Google returns genuine zero-result pages
// for obscure strings, and a zero-result SERP is a legitimate response, not
// a failure (the harness would grind to its deadline waiting for h3s that
// will never render).
import { googleSearchWithDependencies } from "../src/google-ai.ts";

const cold = process.argv.includes("--cold");
const unique = Date.now();
const queries = [
	["what is the broker pattern in distributed systems", "node.js stream backpressure explained"],
	["typescript const type parameters", "react server components hydration"],
	["sqlite performance tuning pragmas", "rust tokio runtime architecture"],
];

const timed = (q, maxResults = 8, timeoutMs = 30000) => {
	const t0 = Date.now();
	return googleSearchWithDependencies(q, { maxResults, timeoutMs }).then(
		(r) => ({
			ok: true,
			ms: Date.now() - t0,
			n: r.results?.length ?? 0,
			phases: r.timings
				? `setup=${Math.round(r.timings.targetSetupMs ?? 0)} nav=${Math.round(r.timings.navigationMs ?? 0)} extract=${Math.round(r.timings.extractionMs ?? 0)}`
				: "",
			pages: r.timings?.pages?.length ?? 0,
		}),
		(e) => ({
			ok: false,
			ms: Date.now() - t0,
			code: e?.code,
			msg: String(e?.message || e).slice(0, 90),
		}),
	);
};

const show = (label, r) => {
	if (r.ok)
		console.log(
			`${label}: OK ${r.ms}ms n=${r.n} pages=${r.pages} ${r.phases}`,
		);
	else console.log(`${label}: FAIL ${r.ms}ms code=${r.code} ${r.msg}`);
};

if (cold) {
	console.log("=== phase 1: COLD (Chrome + broker assumed down) ===");
	const [q1] = queries[0];
	show("cold single", await timed(`${q1} ${unique}`));
} else {
	console.log("=== phase 1 skipped (no --cold; warm infra assumed) ===");
}

console.log("=== phase 2: WARM single ===");
show("warm single 1", await timed(queries[0][0]));
show("warm single 2", await timed(queries[0][1]));

console.log("=== phase 3: WARM concurrent x2 (Promise.all, stagger 0) ===");
const t0 = Date.now();
const [a, b] = await Promise.all([
	timed(queries[1][0]),
	timed(queries[1][1]),
]);
show("conc A", a);
show("conc B", b);
console.log(`conc wall: ${Date.now() - t0}ms`);

console.log("=== phase 4: WARM concurrent x2 round 2 (sustained load) ===");
const t1 = Date.now();
const [c, d] = await Promise.all([timed(queries[2][0]), timed(queries[2][1])]);
show("conc 2A", c);
show("conc 2B", d);
console.log(`conc wall: ${Date.now() - t1}ms`);

process.exit(0);
