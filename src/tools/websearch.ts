import { Type } from "typebox";
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
	shouldRunReddit,
} from "../search-orchestration.ts";

const SEARCH_DEADLINE_MS = 7000;
// Hard upper bound for the Google lane itself (measured from when the lane's
// search actually starts, after chromeReady). The broker's pagination
// budget-fencing (2s page floor, per-page 3.5s cap) fits inside this window:
// a hot broker returns ~1s for max 15, and even a slow sparse tail page can
// never burn more than this. The overall tool deadline stays 7s.
const GOOGLE_LANE_MAX_MS = 3000;

function classifyRedditStatus(status: string, count: number): EngineStatus {
	if (count > 0 || status === "ok") return "ok";
	if (status.startsWith("timeout")) return "timeout";
	if (status.startsWith("error") || status.startsWith("unavailable"))
		return "error";
	return "empty";
}

export function registerWebsearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-websearch",
		label: "Web Search",
		description:
			"Search the web; returns deduped, cross-engine ranked results with title, url, snippet, and sourceType (official-docs/repo/academic/maintainer-blog/website/community/news/social). No API keys — runs DDG, Brave, Yahoo, and Bing in parallel, capped at ~7s (returns deterministic partial results at the deadline). Google is enabled by default when Chrome CDP is available; Reddit is an automatic CDP companion whenever CDP is available, including when google:false. Common: query, max. Situational: compact:true for URL-scouting (one line per result — title + url + sourceType, no snippet), goggles to rerank additively (presets: docs-first, research, news-balanced, or custom rules), prefetch to warm the cache with the top hits, google:false to skip Google only.",
		promptSnippet: "Search the web for current information or references",
		promptGuidelines: [
			"Use aio-websearch when the user asks a question that requires current or external information not in your training data.",
			"After getting search results, use aio-webfetch or aio-webpull to retrieve the full content of the most relevant result.",
			"Runs DDG/Brave/Yahoo/Bing in parallel. Google requires headless Chrome (auto-launched) and is enabled by default. Reddit is also automatic when Chrome CDP is available; google: false skips Google but does not disable Reddit. Set google: false to skip Google.",
			"Set compact: true for URL scouting — one line per result (title + URL + sourceType, no snippet) to minimize token waste.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (e.g. 'React Server Components RFC')",
			}),
			max: Type.Optional(
				Type.Number({
					description:
						"Max results to request from each engine (default: 15). Up to 25 returned after dedup across all engines.",
					default: 15,
				}),
			),
			google: Type.Optional(
				Type.Boolean({
					description:
						"Also search Google via Chrome CDP (headless by default; set GREEDY_SEARCH_VISIBLE=1 for visible mode). Default: true.",
					default: true,
				}),
			),
			compact: Type.Optional(
				Type.Boolean({
					description:
						"Opt-in compact output for URL scouting: render ONE line per result with just title + URL + sourceType (official-docs/repo/academic/maintainer-blog/website/community/news/social) and NO snippet. Keeps the engine-count header and any non-ok engine notes. Default: false (full snippets).",
					default: false,
				}),
			),
			prefetch: Type.Optional(
				Type.Union([Type.Boolean(), Type.Number()], {
					description:
						"Opt-in speculative prefetch: background-fetch the top result URLs into the session cache while you read the results, so follow-up aio-webfetch calls are served instantly from cache. Pass true to prefetch the top 3 results, or a positive integer to prefetch that many. Default: false (off).",
				}),
			),
			goggles: Type.Optional(
				Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
					description:
						"Optional rerank profile applied additively on top of the normal ranking. Pass a built-in preset name ('docs-first', 'research', 'news-balanced'), a path to a JSON file of custom rules, an inline JSON string, or a rules object ({ rules: [{ domains?, domainMarkers?, urlMarkers?, titleTerms?, weight }] }). Omit for unchanged default ranking.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const query = params.query;
			setSearchContext(query);
			const max = params.max ?? 15;
			const useGoogle = params.google ?? true;
			const compact = params.compact === true;
			const startedAt = Date.now();
			const searchDeadlineAt = startedAt + SEARCH_DEADLINE_MS;
			const goggles = await loadGoggles(params.goggles as GogglesInput);

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
				cdpAvailableGA(),
				isProviderAvailable("reddit"),
			);
			// Track why Google produced no results so a silent zero is surfaced
			// instead of looking like Google was never attempted (B4).
			const googleEnabled =
				useGoogle && cdpAvailableGA() && isProviderAvailable("google");
			let googleStatus: string;
			if (!useGoogle) googleStatus = "disabled (google: false)";
			else if (!cdpAvailableGA())
				googleStatus = "unavailable (Chrome CDP not present)";
			else if (isProviderAvailable("google")) googleStatus = "pending";
			else
				googleStatus = "unavailable (provider cooled down after recent failures)";
			const chromeReady =
				googleEnabled || redditEnabled
					? ensureChrome(undefined, {
							deadlineAt: searchDeadlineAt,
							signal,
						}).catch(() => null)
					: null;
			let redditStatus: string;
			if (!cdpAvailableGA()) redditStatus = "unavailable (Chrome CDP not present)";
			else if (isProviderAvailable("reddit")) redditStatus = "pending";
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

			const httpPromise = searchWeb(query, goggles).then(
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
			if (chromeReady) {
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
						const g = await googleSearch(query, {
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
						googleStatus = `error (${String(err).slice(0, 120)})`;
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
						const r = await searchReddit(query);
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
