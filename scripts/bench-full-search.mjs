#!/usr/bin/env node
// bench-full-search.mjs — full aio-websearch benchmark (legacy vs broker).
//
// Mirrors the real tool's orchestration exactly: searchWeb (HTTP engines,
// 2.7s per-engine deadline in the public tool path) + googleSearch (CDP lane)
// + searchReddit (CDP companion, serialized after Google), collected under
// the ~3s public response target with a 7s hard safety deadline. Records total
// latency, per-provider status/counts, and Windows process/commit deltas around
// each sample.
//
// Usage:
//   node --experimental-strip-types scripts/bench-full-search.mjs <legacy|broker> [samples] [query...]
//   e.g. node --experimental-strip-types scripts/bench-full-search.mjs broker 10 "pi coding agent"
import { execSync } from "node:child_process";
import { platform } from "node:os";
import {
	closeGoogleBroker,
	ensureChrome,
	googleSearch,
} from "../src/google-ai.ts";
import { searchWeb } from "../src/search.ts";
import { searchReddit } from "../src/verticals/reddit_search.ts";
import { collectProviderResults } from "../src/search-orchestration.ts";

const mode = process.argv[2] ?? "legacy";
const samples = Number.parseInt(process.argv[3] ?? "10", 10);
// Optional spacing (ms) between samples. Real aio-websearch calls are spaced
// by user thinking time; zero-spacing bursts trigger engine rate-limiting
// (Brave 429, reddit cooldown) and the 10-min search cache, which distorts
// the numbers. Pass e.g. 4000 to simulate steady-state usage.
const spacingMs = Number.parseInt(process.argv[4] ?? "0", 10);
const baseQuery = process.argv.slice(5).join(" ") || "pi coding agent";
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
const SEARCH_RESPONSE_TARGET_MS = 2900;
const HTTP_ENGINE_RESPONSE_DEADLINE_MS = 2700;
const GOOGLE_LANE_MAX_MS = 2900;

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
function waitForPromiseOrDeadline(promise, deadlineAt) {
	return new Promise((resolve) => {
		let timer;
		const finish = () => {
			if (timer) clearTimeout(timer);
			resolve();
		};
		timer = setTimeout(finish, Math.max(deadlineAt - Date.now(), 1));
		timer.unref?.();
		void promise.then(finish, finish);
	});
}

function classifyBenchGoogleStatus(google) {
	if (google === undefined) return "not-settled";
	return google.results.length > 0 ? "ok" : "empty";
}

function classifyBenchRedditStatus(reddit) {
	if (!reddit) return "not-settled";
	if (reddit.ok) return "ok";
	// searchReddit's own deadline miss is a timeout, not a provider error.
	return reddit.budgetMiss ? "timeout" : "error";
}

async function runFullSearch(sampleIndex) {
	const query = QUERIES[Math.min(sampleIndex, QUERIES.length - 1)];
	const startedAt = Date.now();
	const searchDeadlineAt = startedAt + SEARCH_DEADLINE_MS;
	const responseDeadlineAt = startedAt + SEARCH_RESPONSE_TARGET_MS;

	// HTTP engines (independent of Chrome).
	const httpPromise = searchWeb(query, undefined, {
		engineDeadlineMs: HTTP_ENGINE_RESPONSE_DEADLINE_MS,
	}).then(
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
				timeoutMs: Math.min(SEARCH_DEADLINE_MS, GOOGLE_LANE_MAX_MS),
				maxResults: 10,
				deadlineAt: Math.min(searchDeadlineAt, Date.now() + GOOGLE_LANE_MAX_MS),
			});
			return { source: "google", results: g.results };
		} catch {
			return { source: "google", results: [] };
		}
	})();
	const redditPromise = (async () => {
		try {
			await waitForPromiseOrDeadline(googlePromise, responseDeadlineAt);
			if (Date.now() >= responseDeadlineAt) {
				return { source: "reddit", results: [], ok: false, budgetMiss: true };
			}
			await waitForPromiseOrDeadline(chromeReady, responseDeadlineAt);
			if (Date.now() >= responseDeadlineAt) {
				return { source: "reddit", results: [], ok: false, budgetMiss: true };
			}
			const r = await searchReddit(query, { deadlineAt: responseDeadlineAt });
			return {
				source: "reddit",
				results: r?.results ?? [],
				ok: r?.ok ?? false,
				// searchReddit's own deadline miss is a timeout, not a provider error.
				budgetMiss: r
					? r.ok === false && r.error?.includes("response budget") === true
					: true,
			};
		} catch {
			return { source: "reddit", results: [], ok: false, budgetMiss: false };
		}
	})();

	// Stamp each lane's ACTUAL settlement time so the log can show real
	// completion times even when the response budget returns early.
	const laneSettleMs = {};
	const stamp = (key, p) =>
		p.then((v) => {
			laneSettleMs[key] = Date.now() - startedAt;
			return v;
		});
	const allSettled = Promise.all([
		stamp("http", httpPromise),
		stamp("google", googlePromise),
		stamp("reddit", redditPromise),
	]);

	const collected = await collectProviderResults(
		[
			["http", httpPromise],
			["google", googlePromise],
			["reddit", redditPromise],
		],
		Math.max(Math.min(responseDeadlineAt, searchDeadlineAt) - Date.now(), 1),
	);
	const v = collected.values;
	const http = v.http?.counts;
	// Capture the true return moment FIRST (the tool would hand control back
	// here), then keep listening past the budget cut so we capture when every
	// lane actually finishes.
	const returnElapsedMs = Date.now() - startedAt;
	await waitForPromiseOrDeadline(allSettled, searchDeadlineAt + 5_000);
	const trueSettleMs = Math.max(...Object.values(laneSettleMs), 0);
	return {
		timedOut: collected.timedOut,
		elapsedMs: returnElapsedMs,
		laneSettleMs,
		trueSettleMs,
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
		googleStatus: classifyBenchGoogleStatus(v.google),
		redditStatus: classifyBenchRedditStatus(v.reddit),
		// A Reddit budget miss inside searchReddit counts as a response-budget
		// cut even when the outer collector did not fire first (#97 fidelity).
		responseBudgetCut: collected.timedOut || v.reddit?.budgetMiss === true,
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
			`google=${row.googleStatus} reddit=${row.redditStatus}${row.responseBudgetCut ? " [response-budget-cut]" : ""} ` +
			`actual-settle=${row.trueSettleMs}ms` +
			(row.laneSettleMs?.http == null
				? ""
				: ` (http ${row.laneSettleMs.http}ms)`) +
			(row.laneSettleMs?.google == null
				? ""
				: ` (google ${row.laneSettleMs.google}ms)`) +
			(row.laneSettleMs?.reddit == null
				? ""
				: ` (reddit ${row.laneSettleMs.reddit}ms)`),
	);
	if (spacingMs > 0 && i < samples - 1) {
		await new Promise((resolve) => setTimeout(resolve, spacingMs));
	}
}
await closeGoogleBroker(undefined, { deadlineAt: Date.now() + 5_000 }).catch(
	() => undefined,
);
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
const deadlineCut = rows.filter((r) => r.responseBudgetCut).length;

console.log(`\n=== SUMMARY (${mode}, n=${samples}) ===`);
console.log(
	`  return latency (response budget): p50=${p50}ms  p95=${p95}ms  avg=${Math.round(avg)}ms`,
);
const settleLatencies = rows.map((r) => r.trueSettleMs).sort((a, b) => a - b);
const sP50 = settleLatencies[Math.floor(settleLatencies.length * 0.5)];
const sP95 =
	settleLatencies[
		Math.min(
			settleLatencies.length - 1,
			Math.floor(settleLatencies.length * 0.95),
		)
	];
const sAvg =
	settleLatencies.reduce((a, b) => a + b, 0) / settleLatencies.length;
console.log(
	`  actual full-settle (lanes truly done): p50=${sP50}ms  p95=${sP95}ms  avg=${Math.round(sAvg)}ms`,
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

// This is a one-shot live benchmark harness, not the long-lived pi host. Some
// native/browser libraries can keep diagnostic sockets alive after their public
// promises and broker cleanup have completed; exit explicitly after printing
// the measured summary so CI/manual benchmark runs do not hang on idle handles.
process.exit(0);
