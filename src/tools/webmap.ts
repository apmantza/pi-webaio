import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { smartFetch, getLatestChromeProfile, DEFAULT_OS } from "../fetch.ts";
import { discover } from "../discovery.ts";
import {
	isGitHubUrl,
	mapGitHubRepo,
	parseGitHubMapUrl,
} from "../github-map.ts";
import type { FetchOpts } from "../types.ts";

export function registerWebmapTool(pi: ExtensionAPI): void {
	pi.registerTool({
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
		parameters: Type.Object({
			url: Type.String({
				description:
					"URL to discover pages for (e.g. https://docs.example.com or https://github.com/owner/repo)",
			}),
			max: Type.Optional(
				Type.Number({
					description: "Max URLs to discover (default: 100)",
					default: 100,
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
		}),

		async execute(_toolCallId, params) {
			let raw = params.url;
			if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new Error(`Bad URL: ${params.url}`);
			}

			const max = params.max ?? 100;
			const browser = (params.browser as string) ?? getLatestChromeProfile();
			const os = (params.os as string) ?? DEFAULT_OS;
			const fetchOpts: FetchOpts = { browser, os };

			// ── GitHub fast path ──────────────────────────────────────────
			// Without this, aio-webmap on a GitHub URL falls back to crawling
			// github.com's explore pages — useless. Detect GitHub and route
			// to a repo-native mapper that returns a real file tree +
			// feature URLs.
			if (isGitHubUrl(url.href)) {
				const ref = parseGitHubMapUrl(url.href);
				if (ref) {
					const ghMap = await mapGitHubRepo(url.href, ref, { max });
					const text = renderGitHubMap(ghMap);
					return {
						content: [{ type: "text", text }],
						details: {
							url: url.href,
							totalUrls: ghMap.urls.length,
							urls: ghMap.urls,
							llmsUrls: [],
							sources: ghMap.sources,
							source: ghMap.source,
							browser,
							os,
							repo: ghMap.repo,
							treeMarkdown: ghMap.treeMarkdown,
							architecture: ghMap.architecture,
						},
					};
				}
			}

			// ── Generic web discovery ─────────────────────────────────────
			const urls = await discover(url.href, max, fetchOpts);

			let llmsUrls: string[] = [];
			try {
				const llmsRes = await smartFetch(`${url.origin}/llms.txt`, fetchOpts);
				if (llmsRes && llmsRes.status < 400) {
					llmsUrls = llmsRes.text
						.split(/\n/)
						.filter((l) => /^https?:\/\//i.test(l.trim()))
						.map((l) => l.trim());
				}
			} catch {
				/* ignore */
			}

			// Build sources map for the generic path
			const sources: Record<string, string[]> = {};
			for (const u of urls) sources["sitemap-or-nav-or-crawl"] = urls;
			if (llmsUrls.length) sources["llms.txt"] = llmsUrls;

			const text = [
				`🌐 Site map for ${url.href}`,
				`\nDiscovered ${urls.length} pages via sitemaps/robots/nav/crawl.`,
				llmsUrls.length > 0
					? `\nFound ${llmsUrls.length} entries in llms.txt`
					: "",
				"\n\nFirst 50 pages:",
				...urls.slice(0, 50).map((u, i) => `${i + 1}. ${u}`),
				urls.length > 50 ? `\n... and ${urls.length - 50} more` : "",
				llmsUrls.length > 0
					? `\n\nllms.txt entries:\n${llmsUrls.map((u) => `  - ${u}`).join("\n")}`
					: "",
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					url: url.href,
					totalUrls: urls.length,
					urls,
					llmsUrls,
					sources,
					source: "sitemap-or-nav-or-crawl",
					browser,
					os,
				},
			};
		},
	});
}

/**
 * Render a GitHubMapResult as a readable text block for the agent.
 * Keeps both the high-level summary and the file tree / feature lists.
 */
function renderGitHubMap(
	map: import("../github-map.ts").GitHubMapResult,
): string {
	if (!map.ok) {
		return `${map.summary}\n\nError: ${map.error ?? "unknown"}`;
	}

	const lines: string[] = [map.summary];

	if (map.architecture) {
		lines.push(map.architecture);
	}

	if (map.treeMarkdown) {
		lines.push(map.treeMarkdown);
	}

	// Per-source URL lists (capped so the chat doesn't blow up)
	const sourceLines: string[] = [];
	for (const [src, urls] of Object.entries(map.sources)) {
		if (urls.length === 0) continue;
		const preview = urls.slice(0, 5);
		const more =
			urls.length > preview.length ? ` …+${urls.length - preview.length}` : "";
		sourceLines.push(`**${src}** (${urls.length}):`);
		for (const u of preview) sourceLines.push(`  - ${u}`);
		sourceLines.push(more ? `  ${more}` : "");
	}
	if (sourceLines.length > 0) {
		lines.push("## URLs by source\n");
		lines.push(sourceLines.join("\n"));
	}

	return lines.join("\n");
}
