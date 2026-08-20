import { TOOL_METADATA } from "./lazy.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { setSearchContext } from "../session-store.ts";
import {
	searchWeb,
	ENGINE_WEIGHTS,
	recordProviderNetworkFailure,
	isProviderAvailable,
	extractDomain,
	scoreAndRankResults,
	buildResultBuckets,
	engineStatusNotes,
	formatEngineLatency,
	renderSearchResults,
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

const SEARCH_DEADLINE_MS = 7000;
// Hard upper bound for the Google lane itself (measured from when the lane's
// search actually starts, after chromeReady). The broker's pagination
// budget-fencing (2s page floor, per-page 3.5s cap) fits inside this window:
// a hot broker returns ~1s for max 15, and even a slow sparse tail page can
// never burn more than this. The overall tool deadline stays 7s.
const GOOGLE_LANE_MAX_MS = 3000;

type WebsearchDependencies = {
	loadGoggles?: typeof loadGoggles;
	searchWeb?: typeof searchWeb;
	ensureChrome?: typeof ensureChrome;
	googleSearch?: typeof googleSearch;
	searchReddit?: typeof searchReddit;
	cdpAvailable?: typeof cdpAvailableGA;
	providerAvailable?: typeof isProviderAvailable;
};

function classifyRedditStatus(status: string, count: number): EngineStatus {
	if (count > 0 || status === "ok") return "ok";
	if (status.startsWith("timeout")) return "timeout";
	if (status.startsWith("error") || status.startsWith("unavailable"))
		return "error";
	return "empty";
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

	pi.registerTool({
		...TOOL_METADATA["aio-websearch"],
		async execute(_toolCallId, params, signal, onUpdate) {
			const query = params.query;
			setSearchContext(query);
			const max = params.max ?? 15;
			const useGoogle = params.google ?? true;
			const compact = params.compact === true;
			const startedAt = Date.now();
			const searchDeadlineAt = startedAt + SEARCH_DEADLINE_MS;
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
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Searching "${query}" via ${engineNames.join(", ")}...`,
					},
				],
			});

			const httpPromise = searchWebImpl(query, goggles).then(
				(r) => ({
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
				}),
				() => ({
					source: "http" as const,
					results: [] as SearchResult[],
					httpCounts: { ddg: 0, brave: 0, yahoo: 0, bing: 0, reddit: 0 },
					engineStatus: undefined as EngineStatusMap | undefined,
				}),
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
							Date.now() + GOOGLE_LANE_MAX_MS,
						);
						const g = await googleSearchImpl(query, {
							timeoutMs: Math.min(SEARCH_DEADLINE_MS, GOOGLE_LANE_MAX_MS),
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
								? `timeout (search deadline ${SEARCH_DEADLINE_MS}ms)`
								: `error (${String(err).slice(0, 120)})`;
						return { source: "google" as const, results: [] };
					}
				})();
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
						await chromeReady;
						const r = await searchRedditImpl(query);
						if (!r) {
							redditStatus = "unavailable (CDP search returned null)";
							return {
								source: "reddit" as const,
								results: [],
								latencyMs: Date.now() - redditStartedAt,
							};
						}
						if (!r.ok) {
							redditStatus = `error (${r.error})`;
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
				SEARCH_DEADLINE_MS,
			);
			const result = collected.values;

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
					googleStatus = `timeout (search deadline ${SEARCH_DEADLINE_MS}ms)`;
				if (redditEnabled && !redditResult)
					redditStatus = `timeout (search deadline ${SEARCH_DEADLINE_MS}ms)`;
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
						latencyMs: redditResult?.latencyMs ?? SEARCH_DEADLINE_MS,
					},
				};
			}

			const scored = scoreAndRankResults(buckets, query, goggles);
			const merged = scored.map((s) => s.result);

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
				deadlineMs: SEARCH_DEADLINE_MS,
				timedOut: collected.timedOut,
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
			return new Text(head + query);
		},
		renderResult(result, options, theme: Theme) {
			const details = result.details as any;

			if (options.isPartial) {
				return new Text(theme.fg("warning", `Searching "${details.query}"...`));
			}

			const count = details.results?.length ?? 0;
			const engines: string[] = [];
			if (details.ddgCount) engines.push(`DDG:${details.ddgCount}`);
			if (details.braveCount) engines.push(`Brave:${details.braveCount}`);
			if (details.yahooCount) engines.push(`Yahoo:${details.yahooCount}`);
			if (details.bingCount) engines.push(`Bing:${details.bingCount}`);
			if (details.googleCount) engines.push(`Google:${details.googleCount}`);
			if (details.redditCount) engines.push(`Reddit:${details.redditCount}`);
			const engineStr = engines.join("+") || "HTTP";

			const dur = details.durationMs ?? 0;
			const durText = dur >= 1000 ? `${Math.round(dur / 1000)}s` : `${dur}ms`;

			const summary =
				theme.fg("success", `${count} result${count === 1 ? "" : "s"}`) +
				theme.fg("muted", ` via ${engineStr} in ${durText}`);

			// Compact notes for any non-ok HTTP engine (P2), so the TUI reader also
			// sees why an engine is missing rather than only the agent text.
			const statusNotes = details.engineStatus
				? engineStatusNotes(details.engineStatus)
				: [];
			const noteLine = statusNotes.length
				? theme.fg("dim", statusNotes.join(" "))
				: "";

			if (count === 0) return new Text(summary);
			if (!options.expanded)
				return new Text(noteLine ? `${summary}\n${noteLine}` : summary);

			const rows = [summary];
			if (noteLine) rows.push(noteLine);
			const visibleLimit = 8;
			for (const item of details.results.slice(0, visibleLimit)) {
				const domainTag = item.domain ? ` (${item.domain})` : "";
				const srcTag =
					item.sources && item.sources.length > 1
						? ` — ${item.sources.join("+")}`
						: "";
				rows.push(
					`${theme.fg("accent", item.title?.slice(0, 80) ?? "")}${theme.fg("dim", domainTag + srcTag)}`,
				);
				rows.push(theme.fg("dim", `  ${item.url?.slice(0, 100) ?? ""}`));
				if (item.snippet)
					rows.push(theme.fg("muted", `  ${item.snippet.slice(0, 140)}`));
			}
			if (details.results.length > visibleLimit) {
				rows.push(
					theme.fg("dim", `… ${details.results.length - visibleLimit} more`),
				);
			}
			return new Text(rows.join("\n"));
		},
	});
}
