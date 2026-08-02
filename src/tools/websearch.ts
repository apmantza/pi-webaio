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

export function registerWebsearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-websearch",
		label: "Web Search",
		description:
			"Search the web; returns deduped, cross-engine ranked results with title, url, snippet, and sourceType (official-docs/repo/academic/maintainer-blog/website/community/news/social). No API keys — runs DDG, Brave, Yahoo, Bing, Mojeek, and Google in parallel, capped at ~7s (returns whatever is ready). Common: query, max. Situational: compact:true for URL-scouting (one line per result — title + url + sourceType, no snippet), goggles to rerank additively (presets: docs-first, research, news-balanced, or custom rules), prefetch to warm the cache with the top hits, google:false to skip Google.",
		promptSnippet: "Search the web for current information or references",
		promptGuidelines: [
			"Use aio-websearch when the user asks a question that requires current or external information not in your training data.",
			"After getting search results, use aio-webfetch or aio-webpull to retrieve the full content of the most relevant result.",
			"Runs DDG/Brave/Yahoo/Bing/Mojeek + Google in parallel. Google requires headless Chrome (auto-launched). Set google: false to skip.",
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
				Type.Union(
					[Type.String(), Type.Record(Type.String(), Type.Unknown())],
					{
						description:
							"Optional rerank profile applied additively on top of the normal ranking. Pass a built-in preset name ('docs-first', 'research', 'news-balanced'), a path to a JSON file of custom rules, an inline JSON string, or a rules object ({ rules: [{ domains?, domainMarkers?, urlMarkers?, titleTerms?, weight }] }). Omit for unchanged default ranking.",
					},
				),
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate) {
			const query = params.query;
			setSearchContext(query);
			const max = params.max ?? 15;
			const useGoogle = params.google ?? true;
			const compact = params.compact === true;
			const startedAt = Date.now();
			const goggles = await loadGoggles(params.goggles as GogglesInput);

			// Resolve prefetch count: false/undefined → 0, true → default, number → clamp ≥ 0.
			const prefetchParam = params.prefetch;
			const prefetchCount: number =
				prefetchParam === true
					? DEFAULT_PREFETCH_COUNT
					: typeof prefetchParam === "number" && prefetchParam > 0
						? Math.floor(prefetchParam)
						: 0;

			const SEARCH_TIMEOUT = 7000;
			// Chrome cold-start can take up to 30s; fire it in parallel so startup
			// time does not consume the search-race window.
			const googleEnabled =
				useGoogle && cdpAvailableGA() && isProviderAvailable("google");
			// Track why Google produced no results so a silent zero is surfaced
			// instead of looking like Google was never attempted (B4).
			let googleStatus: string;
			if (!useGoogle) googleStatus = "disabled (google: false)";
			else if (!cdpAvailableGA())
				googleStatus = "unavailable (Chrome CDP not present)";
			else if (!isProviderAvailable("google"))
				googleStatus =
					"unavailable (provider cooled down after recent failures)";
			else googleStatus = "pending";
			const chromeReady = googleEnabled
				? ensureChrome().catch(() => null)
				: null;

		const engineNames = ["DDG", "Brave", "Yahoo", "Bing"];
		if (useGoogle) engineNames.push("Google");
		const useReddit = process.env.REDDIT_CDP_SEARCH === "1";
		const redditEnabled =
			useReddit && cdpAvailableGA() && isProviderAvailable("reddit");
		let redditStatus: string;
		if (!useReddit) redditStatus = "disabled (reddit: false)";
		else if (!cdpAvailableGA())
			redditStatus = "unavailable (Chrome CDP not present)";
		else if (!isProviderAvailable("reddit"))
			redditStatus =
				"unavailable (provider cooled down after recent failures)";
		else redditStatus = "pending";
		if (useReddit) engineNames.push("Reddit");
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
						redditCount: r.redditCount,
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
						const g = await googleSearch(query, {
							timeoutMs: SEARCH_TIMEOUT,
							maxResults: max,
						});
						const results = g.results.map((r) => ({
							title: r.title,
							url: r.url,
							snippet: r.snippet,
							domain: extractDomain(r.url),
						}));
						googleStatus = results.length
							? "ok"
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
			let redditPromise: Promise<{
				source: "reddit";
				results: SearchResult[];
			}>;
			if (redditEnabled) {
				redditPromise = (async () => {
					try {
						await chromeReady;
						const r = await searchReddit(query);
						if (!r) {
							redditStatus =
								"unavailable (CDP search returned null)";
							return { source: "reddit" as const, results: [] };
						}
						if (!r.ok) {
							redditStatus = `error (${r.error})`;
							return { source: "reddit" as const, results: [] };
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
						return { source: "reddit" as const, results };
					} catch (err) {
						recordProviderNetworkFailure("reddit", String(err));
						redditStatus = `error (${String(err).slice(0, 120)})`;
						return { source: "reddit" as const, results: [] };
				}
			})();
			} else {
				redditPromise = Promise.resolve({
					source: "reddit" as const,
					results: [],
				});
			}

			// Outer timeout must cover Chrome cold-start (≤30s) + actual search.
			const OUTER_TIMEOUT = chromeReady ? 40000 : SEARCH_TIMEOUT;
			let timeoutHandle: ReturnType<typeof setTimeout>;
			const timeoutPromise = new Promise<null>((r) => {
				timeoutHandle = setTimeout(() => r(null), OUTER_TIMEOUT);
				timeoutHandle.unref?.();
			});

			const allPromise = Promise.all([
				httpPromise,
				googlePromise,
				redditPromise,
			]);
			let result: Awaited<typeof allPromise> | null;
			try {
				result = await Promise.race([allPromise, timeoutPromise]);
			} finally {
				clearTimeout(timeoutHandle!);
			}

			let httpResults: SearchResult[] = [];
			let googleResults: SearchResult[] = [];
			let redditResults: SearchResult[] = [];
			let httpCounts = { ddg: 0, brave: 0, yahoo: 0, bing: 0, reddit: 0 };
			let engineStatus: EngineStatusMap | undefined;

			if (result) {
				httpResults = result[0].results;
				googleResults = result[1].results;
				redditResults = result[2].results;
				httpCounts = (result[0] as any).httpCounts ?? httpCounts;
				engineStatus = (result[0] as any).engineStatus ?? engineStatus;
			} else {
				const settled = await Promise.allSettled([
					httpPromise,
					googlePromise,
					redditPromise,
				]);
				if (settled[0].status === "fulfilled") {
					httpResults = settled[0].value.results;
					httpCounts = (settled[0].value as any).httpCounts ?? httpCounts;
					engineStatus = (settled[0].value as any).engineStatus ?? engineStatus;
				}
				if (settled[1].status === "fulfilled")
					googleResults = settled[1].value.results;
				if (settled[2].status === "fulfilled")
					redditResults = settled[2].value.results;
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

			const scored = scoreAndRankResults(buckets, query, goggles);
			const merged = scored.map((s) => s.result);

			if (!merged.length) {
				return {
					content: [
						{
							type: "text",
							text: `No search results found for "${query}".`,
						},
					],
					details: { query, results: [] },
				};
			}

			const MAX_TOTAL = 25;
			const limited = merged.slice(0, MAX_TOTAL);

			const engineLabel: string[] = [];
			const httpEngineIds = [
				"ddg",
				"brave",
				"yahoo",
				"bing",
			] as const;
			const httpEngineNames: Record<
				(typeof httpEngineIds)[number],
				string,
			> = {
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
				const latency =
					latencyMs > 0 ? ` (${formatEngineLatency(latencyMs)})` : "";
				engineLabel.push(`${httpEngineNames[id]}:${count}${latency}`);
			}
			if (googleResults.length)
				engineLabel.push(`Google:${googleResults.length}`);
			if (redditResults.length)
				engineLabel.push(`Reddit:${redditResults.length}`);
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
			// Surface a requested-but-empty Reddit so a silent zero is visible.
			const redditNote =
				useReddit &&
				redditResults.length === 0 &&
				redditStatus !== "disabled (reddit: false)"
					? `\n_(Reddit: requested but returned nothing — ${redditStatus})_`
				: "";

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
				redditNote,
				engineNotes,
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					results: limited,
					...httpCounts,
					engineStatus,
					googleCount: googleResults.length,
					googleStatus,
					redditCount: redditResults.length,
					redditStatus,
					durationMs: Date.now() - startedAt,
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
			if (details.mojeekCount) engines.push(`Mojeek:${details.mojeekCount}`);
			if (details.googleCount) engines.push(`Google:${details.googleCount}`);
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
