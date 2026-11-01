import { TOOL_METADATA } from "./lazy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredContent } from "../session-store.ts";
import { applyTokenBudget } from "../prune-markdown.ts";
import { estimateTokens } from "../token-count.ts";
import { diffContent } from "../content-diff.ts";
import { shortHash, hashesEqual } from "../content-hash.ts";

/**
 * Compose the header block and the (already budgeted) body into what the agent
 * actually receives. Exported so the budget maths is testable through the same
 * seam the handler uses — a test that rebuilt this composition itself would stay
 * green while the handler drifted.
 */
export function buildWebcontentText(header: string[], body: string): string {
	return `${header.filter(Boolean).join("\n")}\n\n---\n\n${body}`;
}

/**
 * `budgetTokens` is documented as a hard ceiling on "the content returned to the
 * agent", and the header block is returned to the agent too. Budget the body for
 * whatever the header leaves, so the composed output honours the number the
 * caller passed — the same guarantee `aio-webfetch` makes for the same parameter
 * name.
 *
 * Floors at 1 rather than 0: `applyTokenBudget` reads a non-positive budget as
 * "no budget", so an impossible budget would otherwise fail open into returning
 * the whole document (the shape that made a negative content budget mean
 * unlimited in the cited-answer path).
 */
export function bodyBudgetForFraming(
	totalTokens: number,
	header: string[],
): number {
	const framing = estimateTokens(buildWebcontentText(header, ""));
	return Math.max(1, totalTokens - framing);
}

// Per-URL prune result cache — same url+budget+query → same pruned output
// until content changes (key includes contentHash). Life-depends: avoids
// re-running BM25 + prune on 116k pi.dev doc per webcontent call.
const _pruneCache = new Map<
	string,
	{ contentHash: string | undefined; result: string }
>();
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
			const header = [
				`Retrieved content for ${stored.url}`,
				stored.title ? `Title: ${stored.title}` : "",
				`Length: ${stored.content.length} chars`,
				contentHash ? `Content hash: ${contentHash}` : "",
				unchanged
					? `Unchanged since previous version (${shortHash(stored.previousContentHash!)})`
					: "",
			];
			let displayContent: string;
			if (budgetTokens) {
				// The header is part of what the caller budgeted, so it is charged
				// against the budget before the body is pruned.
				const bodyBudget = bodyBudgetForFraming(budgetTokens, header);
				const cacheKey = `${stored.url}\x00${bodyBudget}\x00${query ?? ""}\x00${stored.contentHash ?? ""}`;
				const hit = _pruneCache.get(cacheKey);
				if (hit && hit.contentHash === stored.contentHash) {
					displayContent = hit.result;
				} else {
					displayContent = applyTokenBudget(
						stored.content,
						bodyBudget,
						query,
						stored.url,
					);
					if (_pruneCache.size >= _PRUNE_CACHE_MAX) {
						const oldest = _pruneCache.keys().next().value as
							| string
							| undefined;
						if (oldest !== undefined) _pruneCache.delete(oldest);
					}
					_pruneCache.set(cacheKey, {
						contentHash: stored.contentHash,
						result: displayContent,
					});
				}
			} else {
				displayContent = stored.content;
			}
			const text = buildWebcontentText(header, displayContent);
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
