// ─── Go packages extractor ─────────────────────────────────────────
// Uses the Go module proxy (proxy.golang.org) for metadata.
// No API key required. Returns module info, versions, and origin details.

import type { VerticalResult } from "./types.ts";

export function matchesGoPackages(url: string): boolean {
	return /^https?:\/\/pkg\.go\.dev\/[^/]+/i.test(url);
}

export async function extractGoPackages(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
	fetchText: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	// Extract module path from pkg.go.dev URL
	// e.g. https://pkg.go.dev/github.com/gin-gonic/gin
	const match = url.match(/pkg\.go\.dev\/([^?#]+)/i);
	if (!match) return null;
	const modulePath = match[1]!;

	// Fetch latest version info from Go proxy
	const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@latest`;
	const data = await fetchJson(proxyUrl);

	let version = "";
	let publishTime = "";
	let vcs = "";
	let repoUrl = "";
	let hash = "";

	if (data && typeof data === "object") {
		const d = data as Record<string, unknown>;
		version = String(d.Version || "");
		publishTime = String(d.Time || "");
		const origin =
			typeof d.Origin === "object" && d.Origin !== null
				? (d.Origin as Record<string, unknown>)
				: null;
		if (origin) {
			vcs = String(origin.VCS || "");
			repoUrl = String(origin.URL || "");
			hash = String(origin.Hash || "");
		}
	}

	// If proxy fails, try to extract basic info from the HTML page
	let docHtml = "";
	if (!version) {
		const html = await fetchText(url);
		if (html) {
			docHtml = html;
			// Try to extract version from HTML
			const versionMatch = html.match(/data-version="([^"]+)"/i);
			if (versionMatch) version = versionMatch[1]!;
			// Try to extract module path
			const pathMatch = html.match(/<code[^>]*>([^<]+)<\/code>/i);
			if (pathMatch && !modulePath.includes("/")) {
				// fallback
			}
		}
	}

	if (!version && !docHtml) {
		return null;
	}

	// Try to fetch version list
	const versionsUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@v/list`;
	const versionsText = await fetchText(versionsUrl);
	const versions = versionsText
		? versionsText
				.trim()
				.split("\n")
				.filter((v) => v.startsWith("v"))
				.sort((a, b) => {
					// Simple semver-ish sort (reverse)
					const ap = a.replace(/^v/, "").split(".").map(Number);
					const bp = b.replace(/^v/, "").split(".").map(Number);
					for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
						const av = ap[i] || 0;
						const bv = bp[i] || 0;
						if (av !== bv) return bv - av;
					}
					return 0;
				})
		: [];

	let md = `# ${modulePath}\n\n`;
	if (version) md += `- **Latest:** ${version}\n`;
	if (publishTime) md += `- **Published:** ${publishTime}\n`;
	if (vcs) md += `- **VCS:** ${vcs}\n`;
	if (repoUrl) md += `- **Repository:** ${repoUrl}\n`;
	if (hash) md += `- **Commit:** \`${hash.slice(0, 12)}\`\n`;
	md += `- **Module:** \`${modulePath}\`\n`;
	md += `- **Go get:** \`go get ${modulePath}\`\n`;

	if (versions.length > 0) {
		md += `\n## Versions (${versions.length})\n\n`;
		for (const v of versions.slice(0, 15)) {
			md += `- ${v}\n`;
		}
		if (versions.length > 15) md += `- _… and ${versions.length - 15} more_\n`;
	}

	// If we have HTML, try to extract package synopsis/description
	if (docHtml) {
		const synopsisMatch = docHtml.match(
			/<meta\s+name="go-description"\s+content="([^"]*)"/i,
		);
		if (synopsisMatch && synopsisMatch[1]) {
			md += `\n## Description\n\n${synopsisMatch[1]}\n`;
		} else {
			// Try to find first paragraph in documentation
			const docMatch = docHtml.match(
				/<div[^>]*class="Documentation[^"]*"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i,
			);
			if (docMatch && docMatch[1]) {
				const desc = stripTags(docMatch[1]).replace(/\s+/g, " ").trim();
				if (desc.length > 20) {
					md += `\n## Description\n\n${desc.slice(0, 500)}\n`;
				}
			}
		}
	}

	return {
		ok: true,
		url,
		title: modulePath,
		content: md,
	};
}

// Loop until stable to prevent incomplete multi-character sanitization
// (CodeQL S5852).
function stripTags(s: string): string {
	let prev: string;
	do {
		prev = s;
		s = s.replace(/<[^>]*>/g, "");
	} while (s !== prev);
	return s;
}
