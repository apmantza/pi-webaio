import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_PREVIEW_CHARS, pullPageEnhanced } from "../content.ts";
import { compileContextPackage } from "../context-package.ts";
import { DEFAULT_OS, getLatestChromeProfile } from "../fetch.ts";
import {
	cdpAvailable as cdpAvailableGA,
	ensureChrome,
	summarizeUrl,
} from "../google-ai.ts";
import {
	extractInteractables,
	formatInteractablesSection,
} from "../interactive-elements.ts";
import { pruneMarkdown } from "../prune-markdown.ts";
import {
	BASE_TEMP,
	getSearchContext,
	normalizeCacheKey,
	storeContent,
	summaryCache,
} from "../session-store.ts";
import { storeResult } from "../storage.ts";
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

export function registerWebfetchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webfetch",
		label: "Web Fetch",
		description:
			"Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Detects PDFs, GitHub repos, and Next.js RSC. Long content is automatically summarized via Gemini AI; full content always saved to file.",
		promptSnippet:
			"aio-webfetch(url|urls, mode?, browser?, os?, proxy?, prune?, interactive?, bypass?, bypassStrategies?, compile?, out?, cacheTtlSeconds?, start_index?, max_length?, format?): fetch URL(s) with anti-bot TLS fingerprinting, defuddle extraction, and optional AI summary. Default `format=markdown` saves to disk; pass `format=html|text|json|raw` for an in-memory body. Use the read tool on the saved path for full text.",
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
		}),

		async execute(
			_toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			onUpdate: ((update: any) => void) | undefined,
			_ctx: any,
		): Promise<any> {
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
							const startIndex = params.start_index as number | undefined;
							const maxLength = params.max_length as number | undefined;
							const bypass = params.bypass === true;
							const bypassStrategies = params.bypassStrategies as
								| string[]
								| undefined;
							updateItem(idx, { status: "loading", progress: 0.4 });
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
								const pruned = pruneMarkdown(contentBody, pruneTokens);
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
							let responseId: string | undefined;
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
								responseId = await storeResult(
									result.url!,
									formatted.body,
									"webfetch",
									{
										title: result.title || url.pathname,
										ttlSeconds: params.cacheTtlSeconds,
									},
								);
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
					const preview: string = r.body ?? "";

					function buildDeterministicSummary(content: string): string {
						const lines = content.split("\n");
						const out = [];
						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed) continue;
							if (/^#{1,3}\s/.test(trimmed)) {
								out.push(trimmed);
								continue;
							}
							if (out.length > 0 && !/^#{1,3}\s/.test(out[out.length - 1])) {
								continue;
							}
							const firstSentence = trimmed.match(/^(.{20,120}?)[.!?](\s|$)/);
							if (firstSentence) {
								out.push(firstSentence[1] + ".");
							}
						}
						return out.join("\n\n").slice(0, MAX_PREVIEW_CHARS);
					}

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

					const isShort = preview.length <= MAX_PREVIEW_CHARS;
					if (!skipSummary && !isShort && cdpAvailableGA()) {
						const cacheKey = normalizeCacheKey(r.url as string);
						const cached = summaryCache.get(cacheKey);
						if (cached) {
							summary = cached;
							summarized = true;
						} else {
							try {
								await ensureChrome();
								summary = await summarizeUrl(r.url as string, {
									timeoutMs: 15000,
									context: searchCtx,
								});
								if (summary) {
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

					let summaryNotice: string;
					let displayContent: string;

					if (summarized && summary) {
						summaryNotice = r.outPath
							? `\n[AI-summarized by Google AI. Full content (${preview.length} chars) saved to ${r.outPath}. Use the read tool for full text.]`
							: `\n[AI-summarized by Google AI. Full content (${preview.length} chars, in-memory only).]`;
						displayContent = summary;
					} else if (isShort) {
						summaryNotice = "";
						displayContent = preview;
					} else {
						summaryNotice = `\n[Preview truncated: ${preview.length} chars total, ${MAX_PREVIEW_CHARS} chars shown. Use the read tool for full content.]`;
						displayContent = preview.slice(0, MAX_PREVIEW_CHARS);
					}

					// For non-markdown formats, the content is in `body` but
					// was not saved to disk. Show a different header.
					const itemFormat = (r as any).format ?? "markdown";
					const formatLabel =
						itemFormat === "markdown"
							? `✓ Fetched and saved to ${r.outPath}${summaryNotice}`
							: `✓ Fetched as ${itemFormat} (${preview.length} chars, in-memory only)${summaryNotice}`;

					const text = [
						formatLabel,
						`\nTitle: ${r.title}`,
						`URL: ${r.url}`,
						`Format: ${itemFormat}`,
						`Response ID: ${(r as any).responseId}`,
						"\n---\n",
						displayContent,
					].join("\n");

					return {
						content: [{ type: "text", text }],
						details: {
							outPath: r.outPath,
							title: r.title,
							url: r.url,
							responseId: (r as any).responseId,
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
							content: (r as any).body ?? "",
							format: itemFormat,
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

				const lines = [
					`Fetched ${okResults.length}/${targets.length} URLs:`,
					packagePath ? `\n📦 Compiled package: ${packagePath}` : "",
					"",
					...okResults.map((r) => {
						const itemFormat = (r as any).format ?? "markdown";
						const dest = r.outPath
							? `→ ${r.outPath} (${r.length} chars)`
							: `→ ${itemFormat} (${r.length} chars, in-memory)`;
						return `✓ ${r.title} — ${r.url}\n  ${dest}${(r as any).responseId ? `\n  ID: ${(r as any).responseId}` : ""}`;
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
