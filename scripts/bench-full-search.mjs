#!/usr/bin/env node
// bench-full-search.mjs — full aio-websearch benchmark (legacy vs broker).
//
// Mirrors the real tool's orchestration exactly: searchWeb (HTTP engines,
// 4.5s per-engine deadline) + googleSearch (CDP lane) + searchReddit (CDP
// companion), collected under the 7s hard response deadline via
// collectProviderResults. Records total latency, per-provider status/counts,
// and Windows process/commit deltas around each sample.
//
// Usage:
//   node --experimental-strip-types scripts/bench-full-search.mjs <legacy|broker> [samples] [query...]
//   e.g. node --experimental-strip-types scripts/bench-full-search.mjs broker 10 "pi coding agent"
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { ensureChrome, googleSearch } from "../src/google-ai.ts";
import { searchWeb } from "../src/search.ts";
import { searchReddit } from "../src/verticals/reddit_search.ts";
import { collectProviderResults } from "../src/search-orchestration.ts";

const mode = process.argv[2] ?? "legacy";
const samples = Number.parseInt(process.argv[3] ?? "10", 10);
const baseQuery = process.argv.slice(4).join(" ") || "pi coding agent";
// Rotate distinct queries so consecutive samples don't hit the 10-min
// search cache (which would attribute cached results to DDG and measure
// cache hits instead of fresh searches). Mirrors real usage where each
// aio-websearch call is a distinct query.
const QUERIES = [
	baseQuery,
	`${baseQuery} extension API`,
	`${baseQuery} tool registration`,
	`${baseQuery} skills and themes`,
	`${baseQuery} session management`,
	`${baseQuery} provider configuration`,
	`${baseQuery} model integration`,
	`${baseQuery} command line usage`,
	`${baseQuery} configuration reference`,
	`${baseQuery} package publishing`,
];
const SEARCH_DEADLINE_MS = 7000;

process.env.PI_WEBAIO_CDP_BROKER = mode === "broker" ? "1" : "0";
console.log(
	`\n=== FULL aio-websearch benchmark: mode=${mode} (PI_WEBAIO_CDP_BROKER=${process.env.PI_WEBAIO_CDP_BROKER}), samples=${samples}, query="${baseQuery}" ===`,
);

// ─── System snapshot (Windows: process count, working set) ───────────
function systemSnapshot() {
	if (platform() !== "win32") return null;
	try {
		const snapPath = process.env.TEMP + "\\pw-snap.txt";
		execSync(
			"powershell -NoProfile -Command " +
				`"Set-Content -Path '${snapPath}' -Value (@(Get-Process).Count.ToString() + ',' + [math]::Round(((Get-Process | Measure-Object WorkingSet64 -Sum).Sum / 1GB), 2))"`,
			{ encoding: "utf8", timeout: 15000 },
		);
		const [processes, wsGb] = execSync(`type "${snapPath}"`, {
			encoding: "utf8",
			timeout: 5000,
		})
			.trim()
			.split(",");
		try {
			execSync(`del /q "${snapPath}"`, { stdio: "ignore" });
		} catch {}
		return {
			processes: Number.parseInt(processes ?? "0", 10),
			workingSetGb: Number.parseFloat(wsGb ?? "0"),
		};
	} catch {
		return null;
	}
}

function nodeProcessCount() {
	try {
		return execSync(
			'wmic process where "name=\'node.exe\'" get ProcessId 2>nul | find /c /v ""',
			{ encoding: "utf8", timeout: 5000 },
		).trim();
	} catch {
		return "?";
	}
}

// ─── One full-search iteration (mirrors registerWebsearchTool.execute) ─
async function runFullSearch(sampleIndex) {
	const query = QUERIES[Math.min(sampleIndex, QUERIES.length - 1)];
	const startedAt = Date.now();
	const searchDeadlineAt = startedAt + SEARCH_DEADLINE_MS;

	// HTTP engines (independent of Chrome).
	const httpPromise = searchWeb(query).then(
		(r) => ({ source: "http", results: r.results, counts: r }),
		() => ({ source: "http", results: [], counts: null }),
	);

	// Chrome lanes (Google + Reddit share ONE ensureChrome — mirrors the
	// real tool's chromeReady promise so the two CDP lanes don't race
	// Chrome startup against each other).
	const chromeReady = ensureChrome(undefined, {
		deadlineAt: searchDeadlineAt,
	}).catch(() => null);
	const googlePromise = (async () => {
		try {
			await chromeReady;
			const g = await googleSearch(query, {
				timeoutMs: SEARCH_DEADLINE_MS,
				maxResults: 10,
				deadlineAt: searchDeadlineAt,
			});
			return { source: "google", results: g.results };
		} catch {
			return { source: "google", results: [] };
		}
	})();
	const redditPromise = (async () => {
		try {
			await chromeReady;
			const r = await searchReddit(query);
			return { source: "reddit", results: r?.results ?? [], ok: r?.ok ?? false };
		} catch {
			return { source: "reddit", results: [], ok: false };
		}
	})();

	const collected = await collectProviderResults(
		[
			["http", httpPromise],
			["google", googlePromise],
			["reddit", redditPromise],
		],
		SEARCH_DEADLINE_MS,
	);
	const v = collected.values;
	const http = v.http?.counts;
	return {
		timedOut: collected.timedOut,
		elapsedMs: Date.now() - startedAt,
		httpResults: v.http?.results?.length ?? 0,
		googleResults: v.google?.results?.length ?? 0,
		redditResults: v.reddit?.results?.length ?? 0,
		total:
			(v.http?.results?.length ?? 0) +
			(v.google?.results?.length ?? 0) +
			(v.reddit?.results?.length ?? 0),
		ddg: http?.ddgCount ?? 0,
		brave: http?.braveCount ?? 0,
		yahoo: http?.yahooCount ?? 0,
		bing: http?.bingCount ?? 0,
		googleStatus: v.google ? "ok" : "not-settled",
		redditStatus: v.reddit ? (v.reddit.ok ? "ok" : "error") : "not-settled",
	};
}

// ─── Run ─────────────────────────────────────────────────────────────
const before = systemSnapshot();
const rows = [];
for (let i = 0; i < samples; i++) {
	const row = await runFullSearch(i);
	rows.push(row);
	console.log(
		`  sample ${String(i + 1).padStart(2)}: ${String(row.elapsedMs).padStart(5)}ms ` +
			`http=${row.httpResults} google=${row.googleResults} reddit=${row.redditResults} ` +
			`total=${row.total} ddg=${row.ddg} brave=${row.brave} yahoo=${row.yahoo} bing=${row.bing} ` +
			`google=${row.googleStatus} reddit=${row.redditStatus}${row.timedOut ? " [deadline-cut]" : ""}`,
	);
}
const after = systemSnapshot();

// ─── Summary ────────────────────────────────────────────────────────
const latencies = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 =
	latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const httpOk = rows.filter((r) => r.httpResults > 0).length;
const googleOk = rows.filter((r) => r.googleResults > 0).length;
const redditOk = rows.filter((r) => r.redditResults > 0).length;
const deadlineCut = rows.filter((r) => r.timedOut).length;

console.log(`\n=== SUMMARY (${mode}, n=${samples}) ===`);
console.log(
	`  total latency: p50=${p50}ms  p95=${p95}ms  avg=${Math.round(avg)}ms`,
);
console.log(
	`  success: http=${httpOk}/${samples} (${Math.round((httpOk / samples) * 100)}%)  ` +
		`google=${googleOk}/${samples} (${Math.round((googleOk / samples) * 100)}%)  ` +
		`reddit=${redditOk}/${samples} (${Math.round((redditOk / samples) * 100)}%)`,
);
console.log(`  deadline cuts: ${deadlineCut}/${samples}`);
console.log(`  node processes at end: ${nodeProcessCount()}`);
console.log(
	`  system: processes ${before?.processes ?? "?"} -> ${after?.processes ?? "?"}  ` +
		`working set ${before?.workingSetGb ?? "?"}GB -> ${after?.workingSetGb ?? "?"}GB`,
);
