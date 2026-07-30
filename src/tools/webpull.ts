import { join } from "node:path";
import { cpus } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLatestChromeProfile, DEFAULT_OS } from "../fetch.ts";
import { pullPageEnhanced } from "../content.ts";
import { discover } from "../discovery.ts";
import { storeContent, BASE_TEMP } from "../session-store.ts";
import { compileContextPackage } from "../context-package.ts";
import { safeResolveInBaseTemp } from "./utils.ts";
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
import { buildIndex } from "../webquery-index.ts";

const MAX_CRAWL_ITEMS = 500;

/**
 * Headline line for the pull summary (B8). Distinguishes a pull that fetched
 * nothing new because a previous pull already completed everything (resume
 * defaults on) from a genuine zero-result pull, so "Pulled 0 pages" no longer
 * looks like a silent failure.
 */
export function formatPullHeadline(
	ok: number,
	priorCompleted: number,
	outDir: string,
): string {
	if (ok === 0 && priorCompleted > 0) {
		return `✅ 0 new pages (${priorCompleted} already completed from a previous pull — pass resume:false to re-pull) in ${outDir}`;
	}
	return `✅ Pulled ${ok} pages to ${outDir}`;
}

// ─── Pull concurrency sizing (P4) ────────────────────────────────────
// A single-host pull is rate-limiter-bound, not CPU- or network-bound:
// smartFetch's per-host TokenBucket (burst 10, 5/s refill) sustains ~6
// req/s no matter how many workers dispatch into it. Measured: 32 workers
// = 6.37 pages/s vs 4 workers = 4.03 pages/s — 8× workers bought only
// 1.58× throughput, the surplus just queueing on the bucket lock and
// burning memory. Right-size the worker count to the rate limit instead of
// blindly using cpus×2 (which is 32 on a 16-core host).
//
// Multi-host pulls are the exception: every host has its OWN bucket, so
// concurrency actually pays off across hosts. Scale the worker count with
// the distinct-host count there, bounded by CPU headroom (parallel
// extraction is CPU-bound) and a hard ceiling.

/** Minimum workers for any pull (keeps tiny/odd inputs sane). */
export const PULL_CONCURRENCY_FLOOR = 4;
/** Hard ceiling so a huge multi-host pull cannot exhaust resources. */
export const PULL_CONCURRENCY_CEILING = 32;
/**
 * Workers that saturate one host's 5 req/s bucket (burst 10) with headroom
 * — the 8–12 range the perf audit (docs/perf-improvements.md, P4) measured
 * as optimal for a single host.
 */
export const PULL_WORKERS_PER_HOST = 10;

/**
 * Count the distinct hostnames in a set of target URLs. Unparseable URLs
 * are ignored (they cannot be fetched anyway). Used to decide whether a
 * pull is single-host (rate-limiter-bound) or multi-host (where more
 * workers help). Exported for unit tests.
 */
export function countDistinctHosts(targetUrls: string[]): number {
	const hosts = new Set<string>();
	for (const raw of targetUrls) {
		let s = raw;
		if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
		try {
			const host = new URL(s).hostname.toLowerCase();
			if (host) hosts.add(host);
		} catch {
			/* unparseable URL — skip for host counting */
		}
	}
	return hosts.size;
}

/**
 * Right-size pull worker count for a target URL set (P4). Pure/offline.
 *
 * - Single host (≤1 distinct host): rate-limiter-bound, so return
 *   ~PULL_WORKERS_PER_HOST (10) regardless of URL count or CPU — surplus
 *   workers only add lock contention + memory.
 * - Multi host: scale ~PULL_WORKERS_PER_HOST per distinct host (each host
 *   has its own bucket), bounded by CPU headroom (cpus×2, floored) and the
 *   hard ceiling.
 *
 * Always returns a value within [PULL_CONCURRENCY_FLOOR, PULL_CONCURRENCY_CEILING].
 * The deliberate 5/s per-host rate cap is NOT touched here.
 */
export function computePullConcurrency(
	targetUrls: string[],
	cpus: number,
): number {
	const distinctHosts = countDistinctHosts(targetUrls);

	if (distinctHosts <= 1) {
		// Single-host (or empty/unparseable): one bucket, I/O-bound. CPU
		// count is irrelevant — clamp the per-host worker count and return.
		return Math.min(
			PULL_CONCURRENCY_CEILING,
			Math.max(PULL_CONCURRENCY_FLOOR, PULL_WORKERS_PER_HOST),
		);
	}

	// Multi-host: more workers pay off across hosts. Scale with host count,
	// cap by CPU headroom (parallel extraction is CPU-bound) and the ceiling.
	const safeCpus = Math.max(1, Math.round(cpus));
	const hostScaled = distinctHosts * PULL_WORKERS_PER_HOST;
	const cpuCap = Math.max(PULL_CONCURRENCY_FLOOR, safeCpus * 2);
	return Math.min(
		PULL_CONCURRENCY_CEILING,
		Math.max(PULL_CONCURRENCY_FLOOR, Math.min(hostScaled, cpuCap)),
	);
}

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
					description: `Max pages to pull (default: 100, capped at ${MAX_CRAWL_ITEMS})`,
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
			bypass: Type.Optional(
				Type.Boolean({
					description:
						"Enable paywall bypass on every page in the pull. If a fetched page looks paywalled, retry using a chain of strategies (Googlebot UA, archive.org Wayback, Playwright with paywall JS blocked) before recording an error.",
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
				? safeResolveInBaseTemp(params.out)
				: join(BASE_TEMP, url.hostname);
			const max = Math.min(
				MAX_CRAWL_ITEMS,
				Number.isFinite(params.max) && (params.max as number) > 0
					? (params.max as number)
					: 100,
			);
			// Right-sized via computePullConcurrency once the target URL set is
			// known (below). Seed with a single-host sizing from the root URL so
			// the value is always sane before discovery/resume refines it (P4).
			let concurrency = computePullConcurrency([url.href], cpus().length);
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
				bypass: params.bypass === true,
			};

			const router =
				routes.length > 0 ? new SessionRouter(parseRoutes(routes)) : null;

			let queue: RequestQueue | null = null;
			let priorCompleted = 0;
			if (resume && hasQueueFile(outDir)) {
				queue = await RequestQueue.resume(outDir);
				if (queue) {
					const s = queue.stats();
					priorCompleted = s.completed;
					// Size workers from the URLs still to be fetched (P4).
					concurrency = computePullConcurrency(
						queue
							.snapshot()
							.filter(
								(e) =>
									e.status === "queued" || e.status === "in_progress",
							)
							.map((e) => e.url),
						cpus().length,
					);
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

				// Size workers from the discovered URL set (P4): single-host
				// pulls are rate-limiter-bound (~10 workers), multi-host scale up.
				concurrency = computePullConcurrency(urls, cpus().length);

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

			// Build BM25 index from all markdown files currently on disk.
			// A full rebuild keeps the index consistent even after resume/append pulls.
			let indexBuilt = false;
			if (ok > 0) {
				try {
					await buildIndex(outDir);
					indexBuilt = true;
				} catch {
					/* best effort — pull result is still valid */
				}
			}

			const summary = [
				formatPullHeadline(ok, priorCompleted, outDir),
				err > 0 ? `⚠️ ${err} pages failed` : "",
				indexBuilt ? `🔍 BM25 index built — use aio-webquery to search this corpus` : "",
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
					indexBuilt,
					queueStats: queue?.stats(),
					browserPoolStats: browserPool?.stats(),
				},
			};
		},
	});
}
