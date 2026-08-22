#!/usr/bin/env node
// probe-google-lane.mjs — one-off diagnostic: Google lane latency split by
// broker-daemon state (cold spawn vs already-running-but-warming vs warm).
// Usage: node --experimental-strip-types scripts/probe-google-lane.mjs [--kill-first]
import { closeGoogleBroker, ensureChrome, googleSearch } from "../src/google-ai.ts";

const killFirst = process.argv.includes("--kill-first");
const queries = [
	"gleam language release notes",
	"pi coding agent extensions",
	"webassembly runtime benchmarks",
	"rust async runtime comparison",
	"zig build system explained",
];

const ts = () => Date.now();
if (killFirst) {
	console.log("closing any live broker daemon…");
	await closeGoogleBroker(undefined, { deadlineAt: ts() + 8_000 }).catch(() => {});
	await new Promise((r) => setTimeout(r, 2_000));
}

let q = 0;
const nextQuery = () => queries[q++ % queries.length];

async function timedSearch(label) {
	const t0 = ts();
	let chromeMs = null;
	try {
		const ready = await ensureChrome(undefined, { deadlineAt: ts() + 30_000 });
		chromeMs = ts() - t0;
		const g = await googleSearch(nextQuery(), {
			timeoutMs: 25_000,
			maxResults: 10,
			deadlineAt: ts() + 25_000,
		});
		const total = ts() - t0;
		console.log(
			`${label}: chromeReady=${chromeMs}ms search=${total - chromeMs}ms TOTAL=${total}ms results=${g.results?.length ?? 0}`,
		);
		return { label, chromeMs, searchMs: total - chromeMs, total, ok: (g.results?.length ?? 0) > 0 };
	} catch (e) {
		const total = ts() - t0;
		console.log(`${label}: FAILED @ ${total}ms (chromeReady=${chromeMs ?? "?"}ms) ${String(e?.message ?? e).slice(0, 100)}`);
		return { label, chromeMs, total, ok: false };
	}
}

await timedSearch("run1 (first probe — may hit warming daemon)");
for (let i = 2; i <= 6; i++) {
	await timedSearch(`run${i} (warm)`);
	await new Promise((r) => setTimeout(r, 1500));
}
await closeGoogleBroker(undefined, { deadlineAt: ts() + 5_000 }).catch(() => {});
process.exit(0);
