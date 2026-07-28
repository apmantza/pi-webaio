import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchWeb } from "../search.ts";
import { loadGoggles, type GogglesInput } from "../goggles.ts";
import { pullPageEnhanced } from "../content.ts";
import { getLatestChromeProfile, DEFAULT_OS } from "../fetch.ts";
import { buildIndex } from "../webquery-index.ts";
import type { ScrapeMode } from "../types.ts";
import { frontmatter, runInBatches } from "./utils.ts";
import {
	bundleDirName,
	clampMaxSources,
	classifyReachability,
	classifySourceStance,
	extractEvidence,
	isPrimarySource,
	rankSources,
	slugify,
	summarizeStance,
	buildStatusMd,
	buildEvidenceMd,
	buildClaimsMdScaffold,
	buildGapsMd,
	buildStanceMd,
	buildManifest,
	buildSourcesJson,
	buildEvidenceJson,
	buildStanceJson,
	writeBundle,
	type QueryResults,
	type FetchedSourceRecord,
	type EvidenceEntry,
	type RankedSource,
	type SourceStance,
} from "../research.ts";

/** Cap on the number of sub-queries fanned out to aio-websearch, to bound work. */
const MAX_QUERIES = 6;

/** Concurrency for fetching top-ranked sources. */
const FETCH_CONCURRENCY = 3;

function resolveOutDir(
	outDir: string | undefined,
	defaultName: string,
): string {
	if (outDir) return resolve(process.cwd(), outDir);
	return resolve(process.cwd(), ".pi", "webaio-research", defaultName);
}

export function registerWebresearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webresearch",
		label: "Web Research",
		description:
			"Single-round research orchestrator: fans out aio-websearch over a query (and optional sub-queries), ranks and dedupes sources, fetches the top-N through the webfetch pipeline, indexes them into a local BM25 corpus, and writes an auditable research bundle (STATUS.md, reports/, sources/, data/) to disk. Deterministic retrieval + bookkeeping only — no LLM calls inside the tool; the calling agent writes the cited claims.",
		promptSnippet:
			"aio-webresearch(query, queries?, maxSources?, outDir?, writeBundle?): run a single-round research pass and write a bundle under .pi/webaio-research/",
		promptGuidelines: [
			"Use aio-webresearch when the user wants a multi-source research pass with a durable, auditable trail (as opposed to a single aio-websearch/aio-webfetch call).",
			"This is a single-round MVP: one fan-out of searches, one fetch pass, one bundle. There is no iterative follow-up loop yet.",
			"After the tool returns, read reports/EVIDENCE.md and data/evidence.json, then fill in reports/CLAIMS.md yourself — the tool does not call an LLM to synthesize claims.",
			"Pass `queries` with a few complementary sub-queries (different phrasings/angles) to widen coverage beyond the single `query`.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Primary research question or topic.",
			}),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional agent-supplied sub-queries to fan out alongside `query` for wider coverage. Capped at 6 total (including `query`).",
				}),
			),
			maxSources: Type.Optional(
				Type.Number({
					description:
						"Maximum number of ranked sources to fetch and include in the bundle. Clamped to 3-12. Default 6.",
					default: 6,
					minimum: 3,
					maximum: 12,
				}),
			),
			outDir: Type.Optional(
				Type.String({
					description:
						"Output directory for the research bundle, resolved relative to the current working directory. Default: .pi/webaio-research/<timestamp>_<slug>/",
				}),
			),
			writeBundle: Type.Optional(
				Type.Boolean({
					description:
						"Write the research bundle to disk (default: true). Set false to only search/fetch/rank in memory and return the summary without writing files.",
					default: true,
				}),
			),
			goggles: Type.Optional(
				Type.Union(
					[Type.String(), Type.Record(Type.String(), Type.Unknown())],
					{
						description:
							"Optional rerank profile applied additively to each fanned-out search on top of the normal ranking. Pass a built-in preset name ('docs-first', 'research', 'news-balanced'), a path to a JSON file of custom rules, an inline JSON string, or a rules object ({ rules: [{ domains?, domainMarkers?, urlMarkers?, titleTerms?, weight }] }). Omit for unchanged default ranking.",
					},
				),
			),
		}),

		async execute(_toolCallId, params: any, _signal, onUpdate) {
			const query: string = params.query;
			const startedAt = new Date();
			const shouldWrite = params.writeBundle !== false;
			const maxSources = clampMaxSources(params.maxSources);
			const goggles = await loadGoggles(params.goggles as GogglesInput);

			const subQueries: string[] = Array.isArray(params.queries)
				? params.queries.filter(
						(q: unknown) => typeof q === "string" && q.trim(),
					)
				: [];
			const allQueries = [query, ...subQueries]
				.map((q) => q.trim())
				.filter((q, i, arr) => q && arr.indexOf(q) === i)
				.slice(0, MAX_QUERIES);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Researching "${query}" across ${allQueries.length} quer${allQueries.length === 1 ? "y" : "ies"}...`,
					},
				],
			});

			// ── 1. Fan out search ────────────────────────────────────────────
			const perQuery: QueryResults[] = await Promise.all(
				allQueries.map(async (q) => {
					try {
						const r = await searchWeb(q, goggles);
						return { query: q, results: r.results };
					} catch {
						return { query: q, results: [] };
					}
				}),
			);
			const zeroResultQueries = perQuery
				.filter((p) => p.results.length === 0)
				.map((p) => p.query);

			// ── 2. Rank + dedupe ─────────────────────────────────────────────
			const ranked: RankedSource[] = rankSources(perQuery);
			const toFetch = ranked.slice(0, maxSources);
			const unfetchedRanked = ranked.slice(maxSources);

			// ── 3. Fetch top-N through the webfetch pipeline ─────────────────
			const bundleName = bundleDirName(query, startedAt);
			const bundleDir = resolveOutDir(params.outDir, bundleName);
			const sourcesDir = join(bundleDir, "sources");
			if (shouldWrite) await mkdir(sourcesDir, { recursive: true });

			const browser = getLatestChromeProfile();
			const os = DEFAULT_OS;

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Fetching top ${toFetch.length} of ${ranked.length} ranked source(s)...`,
					},
				],
			});

			const fetched: FetchedSourceRecord[] = await runInBatches(
				toFetch,
				Math.min(FETCH_CONCURRENCY, Math.max(1, toFetch.length)),
				async (source, idx) => {
					// Guard the per-source fetch so a single throwing source (e.g. a
					// mis-routed vertical extractor whose own network call rejects) is
					// classified "dead" instead of aborting the whole research run (B3).
					let result: Awaited<ReturnType<typeof pullPageEnhanced>>;
					try {
						result = await pullPageEnhanced(source.url, {
							browser,
							os,
							mode: "auto" as ScrapeMode,
						});
						if (!result.ok) {
							const retryable =
								result.errorInfo?.retryable ||
								result.errorInfo?.code === "blocked";
							if (retryable) {
								const browserResult = await pullPageEnhanced(source.url, {
									browser,
									os,
									mode: "browser" as ScrapeMode,
								});
								if (browserResult.ok) result = browserResult;
							}
						}
					} catch (err) {
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						const deadRecord: FetchedSourceRecord = {
							id: source.id,
							url: source.url,
							title: source.title,
							domain: source.domain,
							primary: isPrimarySource(source.domain),
							ok: false,
							statusCode: undefined,
							errorCode: "network",
							errorMessage,
							reachability: classifyReachability({
								ok: false,
								statusCode: undefined,
								errorCode: "network",
							}),
							wordCount: undefined,
							publishedAt: undefined,
						};
						return deadRecord;
					}

					const statusCode = result.errorInfo?.statusCode;
					const errorCode = result.errorInfo?.code;
					const reachability = classifyReachability({
						ok: result.ok,
						statusCode,
						errorCode,
					});

					const record: FetchedSourceRecord = {
						id: source.id,
						url: source.url,
						title: (result.ok ? result.title : source.title) || source.title,
						domain: source.domain,
						primary: isPrimarySource(source.domain),
						ok: result.ok,
						statusCode,
						errorCode,
						errorMessage: result.ok ? undefined : (result.error ?? undefined),
						reachability,
						wordCount: result.ok ? result.wordCount : undefined,
						publishedAt: result.ok ? result.published : undefined,
					};

					if (result.ok && shouldWrite) {
						const fileSlug = slugify(
							record.title || source.domain || `source-${idx + 1}`,
							40,
						);
						const fileName = `${String(idx + 1).padStart(2, "0")}-${fileSlug}.md`;
						const md =
							frontmatter(record.title, source.url, {
								author: result.author,
								published: result.published,
								site: result.site,
								language: result.language,
								wordCount: result.wordCount,
							}) + (result.content ?? "");
						await writeFile(join(sourcesDir, fileName), md, "utf8");
						record.file = `sources/${fileName}`;
						(record as any)._content = result.content ?? "";
					}

					return record;
				},
			);

			// ── 4. BM25-index the fetched sources (aio-webquery compatible) ──
			let indexBuilt = false;
			if (shouldWrite && fetched.some((f) => f.ok)) {
				try {
					await buildIndex(sourcesDir);
					indexBuilt = true;
				} catch {
					/* best effort — bundle is still valid without the index */
				}
			}

			// ── 5. Deterministic evidence extraction (BM25, no LLM) ──────────
			const evidence: EvidenceEntry[] = [];
			const sourceStances: SourceStance[] = [];
			for (const f of fetched) {
				const content = (f as any)._content as string | undefined;
				delete (f as any)._content;
				if (!f.ok || !content) continue;
				const e = extractEvidence(f.id, f.url, f.title, content, query);
				if (e) evidence.push(e);
				sourceStances.push(
					classifySourceStance({
						sourceId: f.id,
						url: f.url,
						title: f.title,
						text: content,
						query,
						primary: f.primary,
						publishedAt: f.publishedAt,
					}),
				);
			}

			// ── 5b. Deterministic claim-stance pass (keyword/pattern-based, no LLM) ──
			const stance = summarizeStance(query, sourceStances);

			const finishedAt = new Date();
			const summary = {
				query,
				queries: allQueries,
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				maxSources,
				consulted: ranked.length,
				fetched,
				unfetchedRanked,
				stance,
			};

			// ── 6. Write the bundle ───────────────────────────────────────────
			if (shouldWrite) {
				const statusMd = buildStatusMd(summary);
				const evidenceMd = buildEvidenceMd(evidence, fetched);
				const claimsMd = buildClaimsMdScaffold(query, fetched);
				const gapsMd = buildGapsMd(summary, zeroResultQueries);
				const stanceMd = buildStanceMd(stance);
				const manifest = buildManifest({
					query,
					queries: allQueries,
					maxSources,
					startedAt: summary.startedAt,
					finishedAt: summary.finishedAt,
					consulted: ranked.length,
					fetched,
					bundleDir,
					stance,
				});
				const sourcesJson = buildSourcesJson(ranked, fetched);
				const evidenceJson = buildEvidenceJson(evidence);
				const stanceJson = buildStanceJson(stance);

				await writeBundle({
					bundleDir,
					statusMd,
					evidenceMd,
					claimsMd,
					gapsMd,
					stanceMd,
					manifest,
					sourcesJson,
					evidenceJson,
					stanceJson,
				});
			}

			const okCount = fetched.filter((f) => f.ok).length;
			const skippedCount = fetched.filter(
				(f) => f.reachability === "skipped",
			).length;
			const deadCount = fetched.filter((f) => f.reachability === "dead").length;
			const primaryCount = fetched.filter((f) => f.primary && f.ok).length;

			const lines = [
				shouldWrite
					? `✓ Research bundle written to ${bundleDir}`
					: `✓ Research pass complete (writeBundle: false — nothing saved to disk)`,
				``,
				`Query: "${query}"${allQueries.length > 1 ? ` (+${allQueries.length - 1} sub-quer${allQueries.length - 1 === 1 ? "y" : "ies"})` : ""}`,
				`Sources consulted: ${ranked.length}  |  fetched: ${fetched.length}  |  primary: ${primaryCount}`,
				`Reachability: ${okCount} ok, ${skippedCount} skipped (anti-bot), ${deadCount} dead`,
				indexBuilt
					? `BM25 index built at ${join(bundleDir, "sources")} — query it with aio-webquery`
					: "",
				`Claim stance (heuristic, non-authoritative): ${stance.verdict} (${stance.supportingCount} supporting, ${stance.conflictingCount} conflicting, ${stance.neutralCount} neutral) — keyword/pattern-based, not semantic entailment; verify before treating as fact.`,
				shouldWrite
					? `\nNext: read ${join(bundleDir, "reports", "EVIDENCE.md")} and fill in ${join(bundleDir, "reports", "CLAIMS.md")}. See ${join(bundleDir, "STANCE.md")} for a non-authoritative candidate stance.`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: lines }],
				details: {
					bundleDir: shouldWrite ? bundleDir : undefined,
					query,
					queries: allQueries,
					maxSources,
					consulted: ranked.length,
					fetchedCount: fetched.length,
					okCount,
					skippedCount,
					deadCount,
					primaryCount,
					indexBuilt,
					sources: ranked,
					fetched,
					stance,
					goggles: goggles?.name,
				},
			};
		},
	});
}
