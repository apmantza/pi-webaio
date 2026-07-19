import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { createBM25Scorer } from "../bm25.ts";
import { loadIndex } from "../webquery-index.ts";

/** Default output directory matches webpull's default: <os-temp>/pi-webaio/<hostname> */
const DEFAULT_BASE = join(tmpdir(), "pi-webaio");

export function registerWebqueryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webquery",
		label: "Web Query",
		description:
			"Search a locally-pulled website corpus (from aio-webpull) using BM25. No re-fetching — offline, token-cheap knowledge base retrieval. Returns top-k relevant chunks with source file, original URL, and heading breadcrumb.",
		promptSnippet: "Search pulled docs locally with BM25",
		promptGuidelines: [
			"Use aio-webquery to search content previously pulled with aio-webpull without re-downloading anything.",
			"Use aio-webpull first if no index exists yet — it will build the BM25 index automatically.",
			"Use aio-websearch or aio-webfetch for live web searches instead.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query to run against the local corpus",
			}),
			dir: Type.Optional(
				Type.String({
					description: `Directory containing a pulled corpus (output of aio-webpull). Defaults to the standard temp location: ${DEFAULT_BASE}/<hostname>`,
				}),
			),
			topK: Type.Optional(
				Type.Number({
					description: "Number of top chunks to return (default: 8)",
					default: 8,
				}),
			),
		}),

		async execute(_toolCallId: string, params: any): Promise<any> {
			const query: string = params.query;
			const topK: number =
				Number.isFinite(params.topK) && params.topK > 0
					? Math.floor(params.topK)
					: 8;

			// Resolve directory
			const dir: string = params.dir ?? DEFAULT_BASE;

			// Load the index
			const loaded = await loadIndex(dir);
			if (!loaded.ok) {
				return {
					content: [{ type: "text", text: loaded.message }],
					details: { found: false, reason: loaded.reason, dir },
				};
			}

			const { index } = loaded;
			const { chunks } = index;

			if (chunks.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `The index at ${dir} exists but contains no chunks. The pulled corpus may be empty.`,
						},
					],
					details: { found: true, chunkCount: 0, dir },
				};
			}

			// Score all chunks with BM25
			const scorer = createBM25Scorer(query);
			const texts = chunks.map((c) => c.text);
			const scores = scorer.scoreAll(texts);

			// Rank and select top-k
			const ranked = scores
				.map((score, i) => ({ score, chunk: chunks[i]! }))
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, topK);

			if (ranked.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No relevant chunks found for query: "${query}"\n\nThe corpus at ${dir} has ${chunks.length} indexed chunks but none matched the query terms.`,
						},
					],
					details: { found: true, chunkCount: chunks.length, matchCount: 0, dir },
				};
			}

			// Format output
			const lines: string[] = [
				`Found ${ranked.length} relevant chunk${ranked.length === 1 ? "" : "s"} (of ${chunks.length} indexed) for: "${query}"`,
				`Corpus: ${dir}  |  Built: ${index.builtAt}`,
				"",
			];

			for (let i = 0; i < ranked.length; i++) {
				const { score, chunk } = ranked[i]!;
				const heading = chunk.heading ? ` › ${chunk.heading}` : "";
				lines.push(`--- [${i + 1}/${ranked.length}] score=${score.toFixed(3)} ---`);
				lines.push(`File: ${chunk.file}${heading}`);
				if (chunk.url) lines.push(`URL: ${chunk.url}`);
				lines.push("");
				lines.push(chunk.text);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					found: true,
					query,
					dir,
					chunkCount: chunks.length,
					matchCount: ranked.length,
					builtAt: index.builtAt,
					results: ranked.map(({ score, chunk }) => ({
						score,
						file: chunk.file,
						url: chunk.url,
						heading: chunk.heading,
					})),
				},
			};
		},
	});
}
