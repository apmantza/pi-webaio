// ─── pub.dev extractor ─────────────────────────────────────────────
// Uses the pub.dev public API for Dart/Flutter packages.
// No API key required. Returns package metadata, versions, and dependencies.

import type { VerticalResult } from "./types.ts";

export function matchesPubDev(url: string): boolean {
	return /^https?:\/\/pub\.dev\/packages\/[^/]+/i.test(url);
}

export async function extractPubDev(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const match = url.match(/pub\.dev\/packages\/([^/?#]+)/i);
	if (!match) return null;
	const pkgName = match[1]!;

	const data = await fetchJson(
		`https://pub.dev/api/packages/${encodeURIComponent(pkgName)}`,
	);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const latest =
		d.latest && typeof d.latest === "object"
			? (d.latest as Record<string, unknown>)
			: null;
	const versions = Array.isArray(d.versions)
		? (d.versions as Record<string, unknown>[])
		: [];

	if (!latest) return null;

	const pubspec =
		latest.pubspec && typeof latest.pubspec === "object"
			? (latest.pubspec as Record<string, unknown>)
			: {};

	const name = String(pubspec.name || pkgName);
	const description = String(pubspec.description || "");
	const version = String(pubspec.version || latest.version || "");
	const repository = String(pubspec.repository || "");
	const homepage = String(pubspec.homepage || "");
	const documentation = String(pubspec.documentation || "");
	const issueTracker = String(pubspec.issue_tracker || "");
	const topics = Array.isArray(pubspec.topics)
		? (pubspec.topics as string[])
		: [];
	const published = String(latest.published || "");

	const deps =
		pubspec.dependencies && typeof pubspec.dependencies === "object"
			? (pubspec.dependencies as Record<string, unknown>)
			: {};
	const devDeps =
		pubspec.dev_dependencies && typeof pubspec.dev_dependencies === "object"
			? (pubspec.dev_dependencies as Record<string, unknown>)
			: {};
	const env =
		pubspec.environment && typeof pubspec.environment === "object"
			? (pubspec.environment as Record<string, string>)
			: {};

	let md = `# ${name}\n\n`;
	if (description) md += `> ${description}\n\n`;
	if (version) md += `- **Version:** ${version}\n`;
	if (published) md += `- **Published:** ${published}\n`;
	if (env.sdk) md += `- **SDK:** ${env.sdk}\n`;
	if (env.flutter) md += `- **Flutter:** ${env.flutter}\n`;
	if (repository) md += `- **Repository:** ${repository}\n`;
	if (homepage) md += `- **Homepage:** ${homepage}\n`;
	if (documentation) md += `- **Documentation:** ${documentation}\n`;
	if (issueTracker) md += `- **Issues:** ${issueTracker}\n`;
	if (topics.length) md += `- **Topics:** ${topics.join(", ")}\n`;

	const depEntries = Object.entries(deps);
	if (depEntries.length) {
		md += `\n## Dependencies (${depEntries.length})\n\n`;
		for (const [depName, spec] of depEntries.slice(0, 30)) {
			if (typeof spec === "string") {
				md += `- ${depName}${spec ? `: ${spec}` : ""}\n`;
			} else if (typeof spec === "object" && spec !== null) {
				const s = spec as Record<string, unknown>;
				if (s.sdk) {
					md += `- ${depName}: SDK ${String(s.sdk)}\n`;
				} else {
					md += `- ${depName}\n`;
				}
			} else {
				md += `- ${depName}\n`;
			}
		}
		if (depEntries.length > 30)
			md += `- _… and ${depEntries.length - 30} more_\n`;
	}

	const devDepEntries = Object.entries(devDeps);
	if (devDepEntries.length) {
		md += `\n## Dev Dependencies (${devDepEntries.length})\n\n`;
		for (const [depName, spec] of devDepEntries.slice(0, 20)) {
			if (typeof spec === "string") {
				md += `- ${depName}${spec ? `: ${spec}` : ""}\n`;
			} else {
				md += `- ${depName}\n`;
			}
		}
		if (devDepEntries.length > 20)
			md += `- _… and ${devDepEntries.length - 20} more_\n`;
	}

	if (versions.length > 1) {
		md += `\n## Versions (${versions.length})\n\n`;
		for (const v of versions.slice(-10).reverse()) {
			const ver = String(v.version || "");
			if (ver) md += `- ${ver}\n`;
		}
	}

	return {
		ok: true,
		url,
		title: name,
		content: md,
	};
}
