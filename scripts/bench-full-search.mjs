#!/usr/bin/env node
// bench-full-search.mjs — full aio-websearch benchmark (legacy vs broker).
//
// Re-implements the tool's orchestration: searchWeb (HTTP engines, per-engine
// deadline in the public tool path) + googleSearch (CDP lane) + searchReddit
// (CDP companion, serialized after Google), collected under the tool's public
// response target and hard cap — which it now IMPORTS from
// `src/tools/websearch.ts` instead of copying, because copied budgets drift.
//
// LIMITATION, stated rather than implied: this mirrors the orchestration, it
// does not drive `registerWebsearchTool.execute`. It therefore measures real
// provider and Chrome latency, but it cannot see a regression inside the tool
// itself (aggregation, dedup, ranking, status mapping). For that, use
// `scripts/bench-search.mjs`, which drives the real registered execute against
// faked providers offline and asserts on orchestration cost and deadline
// containment. Records total latency, per-provider status/counts, and Windows
// process/commit deltas around each sample.
//
// Usage:
//   node --experimental-strip-types scripts/bench-full-search.mjs <legacy|broker> [samples] [query...]
//   e.g. node --experimental-strip-types scripts/bench-full-search.mjs broker 10 "pi coding agent"
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/** realpath without the failure mode: an unresolvable argv[1] falls back to itself. */
function safeRealpath(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
import {
	closeGoogleBroker,
	ensureChrome,
	googleSearch,
} from "../src/google-ai.ts";
import { searchWeb } from "../src/search.ts";
import { searchReddit } from "../src/verticals/reddit_search.ts";
import { collectProviderResults } from "../src/search-orchestration.ts";
// The budget belongs to the tool, not to the harness. These used to be local
// copies; they drifted (7000 vs the tool's 3500, 2900 vs 3000) and every table
// this script printed described a tool that no longer existed.
import {
	GOOGLE_LANE_MAX_MS,
	HTTP_ENGINE_RESPONSE_DEADLINE_MS,
	SEARCH_DEADLINE_MS,
	SEARCH_RESPONSE_TARGET_MS,
} from "../src/tools/websearch.ts";

const USAGE = `usage: npm run bench:search:full -- [mode] [samples] [spacingMs] -- [query...]
       (or: node scripts/bench-full-search.mjs [mode] [samples] [spacingMs] -- [query...])

  mode        legacy | broker | <any label>   default: legacy
              (broker sets PI_WEBAIO_CDP_BROKER=1; the label is only a column header)
  samples     number of full-search iterations    default: 10
  spacingMs   pause between samples, to avoid engine rate limits and the
              10-minute search cache    default: 0
  query...    base query (distinct variants are rotated per sample)
              default: "pi coding agent"

Put the query after -- whenever it could look like a flag, e.g.

  npm run bench:search:full -- legacy 10 0 -- ls -h

Without the separator a query word that reads as a flag is indistinguishable from
one. Positional queries still work for anything that cannot be confused.

This harness performs LIVE network requests on every sample. Nothing here is
offline-safe, so --help is handled before any sampling starts: an operator
reading the flags must not have to spend live samples to do it (#97).

Environment: PI_WEBAIO_CDP_BROKER=1 selects the broker Google lane.
`;

// The help scan must stop at `--`: everything after it is the QUERY, and a query
// containing `-h` ("ls -h", "git diff --help") must run rather than print usage and
// exit 0 — scanning every argument silently turned a measured query into a no-op
// that looked like it had completed. Note Node passes the `--` separator through to
// `process.argv`, so it has to be removed here or the query starts with a literal
// `--` and measures a different search than the operator typed.
function classifyBenchGoogleStatus(google) {
	if (google === undefined) return "not-settled";
	return google.results.length > 0 ? "ok" : "empty";
}

/**
 * Map one `searchReddit` return onto the lane axes the harness reports. Extracted from
 * the lane body so it is testable without a browser: pinning only the classifier would
 * leave `unavailable: r === null` — the line that actually distinguishes "never ran" from
 * "ran out of time" — free to regress to `false` and survive every assertion.
 */
export function redditLaneOutcome(r) {
	return {
		results: r?.results ?? [],
		ok: r?.ok ?? false,
		// null is NOT a budget miss. `searchReddit` returns null on three paths, all of them
		// "no browser was talked to": no DevToolsActivePort for the profile dir, a port file
		// whose Chrome does not answer the liveness probe, or a throw while probing. It made
		// zero requests on every one of them. Kept as its own axis so no downstream consumer
		// can infer "timeout" from an absence of results (#97, the shape #201 fixed in the
		// tool). Wording must cover all three: an earlier draft said "no CDP port", which is
		// false for the stale-port and probe-throw paths.
		unavailable: r === null,
		// searchReddit's own deadline miss is a timeout, not a provider error.
		budgetMiss: r ? r.ok === false && r.error?.includes("response budget") === true : false,
	};
}

export function classifyBenchRedditStatus(reddit) {
	if (!reddit) return "not-settled";
	if (reddit.ok) return "ok";
	// A null from `searchReddit` means it never made a request. Three paths produce it
	// (`src/verticals/reddit_search.ts`): no DevToolsActivePort for the profile dir, a port
	// file whose Chrome fails the liveness probe, or a throw while probing. Folding that into
	// `budgetMiss` labelled a zero-request lane as `timeout`, which is the #201 defect shape
	// and it poisoned this harness's own evidence: the n=10 baseline read `reddit=0/10 (0%)
	// reddit=timeout`, pointing a reader at Reddit's deadline when no request had been made.
	// The TOOL already distinguishes these (`src/tools/websearch.ts`: "unavailable (CDP
	// search returned null)"); the harness must not be the surface that gets it wrong,
	// because #97's acceptance data is harness output.
	if (reddit.unavailable) return "unavailable (CDP unreachable; never requested)";
	// searchReddit's own deadline miss is a timeout, not a provider error.
	return reddit.budgetMiss ? "timeout" : "error";
}

// Importable without running. Without this guard, `import { classifyBenchRedditStatus }`
// from a unit test executed the whole live benchmark as a side effect and then called
// process.exit(0), killing the test process — which is one reason this harness shipped
// with its status taxonomy untested, and that taxonomy is what #97's evidence tables are
// built from.
//
// realpath before comparing: a path reached through a symlink resolves to the module URL
// Node actually loaded, so direct execution via a linked path is still recognised as main.
// Falls back to the raw path if realpath itself fails, so a weird argv[1] degrades to the
// previous comparison rather than throwing at import time.
const IS_MAIN = !process.argv[1] ||
	import.meta.url ===
	pathToFileURL(safeRealpath(process.argv[1])).href;
if (IS_MAIN) {
	const rawArgs = process.argv.slice(2);
	const sepAt = rawArgs.indexOf("--");
	const flagArgs = sepAt === -1 ? rawArgs : rawArgs.slice(0, sepAt);
	const queryArgs = sepAt === -1 ? null : rawArgs.slice(sepAt + 1);

	if (flagArgs.some((a) => a === "--help" || a === "-h")) {
		console.log(USAGE);
		process.exit(0);
	}

	const mode = flagArgs[0] ?? "legacy";
	const samples = Number.parseInt(flagArgs[1] ?? "10", 10);
	// Optional spacing (ms) between samples. Real aio-websearch calls are spaced
	// by user thinking time; zero-spacing bursts trigger engine rate-limiting
	// (Brave 429, reddit cooldown) and the 10-min search cache, which distorts
	// the numbers. Pass e.g. 4000 to simulate steady-state usage.
	const spacingMs = Number.parseInt(flagArgs[2] ?? "0", 10);
	// Positional queries (args 4+) still work so no existing invocation breaks; `--`
	// takes precedence and is the documented form because it cannot be confused with a
	// flag.
	const baseQuery =
		(queryArgs && queryArgs.length ? queryArgs.join(" ") : flagArgs.slice(3).join(" ")) ||
		"pi coding agent";
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
		// The pipeline below is Windows-only, and on POSIX it is not merely useless:
		// `2>nul` is not a redirect there, so the shell CREATES A FILE named `nul` and
		// `find`'s errors reach the operator (`find: '/c': No such file or directory`)
		// while the figure prints as "?". #97 requires a process count, so POSIX gets a
		// real one rather than a silent blank, and only an unmeasurable platform is
		// reported as unavailable.
		if (platform() !== "win32") {
			try {
				// `pgrep -x node | wc -l` exits with WC's status, so on a host without
				// pgrep the pipeline still prints `0` and still exits 0: the catch below
				// never ran, the summary printed a confident `0` node processes beside a
				// shell error on stderr, and `n/a (no pgrep)` was unreachable text.
				// Resolve availability first so a missing tool throws into the honest branch.
				const out = execSync("command -v pgrep >/dev/null && pgrep -x node | wc -l", {
					encoding: "utf8",
					timeout: 5000,
				});
				const n = Number.parseInt(out.trim(), 10);
				return Number.isFinite(n) ? String(n) : "?";
			} catch {
				// pgrep is absent (minimal containers) — say which, do not print "?".
				return "n/a (no pgrep on this platform)";
			}
		}
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
					// null is NOT a budget miss. Kept as its own axis so the classifier cannot
					// infer "timeout" from the absence of results (#97, same shape as #201).
					unavailable: r === null,
					// searchReddit's own deadline miss is a timeout, not a provider error.
					budgetMiss: r
						? r.ok === false && r.error?.includes("response budget") === true
						: false,
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
		`  system: processes ${before?.processes ?? "n/a (Windows-only commit-charge probe)"} -> ${after?.processes ?? "n/a"}  ` +
			`working set ${before?.workingSetGb ?? "n/a"}GB -> ${after?.workingSetGb ?? "n/a"}GB`,
	);

	// This is a one-shot live benchmark harness, not the long-lived pi host. Some
	// native/browser libraries can keep diagnostic sockets alive after their public
	// promises and broker cleanup have completed; exit explicitly after printing
	// the measured summary so CI/manual benchmark runs do not hang on idle handles.
	process.exit(0);
}
