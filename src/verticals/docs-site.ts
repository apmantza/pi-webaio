// ─── Docs-site extractor ───────────────────────────────────────────
// Extracts structured content from common docs platforms:
// Docusaurus, GitBook, ReadTheDocs, MDN, VitePress, MkDocs.

import { parseHTML } from "linkedom";
import type { VerticalResult } from "./types.ts";

/** Check if a URL's hostname equals or ends with the given host (with dot). */
function isHostMatch(url: string, host: string): boolean {
	try {
		const u = new URL(url);
		const h = u.hostname;
		return h === host || h.endsWith("." + host);
	} catch {
		return false;
	}
}

export function matchesDocsSite(url: string): boolean {
	const hosts = [
		"docs.",
		"developer.mozilla.org",
		"gitbook.io",
		"readthedocs.io",
		"readthedocs.org",
		"vitejs.dev",
		"docusaurus.io",
	];
	try {
		const u = new URL(url);
		const h = u.hostname;
		return hosts.some((host) => h === host || h.endsWith("." + host));
	} catch {
		return false;
	}
}

export function extractDocsSite(
	html: string,
	url: string,
): VerticalResult | null {
	const { document } = parseHTML(html);

	// Detect platform from meta tags or DOM structure
	let platform = "unknown";
	const htmlClass = document.documentElement?.getAttribute("class") || "";
	const bodyClass = document.body?.getAttribute("class") || "";
	const metaGenerator =
		document.querySelector('meta[name="generator"]')?.getAttribute("content") ||
		"";

	if (htmlClass.includes("docusaurus") || metaGenerator.includes("Docusaurus"))
		platform = "docusaurus";
	else if (
		bodyClass.includes("gitbook") ||
		document.querySelector(".gitbook-root")
	)
		platform = "gitbook";
	else if (
		document.querySelector(".mdn-content") ||
		isHostMatch(url, "developer.mozilla.org")
	)
		platform = "mdn";
	else if (
		document.querySelector(".vitepress") ||
		bodyClass.includes("vitepress")
	)
		platform = "vitepress";
	else if (
		document.querySelector(".rst-content") ||
		document.querySelector(".rst-footer-buttons")
	)
		platform = "readthedocs";

	// Try to find the main content area based on platform
	const selectors: string[] = [];
	switch (platform) {
		case "docusaurus":
			selectors.push("article.markdown", "main article", ".theme-doc-markdown");
			break;
		case "gitbook":
			selectors.push(".gitbook-root", "[data-testid='page.content']", "main");
			break;
		case "mdn":
			selectors.push("article.main-page-content", "#content", "main");
			break;
		case "vitepress":
			selectors.push(".vp-doc", "main .content", "main");
			break;
		case "readthedocs":
			selectors.push(".rst-content", "[role='main']", "main");
			break;
		default:
			selectors.push(
				"article",
				"main",
				".content",
				"[role='main']",
				".documentation",
			);
	}

	let contentEl = null;
	for (const sel of selectors) {
		contentEl = document.querySelector(sel);
		if (contentEl) break;
	}

	if (!contentEl) return null;

	// Remove navigation/noise elements
	for (const noise of contentEl.querySelectorAll(
		"nav, .sidebar, .toc, .breadcrumb, .pagination, [role='navigation']",
	)) {
		noise.remove();
	}

	const title =
		document.querySelector("h1")?.textContent?.trim() ||
		document.querySelector("title")?.textContent?.trim() ||
		"";
	const text = contentEl.textContent?.replace(/\n{3,}/g, "\n\n").trim() || "";

	let md = `# ${title}\n\n`;
	md += `> Platform: ${platform}\n\n`;
	md += text;

	return {
		ok: true,
		url,
		title,
		content: md,
	};
}
