import { join, resolve } from "node:path";
import { cpus } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLatestChromeProfile, DEFAULT_OS } from "../fetch.ts";
import { pullPageEnhanced } from "../content.ts";
import { discover } from "../discovery.ts";
import { storeContent, BASE_TEMP } from "../session-store.ts";
import { compileContextPackage } from "../context-package.ts";
import { RequestQueue, hasQueueFile } from "../request-queue.ts";
import { BrowserPool } from "../browser-pool.ts";
import { SessionRouter, parseRoutes } from "../session-router.ts";
import type { FetchOpts, ScrapeMode, Page } from "../types.ts";
import {
	frontmatter,
	writePage,
	rewriteLinks,
	runPullFromQueue,
} from "./utils.ts";

export function registerWebpullTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webpull",
		label: "Webpull",
		description:
			"Pull any public website or docs site into local markdown files with anti-bot TLS fingerprinting. Discovers pages via sitemap, navigation links, or crawling. Writes files preserving URL structure with YAML frontmatter.",
		promptSnippet: "Pull an entire website into local markdown files",
		promptGuidelines: [
			"Use aio-websearch when the user wants to find information online. Returns compact search results.",
			"Use aio-webfetch when the user wants to download a specific URL or batch of URLs.",
			"After aio-webpull completes, use the built-in read tool to inspect the generated markdown files.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "URL to pull (e.g. https://docs.example.com)",
			}),
			out: Type.Optional(
				Type.String({
					description: "Output directory under temp (default: <hostname>)",
				}),
			),
			max: Type.Optional(
				Type.Number({
					description: "Max pages to pull (default: 100)",
					default: 100,
				}),
			),
			mode: Type.Optional(
				Type.String({
					description: `Scrape mode: "auto" (default), "fast", "fingerprint", or "browser". Auto escalates when bot protection is detected.`,
				}),
			),
			browser: Type.Optional(
				Type.String({
					description: `Browser profile for TLS fingerprinting. Default: "${getLatestChromeProfile()}". Examples: chrome_145, firefox_147, safari_26, edge_145`,
				}),
			),
			os: Type.Optional(
				Type.String({
					description: `OS profile for fingerprinting. Default: "${DEFAULT_OS}". Options: windows, macos, linux, android, ios`,
				}),
			),
			proxy: Type.Optional(
				Type.String({
					description:
						"Proxy URL (e.g. http://user:pass@host:port or socks5://host:port)",
				}),
			),
			compile: Type.Optional(
				Type.Boolean({
					description:
						"Compile pulled pages into a single context package after completion.",
				}),
			),
			resume: Type.Optional(
				Type.Boolean({
					description:
						"Resume a previous pull from the output directory (default: auto-detect). Set to false to force a fresh pull.",
				}),
			),
			routes: Type.Optional(
				Type.Array(
					Type.Object({
						pattern: Type.String({
							description:
								"URL pattern: path string, glob (*/docs/*), or regex (/^\\/api\\//)",
						}),
						mode: Type.Optional(
							Type.String({
								description:
									"Fetcher mode: fast, fingerprint, browser, or auto",
							}),
						),
						extractor: Type.Optional(
							Type.String({
								description:
									"Vertical extractor name (e.g. npm, pypi, wikipedia)",
							}),
						),
						browser: Type.Optional(
							Type.String({
								description: "Browser profile override for this route",
							}),
						),
						os: Type.Optional(
							Type.String({
								description: "OS profile override for this route",
							}),
						),
					}),
					{
						description:
							"Route definitions: URL pattern -> fetcher mode/extractor. Evaluated in order, first match wins.",
					},
				),
			),
			adaptive: Type.Optional(
				Type.Boolean({
					description:
						"Enable adaptive content selector — remembers element structure to survive site redesigns (default: false)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			let raw = params.url;
			if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new Error(`Bad URL: ${params.url}`);
			}

			const outDir = params.out
				? resolve(BASE_TEMP, params.out)
				: join(BASE_TEMP, url.hostname);
			const max = params.max ?? 100;
			const concurrency = Math.max(4, cpus().length * 2);
			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const proxy = (params.proxy as string) ?? undefined;
			const mode = (params.mode as ScrapeMode) ?? "auto";
			const compile = (params.compile as boolean) ?? false;
			const resume = params.resume !== false;
			const routes = (params.routes ?? []) as {
				pattern: string;
				mode?: string;
				extractor?: string;
				browser?: string;
				os?: string;
			}[];
			const adaptive = params.adaptive === true || params.adaptive === "true";
			let wreqSession: any = null;
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

			const fetchOpts: FetchOpts = {
				browser,
				os,
				proxy,
				mode,
				adaptive,
				wreqSession,
			};

			const router =
				routes.length > 0 ? new SessionRouter(parseRoutes(routes)) : null;

			let queue: RequestQueue | null = null;
			if (resume && hasQueueFile(outDir)) {
				queue = await RequestQueue.resume(outDir);
				if (queue) {
					const s = queue.stats();
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `🔄 Resuming pull: ${s.completed} done, ${s.queued} queued, ${s.failed} failed`,
							},
						],
						details: { stage: "resume", stats: s },
					});
				}
			}

			if (!queue) {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `🔍 Discovering pages for ${url.href} (${browser}/${os})...`,
						},
					],
					details: { stage: "discover", browser, os },
				});

				const urls = await discover(url.href, max, fetchOpts);
				if (!urls.length) throw new Error("No pages found.");

				queue = await RequestQueue.create(outDir);
				await queue.add(urls);

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `📄 Found ${urls.length} pages. Pulling with ${concurrency} workers...`,
						},
					],
					details: { stage: "pull", total: urls.length, browser, os },
				});
			}

			const needsBrowser = mode === "browser" || mode === "auto";
			const browserPool = needsBrowser
				? new BrowserPool({ headless: true, channel: "chrome" })
				: null;

			// Session warm-up: hit root URL before deep links to establish
			// cookies, TLS state, and anti-bot clearance.
			if (mode !== "fast") {
				try {
					await pullPageEnhanced(url.href, {
						...fetchOpts,
						...(browserPool ? { browserPool } : {}),
					});
					// Dwell: 800-1500ms jittered pause to mimic human behavior
					await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
				} catch {
					/* warm-up failed, proceed anyway */
				}
			}

			let ok = 0;
			let err = 0;
			const files: string[] = [];
			const errors: string[] = [];
			const pageUrlToPath = new Map<string, string>();
			const pagePathToUrl = new Map<string, string>();
			const pagePathToTitle = new Map<string, string>();
			const totalUrls =
				queue.stats().queued +
				queue.stats().inProgress +
				queue.stats().completed;

			try {
				await runPullFromQueue(queue, concurrency, async (pageUrl: string) => {
					if (signal?.aborted) return;

					const urlOpts: FetchOpts = {
						...fetchOpts,
						...(browserPool ? { browserPool } : {}),
					};

					if (router) {
						const match = router.match(pageUrl);
						if (match) {
							if (match.mode) urlOpts.mode = match.mode as ScrapeMode;
							if (match.browser) urlOpts.browser = match.browser;
							if (match.os) urlOpts.os = match.os;
						}
					}

					const result = await pullPageEnhanced(pageUrl, urlOpts);
					if (!result.ok) {
						const willRetry = await queue.fail(
							pageUrl,
							result.error ?? "Unknown error",
						);
						if (!willRetry) {
							err++;
							errors.push(`${pageUrl}: ${result.error}`);
						}
						return;
					}

					await queue.complete(pageUrl);

					const page: Page = {
						url: result.url!,
						title: result.title || new URL(result.url!).pathname,
						markdown:
							frontmatter(result.title || "", result.url!, {
								author: result.author,
								published: result.published,
								site: result.site,
								language: result.language,
								wordCount: result.wordCount,
							}) + (result.content ?? ""),
					};

					const rel = await writePage(page, outDir);
					files.push(rel);
					pageUrlToPath.set(page.url, rel);
					pagePathToUrl.set(rel, page.url);
					pagePathToTitle.set(rel, page.title || rel);
					ok++;

					storeContent(result.url!, result.title, page.markdown, undefined, {
						author: result.author,
						published: result.published,
						site: result.site,
						language: result.language,
						wordCount: result.wordCount,
					});

					const qStats = queue.stats();
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `⏳ ${ok + err}/${totalUrls} pages processed — pulled ${result.title || page.url} → ${rel}`,
							},
						],
						details: {
							stage: "stream",
							ok,
							err,
							total: totalUrls,
							file: rel,
							title: result.title,
							url: result.url,
							wordCount: result.wordCount,
							queueStats: qStats,
						},
					});
				});
			} finally {
				if (browserPool) {
					await browserPool.drain();
				}
				if (queue) {
					await queue.close();
				}
				if (wreqSession) {
					try {
						await wreqSession.close();
					} catch {
						/* best-effort */
					}
				}
			}

			if (pageUrlToPath.size > 1) {
				let rewrites = 0;
				for (const rel of files) {
					const full = join(outDir, rel);
					try {
						const md = await readFile(full, "utf8");
						const rewritten = rewriteLinks(md, pageUrlToPath, rel);
						if (rewritten !== md) {
							await writeFile(full, rewritten, "utf8");
							rewrites++;
						}
					} catch {
						/* best effort */
					}
				}
				if (rewrites > 0) {
					onUpdate?.({
						content: [
							{ type: "text", text: `🔗 Rewrote links in ${rewrites} files` },
						],
						details: { stage: "rewrite", filesRewritten: rewrites },
					});
				}
			}

			const summary = [
				`✅ Pulled ${ok} pages to ${outDir}`,
				err > 0 ? `⚠️ ${err} pages failed` : "",
				``,
				`Files:`,
				...files.slice(0, 30).map((f) => `  - ${f}`),
				files.length > 30 ? `  ... and ${files.length - 30} more` : "",
				errors.length > 0
					? `\nErrors:\n${errors
							.slice(0, 10)
							.map((e) => `  - ${e}`)
							.join("\n")}`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			let packagePath: string | undefined;
			if (compile && ok > 0) {
				try {
					const pages = await Promise.all(
						files.map(async (rel) => {
							const filePath = join(outDir, rel);
							try {
								const content = await readFile(filePath, "utf8");
								return {
									url: pagePathToUrl.get(rel) ?? rel,
									title: pagePathToTitle.get(rel) ?? rel,
									content,
									relPath: rel,
								};
							} catch {
								return null;
							}
						}),
					);
					const validPages = pages.filter((p) => p !== null);
					if (validPages.length > 0) {
						const pkg = await compileContextPackage(
							validPages,
							join(outDir, "..", "packages"),
							{
								packageName: `${url.hostname}-${Date.now()}`,
							},
						);
						packagePath = pkg.packagePath;
					}
				} catch {
					/* best effort */
				}
			}

			const totalProcessed = ok + err;
			return {
				content: [
					{
						type: "text",
						text:
							summary +
							(packagePath ? `\n📦 Compiled package: ${packagePath}` : ""),
					},
				],
				details: {
					outDir,
					total: totalProcessed,
					ok,
					err,
					files,
					errors,
					browser,
					os,
					proxy,
					packagePath,
					adaptive,
					queueStats: queue?.stats(),
					browserPoolStats: browserPool?.stats(),
				},
			};
		},
	});
}
