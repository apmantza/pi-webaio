// ─── RubyGems extractor ────────────────────────────────────────────
// Uses the RubyGems.org public API.
// No API key required. Returns gem metadata, dependencies, and links.

import type { VerticalResult } from "./types.ts";

export function matchesRubyGems(url: string): boolean {
	return /^https?:\/\/rubygems\.org\/gems\/[^/]+/i.test(url);
}

export async function extractRubyGems(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/rubygems\.org\/gems\/([^/?#]+)/i);
	if (!match) return null;
	const gemName = match[1]!;

	const data = await fetchJson(
		`https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`,
	);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const name = String(d.name || gemName);
	const version = String(d.version || "");
	const info = String(d.info || "");
	const authors = String(d.authors || "");
	const licenses = Array.isArray(d.licenses)
		? (d.licenses as string[])
		: d.licenses
			? [String(d.licenses)]
			: [];
	const downloads = Number(d.downloads || 0);
	const versionDownloads = Number(d.version_downloads || 0);
	const homepageUri = String(d.homepage_uri || "");
	const sourceCodeUri = String(d.source_code_uri || "");
	const documentationUri = String(d.documentation_uri || "");
	const bugTrackerUri = String(d.bug_tracker_uri || "");
	const wikiUri = String(d.wiki_uri || "");
	const changelogUri = String(d.changelog_uri || "");
	const projectUri = String(d.project_uri || "");
	const yanked = Boolean(d.yanked);

	const deps =
		d.dependencies && typeof d.dependencies === "object"
			? (d.dependencies as Record<string, Record<string, unknown>[]>)
			: {};
	const runtimeDeps = deps.runtime || [];
	const devDeps = deps.development || [];

	let md = `# ${name}\n\n`;
	if (info) md += `> ${info}\n\n`;
	if (yanked) md += `⚠️ **This gem has been yanked.**\n\n`;
	if (version) md += `- **Version:** ${version}\n`;
	if (authors) md += `- **Author(s):** ${authors}\n`;
	if (licenses.length) md += `- **License:** ${licenses.join(", ")}\n`;
	if (downloads)
		md += `- **Downloads:** ${downloads.toLocaleString()} total${versionDownloads ? ` (${versionDownloads.toLocaleString()} this version)` : ""}\n`;
	if (homepageUri) md += `- **Homepage:** ${homepageUri}\n`;
	if (sourceCodeUri) md += `- **Repository:** ${sourceCodeUri}\n`;
	if (documentationUri) md += `- **Docs:** ${documentationUri}\n`;
	if (bugTrackerUri) md += `- **Issues:** ${bugTrackerUri}\n`;
	if (wikiUri) md += `- **Wiki:** ${wikiUri}\n`;
	if (changelogUri) md += `- **Changelog:** ${changelogUri}\n`;
	if (projectUri) md += `- **RubyGems:** ${projectUri}\n`;

	if (runtimeDeps.length) {
		md += `\n## Runtime Dependencies (${runtimeDeps.length})\n\n`;
		for (const dep of runtimeDeps.slice(0, 30)) {
			const depName = String(dep.name || "");
			const req = String(dep.requirements || "");
			if (depName) md += `- ${depName}${req ? ` (${req})` : ""}\n`;
		}
		if (runtimeDeps.length > 30)
			md += `- _… and ${runtimeDeps.length - 30} more_\n`;
	}

	if (devDeps.length) {
		md += `\n## Development Dependencies (${devDeps.length})\n\n`;
		for (const dep of devDeps.slice(0, 20)) {
			const depName = String(dep.name || "");
			const req = String(dep.requirements || "");
			if (depName) md += `- ${depName}${req ? ` (${req})` : ""}\n`;
		}
		if (devDeps.length > 20) md += `- _… and ${devDeps.length - 20} more_\n`;
	}

	return {
		ok: true,
		url,
		title: name,
		content: md,
	};
}
