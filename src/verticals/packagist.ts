// ─── Packagist extractor ───────────────────────────────────────────
// Uses the Packagist public API for PHP packages.
// No API key required. Returns package metadata, versions, and dependencies.

import type { VerticalResult } from "./types.ts";

export function matchesPackagist(url: string): boolean {
	return /^https?:\/\/packagist\.org\/packages\/[^/]+\/[^/]+/i.test(url);
}

export async function extractPackagist(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/packagist\.org\/packages\/([^/?#]+\/[^/?#]+)/i);
	if (!match) return null;
	const pkgName = match[1]!;

	const data = await fetchJson(
		`https://packagist.org/packages/${encodeURIComponent(pkgName)}.json`,
	);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const pkg =
		d.package && typeof d.package === "object"
			? (d.package as Record<string, unknown>)
			: {};

	const name = String(pkg.name || pkgName);
	const description = String(pkg.description || "");
	const time = String(pkg.time || "");
	const maintainers = Array.isArray(pkg.maintainers)
		? (pkg.maintainers as Record<string, unknown>[])
		: [];
	const versionsObj =
		pkg.versions && typeof pkg.versions === "object"
			? (pkg.versions as Record<string, Record<string, unknown>>)
			: {};
	const versionKeys = Object.keys(versionsObj);
	const latestVersion = versionKeys[0];
	const latest = latestVersion ? versionsObj[latestVersion] : null;

	const homepage =
		latest && typeof latest.homepage === "string" ? latest.homepage : "";
	const repository =
		latest && typeof latest.source === "object" && latest.source !== null
			? String((latest.source as Record<string, unknown>).url || "")
			: "";
	const license =
		latest && Array.isArray(latest.license)
			? (latest.license as string[]).join(", ")
			: latest && typeof latest.license === "string"
				? latest.license
				: "";
	const type = latest && typeof latest.type === "string" ? latest.type : "";
	const keywords =
		latest && Array.isArray(latest.keywords)
			? (latest.keywords as string[])
			: latest && Array.isArray(latest.tags)
				? (latest.tags as string[])
				: [];

	let md = `# ${name}\n\n`;
	if (description) md += `> ${description}\n\n`;
	if (latestVersion) md += `- **Latest:** ${latestVersion}\n`;
	if (time) md += `- **Created:** ${time}\n`;
	if (type) md += `- **Type:** ${type}\n`;
	if (license) md += `- **License:** ${license}\n`;
	if (homepage) md += `- **Homepage:** ${homepage}\n`;
	if (repository) md += `- **Repository:** ${repository}\n`;
	if (keywords.length) md += `- **Keywords:** ${keywords.join(", ")}\n`;

	if (maintainers.length) {
		md += `- **Maintainers:** ${maintainers
			.map((m) => String(m.name || ""))
			.filter(Boolean)
			.join(", ")}\n`;
	}

	// Dependencies from latest version
	if (latest) {
		const require =
			latest.require && typeof latest.require === "object"
				? (latest.require as Record<string, string>)
				: {};
		const requireDev =
			latest["require-dev"] && typeof latest["require-dev"] === "object"
				? (latest["require-dev"] as Record<string, string>)
				: {};

		const reqEntries = Object.entries(require).filter(
			([k]) => k !== "php" && !k.startsWith("ext-"),
		);
		const phpVersion = require.php;
		const extEntries = Object.entries(require).filter(([k]) =>
			k.startsWith("ext-"),
		);

		if (phpVersion) md += `- **PHP:** ${phpVersion}\n`;
		if (extEntries.length) {
			md += `- **Extensions:** ${extEntries.map(([k, v]) => `${k.replace("ext-", "")}${v && v !== "*" ? ` (${v})` : ""}`).join(", ")}\n`;
		}

		if (reqEntries.length) {
			md += `\n## Dependencies (${reqEntries.length})\n\n`;
			for (const [depName, constraint] of reqEntries.slice(0, 30)) {
				md += `- ${depName}${constraint && constraint !== "*" ? `: ${constraint}` : ""}\n`;
			}
			if (reqEntries.length > 30)
				md += `- _… and ${reqEntries.length - 30} more_\n`;
		}

		if (Object.keys(requireDev).length) {
			md += `\n## Dev Dependencies (${Object.keys(requireDev).length})\n\n`;
			for (const [depName, constraint] of Object.entries(requireDev).slice(
				0,
				20,
			)) {
				md += `- ${depName}${constraint && constraint !== "*" ? `: ${constraint}` : ""}\n`;
			}
			if (Object.keys(requireDev).length > 20)
				md += `- _… and ${Object.keys(requireDev).length - 20} more_\n`;
		}
	}

	// Version count
	if (versionKeys.length > 1) {
		md += `\n## Versions (${versionKeys.length})\n\n`;
		for (const v of versionKeys.slice(0, 10)) {
			md += `- ${v}\n`;
		}
		if (versionKeys.length > 10)
			md += `- _… and ${versionKeys.length - 10} more_\n`;
	}

	return {
		ok: true,
		url,
		title: name,
		content: md,
	};
}
