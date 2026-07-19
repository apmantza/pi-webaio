import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredContent } from "../session-store.ts";
import { applyTokenBudget } from "../prune-markdown.ts";

export function registerWebcontentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webcontent",
		label: "Web Content",
		description:
			"Retrieve previously fetched content from session storage by URL. Content is stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Get stored content from a previous fetch",
		promptGuidelines: [
			"Use aio-webcontent when you need the full content of a previously fetched URL without re-downloading.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "URL of previously fetched content",
			}),
			budgetTokens: Type.Optional(
				Type.Number({
					description:
						"Hard token budget for the content returned to the agent. When set, the output is guaranteed to fit within this many tokens — heading structure is preserved, lowest-value sections are dropped first, and a footer notes how many sections were omitted. Min 100.",
					minimum: 100,
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"Relevance query for budget-aware pruning. When set alongside budgetTokens, sections are scored by BM25 relevance so the most relevant sections are kept.",
				}),
			),
		}),

		async execute(_toolCallId: string, params: any): Promise<any> {
			const stored = getStoredContent(params.url);
			if (!stored) {
				return {
					content: [
						{
							type: "text",
							text: `No stored content found for ${params.url}`,
						},
					],
					details: { found: false },
				};
			}
			const budgetTokens = params.budgetTokens as number | undefined;
			const query = params.query as string | undefined;
			const displayContent = budgetTokens
				? applyTokenBudget(stored.content, budgetTokens, query, stored.url)
				: stored.content;
			const text = [
				`Retrieved content for ${stored.url}`,
				stored.title ? `Title: ${stored.title}` : "",
				`Length: ${stored.content.length} chars`,
				"\n---\n",
				displayContent,
			]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					found: true,
					title: stored.title,
					url: stored.url,
					timestamp: stored.timestamp,
					length: stored.content.length,
					budgeted: budgetTokens !== undefined,
				},
			};
		},
	});
}
