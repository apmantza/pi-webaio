import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredContent } from "../session-store.ts";
import { applyTokenBudget } from "../prune-markdown.ts";
import { diffContent } from "../content-diff.ts";
import { shortHash, hashesEqual } from "../content-hash.ts";

export function registerWebcontentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webcontent",
		label: "Web Content",
		description:
			"Retrieve previously fetched content from session storage by URL. Content is stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Get stored content from a previous fetch",
		promptGuidelines: [
			"Use aio-webcontent when you need the full content of a previously fetched URL without re-downloading.",
			"Pass diff: true to see a section-level diff of the URL's current cached content against its previous version.",
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
			diff: Type.Optional(
				Type.Boolean({
					description:
						"When true, return a section-level diff of the URL's current cached content against its previously stored version (reusing the aio-webfetch diff engine) instead of the full content. Requires the URL to have been fetched at least twice. Default: false.",
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

			const contentHash = stored.contentHash
				? shortHash(stored.contentHash)
				: undefined;
			// F6 dedup signal: the current content is byte-identical to the
			// previous version this URL was stored with.
			const unchanged =
				!!stored.previousContentHash &&
				hashesEqual(stored.contentHash, stored.previousContentHash);

			// ── Diff-mode (F6) ────────────────────────────────────────────
			if (params.diff === true) {
				if (stored.previousContent === undefined) {
					const text = [
						`No previous version to diff for ${stored.url}`,
						"Only one version of this URL is cached — fetch it again after it changes to produce a diff.",
						contentHash ? `Current content hash: ${contentHash}` : "",
					]
						.filter(Boolean)
						.join("\n");
					return {
						content: [{ type: "text", text }],
						details: {
							found: true,
							diff: false,
							reason: "no-previous-version",
							url: stored.url,
							contentHash,
						},
					};
				}

				const result = diffContent(stored.previousContent, stored.content);
				const prevHash = stored.previousContentHash
					? shortHash(stored.previousContentHash)
					: undefined;
				const text = [
					`Diff for ${stored.url}`,
					`Previous hash: ${prevHash ?? "(unknown)"} → Current hash: ${contentHash ?? "(unknown)"}`,
					"",
					result.summary,
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: {
						found: true,
						diff: true,
						url: stored.url,
						unchanged: result.unchanged,
						summary: result.summary,
						addedSections: result.addedSections,
						removedSections: result.removedSections,
						changedSections: result.changedSections,
						previousContentHash: prevHash,
						contentHash,
					},
				};
			}

			// ── Default retrieval (unchanged behavior) ────────────────────
			const budgetTokens = params.budgetTokens as number | undefined;
			const query = params.query as string | undefined;
			const displayContent = budgetTokens
				? applyTokenBudget(stored.content, budgetTokens, query, stored.url)
				: stored.content;
			const text = [
				`Retrieved content for ${stored.url}`,
				stored.title ? `Title: ${stored.title}` : "",
				`Length: ${stored.content.length} chars`,
				contentHash ? `Content hash: ${contentHash}` : "",
				unchanged
					? `Unchanged since previous version (${shortHash(stored.previousContentHash!)})`
					: "",
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
					contentHash,
					unchanged,
					hasPreviousVersion: stored.previousContent !== undefined,
				},
			};
		},
	});
}
