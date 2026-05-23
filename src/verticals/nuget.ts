// ─── NuGet extractor ───────────────────────────────────────────────
// Uses the NuGet Search API (v3).
// No API key required. Returns package metadata, versions, and dependencies.

import type { VerticalResult } from "./types.js";

export function matchesNuGet(url: string): boolean {
	return /^https?:\/\/www\.nuget\.org\/packages\/[^/]+/i.test(url);
}

export async function extractNuGet(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/nuget\.org\/packages\/([^/?#]+)/i);
	if (!match) return null;
	const pkgName = match[1]!;

	// Use NuGet search API to find the package
	const searchUrl = `https://azuresearch-usnc.nuget.org/query?q=packageid:${encodeURIComponent(pkgName)}&prerelease=false`;
	const searchData = await fetchJson(searchUrl);

	if (!searchData || typeof searchData !== "object") return null;
	const sd = searchData as Record<string, unknown>;
	const data = Array.isArray(sd.data)
		? (sd.data as Record<string, unknown>[])
		: [];
	if (data.length === 0) return null;

	const pkg = data[0]!;
	const id = String(pkg.id || pkgName);
	const version = String(pkg.version || "");
	const description = String(pkg.description || "");
	const summary = String(pkg.summary || "");
	const authors = String((pkg.authors as string) || "");
	const owners = Array.isArray(pkg.owners)
		? (pkg.owners as string[])
		: String(pkg.owners || "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	const totalDownloads = Number(pkg.totalDownloads || 0);
	const verified = Boolean(pkg.verified);
	const projectUrl = String(pkg.projectUrl || "");
	const licenseUrl = String(pkg.licenseUrl || "");
	const iconUrl = String(pkg.iconUrl || "");
	const tags = Array.isArray(pkg.tags) ? (pkg.tags as string[]) : [];
	const registration = String(pkg.registration || "");

	const versions = Array.isArray(pkg.versions)
		? (pkg.versions as Record<string, unknown>[])
		: [];

	let md = `# ${id}\n\n`;
	if (description) md += `> ${description}\n\n`;
	else if (summary) md += `> ${summary}\n\n`;
	if (verified) md += `✅ **Verified package**\n\n`;
	if (version) md += `- **Version:** ${version}\n`;
	if (totalDownloads)
		md += `- **Downloads:** ${totalDownloads.toLocaleString()}\n`;
	if (authors) md += `- **Authors:** ${authors}\n`;
	if (owners.length) md += `- **Owners:** ${owners.join(", ")}\n`;
	if (projectUrl) md += `- **Project:** ${projectUrl}\n`;
	if (licenseUrl) md += `- **License:** ${licenseUrl}\n`;
	if (tags.length) md += `- **Tags:** ${tags.join(", ")}\n`;
	if (registration) md += `- **NuGet:** ${registration}\n`;
	if (iconUrl) {
		md += `\n![Icon](${iconUrl})\n`;
	}

	if (versions.length > 0) {
		md += `\n## Versions (${versions.length})\n\n`;
		for (const v of versions.slice(-15)) {
			const ver = String(v.version || "");
			const downloads = Number(v.downloads || 0);
			if (ver)
				md += `- ${ver}${downloads ? ` — ${downloads.toLocaleString()} downloads` : ""}\n`;
		}
		if (versions.length > 15) md += `- _… and ${versions.length - 15} more_\n`;
	}

	return {
		ok: true,
		url,
		title: id,
		content: md,
	};
}
