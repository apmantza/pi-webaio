import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { smartFetch, getLatestChromeProfile, DEFAULT_OS } from "../fetch.ts";
import { discover } from "../discovery.ts";
import type { FetchOpts } from "../types.ts";

export function registerWebmapTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webmap",
		label: "Web Map",
		description:
			"Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, llms.txt, and crawling without fetching content. Returns structured URLs grouped by source.",
		promptSnippet: "Discover pages on a website without fetching content",
		promptGuidelines: [
			"Use aio-webmap to discover all pages on a site before a full pull.",
			"Returns URLs grouped by discovery source: sitemaps, robots.txt, navigation, llms.txt, crawl.",
			"Use aio-webpull to actually fetch and convert the discovered pages.",
		],
		parameters: Type.Object({
			url: Type.String({
				description:
					"URL to discover pages for (e.g. https://docs.example.com)",
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
					browser,
					os,
				},
			};
		},
	});
}
