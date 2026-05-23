// ─── GitLab extractor ──────────────────────────────────────────────
// Uses the GitLab REST API (v4) for gitlab.com and self-hosted instances.
// No API key required for public repos. Returns project metadata,
// file content, or directory listings.

import type { VerticalResult } from "./types.js";

// ─── URL parsing ────────────────────────────────────────────────────

interface GitLabRef {
	host: string;
	namespace: string;
	project: string;
	path?: string;
	ref?: string;
	type: "repo" | "blob" | "tree";
}

function parseGitLabUrl(url: string): GitLabRef | null {
	// 1. Try blob/tree URLs first (more specific)
	const blobTreeMatch = url.match(
		/^https?:\/\/([^/]+)\/(.+?)\/(-\/blob\/|-\/tree\/)([^/]+)(?:\/(.+))?$/i,
	);
	if (blobTreeMatch) {
		const [, host, projectPath, actionType, ref, filePath] = blobTreeMatch;
		// projectPath is everything before /-/blob/ or /-/tree/
		// Split into namespace (all but last segment) and project (last segment)
		const parts = projectPath.split("/");
		if (parts.length < 2) return null;
		const project = parts.pop()!;
		const namespace = parts.join("/");

		if (project.startsWith("-")) return null;

		const type = actionType === "-/blob/" ? "blob" : "tree";
		return { host, namespace, project, ref, path: filePath, type };
	}

	// 2. Try repo root URLs
	const repoMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)\/([^/]+)\/?$/i);
	if (repoMatch) {
		const [, host, namespace, project] = repoMatch;
		if (project.startsWith("-")) return null;
		if (/\.(png|jpg|jpeg|gif|svg|pdf|zip|tar|gz)$/i.test(project)) return null;

		// Reject extra paths that aren't GitLab actions (e.g. /issues, /merge_requests)
		const remaining = url.slice(
			`https://${host}/${namespace}/${project}`.length,
		);
		if (remaining && remaining !== "/" && !remaining.startsWith("/-/")) {
			return null;
		}

		return { host, namespace, project, type: "repo" };
	}

	return null;
}

function encodeProjectId(ref: GitLabRef): string {
	return encodeURIComponent(`${ref.namespace}/${ref.project}`);
}

function apiBase(host: string): string {
	return `https://${host}/api/v4`;
}

// ─── Matching ───────────────────────────────────────────────────────

export function matchesGitLab(url: string): boolean {
	return parseGitLabUrl(url) !== null;
}

// ─── Extraction ─────────────────────────────────────────────────────

export async function extractGitLab(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
	fetchText: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	const ref = parseGitLabUrl(url);
	if (!ref) return null;

	switch (ref.type) {
		case "blob":
			return fetchGitLabBlob(ref, fetchText);
		case "tree":
			return fetchGitLabTree(ref, fetchJson);
		case "repo":
			return fetchGitLabRepo(ref, fetchJson, fetchText);
	}
}

async function fetchGitLabBlob(
	ref: GitLabRef,
	fetchText: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	const projectId = encodeProjectId(ref);
	const branch = ref.ref || "master";
	const filePath = ref.path || "";
	const rawUrl = `${apiBase(ref.host)}/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(branch)}`;

	const text = await fetchText(rawUrl);
	if (!text) return null;

	const filename = filePath.split("/").pop() || filePath;
	return {
		ok: true,
		url: `https://${ref.host}/${ref.namespace}/${ref.project}/-/blob/${branch}/${filePath}`,
		title: filename,
		content: `> via GitLab\n\n\`\`\`${filename.split(".").pop() || ""}\n${text}\n\`\`\``,
	};
}

async function fetchGitLabTree(
	ref: GitLabRef,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const projectId = encodeProjectId(ref);
	const branch = ref.ref || "master";
	const treePath = ref.path || "";
	const treeUrl =
		`${apiBase(ref.host)}/projects/${projectId}/repository/tree?` +
		`ref=${encodeURIComponent(branch)}&path=${encodeURIComponent(treePath)}&per_page=50`;

	const data = await fetchJson(treeUrl);
	if (!data || !Array.isArray(data)) return null;

	const items = data as Record<string, unknown>[];

	let md = `# ${ref.namespace}/${ref.project}\n\n`;
	md += `> Branch: \`${branch}\`\n\n`;
	if (treePath) md += `> Path: \`${treePath}\`\n\n`;
	md += `## Directory Contents (${items.length})\n\n`;

	for (const item of items) {
		const name = String(item.name || "");
		const type = String(item.type || "");
		const icon = type === "tree" ? "📁" : "📄";
		md += `- ${icon} ${name}${type === "tree" ? "/" : ""}\n`;
	}

	return {
		ok: true,
		url: `https://${ref.host}/${ref.namespace}/${ref.project}/-/tree/${branch}/${treePath}`,
		title: `${ref.namespace}/${ref.project}`,
		content: md,
	};
}

async function fetchGitLabRepo(
	ref: GitLabRef,
	fetchJson: (url: string) => Promise<unknown | null>,
	fetchText: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	const projectId = encodeProjectId(ref);
	const base = apiBase(ref.host);

	// Fetch project info
	const projectUrl = `${base}/projects/${projectId}`;
	const projectData = await fetchJson(projectUrl);
	if (!projectData || typeof projectData !== "object") return null;

	const p = projectData as Record<string, unknown>;
	const name = String(p.name || ref.project);
	const description = String(p.description || "");
	const defaultBranch = String(p.default_branch || "master");
	const starCount = Number(p.star_count || 0);
	const forksCount = Number(p.forks_count || 0);
	const webUrl = String(p.web_url || "");
	const httpUrl = String(p.http_url_to_repo || "");
	const readmeUrl = String(p.readme_url || "");
	const topics = Array.isArray(p.topics) ? (p.topics as string[]) : [];
	const visibility = String(p.visibility || "");
	const lastActivity = String(p.last_activity_at || "");
	const namespace =
		p.namespace && typeof p.namespace === "object"
			? (p.namespace as Record<string, unknown>)
			: null;
	const groupName = namespace ? String(namespace.name || "") : "";

	let md = `# ${name}\n\n`;
	if (description) md += `> ${description}\n\n`;
	md += `- **Namespace:** ${groupName || ref.namespace}\n`;
	md += `- **Project:** ${ref.project}\n`;
	if (visibility) md += `- **Visibility:** ${visibility}\n`;
	md += `- **Default branch:** \`${defaultBranch}\`\n`;
	if (starCount) md += `- **Stars:** ${starCount.toLocaleString()}\n`;
	if (forksCount) md += `- **Forks:** ${forksCount.toLocaleString()}\n`;
	if (lastActivity) md += `- **Last activity:** ${lastActivity}\n`;
	if (httpUrl) md += `- **Clone:** \`${httpUrl}\`\n`;
	if (webUrl) md += `- **Web:** ${webUrl}\n`;
	if (topics.length) md += `- **Topics:** ${topics.join(", ")}\n`;

	// Try to fetch README
	if (readmeUrl) {
		const readmePath = `README.md`;
		const readmeRawUrl = `${base}/projects/${projectId}/repository/files/${encodeURIComponent(readmePath)}/raw?ref=${encodeURIComponent(defaultBranch)}`;
		const readmeText = await fetchText(readmeRawUrl);
		if (readmeText) {
			md += `\n---\n\n${readmeText}\n`;
		}
	}

	return {
		ok: true,
		url: webUrl || `https://${ref.host}/${ref.namespace}/${ref.project}`,
		title: name,
		content: md,
	};
}
