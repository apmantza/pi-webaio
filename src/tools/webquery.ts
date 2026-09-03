import { TOOL_METADATA } from "./lazy.ts";
import { join, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { createBM25Scorer } from "../bm25.ts";
import { loadIndex } from "../webquery-index.ts";

// Query result cache — same query+dir+topK → same ranked output until index changes
// Life-depends: avoids re-scoring 500 chunks via BM25 on repeated queries.
const _queryCache = new Map<string, { builtAt: string; result: unknown }>();
const _QUERY_CACHE_MAX = 32;

/** Default output directory matches webpull's default: <os-temp>/pi-webaio/<hostname> */
const DEFAULT_BASE = join(tmpdir(), "pi-webaio");

/**
 * Resolve the corpus directory for aio-webquery (B5). Relative paths resolve
 * against the standard temp base (<temp>/pi-webaio), matching aio-webpull's
 * default output layout (<temp>/pi-webaio/<hostname>), so `dir: "example.com"`
 * targets <temp>/pi-webaio/example.com instead of resolving against the
 * current working directory. Absolute paths pass through unchanged.
 */
export function resolveCorpusDir(
	rawDir: string | undefined,
	base: string = DEFAULT_BASE,
): string {
	const candidate = rawDir ?? base;
	return isAbsolute(candidate) ? candidate : resolve(base, candidate);
}

export function registerWebqueryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...TOOL_METADATA["aio-webquery"],
		async execute(_toolCallId: string, params: any): Promise<any> {
			const query: string = params.query;
			const topK: number =
				Number.isFinite(params.topK) && params.topK > 0
					? Math.floor(params.topK)
					: 8;

			// Resolve directory (relative paths resolve against the temp base — B5).
			const dir: string = resolveCorpusDir(params.dir);

			// Load the index
			const loaded = await loadIndex(dir);
			if (!loaded.ok) {
				const hint =
					loaded.reason === "missing"
						? `\nHint: pass dir="<hostname>" (e.g. dir="example.com") or the absolute pull directory. Corpora live under ${DEFAULT_BASE}/<hostname>.`
						: "";
				return {
					content: [{ type: "text", text: loaded.message + hint }],
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

			// Check query cache — same query+dir+topK+builtAt → hit
			const cacheKey = `${dir}\x00${query}\x00${topK}\x00${index.builtAt}`;
			const cached = _queryCache.get(cacheKey) as
				| { builtAt: string; result: { content: { type: string; text: string }[]; details: unknown } }
				| undefined;
			if (cached && cached.builtAt === index.builtAt) {
				return cached.result;
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
					details: {
						found: true,
						chunkCount: chunks.length,
						matchCount: 0,
						dir,
					},
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
				lines.push(
					`--- [${i + 1}/${ranked.length}] score=${score.toFixed(3)} ---`,
				);
				lines.push(`File: ${chunk.file}${heading}`);
				if (chunk.url) lines.push(`URL: ${chunk.url}`);
				lines.push("");
				lines.push(chunk.text);
				lines.push("");
			}

			const result = {
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
			if (_queryCache.size >= _QUERY_CACHE_MAX) {
				const oldest = _queryCache.keys().next().value as string | undefined;
				if (oldest !== undefined) _queryCache.delete(oldest);
			}
			_queryCache.set(cacheKey, { builtAt: index.builtAt, result });
			return result;
		},
	});
}
