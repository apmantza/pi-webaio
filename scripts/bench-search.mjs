#!/usr/bin/env node
// #97: reproducible FULL-TOOL search benchmark, offline and deterministic.
//
// The measurements that existed before this harness were Google-LANE
// measurements (3-10 samples of the Google extractor) being read as evidence
// about the full `aio-websearch` tool. The tool also fans out to the HTTP
// engines and Reddit, aggregates, dedupes, ranks and renders. This harness
// measures that public path end to end.
//
// It drives the real registered `execute` through the tool's own dependency
// seam with faked providers, so it needs no network, no Chrome and no API key,
// and it is stable enough to assert on. What it measures:
//
//   * pure orchestration cost (fakes resolve instantly) - the part the code
//     controls and the part a "make ranking faster" change could actually move;
//   * whether a slow lane delays usable results;
//   * whether an abandoned lane can hold the tool past the documented deadline.
//
// Live end-to-end validation against real engines is a separate, documented
// concern (see the issue's live-harness requirement): this file deliberately
// makes NO claim about real provider latency, and nothing here should be
// quoted as a p50 for the tool against the internet.

import { registerWebsearchTool } from "../src/tools/websearch.ts";

const PROVIDERS = ["ddg", "brave", "yahoo", "bing"];

function mkResults(n, tag) {
	return Array.from({ length: n }, (_, i) => ({
		title: `Result ${tag} ${i}`,
		url: `https://example${i % 7}.com/${tag}/${i}`,
		snippet: `Snippet ${tag} ${i} - a little text so token shaping is realistic.`,
		domain: `example${i % 7}.com`,
	}));
}

/**
 * Build the dependency seam. `latency` is per-lane artificial delay in ms and
 * `cdp` decides whether the Chrome-dependent lanes are eligible at all - both
 * of which the production gating honours, so the fake exercises the real
 * `shouldRunGoogle`/`shouldRunReddit` path rather than bypassing it.
 */
export function makeFakes({ latency = {}, cdp = true, perEngine = 8 } = {}) {
	const calls = { http: 0, google: 0, reddit: 0, firecrawl: 0, tinyfish: 0, parallel: 0 };
	const engineStatus = Object.fromEntries(
		PROVIDERS.map((id) => [id, { status: "ok", count: perEngine }]),
	);
	const deps = {
		searchWeb: async () => {
			calls.http++;
			if (latency.http) await sleep(latency.http);
			return {
				results: PROVIDERS.flatMap((id) => mkResults(perEngine, id)),
				ddgCount: perEngine,
				braveCount: perEngine,
				yahooCount: perEngine,
				bingCount: perEngine,
				redditCount: 0,
				engineStatus,
			};
		},
		googleSearch: async () => {
			calls.google++;
			if (latency.google) await sleep(latency.google);
			return { results: mkResults(perEngine, "google") };
		},
		searchReddit: async () => {
			calls.reddit++;
			if (latency.reddit) await sleep(latency.reddit);
			return { results: mkResults(4, "reddit"), status: "ok" };
		},
		cdpAvailable: () => cdp,
		// The bonus API lanes are real network calls and FireCrawl is enabled
		// unconditionally in the tool, so without these fakes every "instant"
		// sample here issued a live FireCrawl request and waited on it. That is
		// where the ~300ms floor came from: the number a 0ms lane and a 120ms lane
		// both measured was this lane, not orchestration. TinyFish and Parallel
		// default to "no key configured" and so were latent, but they are faked for
		// the same reason: a benchmark that reaches the network is not offline.
		searchFirecrawl: async () => {
			calls.firecrawl++;
			if (latency.firecrawl) await sleep(latency.firecrawl);
			return { results: mkResults(6, "firecrawl") };
		},
		searchTinyfish: async () => {
			calls.tinyfish++;
			if (latency.tinyfish) await sleep(latency.tinyfish);
			return { results: mkResults(6, "tinyfish") };
		},
		searchParallel: async () => {
			calls.parallel++;
			if (latency.parallel) await sleep(latency.parallel);
			return { results: mkResults(6, "parallel") };
		},
		// Google and Reddit are gated on BOTH Chrome eligibility and provider
		// availability; stubbing this false silently measures nothing, which is
		// exactly how a first draft of this harness reported a 0.1ms p50 for a
		// 2500ms Google lane.
		providerAvailable: (name) => name === "google" || name === "reddit",
		ensureChrome: async () => true,
	};
	return { deps, calls };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register the tool against a capturing fake `pi` and hand back its execute. */
export function tool(deps) {
	const captured = {};
	registerWebsearchTool({ registerTool: (def) => Object.assign(captured, def) }, deps);
	return captured;
}

/**
 * One sample per unique query: the tool caches by query, so reusing a query
 * would measure the cache rather than the orchestration.
 */
export async function sample(execute, { n = 15, args = {}, queryPrefix = "bench" } = {}) {
	const times = [];
	let last = null;
	for (let i = 0; i < n; i++) {
		const t0 = process.hrtime.bigint();
		last = await execute(`call-${i}`, { query: `${queryPrefix}-${i}`, ...args }, undefined, () => {});
		times.push(Number(process.hrtime.bigint() - t0) / 1e6);
	}
	return { ...describe(times), results: last?.details?.results?.length ?? 0, details: last?.details };
}

function describe(times) {
	const s = [...times].sort((a, b) => a - b);
	const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
	return { n: s.length, p50: at(0.5), p95: at(0.95), min: s[0], max: s[s.length - 1] };
}

const fmt = (v) => `${v.toFixed(1)}ms`;

export async function run({ n = 15 } = {}) {
	const rows = [];
	const run1 = async (label, fakes, args, expect) => {
		const { deps, calls } = makeFakes(fakes);
		const ex = tool(deps).execute;
		const r = await sample(ex, { n, args, queryPrefix: label.replace(/\W+/g, "-") });
		rows.push({ label, ...r, calls, expect });
		console.log(
			`${label.padEnd(38)} n=${String(r.n).padStart(2)} p50=${fmt(r.p50).padStart(9)} p95=${fmt(r.p95).padStart(9)} max=${fmt(r.max).padStart(9)} results=${String(r.results).padStart(3)} lanes=${JSON.stringify(calls)}`,
		);
		return r;
	};

	console.log("--- orchestration cost (instant fakes: no provider latency at all) ---");
	// Two rows, and they differ in exactly one axis: whether the Chrome-dependent
	// lanes are eligible. An earlier draft had an "all lanes off" row that passed
	// the same fakes and the same arguments as "http only", so the two baselines
	// were the same measurement printed twice — a comparison that can only ever
	// report zero difference.
	const noCdp = await run1("http + bonus (CDP off)", { cdp: false }, { google: false, reddit: false });
	const warm = await run1("http + bonus + google + reddit", { cdp: true }, { google: true, reddit: true });

	console.log("\n--- does a slow lane delay the whole tool? ---");
	await run1("google 2500ms", { cdp: true, latency: { google: 2500 } }, { google: true });
	await run1("reddit 2500ms", { cdp: true, latency: { reddit: 2500 } }, { google: false, reddit: true });

	console.log("\n--- can an abandoned lane outrun the documented deadline? ---");
	const runaway = await run1("google 20000ms (abandoned)", { cdp: true, latency: { google: 20000 } }, { google: true });
	const runawayReddit = await run1("reddit 20000ms (abandoned)", { cdp: true, latency: { reddit: 20000 } }, { google: false, reddit: true });

	return {
		rows,
		orchestration: { noCdp, warm },
		runaway: { google: runaway, reddit: runawayReddit },
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const r = await run();
	console.log("\nInterpretation:");
	console.log(`  * orchestration p50 ${r.orchestration.warm.p50.toFixed(1)}ms - ranking/dedup/render is not the bottleneck;`);
	console.log("    the tool's floor is its slowest DEFAULT provider lane, so the");
	console.log("    2-3s target is a lane-latency problem, not an aggregation one.");
	console.log(`  * abandoned lanes are cut at ${r.runaway.google.p50.toFixed(0)}ms / ${r.runaway.reddit.p50.toFixed(0)}ms with a partial result,`);
	console.log("    i.e. the hard deadline holds; a late lane degrades to status, not a hang.");
}
