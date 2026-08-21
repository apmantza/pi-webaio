import { TOOL_METADATA } from "./lazy.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "./tui-compat.ts";
import { setSearchContext } from "../session-store.ts";
import {
	searchWeb,
	ENGINE_WEIGHTS,
	recordProviderNetworkFailure,
	isProviderAvailable,
	extractDomain,
	scoreAndRankResults,
	buildResultBuckets,
	buildEngineStatusMap,
	engineStatusNotes,
	formatEngineLatency,
	renderSearchResults,
	type EngineOutcome,
	type EngineStatus,
	type EngineStatusMap,
} from "../search.ts";
import { loadGoggles, type GogglesInput } from "../goggles.ts";
import {
	ensureChrome,
	googleSearch,
	cdpAvailable as cdpAvailableGA,
} from "../google-ai.ts";
import { searchReddit } from "../verticals/reddit_search.ts";
import type { SearchResult } from "../types.ts";
import { triggerPrefetch, DEFAULT_PREFETCH_COUNT } from "../prefetch.ts";
import {
	collectProviderResults,
	shouldRunGoogle,
	shouldRunReddit,
} from "../search-orchestration.ts";
import {
	createSearchProgressComponent,
	createSearchResultComponent,
	providerFromEngineStatus,
	SPINNER_INTERVAL_MS,
	type SearchProviderProgress,
} from "./search-render.ts";

const SEARCH_DEADLINE_MS = 7000;
// Public response target for the full aio-websearch orchestration (#97). The
// 7s hard deadline is still passed to child/browser work as a safety ceiling,
// but the tool returns the providers that settled by this soft budget so slow
// Reddit/HTTP tails cannot hold a healthy warm search at ~4.5-7s. Keep the
// timer just under 3s so normal scheduling overhead still lands below the
// p50<=3.0s release target.
const SEARCH_RESPONSE_TARGET_MS = 2900;
// HTTP engines get a small cushion before the response target so their timeout
// statuses can be parsed and included in the returned engineStatus map instead
// of racing the outer provider collector at the exact same millisecond.
const HTTP_ENGINE_RESPONSE_DEADLINE_MS = 2700;
// Hard upper bound for the Google lane itself (measured from when the lane's
// search actually starts, after chromeReady). The broker's pagination
// budget-fencing (2s page floor, per-page 3.5s cap) fits inside this window:
// a hot broker returns ~1s for max 15, and even a slow sparse tail page can
// never burn more than this. The overall tool deadline stays 7s.
const GOOGLE_LANE_MAX_MS = 2900;

type WebsearchDependencies = {
	loadGoggles?: typeof loadGoggles;
	searchWeb?: typeof searchWeb;
	ensureChrome?: typeof ensureChrome;
	googleSearch?: typeof googleSearch;
	searchReddit?: typeof searchReddit;
	cdpAvailable?: typeof cdpAvailableGA;
	providerAvailable?: typeof isProviderAvailable;
	/** Test/benchmark seam for the hard safety ceiling. Defaults to 7s. */
	searchDeadlineMs?: number;
	/** Test/benchmark seam for the public response target. Defaults to 3s. */
	responseTargetMs?: number;
	/** Test/benchmark seam for the HTTP engine deadline used by this tool path. */
	httpEngineDeadlineMs?: number;
	/** Test/benchmark seam for the Google lane cap. Defaults to 3s. */
	googleLaneMaxMs?: number;
};

function classifyRedditStatus(status: string, count: number): EngineStatus {
	if (count > 0 || status === "ok") return "ok";
	if (status.startsWith("timeout")) return "timeout";
	if (status.startsWith("error") || status.startsWith("unavailable"))
		return "error";
	return "empty";
}

function waitForPromiseOrDeadline(
	promise: Promise<unknown>,
	deadlineAt: number,
): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (timer) clearTimeout(timer);
			resolve();
		};
		timer = setTimeout(finish, Math.max(deadlineAt - Date.now(), 1));
		timer.unref?.();
		void promise.then(finish, finish);
	});
}

export function registerWebsearchTool(
	pi: ExtensionAPI,
	dependencies: WebsearchDependencies = {},
): void {
	const loadGogglesImpl = dependencies.loadGoggles ?? loadGoggles;
	const searchWebImpl = dependencies.searchWeb ?? searchWeb;
	const ensureChromeImpl = dependencies.ensureChrome ?? ensureChrome;
	const googleSearchImpl = dependencies.googleSearch ?? googleSearch;
	const searchRedditImpl = dependencies.searchReddit ?? searchReddit;
	const cdpAvailableImpl = dependencies.cdpAvailable ?? cdpAvailableGA;
	const providerAvailableImpl =
		dependencies.providerAvailable ?? isProviderAvailable;
	const searchDeadlineMs = Math.max(
		1,
		dependencies.searchDeadlineMs ?? SEARCH_DEADLINE_MS,
	);
	const responseTargetMs = Math.max(
		1,
		Math.min(
			dependencies.responseTargetMs ?? SEARCH_RESPONSE_TARGET_MS,
			searchDeadlineMs,
		),
	);
	const httpEngineDeadlineMs = Math.max(
		1,
		Math.min(
			dependencies.httpEngineDeadlineMs ?? HTTP_ENGINE_RESPONSE_DEADLINE_MS,
			responseTargetMs,
		),
	);
	const googleLaneMaxMs = Math.max(
		1,
		Math.min(
			dependencies.googleLaneMaxMs ?? GOOGLE_LANE_MAX_MS,
			searchDeadlineMs,
		),
	);

	pi.registerTool({
		...TOOL_METADATA["aio-websearch"],
		// Render our own framing/background instead of the default Box: every
		// line is padded and painted uniformly (toolPendingBg while running,
		// toolSuccessBg/toolErrorBg when settled), which eliminates black gaps
		// from host-side background application on styled lines.
		renderShell: "self",
		async execute(_toolCallId, params, signal, onUpdate) {
			const query = params.query;
			setSearchContext(query);
			const max = params.max ?? 15;
			const useGoogle = params.google ?? true;
			const compact = params.compact === true;
			const startedAt = Date.now();
			const searchDeadlineAt = startedAt + searchDeadlineMs;
			const responseDeadlineAt = startedAt + responseTargetMs;
			const goggles = await loadGogglesImpl(params.goggles as GogglesInput);

			// Resolve prefetch count: false/undefined → 0, true → default, number → clamp ≥ 0.
			const prefetchParam = params.prefetch;
			const prefetchCount: number =
				prefetchParam === true
					? DEFAULT_PREFETCH_COUNT
					: typeof prefetchParam === "number" && prefetchParam > 0
						? Math.floor(prefetchParam)
						: 0;

			// Chrome cold-start can take up to 30s; fire it in parallel, but never
			// let startup or a CDP provider extend the documented response deadline.
			const redditEnabled = shouldRunReddit(
				cdpAvailableImpl(),
				providerAvailableImpl("reddit"),
			);
			// Track why Google produced no results so a silent zero is surfaced
			// instead of looking like Google was never attempted (B4).
			const googleEnabled = shouldRunGoogle(
				useGoogle,
				cdpAvailableImpl(),
				providerAvailableImpl("google"),
			);
			let googleStatus: string;
			if (!useGoogle) googleStatus = "disabled (google: false)";
			else if (!cdpAvailableImpl())
				googleStatus = "unavailable (Chrome CDP not present)";
			else if (providerAvailableImpl("google")) googleStatus = "pending";
			else
				googleStatus = "unavailable (provider cooled down after recent failures)";
			const chromeReady =
				googleEnabled || redditEnabled
					? ensureChromeImpl(undefined, {
							deadlineAt: searchDeadlineAt,
							signal,
						}).catch(() => null)
					: null;
			let redditStatus: string;
			if (!cdpAvailableImpl())
				redditStatus = "unavailable (Chrome CDP not present)";
			else if (providerAvailableImpl("reddit")) redditStatus = "pending";
			else
				redditStatus = "unavailable (provider cooled down after recent failures)";
			const engineNames = ["DDG", "Brave", "Yahoo", "Bing"];
			if (useGoogle) engineNames.push("Google");
			if (redditEnabled) engineNames.push("Reddit");

			// ── Live TUI progress (#97 UX) ────────────────────────────
			// One row per provider, mutated as each lane settles and re-emitted
			// via onUpdate ticks so the partial view animates. Agent-facing text
			// output is unchanged.
			const liveProviders: SearchProviderProgress[] = [
				{ id: "ddg", label: "DDG", status: "running" },
				{ id: "brave", label: "Brave", status: "running" },
				{ id: "yahoo", label: "Yahoo", status: "running" },
				{ id: "bing", label: "Bing", status: "running" },
				{
					id: "google",
					label: "Google",
					status: googleEnabled ? "running" : "skipped",
					detail: googleEnabled ? undefined : "disabled",
				},
				{
					id: "reddit",
					label: "Reddit",
					status: redditEnabled ? "running" : "skipped",
					detail: redditEnabled ? undefined : "disabled",
				},
			];
			const renderDetails = {
				query,
				providers: liveProviders,
				spinnerTick: 0,
				elapsedMs: 0,
				responseTargetMs,
			};
			let searchFinished = false;
			function pushSearchUpdate(): void {
				if (!onUpdate || searchFinished) return;
				renderDetails.elapsedMs = Date.now() - startedAt;
				try {
					onUpdate({
						content: [
							{
								type: "text",
								text: `Searching "${query}" via ${engineNames.join(", ")}...`,
							},
						],
						details: {
							...renderDetails,
							providers: liveProviders.map((p) => ({ ...p })),
						},
					});
				} catch {
					// A throwing host callback must never escape into the interval
					// tick (uncaughtException) or a lane observer (unhandled rejection).
				}
			}
			function setProvider(
				id: string,
				update: Partial<SearchProviderProgress>,
			): void {
				const row = liveProviders.find((p) => p.id === id);
				if (row) Object.assign(row, update);
				pushSearchUpdate();
			}
			let spinnerTimer: ReturnType<typeof setInterval> | null = null;
			if (onUpdate) {
				spinnerTimer = setInterval(() => {
					renderDetails.spinnerTick += 1;
					pushSearchUpdate();
				}, SPINNER_INTERVAL_MS);
				spinnerTimer.unref?.();
			}
			function finishSearchTui(): void {
				searchFinished = true;
				if (spinnerTimer) {
					clearInterval(spinnerTimer);
					spinnerTimer = null;
				}
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Searching "${query}" via ${engineNames.join(", ")}...`,
					},
				],
				details: {
					...renderDetails,
					providers: liveProviders.map((p) => ({ ...p })),
				},
			});

			const httpStartedAt = Date.now();
			const httpPromise = searchWebImpl(query, goggles, {
				engineDeadlineMs: httpEngineDeadlineMs,
			}).then(
				(r) => {
					// Live TUI: populate each HTTP engine row from its measured
					// outcome as soon as the lane settles.
					for (const id of ["ddg", "brave", "yahoo", "bing"] as const) {
						const row = liveProviders.find((p) => p.id === id);
						if (row)
							Object.assign(
								row,
								providerFromEngineStatus(id, row.label, r.engineStatus?.[id]),
							);
					}
					pushSearchUpdate();
					return {
						source: "http" as const,
						results: r.results.slice(0, max),
						httpCounts: {
							ddg: r.ddgCount,
							brave: r.braveCount,
							yahoo: r.yahooCount,
							bing: r.bingCount,
							reddit: r.redditCount,
						},
						engineStatus: r.engineStatus as EngineStatusMap | undefined,
					};
				},
				() => {
					const latencyMs = Date.now() - httpStartedAt;
					const httpErrorOutcomes: EngineOutcome[] = [
						"ddg",
						"brave",
						"yahoo",
						"bing",
					].map((id) => ({
						id: id as EngineOutcome["id"],
						httpStatus: null,
						count: 0,
						latencyMs,
						skipReason: "error" as const,
					}));
					return {
						source: "http" as const,
						results: [] as SearchResult[],
						httpCounts: { ddg: 0, brave: 0, yahoo: 0, bing: 0, reddit: 0 },
						engineStatus: buildEngineStatusMap(httpErrorOutcomes),
					};
				},
			);

			let googlePromise: Promise<{
				source: "google";
				results: SearchResult[];
			}>;
			if (googleEnabled) {
				googlePromise = (async () => {
					try {
						await chromeReady;
						// Cap the lane at GOOGLE_LANE_MAX_MS measured from when the
						// search actually starts (after chromeReady), never exceeding
						// the overall tool deadline.
						const googleDeadlineAt = Math.min(
							searchDeadlineAt,
							Date.now() + googleLaneMaxMs,
						);
						const g = await googleSearchImpl(query, {
							timeoutMs: Math.min(searchDeadlineMs, googleLaneMaxMs),
							maxResults: max,
							signal,
							deadlineAt: googleDeadlineAt,
						});
						const results = g.results.map((r) => ({
							title: r.title,
							url: r.url,
							snippet: r.snippet,
							domain: extractDomain(r.url),
						}));
						googleStatus = results.length
							? g.degraded
								? "ok (an extra SERP page failed; results degraded to the pages collected)"
								: "ok"
							: "empty (Google returned 0 results)";
						return { source: "google" as const, results };
					} catch (err) {
						recordProviderNetworkFailure("google", String(err));
						const errorCode =
							err && typeof err === "object" && "code" in err
								? (err as { code?: unknown }).code
								: undefined;
						googleStatus =
							errorCode === "deadline_expired"
								? `timeout (Google lane cap ${googleLaneMaxMs}ms; hard deadline ${searchDeadlineMs}ms)`
								: `error (${String(err).slice(0, 120)})`;
						return { source: "google" as const, results: [] };
					}
				})();
				// Live TUI: reflect the Google row as soon as the lane settles.
				void googlePromise.then((res) => {
					setProvider("google", {
						status:
							res.results.length > 0
								? "ok"
								: googleStatus.startsWith("empty")
									? "empty"
									: googleStatus.startsWith("timeout")
										? "timeout"
										: googleStatus.startsWith("disabled") ||
												googleStatus.startsWith("unavailable")
											? "skipped"
											: "error",
						count: res.results.length,
						latencyMs: Date.now() - startedAt,
						detail: res.results.length > 0 ? undefined : googleStatus.slice(0, 60),
					});
				});
			} else {
				googlePromise = Promise.resolve({
					source: "google" as const,
					results: [],
				});
			}

			// Reddit CDP search (synthetic engine — no external APIs)
			const redditStartedAt = Date.now();
			let redditPromise: Promise<{
				source: "reddit";
				results: SearchResult[];
				latencyMs: number;
			}>;
			if (redditEnabled) {
				redditPromise = (async () => {
					try {
						// Reddit's legacy CDP client shares Chrome with the broker.
						// Let the broker-owned Google target finish before Reddit
						// creates/navigates its own target; concurrent browser-level
						// CDP traffic can otherwise stall Google's 3s lane. Bound this
						// wait by the public response target, not the 7s safety ceiling,
						// so Reddit never starts fresh CDP work after the response cut.
						if (googleEnabled) {
							await waitForPromiseOrDeadline(googlePromise, responseDeadlineAt);
						}
						if (Date.now() >= responseDeadlineAt) {
							redditStatus = `timeout (response budget ${responseTargetMs}ms; hard deadline ${searchDeadlineMs}ms)`;
							return {
								source: "reddit" as const,
								results: [],
								latencyMs: responseTargetMs,
							};
						}
						if (chromeReady) {
							await waitForPromiseOrDeadline(chromeReady, responseDeadlineAt);
						}
						if (Date.now() >= responseDeadlineAt) {
							redditStatus = `timeout (response budget ${responseTargetMs}ms; hard deadline ${searchDeadlineMs}ms)`;
							return {
								source: "reddit" as const,
								results: [],
								latencyMs: responseTargetMs,
							};
						}
						const r = await searchRedditImpl(query, {
							deadlineAt: responseDeadlineAt,
							signal,
						});
						if (!r) {
							redditStatus = "unavailable (CDP search returned null)";
							return {
								source: "reddit" as const,
								results: [],
								latencyMs: Date.now() - redditStartedAt,
							};
						}
						if (!r.ok) {
							// A deadline miss inside searchReddit is a response-budget
							// timeout, not a provider error — classify it as such so
							// engineStatus/notes stay truthful (#97).
							redditStatus = r.error?.includes("response budget")
								? `timeout (response budget ${responseTargetMs}ms; hard deadline ${searchDeadlineMs}ms)`
								: `error (${r.error})`;
							return {
								source: "reddit" as const,
								results: [],
								latencyMs: r.elapsed,
							};
						}
						const results = r.results.map((item) => ({
							title: item.title,
							url: item.url,
							snippet: `r/${item.subreddit} · ${item.score} pts · ${item.comments} comments`,
							domain: extractDomain(item.url),
						}));
						redditStatus = results.length
							? "ok"
							: "empty (Reddit returned 0 results)";
						return {
							source: "reddit" as const,
							results,
							latencyMs: r.elapsed,
						};
					} catch (err) {
						recordProviderNetworkFailure("reddit", String(err));
						redditStatus = `error (${String(err).slice(0, 120)})`;
						return {
							source: "reddit" as const,
							results: [],
							latencyMs: Date.now() - redditStartedAt,
						};
					}
				})();
				// Live TUI: reflect the Reddit row as soon as the lane settles.
				// Attached only when the lane actually runs — otherwise the seeded
				// "skipped/disabled" row would be overwritten with a misleading
				// "error" derived from the unavailable-status string.
				void redditPromise.then((res) => {
					const engineStatus = classifyRedditStatus(
						redditStatus,
						res.results.length,
					);
					setProvider("reddit", {
						status:
							engineStatus === "timeout"
								? "timeout"
								: engineStatus === "error"
									? "error"
									: engineStatus === "ok"
										? "ok"
										: "empty",
						count: res.results.length,
						latencyMs: res.latencyMs,
						detail: res.results.length > 0 ? undefined : redditStatus.slice(0, 60),
					});
				});
			} else {
				redditPromise = Promise.resolve({
					source: "reddit" as const,
					results: [],
					latencyMs: 0,
				});
			}

			// This is a hard response deadline. Providers are observed as they settle;
			// after timeout we use only the values already available and detach from
			// late CDP completion. Do not replace this with allSettled: Reddit can
			// spend 30s navigating plus 25s hydrating after the response is due.
			const collected = await collectProviderResults<string, unknown>(
				[
					["http", httpPromise],
					["google", googlePromise],
					["reddit", redditPromise],
				],
				Math.max(Math.min(responseDeadlineAt, searchDeadlineAt) - Date.now(), 1),
			);
			const result = collected.values;

			// The response content is now determined: freeze the live TUI state
			// IMMEDIATELY so a throw during final rendering cannot leave the
			// spinner timer emitting forever. finishSearchTui is idempotent.
			finishSearchTui();

			let httpResults: SearchResult[] = [];
			let googleResults: SearchResult[] = [];
			let redditResults: SearchResult[] = [];
			let httpCounts = { ddg: 0, brave: 0, yahoo: 0, bing: 0, reddit: 0 };
			let engineStatus: EngineStatusMap | undefined;

			const httpResult = result.http as
				| {
						results: SearchResult[];
						httpCounts: typeof httpCounts;
						engineStatus?: EngineStatusMap;
				  }
				| undefined;
			const googleResult = result.google as
				| { results: SearchResult[] }
				| undefined;
			const redditResult = result.reddit as
				| { results: SearchResult[]; latencyMs: number }
				| undefined;
			if (httpResult) {
				httpResults = httpResult.results;
				httpCounts = httpResult.httpCounts ?? httpCounts;
				engineStatus = httpResult.engineStatus ?? engineStatus;
			}
			if (googleResult) googleResults = googleResult.results;
			if (redditResult) redditResults = redditResult.results;

			if (collected.timedOut) {
				if (googleEnabled && !googleResult)
					googleStatus = `timeout (response budget ${responseTargetMs}ms; hard deadline ${searchDeadlineMs}ms)`;
				if (redditEnabled && !redditResult)
					redditStatus = `timeout (response budget ${responseTargetMs}ms; hard deadline ${searchDeadlineMs}ms)`;
				if (!httpResult) {
					const httpTimeoutOutcomes: EngineOutcome[] = [
						"ddg",
						"brave",
						"yahoo",
						"bing",
					].map((id) => ({
						id: id as EngineOutcome["id"],
						httpStatus: null,
						count: 0,
						latencyMs: responseTargetMs,
						skipReason: "timeout" as const,
					}));
					engineStatus = buildEngineStatusMap(httpTimeoutOutcomes);
				}
			}

			const buckets = buildResultBuckets(httpResults, "http");
			for (const r of googleResults) {
				const list = buckets.get(r.url) || [];
				list.push({
					result: r,
					engine: "google",
					weight: ENGINE_WEIGHTS.google,
				});
				buckets.set(r.url, list);
			}
			for (const r of redditResults) {
				const list = buckets.get(r.url) || [];
				list.push({
					result: r,
					engine: "reddit",
					weight: ENGINE_WEIGHTS.reddit,
				});
				buckets.set(r.url, list);
			}

			// Keep Reddit's count/status in the same engine map as the HTTP
			// providers. This is the source of truth for notes and TUI output.
			if (engineStatus && redditEnabled) {
				engineStatus = {
					...engineStatus,
					reddit: {
						count: redditResults.length,
						status: redditResult
							? classifyRedditStatus(redditStatus, redditResults.length)
							: "timeout",
						latencyMs: redditResult?.latencyMs ?? responseTargetMs,
					},
				};
			}

			const scored = scoreAndRankResults(buckets, query, goggles);
			const merged = scored.map((s) => s.result);

			// Freeze the final providers snapshot: lanes that missed the response
			// budget must not be captured as frozen "running" spinner frames.
			const markUnsettled = (id: string): void => {
				const row = liveProviders.find((p) => p.id === id);
				if (row && row.status === "running") {
					row.status = "timeout";
					row.detail = "missed response budget";
				}
			};
			for (const id of ["ddg", "brave", "yahoo", "bing"]) markUnsettled(id);
			if (!googleResult) markUnsettled("google");
			if (!redditResult) markUnsettled("reddit");
			renderDetails.elapsedMs = Date.now() - startedAt;

			const resultDetails = {
				query,
				results: merged.slice(0, 25),
				...httpCounts,
				engineStatus,
				googleCount: googleResults.length,
				googleStatus,
				redditCount: redditResults.length,
				redditStatus,
				durationMs: Date.now() - startedAt,
				deadlineMs: searchDeadlineMs,
				responseBudgetMs: responseTargetMs,
				timedOut: collected.timedOut,
				providers: liveProviders.map((p) => ({ ...p })),
			};

			if (!merged.length) {
				return {
					content: [
						{
							type: "text",
							text: `No search results found for "${query}".`,
						},
					],
					details: resultDetails,
				};
			}

			const MAX_TOTAL = 25;
			const limited = merged.slice(0, MAX_TOTAL);

			const engineLabel: string[] = [];
			const httpEngineIds = ["ddg", "brave", "yahoo", "bing"] as const;
			const httpEngineNames: Record<(typeof httpEngineIds)[number], string> = {
				ddg: "DDG",
				brave: "Brave",
				yahoo: "Yahoo",
				bing: "Bing",
			};
			for (const id of httpEngineIds) {
				const count = httpCounts[id];
				if (!count) continue;
				// Append the measured latency for ok engines so a slow engine that
				// dominated the 7s cap is visible (P5).
				const latencyMs = engineStatus?.[id]?.latencyMs ?? 0;
				const latency = latencyMs > 0 ? ` (${formatEngineLatency(latencyMs)})` : "";
				engineLabel.push(`${httpEngineNames[id]}:${count}${latency}`);
			}
			if (googleResults.length) engineLabel.push(`Google:${googleResults.length}`);
			if (redditResults.length) engineLabel.push(`Reddit:${redditResults.length}`);
			if (!engineLabel.length) engineLabel.push("HTTP");

			// Trigger speculative prefetch of top-N result URLs in the background.
			// This must happen before building the text so the note is included,
			// but the actual network I/O is fire-and-forget (non-blocking).
			const prefetchUrls = limited.slice(0, prefetchCount).map((r) => r.url);
			if (prefetchUrls.length > 0) {
				// triggerPrefetch returns a Promise that resolves when all prefetches
				// finish, but we intentionally do NOT await it. Failures are swallowed
				// inside the module. setImmediate inside triggerPrefetch is unref'd.
				void triggerPrefetch(prefetchUrls, prefetchCount);
			}

			const prefetchNote =
				prefetchUrls.length > 0
					? `\n_(prefetching top ${prefetchUrls.length} result${prefetchUrls.length === 1 ? "" : "s"} in background — follow-up aio-webfetch will be served from cache)_`
					: "";

			// Surface a requested-but-empty Google so a silent zero is visible (B4).
			const googleNote =
				useGoogle &&
				googleResults.length === 0 &&
				googleStatus !== "disabled (google: false)"
					? `\n_(Google: requested but returned nothing — ${googleStatus})_`
					: "";
			// Surface any non-ok engine (including Reddit) through the shared status
			// map so counts, notes, and TUI output cannot disagree.

			// Surface any non-ok HTTP engine (down / rate-limited / cooled-down /
			// empty) so a failed engine is distinguishable from a legitimately
			// empty one instead of silently vanishing from the header (P2).
			const engineNotes = engineStatus
				? engineStatusNotes(engineStatus)
						.map((note) => `\n${note}`)
						.join("")
				: "";

			const gogglesNote = goggles ? ` — goggles: ${goggles.name}` : "";

			const text = [
				`Search results for "${query}" (${engineLabel.join(" + ")})${gogglesNote}`,
				"",
				renderSearchResults(limited, { compact }),
				prefetchNote,
				googleNote,
				engineNotes,
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					...resultDetails,
					results: limited,
					prefetchCount: prefetchUrls.length,
					goggles: goggles?.name,
					compact,
				},
			};
		},
		renderCall(args, theme: Theme) {
			const head = theme.fg("toolTitle", theme.bold("aio-websearch "));
			const query = theme.fg(
				"accent",
				`"${args.query.slice(0, 90)}${args.query.length > 90 ? "…" : ""}"`,
			);
			return new Text(head + query, 0, 0, (t) => theme.bg("toolPendingBg", t));
		},
		renderResult(result, options, theme: Theme) {
			const details = result.details as any;

			// In-flight: animated per-provider progress rows with an
			// elapsed-vs-response-target bar (#97 UX).
			if (options.isPartial) {
				return createSearchProgressComponent(details, theme, "toolPendingBg");
			}

			return createSearchResultComponent(
				{
					query: details.query,
					providers: details.providers,
					resultCount: details.results?.length ?? 0,
					durationMs: details.durationMs,
					responseTargetMs: details.responseBudgetMs,
					timedOut: details.timedOut === true,
					engineNotes: details.engineStatus
						? engineStatusNotes(details.engineStatus)
						: [],
					results: details.results,
				},
				options.expanded === true,
				theme,
				result.isError ? "toolErrorBg" : "toolSuccessBg",
			);
		},
	});
}
