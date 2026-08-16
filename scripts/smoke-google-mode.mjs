// Broker-vs-legacy smoke harness: runs googleSearch (the real tool code path)
// under a chosen PI_WEBAIO_CDP_BROKER mode and reports timing + result shape.
// Usage: node --experimental-strip-types scripts/smoke-google-mode.mjs <legacy|broker> <query...>
import { googleSearch } from "../src/google-ai.ts";

const mode = process.argv[2] ?? "legacy";
const query = process.argv.slice(3).join(" ") || "pi coding agent";

process.env.PI_WEBAIO_CDP_BROKER = mode === "broker" ? "1" : "0";
console.log(`\n=== googleSearch mode=${mode} (PI_WEBAIO_CDP_BROKER=${process.env.PI_WEBAIO_CDP_BROKER}) ===`);
console.log(`query: "${query}"`);

const t0 = Date.now();
try {
	const result = await googleSearch(query, {
		timeoutMs: 25000,
		maxResults: 5,
	});
	const dt = Date.now() - t0;
	console.log(`elapsed: ${dt}ms`);
	const results = result?.results ?? [];
	console.log(`results: ${results.length}`);
	for (const r of results.slice(0, 5)) {
		console.log(`  - ${String(r.title ?? "").slice(0, 70)}`);
		console.log(`    ${r.url}`);
	}
	if (results.length === 0) {
		console.log(`raw: ${JSON.stringify(result).slice(0, 500)}`);
	}
} catch (e) {
	const dt = Date.now() - t0;
	console.log(`elapsed: ${dt}ms`);
	console.log(`THREW: ${String(e?.message ?? e).slice(0, 400)}`);
}
