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
} from "../search.ts";
import {
	ensureChrome,
	googleSearch,
	cdpAvailable as cdpAvailableGA,
} from "../google-ai.ts";
import type { SearchResult } from "../types.ts";

export function registerWebsearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-websearch",
		label: "Web Search",
		description:
			"Search the web using DuckDuckGo, Brave, Yahoo, Bing, and Google in parallel (no API keys required). Returns a compact list of results with title, URL, and snippet. Capped at ~7s — returns whatever is available by then.",
		promptSnippet: "Search the web for current information or references",
		promptGuidelines: [
			"Use aio-websearch when the user asks a question that requires current or external information not in your training data.",
			"After getting search results, use aio-webfetch or aio-webpull to retrieve the full content of the most relevant result.",
			"Runs DDG/Brave/Yahoo/Bing + Google in parallel. Google requires headless Chrome (auto-launched). Set google: false to skip.",
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
		}),

		async execute(_toolCallId, params, _signal, onUpdate) {
			const query = params.query;
			setSearchContext(query);
			const max = params.max ?? 15;
			const useGoogle = params.google ?? true;
			const startedAt = Date.now();

			const SEARCH_TIMEOUT = 21000;

			const engineNames = ["DDG", "Brave", "Yahoo", "Bing"];
			if (useGoogle) engineNames.push("Google");
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Searching "${query}" via ${engineNames.join(", ")}...`,
					},
				],
			});

			const httpPromise = searchWeb(query).then(
				(r) => ({
					source: "http" as const,
					results: r.results.slice(0, max),
					httpCounts: {
						ddg: r.ddgCount,
						brave: r.braveCount,
						yahoo: r.yahooCount,
						bing: r.bingCount,
					},
				}),
				() => ({
					source: "http" as const,
					results: [] as SearchResult[],
					httpCounts: { ddg: 0, brave: 0, yahoo: 0, bing: 0 },
				}),
			);

			let googlePromise: Promise<{
				source: "google";
				results: SearchResult[];
			}>;
			if (useGoogle && cdpAvailableGA() && isProviderAvailable("google")) {
				googlePromise = (async () => {
					try {
						console.error("BEFORE ensureChrome"); await ensureChrome(); console.error("AFTER ensureChrome");
						const g = await googleSearch(query, {
							timeoutMs: SEARCH_TIMEOUT,
							maxResults: max,
						});
						return {
							source: "google" as const,
							results: g.results.map((r) => ({
								title: r.title,
								url: r.url,
								snippet: r.snippet,
								domain: extractDomain(r.url),
							})),
						};
					} catch (err) { console.error("GOOGLE SEARCH ERROR:", err);
						recordProviderNetworkFailure("google", String(err));
						return { source: "google" as const, results: [] };
					}
				})();
			} else {
				googlePromise = Promise.resolve({
					source: "google" as const,
					results: [],
				});
			}

			const timeoutPromise = new Promise<null>((r) =>
				setTimeout(() => r(null), SEARCH_TIMEOUT),
			);

			const allPromise = Promise.all([httpPromise, googlePromise]);
			const result = await Promise.race([allPromise, timeoutPromise]);

			let httpResults: SearchResult[] = [];
			let googleResults: SearchResult[] = [];
			let httpCounts = { ddg: 0, brave: 0, yahoo: 0, bing: 0 };

			if (result) {
				// Both completed within timeout
				httpResults = result[0].results;
				googleResults = result[1].results;
				httpCounts = (result[0] as any).httpCounts ?? httpCounts;
			} else {
				// Timeout: return whatever is available immediately, don't wait
				// http engines usually finish in 3-5s, so use their results
				try {
					const httpResult = await Promise.race([httpPromise, Promise.resolve()]);
					if (httpResult) {
						httpResults = httpResult.results;
						httpCounts = (httpResult as any).httpCounts ?? httpCounts;
					}
				} catch {}
				// google results will be empty (timeout)
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

			const scored = scoreAndRankResults(buckets);
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
			if (httpCounts.ddg) engineLabel.push(`DDG:${httpCounts.ddg}`);
			if (httpCounts.brave) engineLabel.push(`Brave:${httpCounts.brave}`);
			if (httpCounts.yahoo) engineLabel.push(`Yahoo:${httpCounts.yahoo}`);
			if (httpCounts.bing) engineLabel.push(`Bing:${httpCounts.bing}`);
			if (googleResults.length)
				engineLabel.push(`Google:${googleResults.length}`);
			if (!engineLabel.length) engineLabel.push("HTTP");

			const text = [
				`Search results for "${query}" (${engineLabel.join(" + ")})`,
				"",
				...limited.map((r, i) => {
					const domainTag = r.domain ? ` *(${r.domain})*` : "";
					const srcTag =
						r.sources && r.sources.length > 1
							? ` — ${r.sources.join("+")}`
							: "";
					return `${i + 1}. **${r.title}**${domainTag}${srcTag}\n   ${r.url}\n   ${r.snippet}`;
				}),
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					results: limited,
					...httpCounts,
					googleCount: googleResults.length,
					durationMs: Date.now() - startedAt,
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
			const engineStr = engines.join("+") || "HTTP";

			const dur = details.durationMs ?? 0;
			const durText = dur >= 1000 ? `${Math.round(dur / 1000)}s` : `${dur}ms`;

			const summary =
				theme.fg("success", `${count} result${count === 1 ? "" : "s"}`) +
				theme.fg("muted", ` via ${engineStr} in ${durText}`);

			if (count === 0) return new Text(summary);
			if (!options.expanded) return new Text(summary);

			const rows = [summary];
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
