import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_PREVIEW_CHARS, pullPageEnhanced } from "../content.ts";
import { compileContextPackage } from "../context-package.ts";
import {
	chunkMarkdown,
	DEFAULT_OVERLAP_TOKENS,
	formatChunksText,
	type Chunk,
} from "../chunker.ts";
import { DEFAULT_OS, getLatestChromeProfile, smartFetch } from "../fetch.ts";
import {
	cdpAvailable as cdpAvailableGA,
	ensureChrome,
	summarizeUrl,
} from "../google-ai.ts";
import {
	extractInteractables,
	formatInteractablesSection,
} from "../interactive-elements.ts";
import { pruneMarkdown, applyTokenBudget } from "../prune-markdown.ts";
import { createBM25Scorer } from "../bm25.ts";
import {
	BASE_TEMP,
	focusedSummaryAnnotation,
	getSearchContext,
	getStoredContent,
	peekStoredContent,
	shouldInjectSearchContext,
	storeContent,
	summaryCache,
	summaryCacheKey,
} from "../session-store.ts";
import { storeResult } from "../storage.ts";
import {
	attachValidators,
	buildConditionalHeaders,
	drainCapturedValidators,
	extractValidators,
	hasValidators,
	isExpiredEntry,
	refreshEntryOnNotModified,
} from "../http-validators.ts";
import { diffContent } from "../content-diff.ts";
import { estimateTokens } from "../token-count.ts";
import type { ScrapeMode } from "../types.ts";
import {
	applyFormat,
	createCallComponent,
	createProgressComponent,
	createResultComponent,
	type FetchItemProgress,
	SPINNER_INTERVAL_MS,
	type WebfetchDetails,
} from "./render-result.ts";
import {
	buildUserFacingFetchErrorSummary,
	classifyError,
	createFetchError,
	type FetchError,
	type FetchErrorCode,
	type FetchPhase,
	fetchErrorInfoFromUnknown,
	isFetchError,
	suggestRetryTimeoutMs,
} from "./fetch-error.ts";
import { frontmatter, runInBatches, safeResolveInBaseTemp } from "./utils.ts";

/**
 * Build a deterministic fallback summary from markdown content.
 *
 * Used when AI summarization (Google AI Mode) is unavailable or fails.
 * Output is truncated to MAX_PREVIEW_CHARS.
 *
 * @internal Exported for unit tests only. Not part of the public API.
 */

// Cap the input size to avoid blocking the event loop on multi-MB
// markdown pages. 50KB is plenty for a meaningful summary; anything
// beyond that we'd be reading off-screen anyway.
const MAX_SUMMARY_INPUT_CHARS = 50_000;

// CommonMark headings H1-H6 with required space (e.g. "## Section").
const HEADING_RE = /^#{1,6}\s/;

// First sentence of a body line. Minimum 5 chars to skip labels like
// "Hi." (3 chars) and "OK." (3 chars), while still capturing short
// sentences like "Tap Continue." (13 chars) and "Done." (5 chars).
const FIRST_SENTENCE_RE = /^(.{5,120}?)[.!?](\s|$)/;

export function buildDeterministicSummary(content: string): string {
	const trimmedInput = content.slice(0, MAX_SUMMARY_INPUT_CHARS);
	const lines = trimmedInput.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (HEADING_RE.test(trimmed)) {
			out.push(trimmed);
			continue;
		}
		if (out.length > 0 && !HEADING_RE.test(out[out.length - 1])) {
			continue;
		}
		const firstSentence = trimmed.match(FIRST_SENTENCE_RE);
		if (firstSentence) {
			out.push(firstSentence[1] + ".");
		}
	}
	return out.join("\n\n").slice(0, MAX_PREVIEW_CHARS);
}

function parseJsonCandidate(value: string): unknown | null {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function extractJsonPayload(body: string): unknown | null {
	let trimmed = body.trim();
	const wrapper = parseJsonCandidate(trimmed);
	if (
		wrapper &&
		typeof wrapper === "object" &&
		!Array.isArray(wrapper) &&
		"content" in wrapper &&
		"contentLength" in wrapper &&
		typeof (wrapper as { content?: unknown }).content === "string"
	) {
		trimmed = (wrapper as { content: string }).content.trim();
	}

	trimmed = trimmed.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	trimmed = trimmed
		.replace(/^\[UNTRUSTED WEB CONTENT START\]\n?/, "")
		.replace(/\n?\[UNTRUSTED WEB CONTENT END\]$/, "")
		.trim();

	const fenced = trimmed.match(/^```json\s*\n([\s\S]*?)\n```\s*$/i);
	if (fenced) return parseJsonCandidate(fenced[1]!.trim());
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return parseJsonCandidate(trimmed);
	}
	return null;
}

function describeJsonPayload(payload: unknown): string[] {
	if (Array.isArray(payload)) {
		return [
			`JSON array: ${payload.length} item${payload.length === 1 ? "" : "s"}`,
		];
	}
	if (!payload || typeof payload !== "object") {
		return [`JSON ${typeof payload}`];
	}

	const obj = payload as Record<string, unknown>;
	const keys = Object.keys(obj);
	const visibleKeys = keys.slice(0, 12);
	const lines = [
		`JSON object: ${keys.length} top-level key${keys.length === 1 ? "" : "s"}`,
		`Keys: ${visibleKeys.join(", ")}${keys.length > visibleKeys.length ? ", …" : ""}`,
	];

	for (const key of keys.slice(0, 6)) {
		const value = obj[key];
		if (Array.isArray(value)) {
			lines.push(
				`- ${key}: ${value.length} item${value.length === 1 ? "" : "s"}`,
			);
		} else if (value && typeof value === "object") {
			const nestedKeys = Object.keys(value as Record<string, unknown>);
			lines.push(
				`- ${key}: object (${nestedKeys.slice(0, 5).join(", ")}${nestedKeys.length > 5 ? ", …" : ""})`,
			);
		} else {
			lines.push(`- ${key}: ${value === null ? "null" : typeof value}`);
		}
	}
	return lines;
}

export function buildCompactJsonPreview(
	body: string,
	options: { outPath?: string; responseId?: string; length?: number } = {},
): string | null {
	const payload = extractJsonPayload(body);
	if (payload === null) return null;

	const length = options.length ?? body.length;
	const lines = [
		`JSON payload omitted from chat (${length} chars).`,
		...describeJsonPayload(payload),
	];
	if (options.outPath) {
		lines.push(`Full markdown saved to: ${options.outPath}`);
	}
	if (options.responseId) {
		lines.push(`Full result ID: ${options.responseId}`);
	}
	return lines.join("\n");
}

/**
 * Compute RAG chunks for a single markdown result, if requested.
 * Returns undefined if chunks are not requested, the body is
 * empty, or chunking fails. Errors are pushed to the caller-
 * provided `errors` array as generic messages (no internal
 * details leak to users). Full error is logged for debugging.
 */
export function maybeChunkMarkdown(
	body: string | undefined,
	params: { chunks?: boolean; maxTokens?: number; overlapTokens?: number },
	errors: string[],
): Chunk[] | undefined {
	if (!params.chunks || !body) return undefined;
	try {
		const result = chunkMarkdown(body, {
			maxTokens: params.maxTokens,
			overlapTokens: params.overlapTokens,
		});
		return result.length > 0 ? result : undefined;
	} catch {
		errors.push("chunking failed for this result");
		return undefined;
	}
}

/** Default number of top chunks returned in answer mode. */
export const DEFAULT_TOP_CHUNKS = 5;

/**
 * Apply query-focused answer mode to a markdown body.
 *
 * Chunks the markdown, scores each chunk by BM25 against the query,
 * selects the top-k highest-scoring chunks (breaking ties by document
 * position), re-orders them by original position, and prefixes each
 * with its heading breadcrumb. A footer notes how many sections were
 * omitted and that the full content is cached.
 *
 * Returns `undefined` when the body is empty, the query is empty, or
 * chunking yields no results so the caller can fall back to full content.
 *
 * @internal Exported for unit tests only.
 */
export function applyQueryAnswerMode(
	body: string,
	query: string,
	topK: number = DEFAULT_TOP_CHUNKS,
	chunkOptions: { maxTokens?: number; overlapTokens?: number } = {},
): string | undefined {
	if (!body || !query?.trim()) return undefined;

	let chunks: Chunk[];
	try {
		chunks = chunkMarkdown(body, chunkOptions);
	} catch {
		return undefined;
	}
	if (chunks.length === 0) return undefined;

	// Score all chunks in one pass (better IDF than scoring one at a time).
	const scorer = createBM25Scorer(query);
	const texts = chunks.map((c) => c.text);
	const scores = scorer.scoreAll(texts);

	// Pair each chunk with its score and original index.
	const scored = chunks.map((c, i) => ({ chunk: c, score: scores[i] ?? 0 }));

	// Select top-k by score; preserve document order among ties.
	const sorted = scored.slice().sort((a, b) => b.score - a.score);
	const topK_ = Math.max(1, Math.floor(topK));
	const selected = sorted.slice(0, topK_);

	// Re-sort selected chunks by original document position.
	selected.sort((a, b) => a.chunk.index - b.chunk.index);

	const omitted = chunks.length - selected.length;

	// Build a heading-breadcrumb for each chunk by scanning ALL chunks in
	// document order (not just the selected ones) to track heading context.
	// This correctly handles the case where the chunker splits a heading
	// into a separate chunk from its body text, and also handles overlap
	// prepending (which means chunk.text may not be verbatim in `body`).
	const HEADING_INLINE_RE = /^#{1,6}\s+(.+)/m;

	// Walk all chunks in order, tracking the last heading seen.
	const headingByIndex = new Map<number, string>();
	let currentHeadingCtx = "";
	for (const c of chunks) {
		const hm = c.text.match(HEADING_INLINE_RE);
		if (hm) currentHeadingCtx = hm[1]!.trim();
		headingByIndex.set(c.index, currentHeadingCtx);
	}

	const parts = selected.map(({ chunk }) => {
		const heading = headingByIndex.get(chunk.index) ?? "";
		const breadcrumb = heading ? `> **${heading}**\n\n` : "";
		return `${breadcrumb}${chunk.text}`;
	});

	const footer =
		omitted > 0
			? `\n\n---\n_${omitted} section${omitted === 1 ? "" : "s"} omitted. Full content cached — retrieve with aio-webcontent by URL._`
			: `\n\n---\n_Full content cached — retrieve with aio-webcontent by URL._`;

	return parts.join("\n\n---\n\n") + footer;
}

export function registerWebfetchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webfetch",
		label: "Web Fetch",
		description:
			"Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Detects PDFs, GitHub repos, and Next.js RSC. Long content is automatically summarized via Gemini AI; full content always saved to file.",
		promptSnippet:
			"aio-webfetch(url|urls, mode?, browser?, os?, proxy?, prune?, query?, topChunks?, interactive?, bypass?, bypassStrategies?, compile?, out?, cacheTtlSeconds?, start_index?, max_length?, format?): fetch URL(s) with anti-bot TLS fingerprinting, defuddle extraction, and optional AI summary. Default `format=markdown` saves to disk; pass `format=html|text|json|raw` for an in-memory body. Use the read tool on the saved path for full text. Pass `query` alone for answer mode: returns top-k BM25-scored chunks with heading breadcrumbs; full content cached for aio-webcontent.",
		promptGuidelines: [
			"Use aio-webfetch when the user wants to retrieve specific webpage(s), article(s), or file(s).",
			"Use aio-webpull when the user wants to download an entire site or docs collection.",
			"After aio-webfetch completes, use the built-in read tool to inspect the generated markdown file(s).",
			"Pass `urls: [...]` (not `url`) to fetch multiple pages in one call — returns per-item progress in the TUI.",
		],
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"Single URL to fetch. Use either 'url' or 'urls', not both.",
				}),
			),
			urls: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple URLs to fetch in parallel.",
				}),
			),
			out: Type.Optional(
				Type.String({
					description:
						"Output file path under temp for single url (default: auto-derived from URL)",
				}),
			),
			mode: Type.Optional(
				Type.String({
					description: `Scrape mode: "auto" (default), "fast", "fingerprint", or "browser". Auto escalates from fast → fingerprint → browser when bot protection is detected.`,
				}),
			),
			browser: Type.Optional(
				Type.String({
					description: `Browser profile for TLS fingerprinting. Default: "${getLatestChromeProfile()}"`,
				}),
			),
			os: Type.Optional(
				Type.String({
					description: `OS profile for fingerprinting. Default: "${DEFAULT_OS}"`,
				}),
			),
			proxy: Type.Optional(
				Type.String({
					description:
						"Proxy URL (e.g. http://user:pass@host:port or socks5://host:port)",
				}),
			),
			cacheTtlSeconds: Type.Optional(
				Type.Number({
					description: "Opt-in cache TTL in seconds. Omit for fresh fetches.",
				}),
			),
			compile: Type.Optional(
				Type.Boolean({
					description: "Compile batch results into a single context package.",
				}),
			),
			prune: Type.Optional(
				Type.Number({
					description: "Prune markdown to token budget (e.g. 3000).",
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"Relevance query for answer mode or query-aware pruning. When set without `prune`, activates answer mode: the page is chunked and only the top-k most relevant chunks (scored by BM25) are returned — ordered by document position with heading breadcrumbs. The full content is still cached so aio-webcontent can retrieve it by URL. When used with `prune`, keeps sections most relevant to this query during pruning.",
				}),
			),
			topChunks: Type.Optional(
				Type.Number({
					description:
						"Maximum number of top-scoring chunks to return in answer mode (query set, prune absent). Default 5. Min 1.",
					minimum: 1,
				}),
			),
			interactive: Type.Optional(
				Type.Boolean({
					description: "Extract interactive elements as numbered refs.",
				}),
			),
			start_index: Type.Optional(
				Type.Number({
					description:
						"Return content starting from this character index (0-based). Use with max_length for pagination.",
				}),
			),
			max_length: Type.Optional(
				Type.Number({
					description:
						"Maximum characters to return (default: unlimited). Use with start_index for pagination.",
				}),
			),
			bypass: Type.Optional(
				Type.Boolean({
					description:
						"Enable paywall bypass. If the fetched content looks paywalled, retry using a chain of strategies (Googlebot UA, archive.org Wayback, Playwright with paywall JS blocked) until one succeeds. Falls back gracefully if no strategy works.",
				}),
			),
			bypassStrategies: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Override the bypass strategy chain. Valid values: 'ua:googlebot', 'ua:bingbot', 'ua:facebookbot', 'referer:google', 'block_js', 'archive', 'archive_first', 'cookies'. Default is site-specific.",
				}),
			),
			format: Type.Optional(
				Type.String({
					description: `Output format. Default: "markdown". Use "html" for raw HTML, "text" for plain text extraction, "json" for structured metadata + body, "raw" for the full HTTP response object.`,
					default: "markdown",
				}),
			),
			chunks: Type.Optional(
				Type.Boolean({
					description:
						"Return paragraph-bounded chunks alongside the full markdown. Useful for RAG workflows. Only applies to format: markdown (other formats return in-memory body; chunk those yourself).",
				}),
			),
			maxTokens: Type.Optional(
				Type.Number({
					description:
						"Max tokens per chunk. Default 512. Only used when chunks: true. Min 1.",
					minimum: 1,
				}),
			),
			overlapTokens: Type.Optional(
				Type.Number({
					description:
						"Tokens of tail-overlap from the previous chunk prepended to each chunk after the first. Default 50. Only used when chunks: true. Min 0.",
					minimum: 0,
				}),
			),
			budgetTokens: Type.Optional(
				Type.Number({
					description:
						"Hard token budget for the content returned to the agent. When set, the output is guaranteed to fit within this many tokens — heading structure is preserved, lowest-value sections are dropped first (BM25-scored when query is also set), and a footer notes how many sections were omitted. Composes with query answer mode: the budget is applied to the answer-mode output. Full content is always cached before trimming. Min 100.",
					minimum: 100,
				}),
			),
			diff: Type.Optional(
				Type.Boolean({
					description:
						"When true and a previous version of the URL is cached, fetch fresh content and return a section-level diff (added/changed/removed sections by heading) instead of the full page. If content is unchanged (including a 304 Not Modified response), reports 'unchanged since <time>, 0 changes'. When nothing is cached, falls back to a normal full fetch with a note that no baseline exists. The new content replaces the cache so the next diff is against this fetch.",
				}),
			),
		}),

		async execute(
			_toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			onUpdate: ((update: any) => void) | undefined,
			_ctx: any,
		): Promise<any> {
			// Per-execution chunking error tracker (avoids module-level
			// state contamination across concurrent requests).
			const chunkingErrors: string[] = [];
			const targets: string[] = params.urls ?? (params.url ? [params.url] : []);
			if (!targets.length) {
				throw new Error("Provide either 'url' or 'urls'");
			}

			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const proxy = (params.proxy as string) ?? undefined;

			// ── TUI progress tracking ─────────────────────────────────────
			// `details` is mutated in place; the renderer reads it via closure
			// when `onUpdate` fires. Spinner ticks re-emit the same details with
			// an incremented spinnerTick so the animation actually moves.
			const details: WebfetchDetails = {
				total: targets.length,
				completed: 0,
				succeeded: 0,
				failed: 0,
				items: targets.map((u: string, i: number) => ({
					index: i,
					url: u,
					status: "queued",
					progress: 0,
				})),
				url: targets[0],
				status: "connecting",
				progress: 0,
				spinnerTick: 0,
				format: "markdown",
			};

			let spinnerTimer: ReturnType<typeof setInterval> | null = null;
			if (onUpdate) {
				spinnerTimer = setInterval(() => {
					if (details.status === "done" || details.status === "error") {
						return;
					}
					details.spinnerTick = (details.spinnerTick ?? 0) + 1;
					onUpdate({
						content: [
							{ type: "text", text: `Fetching ${details.url ?? "URL"}…` },
						],
						details: { ...details },
					});
				}, SPINNER_INTERVAL_MS);
				// .unref() so the interval doesn't keep the event loop alive
				// when the tool returns (e.g. one-shot `pi -p` invocations).
				spinnerTimer.unref?.();
			}

			function updateItem(
				index: number,
				updates: Partial<FetchItemProgress>,
			): void {
				if (!details.items) return;
				const item = details.items[index];
				if (!item) return;
				Object.assign(item, updates);
				details.completed = details.items.filter(
					(it) => it.status === "done" || it.status === "error",
				).length;
				details.succeeded = details.items.filter(
					(it) => it.status === "done",
				).length;
				details.failed = details.items.filter(
					(it) => it.status === "error",
				).length;
				onUpdate?.({
					content: [
						{ type: "text", text: `Fetching ${details.url ?? "URL"}…` },
					],
					details: { ...details },
				});
			}

			// Mark an item as errored with a summary message + wall-clock
			// elapsed time. Centralized so the three error sites (URL
			// parse, pullPageEnhanced, single-URL outer) stay in sync.
			function markItemError(
				index: number,
				summary: string,
				startedAt: number,
			): void {
				updateItem(index, {
					status: "error",
					progress: 1,
					error: summary,
					elapsedMs: Date.now() - startedAt,
				});
			}

			// ── Validators for legacy → new error mapping ──────────────────
			const VALID_FETCH_ERROR_CODES: Set<string> = new Set([
				"invalid_url",
				"private_ip",
				"blocked_secret",
				"redirect_loop",
				"dns_error",
				"connect_error",
				"tls_error",
				"aborted",
				"timeout",
				"rate_limited",
				"http_error",
				"not_found",
				"auth_required",
				"download_error",
				"empty_body",
				"binary_content",
				"checksum_mismatch",
				"parse_error",
				"encoding_error",
				"out_of_memory",
				"blocked",
				"paywall",
				"bot_detected",
				"no_content",
				"unknown",
			]);
			const VALID_FETCH_PHASES: Set<string> = new Set([
				"validation",
				"connecting",
				"tls",
				"waiting",
				"headers",
				"downloading",
				"processing",
				"rendering",
				"writing",
				"finished",
			]);
			function asFetchErrorCode(s: string | undefined): FetchErrorCode {
				return s && VALID_FETCH_ERROR_CODES.has(s)
					? (s as FetchErrorCode)
					: ("unknown" as FetchErrorCode);
			}
			function asFetchPhase(s: string | undefined): FetchPhase {
				return s && VALID_FETCH_PHASES.has(s)
					? (s as FetchPhase)
					: ("downloading" as FetchPhase);
			}

			// Build a minimal FetchError from a legacy FetchErrorInfo shape.
			function legacyToFetchError(
				legacy:
					| {
							code?: string;
							phase?: string;
							message?: string;
							retryable?: boolean;
							statusCode?: number;
					  }
					| undefined,
				url: string,
				elapsedMs?: number,
			): FetchError | null {
				if (!legacy) return null;
				return createFetchError(
					asFetchErrorCode(legacy.code),
					legacy.message ?? "Fetch failed",
					{
						url,
						phase: asFetchPhase(legacy.phase),
						statusCode: legacy.statusCode,
						elapsedMs,
					},
					{ retryable: legacy.retryable },
				);
			}

			function userErrorSummaryFor(err: {
				error?: string;
				code?: string;
				phase?: string;
				statusCode?: number;
				fetchError?: FetchError;
				url?: string;
			}): string {
				// If the upstream pullPage already built a rich FetchError, use it.
				if (err.fetchError && isFetchError(err.fetchError)) {
					return buildUserFacingFetchErrorSummary(err.fetchError);
				}
				// Otherwise, build a minimal FetchError from the legacy fields.
				const fe =
					legacyToFetchError(err, err.url ?? "unknown") ??
					createFetchError("unknown", err.error ?? "Fetch failed", {
						url: err.url ?? "unknown",
						phase: "downloading",
						statusCode: err.statusCode,
					});
				return buildUserFacingFetchErrorSummary(fe);
			}

			let wreqSession: any = null;
			if (targets.length > 1) {
				try {
					const { createSession } = await import("wreq-js");
					wreqSession = await createSession({
						browser: browser as any,
						os: os as any,
						...(proxy ? { proxy } : {}),
					});
				} catch {
					/* session creation failed — fall back to isolated fetches */
				}
			}

			const singleStartedAt = Date.now();
			const results = await (async () => {
				try {
					return await runInBatches(
						targets,
						Math.min(4, targets.length),
						async (raw, idx) => {
							const startedAt = Date.now();
							updateItem(idx, { status: "fetching", progress: 0.1 });

							let urlStr = raw;
							if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;

							let url: URL;
							try {
								url = new URL(urlStr);
							} catch {
								const fe = createFetchError("invalid_url", `Bad URL: ${raw}`, {
									url: raw,
									phase: "validation",
								});
								markItemError(
									idx,
									buildUserFacingFetchErrorSummary(fe),
									startedAt,
								);
								return {
									ok: false,
									error: fe.message,
									url: raw,
									fetchError: fe,
								};
							}

							let outFile: string;
							if (targets.length === 1 && params.out) {
								outFile = safeResolveInBaseTemp(params.out);
							} else {
								const name =
									url.pathname.replace(/^\//, "").replace(/\//g, "-") ||
									"index";
								outFile = join(BASE_TEMP, url.hostname, `${name}.md`);
							}

							const mode = (params.mode as ScrapeMode) ?? "auto";
							const interactive = params.interactive === true;
							const pruneTokens = params.prune as number | undefined;
							const pruneQuery = params.query as string | undefined;
							const startIndex = params.start_index as number | undefined;
							const maxLength = params.max_length as number | undefined;
							const bypass = params.bypass === true;
							const bypassStrategies = params.bypassStrategies as
								| string[]
								| undefined;
							const diffMode = params.diff === true;

							// ── HTTP revalidation (issue #46) ─────────────────────────
							// When the session-cache entry is present but TTL-expired and
							// has stored validators (ETag/Last-Modified), send a
							// conditional request before falling through to pullPageEnhanced.
							// 304 → refresh TTL, serve cached entry, skip re-extraction.
							// 200 → proceed as normal fresh fetch (validators updated below).
							// Only applies to the plain/wreq rung (mode !== "browser") so we
							// don't try to send HTTP headers via Playwright.
							let notModifiedResult: {
								ok: true;
								url: string;
								title?: string;
								content: string;
								fromCache: true;
								notModified: true;
								cachedAt: number;
							} | null = null;

							if (mode !== "browser") {
								const cachedEntry = getStoredContent(url.href);
								// getStoredContent returns null when TTL is still fresh
								// (entry served directly from cache by the caller) OR when
								// it doesn't exist. We need the raw Map lookup to detect
								// expired-but-present entries; getStoredContent already
								// deleted the key if expired, so we check before expiry.
								// Re-look: peek without the TTL filter.
								const rawEntry = peekStoredContent(url.href);

								if (
									rawEntry &&
									isExpiredEntry(rawEntry) &&
									hasValidators(rawEntry)
								) {
									// Entry is expired but has validators — attempt revalidation.
									const condHeaders = buildConditionalHeaders(rawEntry);
									const revalRes = await smartFetch(url.href, {
										browser,
										os,
										proxy,
										wreqSession,
										headers: condHeaders,
									});
									if (revalRes && revalRes.status === 304) {
										// Server confirmed content unchanged.
										const newValidators = extractValidators(revalRes.headers);
										refreshEntryOnNotModified(url.href, newValidators);
										// Re-fetch the entry (TTL is now fresh again).
										const refreshed = getStoredContent(url.href);
										if (refreshed && refreshed.content) {
											notModifiedResult = {
												ok: true,
												url: url.href,
												title: refreshed.title,
												content: refreshed.content,
												fromCache: true,
												notModified: true,
												cachedAt: refreshed.timestamp,
											};
										}
									}
									// On 200 or other: fall through to normal pullPageEnhanced below.
								}
							}

							updateItem(idx, { status: "loading", progress: 0.4 });

							// ── Diff mode early-exit on 304 (issue #45 + #46 synergy) ──
							if (notModifiedResult && diffMode) {
								const cachedDate = new Date(notModifiedResult.cachedAt).toISOString();
								const diffText = `Unchanged since ${cachedDate}, 0 changes (304 Not Modified — server confirmed content identical).`;
								updateItem(idx, {
									status: "done",
									progress: 1,
									elapsedMs: Date.now() - startedAt,
								});
								const responseId = await storeResult(
									notModifiedResult.url,
									notModifiedResult.content,
									"webfetch",
									{ title: notModifiedResult.title },
								);
								return {
									ok: true,
									url: notModifiedResult.url,
									title: notModifiedResult.title,
									outPath: undefined,
									length: diffText.length,
									responseId,
									body: diffText,
									format: "markdown",
									savedToDisk: false,
									diffResult: diffText,
								};
							}

							// ── Serve from 304 cache (no diff mode) ─────────────────────
							if (notModifiedResult && !diffMode) {
								updateItem(idx, {
									status: "done",
									progress: 1,
									elapsedMs: Date.now() - startedAt,
								});
								const responseId = await storeResult(
									notModifiedResult.url,
									notModifiedResult.content,
									"webfetch",
									{ title: notModifiedResult.title },
								);
								return {
									ok: true,
									url: notModifiedResult.url,
									title: notModifiedResult.title,
									outPath: undefined,
									length: notModifiedResult.content.length,
									responseId,
									body: notModifiedResult.content,
									format: "markdown",
									savedToDisk: false,
								};
							}

							// ── Capture old content for diff (issue #45) ─────────────────
							// Before the fresh fetch, record current cached content if
							// diff mode is on and there is a baseline.
							let diffBaseline: string | null = null;
							let diffBaselineTimestamp: number | null = null;
							if (diffMode) {
								// Try fresh from cache (non-expired entry).
								const existing = getStoredContent(url.href);
								if (existing && existing.content) {
									diffBaseline = existing.content;
									diffBaselineTimestamp = existing.timestamp;
								} else {
									// Check raw map for expired entries too (we want to diff
									// even if cache expired — new content replaces it below).
									const raw = peekStoredContent(url.href);
									if (raw && raw.content) {
										diffBaseline = raw.content;
										diffBaselineTimestamp = raw.timestamp;
									}
								}
							}

							let result = await pullPageEnhanced(url.href, {
								browser,
								os,
								proxy,
								mode,
								wreqSession,
								bypass,
								bypassStrategies: bypassStrategies as any,
							});
							if (!result.ok) {
								const shouldRetryBrowser =
									mode !== "browser" &&
									(result.errorInfo?.retryable ||
										result.errorInfo?.code === "blocked");
								if (shouldRetryBrowser) {
									updateItem(idx, { status: "loading", progress: 0.65 });
									const browserResult = await pullPageEnhanced(url.href, {
										browser,
										os,
										proxy,
										mode: "browser",
										wreqSession,
									});
									if (browserResult.ok) {
										result = browserResult;
									}
								}
							}
							if (!result.ok) {
								const errInfo = result.errorInfo;
								// Prefer the rich FetchError that pullPage already built —
								// it carries downloadedBytes / contentLength / elapsedMs
								// for a smarter suggested-retry-timeout. Fall back to
								// lifting the legacy errorInfo for paths that don't
								// produce a fetchError (e.g. paywall-403 short-circuits).
								const fetchErr: FetchError | null =
									result.fetchError ??
									legacyToFetchError(errInfo, url.href, Date.now() - startedAt);
								const userErrorSummary = fetchErr
									? buildUserFacingFetchErrorSummary(fetchErr)
									: (result.error ?? "Fetch failed");
								const suggestedTimeoutMs = fetchErr
									? suggestRetryTimeoutMs(fetchErr)
									: undefined;
								markItemError(idx, userErrorSummary, startedAt);
								return {
									ok: false,
									error: result.error ?? "Fetch failed",
									errorInfo: errInfo,
									userErrorSummary,
									fetchError: fetchErr ?? undefined,
									suggestedTimeoutMs,
									url: url.href,
								};
							}
							updateItem(idx, { status: "processing", progress: 0.85 });

							let contentBody = result.content ?? "";

							if (interactive && result.rawHtml) {
								const interactables = extractInteractables(result.rawHtml);
								const actionsSection =
									formatInteractablesSection(interactables);
								if (actionsSection) {
									contentBody = actionsSection + "\n" + contentBody;
								}
							}

							const totalChars = contentBody.length;

							if (startIndex !== undefined || maxLength !== undefined) {
								const si = startIndex ?? 0;
								const ml =
									maxLength !== undefined && maxLength > 0
										? maxLength
										: totalChars - si;
								const end = Math.min(si + ml, totalChars);
								if (si < totalChars) {
									contentBody = contentBody.slice(si, end);
									contentBody += `\n\n_(chars ${si + 1}-${end} of ${totalChars} total)_`;
								} else {
									contentBody = `_(start_index ${si} exceeds content length ${totalChars})_`;
								}
							}

							const tokenCount = estimateTokens(contentBody);

							if (pruneTokens && pruneTokens > 0 && tokenCount > pruneTokens) {
								const pruned = pruneMarkdown(contentBody, {
									maxTokens: pruneTokens,
									query: pruneQuery,
								});
								contentBody = pruned.content;
							}

							const markdown =
								frontmatter(result.title || url.pathname, result.url!, {
									author: result.author,
									published: result.published,
									site: result.site,
									language: result.language,
									wordCount: result.wordCount,
								}) + contentBody;

							// Apply the `format` parameter to the markdown result.
							// `markdown` saves to disk; all other formats stay
							// in-memory (raw HTML / text / JSON / raw).
							const formatParam = params.format as string | undefined;
							const formatted = applyFormat(
								result as Extract<typeof result, { ok: true }>,
								formatParam,
								markdown,
							);

							// Only the markdown format writes to disk; the others
							// return the body inline (e.g. for piping into another
							// tool, or for JSON consumers that need a structured
							// object).
							let outPath: string | undefined;
							if (formatted.savedToDisk) {
								outPath = resolve(outFile);
								await mkdir(dirname(outPath), { recursive: true });
								await writeFile(outPath, formatted.body, "utf8");
								storeContent(
									result.url!,
									result.title,
									formatted.body,
									undefined,
									{
										author: result.author,
										published: result.published,
										site: result.site,
										language: result.language,
										wordCount: result.wordCount,
									},
								);
								// Drain HTTP validators captured by pullPage's internal
								// smartFetch call via the side channel in http-validators.ts
								// and persist them with the session-cache entry (issue #46).
								const captured = drainCapturedValidators(result.url!);
								if (captured) {
									attachValidators(result.url!, captured);
								}
							} else if (formatted.format === "markdown") {
								// Non-disk markdown (e.g. when savedToDisk is false but format
								// is still markdown): store in session cache for diff baseline.
								storeContent(
									result.url!,
									result.title,
									formatted.body,
									undefined,
									{
										author: result.author,
										published: result.published,
										site: result.site,
										language: result.language,
										wordCount: result.wordCount,
									},
								);
								const capturedNonDisk = drainCapturedValidators(result.url!);
								if (capturedNonDisk) {
									attachValidators(result.url!, capturedNonDisk);
								}
							}

							const responseId = await storeResult(
								result.url!,
								formatted.body,
								"webfetch",
								{
									title: result.title || url.pathname,
									ttlSeconds: params.cacheTtlSeconds,
									meta: {
										format: formatted.format,
										savedToDisk: formatted.savedToDisk,
									},
								},
							);

							// ── Diff mode return (issue #45) ──────────────────────────────
							if (diffMode && formatted.format === "markdown") {
								let diffText: string;
								if (diffBaseline === null) {
									diffText = `No baseline cached for ${result.url!} — fetched fresh content (${formatted.body.length} chars). Diff will be available on the next call.`;
								} else {
									const dr = diffContent(diffBaseline, formatted.body);
									if (dr.unchanged) {
										const baseDate = diffBaselineTimestamp
											? new Date(diffBaselineTimestamp).toISOString()
											: "unknown";
										diffText = `Unchanged since ${baseDate}, 0 changes.`;
									} else {
										const baseDate = diffBaselineTimestamp
											? new Date(diffBaselineTimestamp).toISOString()
											: "unknown";
										diffText = `Changes vs cached version from ${baseDate}:\n\n${dr.summary}`;
									}
								}
								return {
									ok: true,
									url: result.url!,
									title: result.title || url.pathname,
									outPath,
									length: diffText.length,
									responseId,
									body: diffText,
									format: "markdown",
									savedToDisk: formatted.savedToDisk,
									diffResult: diffText,
								};
							}

							return {
								ok: true,
								url: result.url!,
								title: result.title || url.pathname,
								outPath,
								length: formatted.contentLength,
								responseId,
								body: formatted.body,
								format: formatted.format,
								savedToDisk: formatted.savedToDisk,
							};
						},
					);
				} catch (thrown) {
					// Worker threw (e.g. unexpected Error in pipeline). Convert to a
					// single-element PullResult with a phase-aware FetchError.
					const thrownUrl = (() => {
						try {
							return new URL(targets[0] as string).href;
						} catch {
							return String(targets[0] ?? "unknown");
						}
					})();
					const isFE = isFetchError(thrown);
					const fe: FetchError = isFE
						? thrown
						: classifyError(thrown, { url: thrownUrl });
					const userErrorSummary = buildUserFacingFetchErrorSummary(fe);
					updateItem(0, {
						status: "error",
						progress: 1,
						error: userErrorSummary,
					});
					return [
						{
							ok: false,
							error: fe.message,
							errorInfo: fetchErrorInfoFromUnknown(thrown, { url: thrownUrl }),
							userErrorSummary,
							fetchError: fe,
							suggestedTimeoutMs: suggestRetryTimeoutMs(fe),
							url: thrownUrl,
						},
					];
				}
			})();

			try {
				if (wreqSession) {
					try {
						await wreqSession.close();
					} catch {
						/* best-effort */
					}
				}

				const okResults = results.filter((r) => r.ok);
				const errResults = results.filter((r) => !r.ok);

				if (targets.length === 1) {
					const r = results[0]!;
					if (!r.ok) {
						const errInfo = (r as any).errorInfo;
						// Prefer the precomputed userErrorSummary from the batch
						// callback; fall back to deriving it from the legacy fields.
						const summary =
							(r as any).userErrorSummary ??
							userErrorSummaryFor({
								error: r.error,
								code: errInfo?.code,
								phase: errInfo?.phase,
								statusCode: errInfo?.statusCode,
								fetchError: (r as any).fetchError,
								url: r.url,
							});
						markItemError(0, summary, singleStartedAt);
						const fe = (r as any).fetchError as FetchError | undefined;
						const fetchErrForAgent = (r as any).fetchError as
							| FetchError
							| undefined;
						const tags = fetchErrForAgent
							? `phase=${fetchErrForAgent.phase} code=${fetchErrForAgent.code} ` +
								`category=${fetchErrForAgent.category} ` +
								`retryable=${fetchErrForAgent.retryable}` +
								(fetchErrForAgent.statusCode
									? ` http=${fetchErrForAgent.statusCode}`
									: "")
							: "";
						const agentText = tags
							? `✗ Failed to fetch ${r.url}\n${summary}\n[${tags}]\n${r.error ?? ""}`
							: `✗ Failed to fetch ${r.url}\n\n${summary}\n${r.error ?? ""}`;
						return {
							content: [
								{
									type: "text",
									text: agentText.trim(),
								},
							],
							details: {
								url: r.url,
								status: "error",
								progress: 1,
								spinnerTick: details.spinnerTick,
								errorText: r.error,
								userErrorSummary: summary,
								suggestedTimeoutMs: (r as any).suggestedTimeoutMs,
								errorPhase: fe?.phase,
								errorCategory: fe?.category,
								errorRetryable: fe?.retryable,
								items: details.items,
							},
						};
					}
					updateItem(0, {
						status: "done",
						progress: 1,
						elapsedMs: Date.now() - singleStartedAt,
					});
					// Use the in-memory body for the preview, not a disk read.
					// Markdown and non-markdown formats both populate `r.body`,
					// so this works regardless of whether the result was saved
					// to disk. For non-markdown (html/text/json/raw), `outPath`
					// is undefined and a readFile would throw.
					const preview = r.body ?? "";

					let summary: string | null = null;
					let summarized = false;
					const isGitHubUrl = (() => {
						if (!r.url) return false;
						try {
							const host = new URL(r.url).hostname;
							return (
								host === "github.com" ||
								host === "raw.githubusercontent.com" ||
								host === "gist.github.com" ||
								host.endsWith(".github.com") ||
								host.endsWith(".raw.githubusercontent.com") ||
								host.endsWith(".gist.github.com")
							);
						} catch {
							return false;
						}
					})();
					const skipSummary = isGitHubUrl || preview.includes("> via ");

					const searchCtx = getSearchContext()?.query;
					// Only inject the prior search query into the summary prompt
					// when it is actually related to this page (relatedness gate).
					// Otherwise an unrelated query would bias the summary.
					const pageHeading = preview
						.split("\n")
						.find((l) => /^#{1,6}\s/.test(l))
						?.replace(/^#{1,6}\s*/, "");
					const injectSearchCtx =
						!!searchCtx &&
						shouldInjectSearchContext(searchCtx, {
							url: r.url as string | undefined,
							title: r.title,
							heading: pageHeading,
						});

					const isShort = preview.length <= MAX_PREVIEW_CHARS;
					if (!skipSummary && !isShort && cdpAvailableGA()) {
						const cacheKey = summaryCacheKey(
							r.url as string,
							injectSearchCtx ? searchCtx : undefined,
						);
						const cached = summaryCache.get(cacheKey);
						if (cached) {
							summary = cached;
							summarized = true;
						} else {
							try {
								await ensureChrome();
								summary = await summarizeUrl(r.url as string, {
									timeoutMs: 15000,
									context: injectSearchCtx ? searchCtx : undefined,
								});
								if (summary) {
									// Annotate focused summaries so downstream agents
									// know the summary is not neutral. Cached with the
									// annotation so re-serves are consistent.
									if (injectSearchCtx) {
										summary += focusedSummaryAnnotation(searchCtx as string);
									}
									summarized = true;
									summaryCache.set(cacheKey, summary);
								}
							} catch {
								summary = buildDeterministicSummary(preview);
								if (summary) {
									summarized = true;
								}
							}
						}
					}

					const itemFormat = (r as any).format ?? "markdown";
					const responseId = (r as any).responseId as string | undefined;
					let summaryNotice: string;
					let displayContent: string;

					// ── Answer mode ──────────────────────────────────────────────
					// When `query` is set without `prune`, return only the top-k
					// most relevant chunks scored by BM25. Full content is already
					// stored above; only the agent-visible display is narrowed.
					const answerModeQuery = params.query as string | undefined;
					const answerModePrune = params.prune as number | undefined;
					const answerModeActive =
						!!answerModeQuery && !answerModePrune && itemFormat === "markdown";
					if (answerModeActive) {
						const topK = (params.topChunks as number | undefined) ?? DEFAULT_TOP_CHUNKS;
						const answerBody = applyQueryAnswerMode(
							(r as any).body ?? preview,
							answerModeQuery!,
							topK,
							{
								maxTokens: params.maxTokens as number | undefined,
								overlapTokens: params.overlapTokens as number | undefined,
							},
						);
						if (answerBody !== undefined) {
							summaryNotice = r.outPath
								? `\n[Answer mode: top ${topK} chunks for "${answerModeQuery}". Full content (${preview.length} chars) saved to ${r.outPath}.]`
								: `\n[Answer mode: top ${topK} chunks for "${answerModeQuery}". Full content cached (result ID ${responseId ?? "unavailable"}).]`;
							// Apply hard token budget after answer mode (composes cleanly).
							const budgetTokens = params.budgetTokens as number | undefined;
							displayContent = budgetTokens
								? applyTokenBudget(answerBody, budgetTokens, answerModeQuery, r.url as string | undefined)
								: answerBody;
							// Skip the normal summarize/truncate path.
							const formatLabel =
								`✓ Fetched and saved to ${r.outPath}${summaryNotice}`;
							const chunks =
								maybeChunkMarkdown((r as any).body, params, chunkingErrors);
							const chunkFmt = formatChunksText(
								chunks,
								params.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
							);
							const text = [
								formatLabel,
								`\nTitle: ${r.title}`,
								`URL: ${r.url}`,
								`Format: ${itemFormat}`,
								`Response ID: ${responseId}`,
								chunkFmt.header ? `\n${chunkFmt.header}` : "",
								"\n---\n",
								displayContent,
								chunkFmt.body
									? ["\n\n---\n", `## Chunks (${chunks!.length})\n`, chunkFmt.body].join("\n")
									: "",
								chunkingErrors.length > 0
									? `\n\n[WARN] Chunking failed: ${chunkingErrors.join("; ")}`
									: "",
							].join("\n");
							return {
								content: [{ type: "text", text }],
								details: {
									outPath: r.outPath,
									title: r.title,
									url: r.url,
									responseId,
									browser,
									os,
									proxy,
									truncated: false,
									summarized: false,
									fullLength: preview.length,
									status: "done",
									progress: 1,
									spinnerTick: details.spinnerTick,
									content: displayContent,
									format: itemFormat,
									chunks,
									items: details.items,
								},
							};
						}
					}

					const compactJsonPreview = !summarized
						? buildCompactJsonPreview(preview, {
								outPath: r.outPath,
								responseId,
								length: preview.length,
							})
						: null;

					if (compactJsonPreview && !isShort) {
						summaryNotice = "";
						displayContent = compactJsonPreview;
					} else if (summarized && summary) {
						summaryNotice = r.outPath
							? `\n[AI-summarized by Google AI. Full content (${preview.length} chars) saved to ${r.outPath}. Use the read tool for full text.]`
							: `\n[AI-summarized by Google AI. Full content (${preview.length} chars, result ID ${responseId ?? "unavailable"}).]`;
						displayContent = summary;
					} else if (isShort) {
						summaryNotice = "";
						displayContent = preview;
					} else {
						summaryNotice = r.outPath
							? `\n[Preview truncated: ${preview.length} chars total, ${MAX_PREVIEW_CHARS} chars shown. Use the read tool for full content.]`
							: `\n[Preview truncated: ${preview.length} chars total, ${MAX_PREVIEW_CHARS} chars shown. Full result ID: ${responseId ?? "unavailable"}.]`;
						displayContent = preview.slice(0, MAX_PREVIEW_CHARS);
					}

					// Apply hard token budget to the display content if requested.
					// Full content is already cached above — only the agent-visible
					// portion is narrowed here. Only applied to markdown format.
					const budgetTokens = params.budgetTokens as number | undefined;
					if (budgetTokens && itemFormat === "markdown") {
						displayContent = applyTokenBudget(
							displayContent,
							budgetTokens,
							params.query as string | undefined,
							r.url as string | undefined,
						);
					}

					// For non-markdown formats, the content is in the response-id cache
					// rather than written as a markdown file. Show a different header.
					const formatLabel =
						itemFormat === "markdown"
							? `✓ Fetched and saved to ${r.outPath}${summaryNotice}`
							: `✓ Fetched as ${itemFormat} (${preview.length} chars, result ID ${responseId ?? "unavailable"})${summaryNotice}`;

					// Compute RAG chunks if requested. Only meaningful for
					// format: markdown (other formats are in-memory; caller
					// can chunk them themselves).
					const chunks =
						itemFormat === "markdown"
							? maybeChunkMarkdown((r as any).body, params, chunkingErrors)
							: undefined;
					const chunkFmt = formatChunksText(
						chunks,
						params.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
					);

					const text = [
						formatLabel,
						`\nTitle: ${r.title}`,
						`URL: ${r.url}`,
						`Format: ${itemFormat}`,
						`Response ID: ${responseId}`,
						chunkFmt.header ? `\n${chunkFmt.header}` : "",
						"\n---\n",
						displayContent,
						chunkFmt.body
							? [
									"\n\n---\n",
									`## Chunks (${chunks!.length})\n`,
									chunkFmt.body,
								].join("\n")
							: "",
						chunkingErrors.length > 0
							? `\n\n[WARN] Chunking failed: ${chunkingErrors.join("; ")}`
							: "",
					].join("\n");

					return {
						content: [{ type: "text", text }],
						details: {
							outPath: r.outPath,
							title: r.title,
							url: r.url,
							responseId,
							browser,
							os,
							proxy,
							truncated: !summarized && !isShort,
							summarized,
							fullLength: preview.length,
							summaryLength: summary?.length,
							status: "done",
							progress: 1,
							spinnerTick: details.spinnerTick,
							// The TUI details payload is for rendering only. Keep it aligned
							// with the agent-visible preview/summary instead of leaking the
							// full in-memory body when the result is marked truncated.
							content: displayContent,
							format: itemFormat,
							chunks,
							items: details.items,
						},
					};
				}

				let packagePath: string | undefined;
				// compile only makes sense for markdown (which is saved to disk).
				// For html/text/json/raw the body is in-memory.
				const allMarkdown = okResults.every(
					(r) => ((r as any).format ?? "markdown") === "markdown",
				);
				if (params.compile && okResults.length > 0 && allMarkdown) {
					const pages = await Promise.all(
						okResults.map(async (r) => {
							const content = await readFile(r.outPath!, "utf8");
							return {
								url: r.url,
								title: r.title || r.url,
								content,
								relPath: r.outPath!.replace(BASE_TEMP, "").replace(/^\\/, ""),
							};
						}),
					);
					const pkg = await compileContextPackage(
						pages,
						join(BASE_TEMP, "packages"),
						{
							packageName: `webfetch-${Date.now()}`,
						},
					);
					packagePath = pkg.packagePath;
				}

				// Compute RAG chunks for each markdown result, if requested.
				// Other formats are in-memory; caller can chunk them.
				// Use a local Map instead of mutating result objects to
				// keep the data flow explicit.
				const chunksByUrl = new Map<string, Chunk[]>();
				if (params.chunks) {
					for (const r of okResults) {
						const itemFormat = (r as any).format ?? "markdown";
						if (itemFormat === "markdown" && r.url) {
							const c = maybeChunkMarkdown(
								(r as any).body,
								params,
								chunkingErrors,
							);
							if (c) chunksByUrl.set(r.url, c);
						}
					}
				}

				const lines = [
					`Fetched ${okResults.length}/${targets.length} URLs:`,
					packagePath ? `\n📦 Compiled package: ${packagePath}` : "",
					"",
					...okResults.map((r) => {
						const itemFormat = (r as any).format ?? "markdown";
						const dest = r.outPath
							? `→ ${r.outPath} (${r.length} chars)`
							: `→ ${itemFormat} (${r.length} chars, in-memory)`;
						const chunks = r.url ? chunksByUrl.get(r.url) : undefined;
						const chunkFmt = formatChunksText(
							chunks,
							params.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
							"  ",
						);
						return `✓ ${r.title} — ${r.url}\n  ${dest}${(r as any).responseId ? `\n  ID: ${(r as any).responseId}` : ""}${chunkFmt.header ? `\n${chunkFmt.header}` : ""}${chunkFmt.body}`;
					}),
					...(errResults.length
						? [
								"",
								"Errors:",
								...errResults.map((r) => {
									const code = (r as any).errorInfo?.code;
									const sc = (r as any).errorInfo?.statusCode;
									const tag = [code, sc ? `HTTP ${sc}` : null]
										.filter(Boolean)
										.join(", ");
									const suffix = tag ? ` [${tag}]` : "";
									return `✗ ${r.url}: ${r.error}${suffix}`;
								}),
							]
						: []),
					chunkingErrors.length > 0
						? [
								"",
								"[WARN] Chunking failed for some results:",
								...chunkingErrors.map((e) => `  - ${e}`),
							]
						: [],
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						results,
						browser,
						os,
						packagePath,
						status: okResults.length === targets.length ? "done" : "error",
						progress: 1,
						spinnerTick: details.spinnerTick,
						items: details.items,
						total: targets.length,
						completed: details.completed,
						succeeded: details.succeeded,
						failed: details.failed,
						format: "markdown",
						chunks: Object.fromEntries(chunksByUrl),
					},
				};
			} finally {
				if (spinnerTimer) clearInterval(spinnerTimer);
			}
		},

		renderCall(args: Record<string, unknown>, theme: any) {
			return createCallComponent(args, theme);
		},

		renderResult(
			result: any,
			options: { expanded: boolean; isPartial: boolean },
			theme: any,
		) {
			const details = (result?.details ?? {}) as WebfetchDetails;
			if (options.isPartial) {
				return createProgressComponent(details, theme);
			}
			return createResultComponent(details, options.expanded, theme);
		},
	});
}
