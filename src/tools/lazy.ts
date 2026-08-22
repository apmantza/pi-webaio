/**
 * Lightweight pi registrations for the eight aio tools.
 *
 * The regular tool modules contain the fetch/extraction/search dependency graph
 * and are intentionally imported only after the tool is called. This module
 * keeps only JSON-schema metadata and a small capture shim at startup. The
 * real registration is replayed into the shim on first execution so the
 * existing execute and renderer implementations remain the single source of
 * truth for runtime behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../redact.ts";

type JsonSchema = Record<string, unknown>;
type ToolArgs = Record<string, unknown>;
type Update = (update: unknown) => void;
type RenderCall = (args: unknown, theme: unknown) => unknown;
type RenderResult = (
	result: unknown,
	options: unknown,
	theme: unknown,
) => unknown;

type RegisteredTool = {
	name: string;
	parameters?: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: Update,
	) => Promise<unknown>;
	renderCall?: RenderCall;
	renderResult?: RenderResult;
};

type ToolModule = {
	register: (pi: ExtensionAPI) => void;
};

type Ready = () => Promise<void>;

type LazyTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: JsonSchema;
	needsUserExtractors?: boolean;
	needsCache?: boolean;
	load: () => Promise<ToolModule>;
};

function schema(
	properties: Record<string, JsonSchema>,
	required: string[] = [],
): JsonSchema {
	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

function string(description?: string, extra: JsonSchema = {}): JsonSchema {
	return {
		type: "string",
		...(description ? { description } : {}),
		...extra,
	};
}

function number(description?: string, extra: JsonSchema = {}): JsonSchema {
	return { type: "number", ...(description ? { description } : {}), ...extra };
}

function boolean(description?: string, extra: JsonSchema = {}): JsonSchema {
	return {
		type: "boolean",
		...(description ? { description } : {}),
		...extra,
	};
}

function array(items: JsonSchema, description?: string): JsonSchema {
	return {
		type: "array",
		items,
		...(description ? { description } : {}),
	};
}

const gogglesSchema: JsonSchema = {
	description:
		"Optional rerank profile applied additively on top of normal ranking. Pass a built-in preset name ('docs-first', 'research', 'news-balanced'), a path to JSON rules, an inline JSON string, or a rules object.",
	anyOf: [
		string(),
		{
			type: "object",
			patternProperties: { "^.*$": {} },
		},
	],
};

const routeSchema = schema(
	{
		pattern: string(
			"URL pattern: path string, glob (*/docs/*), or regex (/^\\/api\\//).",
		),
		mode: string("Fetcher mode: fast, fingerprint, browser, or auto."),
		extractor: string("Vertical extractor name (e.g. npm, pypi, wikipedia)."),
		browser: string("Browser profile override for this route."),
		os: string("OS profile override for this route."),
	},
	["pattern"],
);

const lazyTools: LazyTool[] = [
	{
		name: "aio-websearch",
		label: "Web Search",
		needsCache: true,
		description:
			"Search the web; returns deduped, cross-engine ranked results with title, url, snippet, and sourceType (official-docs/repo/academic/maintainer-blog/website/community/news/social). No API keys — runs DDG, Brave, Yahoo, and Bing in parallel, capped at ~7s (returns deterministic partial results at the deadline). Google is enabled by default when Chrome CDP is available. Reddit is OFF by default — opt in per call with reddit:true (requires Chrome CDP). Common: query, max. Situational: compact:true for URL-scouting (one line per result — title + url + sourceType, no snippet), goggles to rerank additively (presets: docs-first, research, news-balanced, or custom rules), prefetch to warm the cache with the top hits, google:false to skip Google only.",
		promptSnippet: "Search the web for current information or references",
		promptGuidelines: [
			"Use aio-websearch when the user asks a question that requires current or external information not in your training data.",
			"After getting search results, use aio-webfetch or aio-webpull to retrieve the full content of the most relevant result.",
			"Runs DDG/Brave/Yahoo/Bing in parallel. Google requires headless Chrome (auto-launched) and is enabled by default. Reddit is OFF by default; pass reddit:true to include it (also needs Chrome CDP). Set google: false to skip Google.",
			"Set compact: true for URL scouting — one line per result (title + URL + sourceType, no snippet) to minimize token waste.",
		],
		parameters: schema(
			{
				query: string("Search query (e.g. 'React Server Components RFC')."),
				max: number("Max results to request from each engine.", { default: 15 }),
				google: boolean("Also search Google via Chrome CDP.", { default: true }),
				reddit: boolean(
					"Also search Reddit via Chrome CDP (off by default).",
					{ default: false },
				),
				compact: boolean("Return one compact line per result.", { default: false }),
				prefetch: {
					anyOf: [boolean(), number()],
					description: "Prefetch the top result URLs into the session cache.",
				},
				goggles: gogglesSchema,
			},
			["query"],
		),
		load: async () => ({
			register: (await import("./websearch.ts")).registerWebsearchTool,
		}),
	},
	{
		name: "aio-webfetch",
		label: "Web Fetch",
		description:
			"Fetch URL(s) and convert to markdown with anti-bot TLS fingerprinting (detects PDFs, GitHub repos, Next.js RSC). Full content is ALWAYS saved to disk + cached; these controls only change what is RETURNED to keep token use low.\n\nCommon patterns:\n- Fetch one page: aio-webfetch(url).\n- Focused answer from one page: aio-webfetch(url, query) — returns the top-k BM25-ranked chunks (with heading breadcrumbs) that answer the query, not the whole page.\n- Cited multi-source answer: aio-webfetch(urls:[...], query) — pools chunks from ALL pages, ranks them, and returns the top-k each labeled with its source URL + heading (verifiable cited retrieval, not a generated answer).\n- One document from many pages: aio-webfetch(urls:[...], compile) — compiles the batch into a single markdown package.\n\nOutput controls:\n- outline:true — ~50-token heading outline (the page's shape) instead of the body.\n- budgetTokens — HARD output ceiling; guarantees the returned text fits N tokens (heading skeleton preserved).\n- format — markdown (default, saved to disk) | html | text | json | raw (in-memory).\n- summarize:true — OPT-IN AI summary for long content. Off by default: long content returns the frugal outline+largest-section preview instead (cheaper, lossless). Full content is saved either way.\n\nThree output-limit knobs (pick one): prune = score-based relevance pruning to a token budget (drops low-value sections, query-aware); budgetTokens = hard output ceiling (guaranteed fit); max_length = raw character window (pagination with start_index).\n\nAdvanced (rarely needed): mode/browser/os/proxy (fetch tuning), chunks/maxTokens/overlapTokens/topChunks (RAG), start_index/max_length (pagination), bypass/bypassStrategies (opt-in paywall bypass), cacheTtlSeconds, interactive, localCheck, diff.",
		promptSnippet:
			"aio-webfetch(url|urls, query?, outline?, budgetTokens?, summarize?, compile?, format?, prune?, topChunks?, …): fetch URL(s) with anti-bot TLS fingerprinting + defuddle extraction. Full content always saved to disk + cached. `url` accepts a string OR an array; `urls` is the array form. `query` alone → single-page answer mode (top-k BM25 chunks w/ breadcrumbs); `urls:[…]+query` → cited multi-source answer (top-k chunks each labeled with its source URL). `outline:true` → ~50-token heading outline. `summarize:true` → opt-in AI summary (off by default; long content otherwise gets the frugal outline+largest-section preview). `format=html|text|json|raw` for an in-memory body. Use the read tool on the saved path for full text.",
		promptGuidelines: [
			"Use aio-webfetch when the user wants to retrieve specific webpage(s), article(s), or file(s).",
			"Use aio-webpull when the user wants to download an entire site or docs collection.",
			"After aio-webfetch completes, use the built-in read tool to inspect the generated markdown file(s).",
			"Pass `urls: [...]` (or `url` with an array) to fetch multiple pages in parallel — returns per-item progress in the TUI.",
			"For a question answered by several pages, pass `urls:[...]` WITH `query` to get a cited multi-source answer (each chunk labeled with its source URL).",
			"AI summarization is opt-in: pass `summarize: true` only when you actually want a lossy summary; otherwise the frugal preview / outline is cheaper and lossless.",
		],
		needsUserExtractors: true,
		needsCache: true,
		parameters: schema({
			url: {
				anyOf: [string(), array(string())],
				description:
					"URL to fetch. Accepts a single URL string OR an array of URL strings (additive — `urls` still works and takes precedence if both are given).",
			},
			urls: array(
				string(),
				"Multiple URLs to fetch in parallel. Takes precedence over `url` if both are given.",
			),
			out: string(
				"Output file path under temp for single url (default: auto-derived from URL).",
			),
			mode: string(
				"Scrape mode: auto (default), fast, fingerprint, or browser. Auto escalates from fast → fingerprint → browser when bot protection is detected.",
			),
			browser: string(
				"Browser profile for TLS fingerprinting. Default: chrome_145.",
			),
			os: string("OS profile for fingerprinting. Default: windows."),
			proxy: string(
				"Proxy URL (e.g. http://user:pass@host:port or socks5://host:port).",
			),
			cacheTtlSeconds: number(
				"Opt-in cache TTL in seconds. Omit for fresh fetches.",
			),
			compile: boolean("Compile batch results into a single markdown package."),
			prune: number("Prune markdown to token budget (e.g. 3000)."),
			query: string(
				"Relevance query for answer mode or query-aware pruning. When set without `prune`, activates answer mode: the page is chunked and only the top-k most relevant chunks (scored by BM25) are returned — ordered by document position with heading breadcrumbs. The full content is still cached so aio-webcontent can retrieve it by URL. When used with `prune`, keeps sections most relevant to this query during pruning.",
			),
			topChunks: number(
				"Maximum number of top-scoring chunks to return in answer mode. Default 5. Min 1.",
				{
					minimum: 1,
				},
			),
			interactive: boolean("Extract interactive elements as numbered refs."),
			start_index: number(
				"Return content starting from this character index (0-based). Use with max_length for pagination.",
			),
			max_length: number(
				"Maximum characters to return (default: unlimited). Use with start_index for pagination.",
			),
			bypass: boolean(
				"Enable paywall bypass. If the fetched content looks paywalled, retry using a chain of strategies (Googlebot UA, archive.org Wayback, Playwright with paywall JS blocked) until one succeeds. Falls back gracefully if no strategy works.",
			),
			bypassStrategies: array(
				string(),
				"Override the bypass strategy chain. Valid values: ua:googlebot, ua:bingbot, ua:facebookbot, referer:google, block_js, archive, archive_first, cookies. Default is site-specific.",
			),
			format: string(
				"Output format. Default: markdown. Use html for raw HTML, text for plain text extraction, json for structured metadata + body, or raw for the full HTTP response object.",
				{
					default: "markdown",
				},
			),
			chunks: boolean(
				"Return paragraph-bounded chunks alongside the full markdown. Useful for RAG workflows. Only applies to format: markdown (other formats return in-memory body; chunk those yourself).",
			),
			maxTokens: number(
				"Max tokens per chunk. Default 512. Only used when chunks: true. Min 1.",
				{ minimum: 1 },
			),
			overlapTokens: number(
				"Tokens of tail-overlap from the previous chunk prepended to each chunk after the first. Default 50. Min 0.",
				{
					minimum: 0,
				},
			),
			budgetTokens: number(
				"Hard token budget for the content returned to the agent. When set, the output is guaranteed to fit within this many tokens — heading structure is preserved, lowest-value sections drop first, and a footer notes omitted sections. Full content is always cached before trimming. Min 100.",
				{
					minimum: 100,
				},
			),
			diff: boolean(
				"When true and a previous version of the URL is cached, fetch fresh content and return a section-level diff instead of the full page. A 304 or unchanged body reports no changes; without a baseline, falls back to a normal fetch.",
			),
			localCheck: boolean(
				"Opt-in local-knowledge pre-check. Before the live fetch, search a pulled corpus for related content. Default (absent) leaves the fetch unchanged.",
			),
			outline: boolean(
				"Opt-in outline/TOC mode. Return only a compact heading outline instead of the body while keeping the full content cached. Applies to format: markdown.",
			),
			summarize: boolean(
				"Opt-in AI summarization for long content via Google AI Mode. Default false: long content returns the frugal outline + largest-section preview instead. The full content is always saved and cached.",
			),
		}),
		load: async () => ({
			register: (await import("./webfetch.ts")).registerWebfetchTool,
		}),
	},
	{
		name: "aio-webcontent",
		label: "Web Content",
		needsCache: true,
		description:
			"Retrieve previously fetched content from session storage by URL. Content is stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Get stored content from a previous fetch",
		promptGuidelines: [
			"Use aio-webcontent when you need the full content of a previously fetched URL without re-downloading.",
			"Pass diff: true to see a section-level diff of the URL's current cached content against its previous version.",
		],
		parameters: schema(
			{
				url: string("URL of previously fetched content."),
				budgetTokens: number(
					"Hard token budget for the content returned to the agent. When set, heading structure is preserved and a footer notes omitted sections. Min 100.",
					{
						minimum: 100,
					},
				),
				query: string(
					"Relevance query for budget-aware pruning. When set alongside budgetTokens, sections are scored by BM25 relevance.",
				),
				diff: boolean(
					"When true, return a section-level diff of the URL's current cached content against its previous version. Requires at least two fetched versions.",
				),
			},
			["url"],
		),
		load: async () => ({
			register: (await import("./webcontent.ts")).registerWebcontentTool,
		}),
	},
	{
		name: "aio-webresult",
		label: "Get Stored Result",
		description:
			"Retrieve a previously fetched web scrape result by response ID. Results are stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Retrieve a stored web scrape by response ID",
		promptGuidelines: [
			"Use aio-webresult when you need to retrieve a previously fetched result by its response ID.",
			"Response IDs are shown after every successful aio-webfetch call.",
			"Use aio-webcontent to retrieve content by URL instead of by ID.",
		],
		parameters: schema(
			{ id: string("Response ID from a previous webfetch call.") },
			["id"],
		),
		load: async () => ({
			register: (await import("./webresult.ts")).registerWebresultTool,
		}),
	},
	{
		name: "aio-webmap",
		label: "Web Map",
		description:
			"Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, llms.txt, and crawling without fetching content. Returns structured URLs grouped by source. GitHub repo URLs return a full file tree + architecture signals + feature URLs (issues, PRs, releases, tags).",
		promptSnippet: "Discover pages on a website without fetching content",
		promptGuidelines: [
			"Use aio-webmap to discover all pages on a site before a full pull.",
			"GitHub repo URLs return a file tree, architecture signals, and feature URLs (issues, PRs, releases, tags).",
			"Returns URLs grouped by discovery source: repo-clone, github-api, github-api:<feature>, sitemaps, robots.txt, navigation, llms.txt, crawl.",
			"Use aio-webpull to actually fetch and convert the discovered pages.",
		],
		parameters: schema(
			{
				url: string(
					"URL to discover pages for (e.g. https://docs.example.com or https://github.com/owner/repo).",
				),
				max: number("Max URLs to discover (default: 100).", { default: 100 }),
				browser: string(
					"Browser profile for TLS fingerprinting. Default: chrome_145.",
				),
				os: string("OS profile for fingerprinting. Default: windows."),
			},
			["url"],
		),
		load: async () => ({
			register: (await import("./webmap.ts")).registerWebmapTool,
		}),
	},
	{
		name: "aio-webpull",
		label: "Webpull",
		needsUserExtractors: true,
		needsCache: true,
		description:
			"Pull a whole site into local markdown files (offline-queryable via aio-webquery). Discovers pages via sitemap, navigation links, or crawling; writes files preserving URL structure with YAML frontmatter, with anti-bot TLS fingerprinting. Common: url, max, out. Situational: compile (bundle into one context package), resume (checkpoint/resume, auto by default — pass false to force fresh), routes (per-URL-pattern fetcher routing), adaptive (survive element structure changes), bypass (opt-in paywall bypass). Advanced: mode/browser/os/proxy.",
		promptSnippet: "Pull an entire website into local markdown files",
		promptGuidelines: [
			"Use aio-websearch when the user wants to find information online. Returns compact search results.",
			"Use aio-webfetch when the user wants to download a specific URL or batch of URLs.",
			"After aio-webpull completes, inspect the generated markdown files with the built-in read tool.",
		],
		parameters: schema(
			{
				url: string("URL to pull (e.g. https://docs.example.com)."),
				out: string("Output directory under temp (default: <hostname>)."),
				max: number("Max pages to pull (default: 100, capped at 500).", {
					default: 100,
				}),
				mode: string(
					"Scrape mode: auto (default), fast, fingerprint, or browser. Auto escalates when bot protection is detected.",
				),
				browser: string(
					"Browser profile for TLS fingerprinting. Default: chrome_145. Examples: chrome_145, firefox_147, safari_26, edge_145.",
				),
				os: string(
					"OS profile for fingerprinting. Default: windows. Options: windows, macos, linux, android, ios.",
				),
				proxy: string(
					"Proxy URL (e.g. http://user:pass@host:port or socks5://host:port).",
				),
				compile: boolean(
					"Compile pulled pages into a single context package after completion.",
				),
				resume: boolean(
					"Resume a previous pull from the output directory (default: auto-detect). Set to false to force a fresh pull.",
				),
				routes: array(
					routeSchema,
					"Route definitions: URL pattern → fetcher mode/extractor. Evaluated in order, first match wins.",
				),
				adaptive: boolean(
					"Enable adaptive content selectors to survive page redesigns (default: false).",
				),
				bypass: boolean(
					"Enable paywall bypass on every page in the pull. Uses the configured archive, bot-UA, block_js, and cookie strategies.",
				),
			},
			["url"],
		),
		load: async () => ({
			register: (await import("./webpull.ts")).registerWebpullTool,
		}),
	},
	{
		name: "aio-webquery",
		label: "Web Query",
		description:
			"Search a locally-pulled website corpus (from aio-webpull) using BM25. No re-fetching — offline, token-cheap knowledge base retrieval. Returns top-k relevant chunks with source file, original URL, and heading breadcrumb.",
		promptSnippet: "Search pulled docs locally with BM25",
		promptGuidelines: [
			"Use aio-webquery to search content previously pulled with aio-webpull without re-downloading anything.",
			"Use aio-webpull first if no index exists yet — it will build the BM25 index automatically.",
			"Use aio-websearch or aio-webfetch for live searches.",
		],
		parameters: schema(
			{
				query: string("Search query to run against the local corpus."),
				dir: string(
					"Directory containing a pulled corpus. Relative paths resolve under <os-temp>/pi-webaio; absolute paths pass through unchanged.",
				),
				topK: number("Number of top chunks to return (default: 8).", {
					default: 8,
				}),
			},
			["query"],
		),
		load: async () => ({
			register: (await import("./webquery.ts")).registerWebqueryTool,
		}),
	},
	{
		name: "aio-webresearch",
		label: "Web Research",
		needsUserExtractors: true,
		needsCache: true,
		description:
			"Single-round research orchestrator: fans out aio-websearch over a query (and optional sub-queries), ranks and dedupes sources, fetches the top-N through the webfetch pipeline, indexes them into a local BM25 corpus, and writes an auditable research bundle (STATUS.md, reports/, sources/, data/) to disk. Deterministic retrieval + bookkeeping only — no LLM calls inside the tool; the calling agent writes the cited claims.",
		promptSnippet:
			"aio-webresearch(query, queries?, maxSources?, outDir?, writeBundle?): run a single-round research pass and write a bundle under .pi/webaio-research/",
		promptGuidelines: [
			"Use aio-webresearch when the user wants a multi-source research pass with a durable, auditable trail (as opposed to a single aio-websearch/aio-webfetch call).",
			"This is a single-round MVP: one fan-out of searches, one fetch pass. There is no iterative follow-up loop yet.",
			"After the tool returns, read reports/EVIDENCE.md and data/evidence.json, then fill in reports/CLAIMS.md yourself — the tool does not call an LLM to synthesize claims.",
			"Pass queries with a few complementary phrasings (different phrasings/angles) to widen coverage beyond the single query.",
		],
		parameters: schema(
			{
				query: string("Primary research question or topic."),
				queries: array(string(), "Optional sub-queries; capped at six total."),
				maxSources: number("Maximum sources to fetch; clamped to 3-12.", {
					default: 6,
					minimum: 3,
					maximum: 12,
				}),
				outDir: string("Output directory for the research bundle."),
				writeBundle: boolean("Write the research bundle to disk.", {
					default: true,
				}),
				goggles: gogglesSchema,
			},
			["query"],
		),
		load: async () => ({
			register: (await import("./webresearch.ts")).registerWebresearchTool,
		}),
	},
];

/** Shared metadata used by both the lazy pi wrappers and real registrations. */
export const TOOL_METADATA: Record<
	string,
	Omit<LazyTool, "load" | "needsUserExtractors" | "needsCache">
> = Object.fromEntries(
	lazyTools.map(
		({
			load: _load,
			needsUserExtractors: _needsUserExtractors,
			needsCache: _needsCache,
			...metadata
		}) => [metadata.name, metadata],
	),
);

function fallbackComponent(text: string): {
	render(width: number): string[];
	invalidate(): void;
} {
	return {
		render(width: number): string[] {
			return [
				text.length > width && width > 1 ? `${text.slice(0, width - 1)}…` : text,
			];
		},
		invalidate(): void {
			// The fallback is immutable.
		},
	};
}

function fallbackCallText(name: string, args: unknown, theme: unknown): string {
	const values = args && typeof args === "object" ? (args as ToolArgs) : {};
	const primary = values.query ?? values.url ?? values.urls;
	const value = primary === undefined ? "" : String(primary);
	let label: string;
	if (name === "aio-websearch") {
		label = `aio-websearch "${value.slice(0, 90)}${value.length > 90 ? "…" : ""}"`;
	} else if (name === "aio-webfetch") {
		const urls = Array.isArray(values.urls) ? values.urls : undefined;
		const fetchLabel =
			urls && urls.length > 1 ? `aio-webfetch ×${urls.length}` : "aio-webfetch";
		let fetchUrl = "...";
		if (typeof values.url === "string" && values.url) {
			fetchUrl = values.url;
		} else if (urls?.[0] !== undefined) {
			fetchUrl = String(urls[0]);
		}
		label = `${fetchLabel} ${fetchUrl}`;
	} else {
		label = value ? `${name} ${value}` : name;
	}
	return styleFallbackText(redactSecrets(label), theme);
}

function styleFallbackText(text: string, theme: unknown): string {
	if (!theme || typeof theme !== "object") return text;
	const candidate = theme as {
		fg?: (color: string, value: string) => string;
		bold?: (value: string) => string;
	};
	if (typeof candidate.fg !== "function") return text;
	const split = text.indexOf(" ");
	const head = split === -1 ? text : text.slice(0, split);
	const tail = split === -1 ? "" : text.slice(split);
	const title =
		typeof candidate.bold === "function" ? candidate.bold(head) : head;
	return `${candidate.fg("toolTitle", title)}${candidate.fg("accent", tail)}`;
}

function fallbackResultText(
	result: unknown,
	options: unknown,
	name: string,
): string {
	if (
		options &&
		typeof options === "object" &&
		(options as { isPartial?: boolean }).isPartial
	) {
		return `${name}…`;
	}
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const firstText = content.find(
				(item): item is { text: string } =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as { text?: unknown }).text === "string",
			);
			if (firstText) {
				return redactSecrets(firstText.text.split("\n", 1)[0] ?? name);
			}
		}
	}
	return name;
}

async function loadRegisteredTool(
	loader: () => Promise<ToolModule>,
): Promise<RegisteredTool> {
	let captured: RegisteredTool | undefined;
	const capture = {
		registerTool(tool: RegisteredTool): void {
			captured = tool;
		},
	};
	const module = await loader();
	// SAFETY: the capture shim implements the only ExtensionAPI method used by
	// registerWeb*Tool; it records the complete tool config and never calls pi.
	module.register(capture as unknown as ExtensionAPI);
	if (!captured) throw new Error("aio tool registration did not produce a tool");
	return captured;
}

function registerLazyTool(
	pi: ExtensionAPI,
	definition: LazyTool,
	ready: Ready,
): void {
	const metadata = TOOL_METADATA[definition.name];
	if (!metadata) throw new Error(`Missing metadata for ${definition.name}`);
	let runtime: RegisteredTool | undefined;
	let loading: Promise<RegisteredTool> | undefined;

	const getRuntime = async (): Promise<RegisteredTool> => {
		if (runtime) return runtime;
		if (!loading) {
			const pending = ready().then(() => loadRegisteredTool(definition.load));
			loading = pending.then(
				(tool) => {
					runtime = tool;
					return tool;
				},
				(err: unknown) => {
					loading = undefined;
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Failed to initialize ${definition.name}: ${message}`);
				},
			);
		}
		return loading;
	};

	pi.registerTool({
		...metadata,
		async execute(toolCallId, params, signal, onUpdate) {
			const tool = await getRuntime();
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			return (
				runtime?.renderCall?.(args, theme) ??
				fallbackComponent(fallbackCallText(definition.name, args, theme))
			);
		},
		renderResult(result, options, theme) {
			return (
				runtime?.renderResult?.(result, options, theme) ??
				fallbackComponent(fallbackResultText(result, options, definition.name))
			);
		},
	});
}

/** Register all tools without importing their implementation graphs. */
export function registerLazyTools(
	pi: ExtensionAPI,
	userExtractorsReady: Ready = async () => {},
	cacheReady: Promise<void> = Promise.resolve(),
): void {
	for (const definition of lazyTools) {
		const ready: Ready = async () => {
			if (definition.needsUserExtractors) await userExtractorsReady();
			if (definition.needsCache) await cacheReady;
		};
		registerLazyTool(pi, definition, ready);
	}
}

/** Names are exported for startup tests and diagnostics. */
export const LAZY_TOOL_NAMES = lazyTools.map((tool) => tool.name);
