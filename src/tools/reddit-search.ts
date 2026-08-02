// ─── Reddit search tool ────────────────────────────────────────────
// Synthetic Reddit search via Chrome CDP — no external APIs.
// Registered as `aio-reddit-search` when REDDIT_CDP_SEARCH=1.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchReddit } from "../verticals/reddit_search.ts";

export function registerRedditSearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-reddit-search",
		label: "Reddit Search",
		description:
			"Search Reddit via CDP (synthetic — no external APIs). " +
			"Requires REDDIT_CDP_SEARCH=1 and the dedicated Chrome instance running. " +
			"Returns structured results: title, url, subreddit, score, comments, author.",
		promptSnippet: "Search Reddit for discussions about a topic",
		promptGuidelines: [
			"Use aio-reddit-search when the user wants to find Reddit discussions on a topic.",
			"Requires REDDIT_CDP_SEARCH=1 and the dedicated Chrome instance (node bin/launch.mjs).",
			"Results are deduplicated by URL and ordered by Reddit's relevance sort.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query (e.g. 'langchain', 'site:reddit.com AI agents')",
			}),
		}),
		async execute(_toolCallId, params, _signal, onUpdate) {
			const query = params.query;
			if (!query) {
				return {
					content: [
						{ type: "text", text: "Error: query parameter is required" },
					],
					isError: true,
				};
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Searching Reddit for "${query}"...`,
					},
				],
			});

			const result = await searchReddit(query);

			if (!result) {
				return {
					content: [
						{
							type: "text",
							text: "Reddit search is unavailable. Set REDDIT_CDP_SEARCH=1 and ensure Chrome is running (node bin/launch.mjs).",
						},
					],
					isError: true,
				};
			}

			if (!result.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Reddit search failed: ${result.error}`,
						},
					],
					isError: true,
				};
			}

			if (result.count === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No Reddit results found for "${query}" (${result.elapsed}ms)`,
						},
					],
				};
			}

			const lines: string[] = [
				`# Reddit search: ${query}`,
				`${result.count} results (${result.elapsed}ms)\n`,
			];

			for (const r of result.results) {
				lines.push(`## ${r.title}`);
				lines.push(`- **URL:** ${r.url}`);
				lines.push(`- **Subreddit:** r/${r.subreddit}`);
				lines.push(`- **Score:** ${r.score} points`);
				lines.push(`- **Comments:** ${r.comments}`);
				if (r.author) lines.push(`- **Author:** u/${r.author}`);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		},
	});
}
