import { TOOL_METADATA } from "./lazy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredContent } from "../session-store.ts";
import { applyTokenBudget } from "../prune-markdown.ts";
import { diffContent } from "../content-diff.ts";
import { shortHash, hashesEqual } from "../content-hash.ts";

// Per-URL prune result cache — same url+budget+query → same pruned output
// until content changes (key includes contentHash). Life-depends: avoids
// re-running BM25 + prune on 116k pi.dev doc per webcontent call.
const _pruneCache = new Map<string, { contentHash: string | undefined; result: string }>();
const _PRUNE_CACHE_MAX = 64;

export function registerWebcontentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...TOOL_METADATA["aio-webcontent"],
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

			// ── Default retrieval — with prune cache (life-depends) ───────
			const budgetTokens = params.budgetTokens as number | undefined;
			const query = params.query as string | undefined;
			let displayContent: string;
			if (!budgetTokens) {
				displayContent = stored.content;
			} else {
				const cacheKey = `${stored.url}\x00${budgetTokens}\x00${query ?? ""}\x00${stored.contentHash ?? ""}`;
				const hit = _pruneCache.get(cacheKey);
				if (hit && hit.contentHash === stored.contentHash) {
					displayContent = hit.result;
				} else {
					displayContent = applyTokenBudget(stored.content, budgetTokens, query, stored.url);
					if (_pruneCache.size >= _PRUNE_CACHE_MAX) {
						const oldest = _pruneCache.keys().next().value as string | undefined;
						if (oldest !== undefined) _pruneCache.delete(oldest);
					}
					_pruneCache.set(cacheKey, { contentHash: stored.contentHash, result: displayContent });
				}
			}
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
