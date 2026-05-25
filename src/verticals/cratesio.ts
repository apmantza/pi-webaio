// ─── crates.io extractor ───────────────────────────────────────────
// Uses the crates.io public API.
// No API key required. Returns crate metadata, versions, and dependencies.

import type { VerticalResult } from "./types.ts";

export function matchesCratesIo(url: string): boolean {
	return /^https?:\/\/crates\.io\/crates\/[^/]+/i.test(url);
}

export async function extractCratesIo(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/crates\.io\/crates\/([^/?#]+)/i);
	if (!match) return null;
	const crateName = match[1]!;

	const data = await fetchJson(
		`https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`,
	);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const crate =
		d.crate && typeof d.crate === "object"
			? (d.crate as Record<string, unknown>)
			: {};
	const versions = Array.isArray(d.versions)
		? (d.versions as Record<string, unknown>[])
		: [];

	const name = String(crate.name || crateName);
	const description = String(crate.description || "");
	const homepage = String(crate.homepage || "");
	const repository = String(crate.repository || "");
	const documentation = String(crate.documentation || "");
	const license = String(
		(versions[0]?.license as string) || crate.max_version || "",
	);
	const downloads = Number(crate.downloads || 0);
	const recentDownloads = Number(crate.recent_downloads || 0);
	const newestVersion = String(crate.newest_version || "");
	const keywords = Array.isArray(crate.keywords)
		? (crate.keywords as string[])
		: [];
	const categories = Array.isArray(crate.categories)
		? (crate.categories as string[])
		: [];

	let md = `# ${name}\n\n`;
	if (description) md += `> ${description}\n\n`;
	if (newestVersion) md += `- **Latest:** ${newestVersion}\n`;
	if (downloads)
		md += `- **Downloads:** ${downloads.toLocaleString()} total${recentDownloads ? ` (${recentDownloads.toLocaleString()} recent)` : ""}\n`;
	if (license) md += `- **License:** ${license}\n`;
	if (homepage) md += `- **Homepage:** ${homepage}\n`;
	if (repository) md += `- **Repository:** ${repository}\n`;
	if (documentation) md += `- **Docs:** ${documentation}\n`;
	if (keywords.length) md += `- **Keywords:** ${keywords.join(", ")}\n`;
	if (categories.length) md += `- **Categories:** ${categories.join(", ")}\n`;

	// Latest version dependencies
	const latest = versions[0];
	if (latest && typeof latest === "object") {
		const deps =
			latest.dependencies && typeof latest.dependencies === "object"
				? (latest.dependencies as Record<string, unknown>[])
				: [];
		if (deps.length) {
			md += `\n## Dependencies (${deps.length})\n\n`;
			for (const dep of deps.slice(0, 30)) {
				const depName = String(dep.crate_id || dep.name || "");
				const req = String(dep.req || "");
				const kind = String(dep.kind || "normal");
				if (depName) {
					md += `- ${depName}${req ? ` (${req})` : ""}${kind !== "normal" ? ` [${kind}]` : ""}\n`;
				}
			}
			if (deps.length > 30) md += `- _… and ${deps.length - 30} more_\n`;
		}
	}

	// Version history
	if (versions.length > 1) {
		md += `\n## Versions (${versions.length})\n\n`;
		for (const v of versions.slice(0, 10)) {
			const ver = String(v.num || "");
			const yanked = v.yanked ? " ⚠️ yanked" : "";
			if (ver) md += `- ${ver}${yanked}\n`;
		}
		if (versions.length > 10) md += `- _… and ${versions.length - 10} more_\n`;
	}

	return {
		ok: true,
		url,
		title: name,
		content: md,
	};
}
