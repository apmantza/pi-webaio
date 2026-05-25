// ─── npm registry extractor ────────────────────────────────────────

import type { VerticalResult } from "./types.ts";

export function matchesNpm(url: string): boolean {
	return /^https?:\/\/www\.npmjs\.com\/package\/[^/]+/i.test(url);
}

export async function extractNpm(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/npmjs\.com\/package\/([^/]+)/i);
	if (!match) return null;
	const pkgName = match[1]!;

	const data = await fetchJson(
		`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`,
	);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const name = String(d.name || pkgName);
	const desc = String(d.description || "");
	const latest =
		d["dist-tags"] && typeof d["dist-tags"] === "object"
			? (d["dist-tags"] as Record<string, unknown>).latest
			: null;
	const latestVer = latest ? String(latest) : null;
	const versions =
		d.versions && typeof d.versions === "object" ? Object.keys(d.versions) : [];
	const homepage = String(d.homepage || "");
	const repo =
		d.repository && typeof d.repository === "object"
			? (d.repository as Record<string, unknown>).url
			: null;
	const license = String(d.license || "");
	const keywords = Array.isArray(d.keywords) ? d.keywords : [];

	let md = `# ${name}\n\n`;
	if (desc) md += `> ${desc}\n\n`;
	if (latestVer) md += `- **Latest:** ${latestVer}\n`;
	if (versions.length) md += `- **Versions:** ${versions.length} total\n`;
	if (homepage) md += `- **Homepage:** ${homepage}\n`;
	if (repo) md += `- **Repository:** ${String(repo)}\n`;
	if (license) md += `- **License:** ${license}\n`;
	if (keywords.length) md += `- **Keywords:** ${keywords.join(", ")}\n`;

	const latestData =
		latestVer && d.versions && typeof d.versions === "object"
			? (d.versions as Record<string, unknown>)[latestVer]
			: null;
	if (latestData && typeof latestData === "object") {
		const ld = latestData as Record<string, unknown>;
		const deps =
			ld.dependencies && typeof ld.dependencies === "object"
				? Object.keys(ld.dependencies)
				: [];
		if (deps.length) {
			md += `\n## Dependencies (${deps.length})\n\n`;
			for (const dep of deps.slice(0, 30)) {
				const v = (ld.dependencies as Record<string, string>)[dep];
				md += `- ${dep}: ${v}\n`;
			}
			if (deps.length > 30) md += `- _… and ${deps.length - 30} more_\n`;
		}
	}

	return {
		ok: true,
		url,
		title: name,
		content: md,
	};
}
