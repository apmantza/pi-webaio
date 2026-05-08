// ─── PyPI extractor ────────────────────────────────────────────────

import type { VerticalResult } from "./types.js";

export function matchesPyPI(url: string): boolean {
	return /^https?:\/\/pypi\.org\/project\/[^/]+/i.test(url);
}

export async function extractPyPI(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/pypi\.org\/project\/([^/]+)/i);
	if (!match) return null;
	const pkgName = match[1]!;

	const data = await fetchJson(
		`https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`,
	);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const info =
		d.info && typeof d.info === "object"
			? (d.info as Record<string, unknown>)
			: {};
	const name = String(info.name || pkgName);
	const summary = String(info.summary || "");
	const desc = String(info.description || "");
	const version = String(info.version || "");
	const author = String(info.author || "");
	const license = String(info.license || "");
	const home = String(info.home_page || "");
	const repo =
		info.project_urls && typeof info.project_urls === "object"
			? (info.project_urls as Record<string, unknown>).Source ||
				(info.project_urls as Record<string, unknown>).Homepage
			: null;
	const reqs = Array.isArray(info.requires_dist) ? info.requires_dist : [];

	let md = `# ${name}\n\n`;
	if (summary) md += `> ${summary}\n\n`;
	if (version) md += `- **Version:** ${version}\n`;
	if (author) md += `- **Author:** ${author}\n`;
	if (license) md += `- **License:** ${license}\n`;
	if (home) md += `- **Homepage:** ${home}\n`;
	if (repo) md += `- **Repository:** ${String(repo)}\n`;

	if (reqs.length) {
		md += `\n## Dependencies\n\n`;
		for (const req of reqs.slice(0, 30)) {
			md += `- ${req}\n`;
		}
		if (reqs.length > 30) md += `- _… and ${reqs.length - 30} more_\n`;
	}

	if (desc) {
		md += `\n## Description\n\n${desc.slice(0, 10000)}\n`;
	}

	return {
		ok: true,
		url,
		title: name,
		content: md,
	};
}
