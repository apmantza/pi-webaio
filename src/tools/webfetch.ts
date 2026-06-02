import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLatestChromeProfile, DEFAULT_OS } from "../fetch.ts";
import { pullPageEnhanced, MAX_PREVIEW_CHARS } from "../content.ts";
import {
	extractInteractables,
	formatInteractablesSection,
} from "../interactive-elements.ts";
import { estimateTokens } from "../token-count.ts";
import { pruneMarkdown } from "../prune-markdown.ts";
import {
	normalizeCacheKey,
	getSearchContext,
	summaryCache,
	storeContent,
	BASE_TEMP,
} from "../session-store.ts";
import { storeResult } from "../storage.ts";
import { compileContextPackage } from "../context-package.ts";
import {
	ensureChrome,
	summarizeUrl,
	cdpAvailable as cdpAvailableGA,
} from "../google-ai.ts";
import type { ScrapeMode } from "../types.ts";
import { frontmatter, runInBatches } from "./utils.ts";

export function registerWebfetchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webfetch",
		label: "Web Fetch",
		description:
			"Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Detects PDFs, GitHub repos, and Next.js RSC. Long content is automatically summarized via Gemini AI; full content always saved to file.",
		promptSnippet: "Fetch a URL and convert to markdown",
		promptGuidelines: [
			"Use aio-webfetch when the user wants to retrieve specific webpage(s), article(s), or file(s).",
			"Use aio-webpull when the user wants to download an entire site or docs collection.",
			"After aio-webfetch completes, use the built-in read tool to inspect the generated markdown file(s).",
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
		}),

		async execute(_toolCallId: string, params: any): Promise<any> {
			const targets: string[] = params.urls ?? (params.url ? [params.url] : []);
			if (!targets.length) {
				throw new Error("Provide either 'url' or 'urls'");
			}

			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const proxy = (params.proxy as string) ?? undefined;

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

			const results = await runInBatches(
				targets,
				Math.min(4, targets.length),
				async (raw, _idx) => {
					let urlStr = raw;
					if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;

					let url: URL;
					try {
						url = new URL(urlStr);
					} catch {
						return {
							ok: false,
							error: `Bad URL: ${raw}`,
							url: raw,
						};
					}

					let outFile: string;
					if (targets.length === 1 && params.out) {
						outFile = resolve(BASE_TEMP, params.out);
					} else {
						const name =
							url.pathname.replace(/^\//, "").replace(/\//g, "-") || "index";
						outFile = join(BASE_TEMP, url.hostname, `${name}.md`);
					}
					const outPath = resolve(outFile);

					const mode = (params.mode as ScrapeMode) ?? "auto";
					const interactive = params.interactive === true;
					const pruneTokens = params.prune as number | undefined;
					const startIndex = params.start_index as number | undefined;
					const maxLength = params.max_length as number | undefined;
					const bypass = params.bypass === true;
					const bypassStrategies = params.bypassStrategies as
						| string[]
						| undefined;
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
						return {
							ok: false,
							error: result.error ?? "Fetch failed",
							errorInfo: result.errorInfo,
							url: url.href,
						};
					}

					let contentBody = result.content ?? "";

					if (interactive && result.rawHtml) {
						const interactables = extractInteractables(result.rawHtml);
						const actionsSection = formatInteractablesSection(interactables);
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

					await mkdir(dirname(outPath), { recursive: true });
					await writeFile(outPath, markdown, "utf8");

					storeContent(result.url!, result.title, markdown, undefined, {
						author: result.author,
						published: result.published,
						site: result.site,
						language: result.language,
						wordCount: result.wordCount,
					});

					const responseId = await storeResult(
						result.url!,
						markdown,
						"webfetch",
						{
							title: result.title || url.pathname,
							ttlSeconds: params.cacheTtlSeconds,
						},
					);

					return {
						ok: true,
						url: result.url!,
						title: result.title || url.pathname,
						outPath,
						length: markdown.length,
						responseId,
					};
				},
			);

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
				if (!r.ok) throw new Error(r.error ?? "Fetch failed");
				const preview = await readFile(r.outPath!, "utf8");

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
					summaryNotice = `\n[AI-summarized by Google AI. Full content (${preview.length} chars) saved to ${r.outPath}. Use the read tool for full text.]`;
					displayContent = summary;
				} else if (isShort) {
					summaryNotice = "";
					displayContent = preview;
				} else {
					summaryNotice = `\n[Preview truncated: ${preview.length} chars total, ${MAX_PREVIEW_CHARS} chars shown. Use the read tool for full content.]`;
					displayContent = preview.slice(0, MAX_PREVIEW_CHARS);
				}

				const text = [
					`✓ Fetched and saved to ${r.outPath}${summaryNotice}`,
					`\nTitle: ${r.title}`,
					`URL: ${r.url}`,
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
					},
				};
			}

			let packagePath: string | undefined;
			if (params.compile && okResults.length > 0) {
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
				...okResults.map(
					(r) =>
						`✓ ${r.title} — ${r.url}\n  → ${r.outPath} (${r.length} chars)${(r as any).responseId ? `\n  ID: ${(r as any).responseId}` : ""}`,
				),
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
				details: { results, browser, os, packagePath },
			};
		},
	});
}
