import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { smartFetch } from "./fetch.ts";
import {
	ghFetch,
	getGithubToken,
	ghRunLogs,
	ghFetchWithFallback,
} from "./github-api.ts";
import { BASE_TEMP } from "./session-store.ts";
import type { GitHubRef, PullResult } from "./types.ts";
import { resolveBinary } from "./tools/utils.ts";

export function parseGitHubUrl(url: string): GitHubRef | null {
	const m = url.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?(?:\/(?!tree\/|blob\/)(.*))?/i,
	);
	if (!m) return null;
	const [, owner, repo, ghType, ref, path, extra] = m;

	// Non-tree/non-blob path after repo (e.g. /issues, /security/code-scanning)
	// → don't treat as a repo; let the regular web fetch pipeline handle it
	if (!ghType && extra) return null;

	if (ghType === "blob") return { owner, repo, ref, path, type: "blob" };
	if (ghType === "tree") return { owner, repo, ref, path, type: "tree" };
	return { owner, repo, type: "repo" };
}

// Map GitHub URL paths → REST API endpoints (gh api format with {owner}/{repo} placeholders)
// gh api expands {owner}/{repo}/{branch} from the current repo context.
// We use explicit /repos/:owner/:repo paths since we're not in a git repo.
const GH_FEATURE_API_MAP: Record<string, string> = {
	// Issues & PRs
	issues: "/issues?state=all&per_page=20",
	pulls: "/pulls?state=all&per_page=20",

	// Actions
	actions: "/actions/runs?per_page=20",

	// Security
	"code-scanning": "/code-scanning/alerts?state=open&per_page=30",
	"secret-scanning": "/secret-scanning/alerts?state=open&per_page=30",
	dependabot: "/dependabot/alerts?state=open&per_page=30",

	// Releases & tags
	releases: "/releases?per_page=20",
	tags: "/tags?per_page=30",

	// Repo info
	branches: "/branches?per_page=30",
	commits: "/commits?per_page=20",
	forks: "/forks?per_page=20",
	stargazers: "/stargazers?per_page=20",
	watchers: "/subscribers?per_page=20",
	contributors: "/contributors?per_page=20",
	labels: "/labels?per_page=30",
	milestones: "/milestones?per_page=20",
	projects: "/projects?per_page=20",
	deployments: "/deployments?per_page=20",

	// Not available via REST API (GraphQL or no API)
	// discussions, wiki, settings, network, community, graphs
};

// ─── SonarCloud API handler ─────────────────────────────────

/** Parse a raw.githubusercontent.com URL into owner/repo/branch/path. */
function parseRawGitHubUrl(
	url: string,
): { owner: string; repo: string; branch: string; path: string } | null {
	const m = url.match(
		/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/i,
	);
	if (!m) return null;
	return { owner: m[1]!, repo: m[2]!, branch: m[3]!, path: m[4]! };
}

export function parseGitHubActionsLogsApiUrl(
	url: string,
): { owner: string; repo: string; runId: string } | null {
	try {
		const u = new URL(url);
		if (u.hostname !== "api.github.com") return null;
		const m = u.pathname.match(
			/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/logs$/,
		);
		if (!m) return null;
		return { owner: m[1]!, repo: m[2]!, runId: m[3]! };
	} catch {
		return null;
	}
}

async function pullGitHubActionsLogs(
	url: string,
	owner: string,
	repo: string,
	runId: string,
): Promise<PullResult | null> {
	try {
		const logText: string | null = await ghRunLogs(owner, repo, runId);
		if (!logText) {
			// gh CLI unavailable or failed — try authenticated API call.
			// The /logs endpoint redirects to a zip archive; gh api follows
			// redirects with auth, but returns raw bytes. We skip this path
			// unless the caller can decode zip, so plain-text ghRunLogs is
			// the only supported route.
			return null;
		}

		const excerpt = extractLogExcerpt(logText);
		let md = `# ${owner}/${repo} — Actions run #${runId} logs\n\n`;
		md += `> via GitHub API + gh CLI\n\n`;
		md += `\`\`\`\n${excerpt}\n\`\`\`\n`;

		try {
			const safeOwner = owner.replace(/[^a-z0-9_-]/gi, "_");
			const safeRepo = repo.replace(/[^a-z0-9_-]/gi, "_");
			const outDir = `${BASE_TEMP}/github-logs/${safeOwner}-${safeRepo}`;
			const fs = await import("node:fs/promises");
			await fs.mkdir(outDir, { recursive: true });
			const outFile = `${outDir}/run-${runId}.log`;
			await fs.writeFile(outFile, logText, "utf8");
			md += `\n<details>\n<summary>📋 Full log saved to disk</summary>\n\n`;
			md += `\`${outFile}\` (${logText.length.toLocaleString()} chars)\n`;
			md += `</details>\n`;
		} catch {
			/* best effort */
		}

		return {
			ok: true,
			url,
			title: `${owner}/${repo} — Actions run #${runId}`,
			content: md,
		};
	} catch {
		return null;
	}
}

export async function pullGitHub(url: string): Promise<PullResult | null> {
	// Handle api.github.com actions logs endpoint (requires auth)
	const apiLogs = parseGitHubActionsLogsApiUrl(url);
	if (apiLogs) {
		return pullGitHubActionsLogs(
			url,
			apiLogs.owner,
			apiLogs.repo,
			apiLogs.runId,
		);
	}

	// Try standard GitHub pipeline (tree/blob/repo)
	const ref = parseGitHubUrl(url);
	if (ref) {
		return pullGitHubRef(ref);
	}

	// Feature page? Try GitHub API (works unauthenticated for public repos)
	const featureResult = await pullGitHubFeature(url);
	if (featureResult) return featureResult;

	// raw.githubusercontent.com URLs — route directly to raw file fetch
	const rawRef = parseRawGitHubUrl(url);
	if (rawRef) {
		const { owner, repo, branch, path } = rawRef;
		// fetchGitHubRaw expects a GitHubRef-like object, but we can call smartFetch directly
		const res = await smartFetch(url);
		if (res?.status && res.status < 400) {
			return {
				ok: true,
				url,
				title: path.split("/").pop() || path,
				content: "> via GitHub\n\n" + res.text,
			};
		}
		// Fallback: try normal fetch pipeline — will include source
		const fallback = await fetchGitHubRaw(owner, repo, branch, path);
		if (fallback.ok) {
			fallback.content = "> via GitHub\n\n" + (fallback.content ?? "");
			return fallback;
		}
	}

	return null;
}

async function pullGitHubRef(ref: GitHubRef): Promise<PullResult | null> {
	let result: PullResult | null = null;
	switch (ref.type) {
		case "blob":
			result = await fetchGitHubRaw(
				ref.owner,
				ref.repo,
				ref.ref || "main",
				ref.path || "",
			);
			break;
		case "tree":
			result = await fetchGitHubTree(ref);
			break;
		case "repo":
			result = await fetchGitHubRepo(ref);
			break;
	}
	// Add source marker so webfetch's AI summarization knows to skip
	if (result?.ok && result.content) {
		result.content = "> via GitHub\n\n" + result.content;
	}
	return result;
}

/**
 * Parse a check run / job log URL into structured components.
 * Handles:
 *   /commit/{sha}/checks/{check_id}/logs
 *   /commit/{sha}/checks/{check_id}/logs/{step_index}
 */
export function parseGitHubCheckLogUrl(url: string): {
	owner: string;
	repo: string;
	sha: string;
	checkId: string;
	step: string | null;
} | null {
	try {
		const u = new URL(url);
		if (u.hostname !== "github.com") return null;
		const m = u.pathname.match(
			/^\/([^/]+)\/([^/]+)\/commit\/([^/]+)\/checks\/(\d+)(?:\/logs(?:\/(.+))?)?$/i,
		);
		if (!m) return null;
		return {
			owner: m[1]!,
			repo: m[2]!,
			sha: m[3]!,
			checkId: m[4]!,
			step: m[5] || null,
		};
	} catch {
		return null;
	}
}

/**
 * Extract the last 15 error lines (or last 50 lines if no errors) from
 * a CI log. Mirrors the behavior of the existing /actions/runs/{id}/job/{id}
 * failed-job-log excerpt in pullGitHubFeature.
 */
function extractLogExcerpt(logText: string, maxLen = 3000): string {
	if (!logText) return "";
	const lines = logText.split("\n");
	const errorLines = lines.filter((l) =>
		/error|fail|exception|traceback|Error|FAIL|panic|undefined/i.test(l),
	);
	const tail = errorLines.length > 0 ? errorLines.slice(-15) : lines.slice(-50);
	const excerpt = tail.join("\n");
	return excerpt.length > maxLen
		? excerpt.slice(0, maxLen) + "\n… (truncated)"
		: excerpt;
}

/**
 * Escape a string for safe inclusion in a markdown table cell.
 *
 * Order matters: backslashes must be escaped BEFORE the meta-character
 * (pipe), otherwise the escape we add for the meta-character will itself
 * be re-escaped by the backslash pass. We also collapse newlines into
 * spaces so a single cell can't break the table row.
 *
 * CodeQL `js/incomplete-sanitization` will flag any single-pass replace
 * that escapes one meta-character without also handling backslashes.
 * Use this helper instead of inline `.replace(/\|/g, "\\|")` calls.
 */
export function escapeMarkdownTableCell(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\n/g, " ");
}

/**
 * Extract the step name from a tab-separated log line. `gh run view --log`
 * output prepends each line with `<step_name>\t` so the tool can identify
 * which step produced each line. Returns null if the line doesn't have a
 * tab-separated step prefix.
 */
function getStepNameFromLogLine(line: string): string | null {
	if (!line) return null;
	const tabIdx = line.indexOf("\t");
	if (tabIdx <= 0) return null;
	return line.slice(0, tabIdx);
}

/**
 * Filter a tab-separated CI log to the section belonging to a specific step.
 * `gh run view --log --job <id>` produces output where every line is
 * `<step_name>\t<status>\t<timestamp>\t<log content>`. To find a step's
 * section, we find the first line with that step name and slice up to the
 * next line with a different step name (or end of log). Returns the
 * original log unchanged if the step name isn't found.
 */
export function filterLogByStepName(logText: string, stepName: string): string {
	if (!logText || !stepName) return logText;
	const lines = logText.split("\n");
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (getStepNameFromLogLine(lines[i]!) === stepName) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return logText;
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const name = getStepNameFromLogLine(lines[i]!);
		if (name && name !== stepName) {
			endIdx = i;
			break;
		}
	}
	return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Get the ordered list of unique step names from a tab-separated log.
 * Used as a final fallback when the API doesn't return step metadata.
 * The 1-based index in the returned array corresponds to the URL's
 * `/logs/{step}` index.
 */
export function getStepNamesInOrder(logText: string): string[] {
	if (!logText) return [];
	const lines = logText.split("\n");
	const seen = new Set<string>();
	const result: string[] = [];
	for (const line of lines) {
		const name = getStepNameFromLogLine(line);
		if (name && !seen.has(name)) {
			seen.add(name);
			result.push(name);
		}
	}
	return result;
}

/**
 * Fallback step filter for logs that use `##[group]Run <step_name>`
 * markers (older Actions format or the raw web UI rendering). Finds the
 * section between the matching group marker and the next one. Returns
 * the original log unchanged if no matching marker is found.
 */
export function filterLogByGroupMarker(
	logText: string,
	stepIndex: string | null,
): string {
	if (!logText || !stepIndex) return logText;
	const lines = logText.split("\n");
	const wantNum = parseInt(stepIndex, 10);
	if (!Number.isFinite(wantNum) || wantNum <= 0) return logText;
	const groupRegex = /^##\[group\](.+?)(?:\s|$)/;
	const groupPositions: Array<{ idx: number; name: string; num: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(groupRegex);
		if (m) {
			groupPositions.push({
				idx: i,
				name: m[1]!.trim(),
				num: groupPositions.length + 1,
			});
		}
	}
	if (groupPositions.length === 0) return logText;
	const target = groupPositions.find((g) => g.num === wantNum);
	if (!target) return logText;
	const start = target.idx;
	const nextGroup = groupPositions.find((g) => g.idx > start);
	const end = nextGroup ? nextGroup.idx : lines.length;
	return lines.slice(start, end).join("\n");
}

/**
 * Fetch and render a GitHub check run log. Handles:
 *   - Actions check runs (uses gh CLI for plain-text logs, falls back to API)
 *   - External CI apps (renders check metadata + annotations, no log)
 *
 * URL pattern: /commit/{sha}/checks/{check_id}/logs/{step_index?}
 */
async function pullGitHubCheckLog(
	url: string,
	owner: string,
	repo: string,
	sha: string,
	checkId: string,
	stepIndex: string | null,
): Promise<PullResult | null> {
	try {
		// 1. Fetch check run metadata (with fallback to gh API on auth issues)
		let checkRun: any;
		try {
			checkRun = await ghFetchWithFallback<any>(
				`/repos/${owner}/${repo}/check-runs/${checkId}`,
			);
		} catch {
			return null;
		}
		if (!checkRun || checkRun.message) return null; // 404

		// 2. Determine if this is an Actions job
		const isActions = checkRun.app?.slug === "github-actions";
		const conclusion = checkRun.conclusion;
		const status = checkRun.status;

		// 3. Build the markdown header
		let md = `# ${owner}/${repo} — check/${checkId}\n\n`;
		md += `> via GitHub API${isActions ? " + gh CLI" : ""}\n\n`;
		const statusIcon =
			conclusion === "success"
				? "✅"
				: conclusion === "failure"
					? "❌"
					: conclusion === "cancelled"
						? "⏹️"
						: status === "in_progress"
							? "🔄"
							: "⏳";
		md += `${statusIcon} **${checkRun.name}** (${status} / ${conclusion || "pending"})\n`;
		md += `- **Commit:** \`${sha.slice(0, 7)}\`\n`;
		if (checkRun.started_at) md += `- **Started:** ${checkRun.started_at}\n`;
		if (checkRun.completed_at)
			md += `- **Completed:** ${checkRun.completed_at}\n`;
		if (checkRun.check_suite?.id)
			md += `- **Check suite:** #${checkRun.check_suite.id}\n`;
		if (stepIndex) md += `- **Step:** #${stepIndex}\n`;
		if (checkRun.html_url) md += `- [View on GitHub](${checkRun.html_url})\n`;

		// 4. Annotations (if any)
		if (checkRun.output?.annotations_count > 0) {
			try {
				const annotations = (await ghFetchWithFallback<any[]>(
					`/repos/${owner}/${repo}/check-runs/${checkId}/annotations`,
				)) as any[];
				if (annotations?.length) {
					md += `\n## Annotations (${annotations.length})\n\n`;
					md += `| File | Line | Level | Message |\n|------|------|-------|---------|`;
					for (const a of annotations.slice(0, 20)) {
						const file = a.path || a.blob_href?.split("/").pop() || "?";
						const line = a.start_line || a.end_line || "?";
						const level = a.annotation_level || "?";
						const msg = escapeMarkdownTableCell((a.message || "").slice(0, 200));
						md += `\n| \`${file}\` | ${line} | ${level} | ${msg} |`;
					}
					if (annotations.length > 20) {
						md += `\n\n_(showing 20 of ${annotations.length} annotations)_`;
					}
					md += `\n`;
				}
			} catch {
				/* best effort */
			}
		}

		// 5. Log content (Actions jobs only)
		if (isActions) {
			const jobId = checkId; // Actions check_id == job_id
			let runId: string | number | null = null;
			let jobSteps: Array<{ number: number; name: string }> = [];
			// Fetch the job once: gives us run_id and the canonical steps[] array
			try {
				const jobInfo = (await ghFetch<any>(
					`/repos/${owner}/${repo}/actions/jobs/${jobId}`,
				)) as any;
				runId = jobInfo?.run_id ?? null;
				if (Array.isArray(jobInfo?.steps)) {
					jobSteps = jobInfo.steps
						.map((s: any, i: number) => ({
							number: typeof s?.number === "number" ? s.number : i + 1,
							name: typeof s?.name === "string" ? s.name : `Step ${i + 1}`,
						}))
						.filter((s: { number: number; name: string }) => s.name);
				}
			} catch {
				/* will try to get run_id from html_url */
			}
			// Fall back to parsing runId from html_url if API didn't return it
			if (!runId && checkRun.html_url) {
				const m = checkRun.html_url.match(/\/actions\/runs\/(\d+)\//);
				if (m) runId = m[1]!;
			}

			let logText: string | null = null;
			if (runId) {
				logText = await ghRunLogs(owner, repo, runId, jobId);
			}

			if (logText) {
				// Resolve step index -> step name via the API's steps[] array,
				// then filter the tab-separated log to that step's section.
				let filtered = logText;
				let resolvedStepName: string | null = null;
				let filterSucceeded = false;

				if (stepIndex && jobSteps.length > 0) {
					const wantNum = parseInt(stepIndex, 10);
					if (Number.isFinite(wantNum) && wantNum > 0) {
						const step = jobSteps.find((s) => s.number === wantNum);
						if (step) {
							resolvedStepName = step.name;
							const section = filterLogByStepName(logText, step.name);
							if (section !== logText) {
								filtered = section;
								filterSucceeded = true;
							}
						}
					}
				}

				// Fallback 1: try `##[group]` marker format (older logs)
				if (!filterSucceeded && stepIndex) {
					const section = filterLogByGroupMarker(logText, stepIndex);
					if (section !== logText) {
						filtered = section;
						filterSucceeded = true;
					}
				}

				// Fallback 2: derive step order from the log itself
				if (!filterSucceeded && stepIndex) {
					const order = getStepNamesInOrder(logText);
					const wantNum = parseInt(stepIndex, 10);
					if (
						Number.isFinite(wantNum) &&
						wantNum > 0 &&
						wantNum <= order.length
					) {
						resolvedStepName = order[wantNum - 1] ?? null;
						if (resolvedStepName) {
							const section = filterLogByStepName(logText, resolvedStepName);
							if (section !== logText) {
								filtered = section;
								filterSucceeded = true;
							}
						}
					}
				}

				const excerpt = extractLogExcerpt(filtered);

				md += `\n## Log excerpt\n\n`;
				if (stepIndex && filterSucceeded && resolvedStepName) {
					md += `_Filtered to step #${stepIndex} (\u201c${resolvedStepName}\u201d)._\n\n`;
				} else if (stepIndex && filterSucceeded) {
					md += `_Filtered to step #${stepIndex}._\n\n`;
				} else if (stepIndex) {
					md += `_(step #${stepIndex} not found; showing tail)_\n\n`;
				}
				md += "```\n";
				md += excerpt;
				md += "\n```\n";

				// Save the filtered (or full) log to disk for reference
				try {
					const safeOwner = owner.replace(/[^a-z0-9_-]/gi, "_");
					const safeRepo = repo.replace(/[^a-z0-9_-]/gi, "_");
					const outDir = `${BASE_TEMP}/github-logs/${safeOwner}-${safeRepo}`;
					const fs = await import("node:fs/promises");
					await fs.mkdir(outDir, { recursive: true });
					const suffix =
						stepIndex && filterSucceeded ? `-step${stepIndex}` : "";
					const outFile = `${outDir}/check-${checkId}${suffix}.log`;
					await fs.writeFile(outFile, filtered, "utf8");
					md += `\n<details>\n<summary>📋 Log saved to disk</summary>\n\n\`${outFile}\` (${filtered.length.toLocaleString()} chars)\n</details>\n`;
				} catch {
					/* best effort */
				}
			} else {
				md += `\n> Log content unavailable. `;
				if (checkRun.html_url) {
					md += `[View the full log on GitHub](${checkRun.html_url}).\n`;
				} else {
					md += `\n`;
				}
			}
		} else {
			// External CI app — log content lives behind the app's details_url
			md += `\n<details>\n<summary>📋 External CI check\n</summary>\n\n`;
			md += `This check was created by **${checkRun.app?.name || "an external app"}** `;
			md += `(slug: \`${checkRun.app?.slug || "?"}\`). Logs are not accessible via the `;
			md += `GitHub REST API — view the [full check on GitHub](${checkRun.html_url || checkRun.details_url || "#"}).\n`;
			md += `</details>\n`;
		}

		return {
			ok: true,
			url: url,
			title: `${owner}/${repo} — check/${checkRun.name || checkId}`,
			content: md,
		};
	} catch {
		return null;
	}
}

/**
 * Fetch and render a single GitHub security advisory alert
 * (Dependabot, code-scanning, or secret-scanning). The web UI for
 * these is gated to authenticated users, but the REST API works for
 * any alert whose repo is readable with the caller's token.
 *
 * URL patterns:
 *   /security/dependabot/{id}
 *   /security/code-scanning/{id}
 *   /security/secret-scanning/{id}
 */
async function pullGitHubSecurityAlert(
	url: string,
	owner: string,
	repo: string,
	sub: string,
	alertId: string,
	apiPath: string,
): Promise<PullResult | null> {
	try {
		const data: any = await ghFetchWithFallback(apiPath);
		// GitHub returns 404 as { message: "..." } for missing alerts,
		// and 401/403 the same way. Surface a clear error in that case
		// instead of rendering an empty object.
		if (!data || data.message) {
			const msg = data?.message ?? "Alert not found";
			const isAuth = /auth|permission|forbidden/i.test(msg);
			return {
				ok: false,
				url,
				error:
					`GitHub ${sub} alert #${alertId}: ${msg}. ` +
					`Set GITHUB_TOKEN or run \`gh auth login\` to access gated security advisories.`,
				errorInfo: {
					message: msg,
					code: isAuth ? "http_error" : "http_error",
					statusCode: 401,
					retryable: false,
				},
			};
		}

		const subLabel =
			sub === "dependabot"
				? "Dependabot alert"
				: sub === "code-scanning"
					? "Code scanning alert"
					: "Secret scanning alert";

		let md = `# ${owner}/${repo} — ${subLabel} #${alertId}\n\n`;
		md += `> via GitHub API (security advisories are gated on the web UI; the API works with \`GITHUB_TOKEN\` or \`gh auth login\`)\n\n`;

		// Common fields across all three alert types
		const state = data.state || "?";
		const severity = data.severity || data.rule?.severity;
		const createdAt = data.created_at;
		const updatedAt = data.updated_at;
		const htmlUrl = data.html_url || url;
		const dismissedAt = data.dismissed_at;
		const dismissedBy = data.dismissed_by?.login;
		const dismissedReason = data.dismissed_reason;

		const stateIcon =
			state === "open" || state === "new" || state === "detected"
				? "🟢"
				: state === "fixed" || state === "resolved"
					? "✅"
					: state === "dismissed" || state === "auto_dismissed"
						? "🚫"
						: "❓";

		md += `${stateIcon} **State:** \`${state}\``;
		if (severity) md += ` · **Severity:** \`${severity}\``;
		md += `\n`;
		if (createdAt) md += `- **Created:** ${createdAt}\n`;
		if (updatedAt) md += `- **Updated:** ${updatedAt}\n`;
		if (dismissedAt) {
			md += `- **Dismissed:** ${dismissedAt}`;
			if (dismissedBy) md += ` by @${dismissedBy}`;
			if (dismissedReason) md += ` (${dismissedReason})`;
			md += `\n`;
		}
		if (htmlUrl) md += `- [View on GitHub](${htmlUrl})\n`;

		// Dependabot-specific
		if (sub === "dependabot") {
			const advisory = data.advisory;
			const dep = data.dependency || {};
			const vuln = data.security_vulnerability || {};
			const pkg = vuln.package || {};
			const cvss = vuln.vulnerable_version_range;
			const patchedVersions = vuln.patched_versions;

			if (advisory) {
				md += `\n## Advisory\n\n`;
				md += `- **GHSA ID:** \`${advisory.ghsa_id || "?"}\`\n`;
				md += `- **CVE ID:** ${advisory.cve_id || "_(none)_"}\n`;
				md += `- **Summary:** ${advisory.summary || "_(no summary)_"}\n`;
				if (advisory.description) {
					md += `\n${advisory.description.slice(0, 4000)}\n`;
				}
				if (advisory.severity) {
					md += `\n- **Severity:** \`${advisory.severity}\`\n`;
				}
				if (Array.isArray(advisory.cvss) && advisory.cvss.length) {
					md += `- **CVSS scores:**\n`;
					for (const c of advisory.cvss) {
						if (c.score !== undefined) {
							md += `  - ${c.vector_string || "?"} → ${c.score}\n`;
						}
					}
				}
				if (Array.isArray(advisory.references) && advisory.references.length) {
					md += `\n## References (${advisory.references.length})\n\n`;
					for (const r of advisory.references.slice(0, 20)) {
						const label =
							r.url?.replace(/^https?:\/\//, "").slice(0, 80) || "?";
						md += `- [${label}](${r.url})\n`;
					}
				}
			}

			if (dep.package || pkg.name) {
				md += `\n## Vulnerable package\n\n`;
				const name = dep.package?.name || pkg.name || "?";
				const ecosystem = dep.package?.ecosystem || pkg.ecosystem || "?";
				md += `- **Package:** \`${name}\` (\`${ecosystem}\`)\n`;
				if (dep.manifest_path)
					md += `- **Manifest:** \`${dep.manifest_path}\`\n`;
				if (dep.scope) md += `- **Scope:** \`${dep.scope}\`\n`;
				if (cvss) md += `- **Vulnerable range:** \`${cvss}\`\n`;
				if (patchedVersions)
					md += `- **Patched versions:** \`${patchedVersions}\`\n`;
				if (vuln.vulnerable_version_range) {
					md += `- **Vulnerable range:** \`${vuln.vulnerable_version_range}\`\n`;
				}
				if (vuln.first_patched_version?.identifier) {
					md += `- **First patched:** \`${vuln.first_patched_version.identifier}\`\n`;
				}
			}
		}

		// Code-scanning-specific
		if (sub === "code-scanning") {
			const rule = data.rule;
			const tool = data.tool;
			const instances = data.most_recent_instance || data.instances?.[0];
			const loc = instances?.location;

			if (rule) {
				md += `\n## Rule\n\n`;
				md += `- **ID:** \`${rule.id || rule.rule_id || "?"}\`\n`;
				if (rule.severity) md += `- **Severity:** \`${rule.severity}\`\n`;
				if (rule.name) md += `- **Name:** ${rule.name}\n`;
				if (rule.description) md += `\n${rule.description.slice(0, 2000)}\n`;
				if (rule.full_description) {
					md += `\n<details>\n<summary>Full description</summary>\n\n${rule.full_description.slice(0, 4000)}\n</details>\n`;
				}
				if (Array.isArray(rule.tags) && rule.tags.length) {
					md += `\n- **Tags:** ${rule.tags.map((t: string) => `\`${t}\``).join(", ")}\n`;
				}
				if (rule.help?.text) {
					md += `\n## Help\n\n${rule.help.text.slice(0, 4000)}\n`;
				}
				if (Array.isArray(rule.help?.markdown_url)) {
					md += `\n## Help links\n\n`;
					for (const u of rule.help.markdown_url) md += `- ${u}\n`;
				}
			}

			if (tool) {
				md += `\n## Tool\n\n`;
				if (tool.name) md += `- **Name:** ${tool.name}\n`;
				if (tool.guid) md += `- **GUID:** \`${tool.guid}\`\n`;
				if (tool.version) md += `- **Version:** \`${tool.version}\`\n`;
			}

			if (instances) {
				md += `\n## Most recent instance\n\n`;
				if (loc?.path) {
					md += `- **Path:** \`${loc.path}\`\n`;
					if (loc.start_line) {
						md += `- **Lines:** ${loc.start_line}${loc.end_line ? `–${loc.end_line}` : ""}\n`;
					}
				}
				if (instances.commit_sha) {
					md += `- **Commit:** \`${instances.commit_sha.slice(0, 12)}\`\n`;
				}
				if (instances.message?.text) {
					md += `\n${instances.message.text.slice(0, 1000)}\n`;
				}
			}
		}

		// Secret-scanning-specific
		if (sub === "secret-scanning") {
			const secretType = data.secret_type;
			const secretTypeDisplay = data.secret_type_display_name;
			const resolution = data.resolution;
			const locations = Array.isArray(data.locations) ? data.locations : [];
			const pushProtectionBypass = data.push_protection_bypassed;

			if (secretType || secretTypeDisplay) {
				md += `\n## Secret\n\n`;
				md += `- **Type:** ${secretTypeDisplay || secretType || "?"}\n`;
				if (secretType) md += `- **ID:** \`${secretType}\`\n`;
				if (resolution) md += `- **Resolution:** \`${resolution}\`\n`;
				if (pushProtectionBypass) {
					md += `- **Push protection bypassed:** ${pushProtectionBypass.bypassed_at || "?"}`;
					if (pushProtectionBypass.bypassed_by?.login) {
						md += ` by @${pushProtectionBypass.bypassed_by.login}`;
					}
					md += `\n`;
				}
			}

			if (locations.length) {
				md += `\n## Locations (${locations.length})\n\n`;
				md += `| Type | Details |\n|------|---------|\n`;
				for (const loc of locations.slice(0, 20)) {
					if (loc.details) {
						md += `| ${loc.type || "?"} | ${escapeMarkdownTableCell(loc.details.slice(0, 200))} |\n`;
					} else if (loc.path) {
						const lines = loc.start_line
							? `:${loc.start_line}${loc.end_line ? `–${loc.end_line}` : ""}`
							: "";
						md += `| ${loc.type || "commit"} | \`${loc.path}${lines}\` |\n`;
					} else {
						md += `| ${loc.type || "?"} | (no details) |\n`;
					}
				}
			}
		}

		// Common: raw JSON for anything we missed
		md += `\n<details>\n<summary>📋 Raw API response</summary>\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 8000)}\n\`\`\`\n</details>\n`;

		return {
			ok: true,
			url,
			title: `${owner}/${repo} — ${subLabel} #${alertId}`,
			content: md,
		};
	} catch (err: any) {
		const msg = err?.message ?? "GitHub API call failed";
		return {
			ok: false,
			url,
			error:
				`GitHub ${sub} alert #${alertId}: ${msg}. ` +
				`Set GITHUB_TOKEN or run \`gh auth login\` to access gated security advisories.`,
			errorInfo: {
				message: msg,
				code: "http_error",
				retryable: false,
			},
		};
	}
}

async function pullGitHubFeature(url: string): Promise<PullResult | null> {
	try {
		const u = new URL(url);
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 3) return null;

		const [owner, repo, feature, ...rest] = parts;
		const baseRepoPath = `/repos/${owner}/${repo}`;

		// ── Handle /commit/{sha}/checks/{check_id}/logs/{step?} ──
		// Must come BEFORE the bare /commit/{sha} branch so the check
		// log is fetched instead of the commit metadata.
		if (feature === "commit" && rest[0] && rest[1] === "checks" && rest[2]) {
			return pullGitHubCheckLog(
				url,
				owner,
				repo,
				rest[0],
				rest[2],
				rest[4] && /^\d+$/.test(rest[4]) ? rest[4] : null,
			);
		}

		let apiPath: string | null = null;
		let featureLabel = feature;

		// ── Handle /security sub-pages ──
		if (feature === "security" && rest[0]) {
			const sub = rest[0];
			featureLabel = `security/${sub}`;

			// Per-alert endpoints: /security/dependabot/{id},
			// /security/code-scanning/{id}, /security/secret-scanning/{id}.
			// The web UI for these is gated to authenticated users, but
			// the REST API works for any alert whose repo is readable
			// with the caller's token (env var, gh CLI, etc.).
			const alertId = rest[1];
			if (alertId && /^\d+$/.test(alertId)) {
				let alertPath: string | null = null;
				if (sub === "dependabot") {
					alertPath = `${baseRepoPath}/dependabot/alerts/${alertId}`;
				} else if (sub === "code-scanning") {
					alertPath = `${baseRepoPath}/code-scanning/alerts/${alertId}`;
				} else if (sub === "secret-scanning") {
					alertPath = `${baseRepoPath}/secret-scanning/alerts/${alertId}`;
				}
				if (alertPath) {
					return pullGitHubSecurityAlert(
						url,
						owner,
						repo,
						sub,
						alertId,
						alertPath,
					);
				}
			}

			const mapped = GH_FEATURE_API_MAP[sub];
			if (mapped) apiPath = `${baseRepoPath}${mapped}`;
		}
		// ── Handle /pull/123 or /issues/123 (single item) ──
		else if ((feature === "pull" || feature === "issues") && rest[0]) {
			const id = rest[0];
			featureLabel = `${feature}/${id}`;
			const endpoint = feature === "pull" ? "pulls" : "issues";
			apiPath = `${baseRepoPath}/${endpoint}/${id}`;
		}
		// ── Handle /commit/SHA ──
		else if (feature === "commit" && rest[0]) {
			featureLabel = `commit/${rest[0].slice(0, 7)}`;
			apiPath = `${baseRepoPath}/commits/${rest[0]}`;
		}
		// ── Handle /releases/tag/v1.0 ──
		else if (feature === "releases" && rest[0] === "tag" && rest[1]) {
			featureLabel = `release/${rest[1]}`;
			apiPath = `${baseRepoPath}/releases/tags/${rest[1]}`;
		}
		// ── Handle /actions/runs/123 ──
		else if (feature === "actions" && rest[0] === "runs" && rest[1]) {
			featureLabel = `actions/run/${rest[1]}`;
			apiPath = `${baseRepoPath}/actions/runs/${rest[1]}`;
		}
		// ── Handle /commits/branch ──
		else if (feature === "commits" && rest[0]) {
			featureLabel = `commits/${rest[0]}`;
			apiPath = `${baseRepoPath}/commits?sha=${rest[0]}&per_page=20`;
		}
		// ── Standard feature pages ──
		else {
			const mapped = GH_FEATURE_API_MAP[feature];
			if (mapped !== undefined) {
				apiPath = `${baseRepoPath}${mapped}`;
			}
		}

		if (!apiPath) return null;

		let data: any;
		try {
			data = await ghFetch(apiPath);
		} catch (_err) {
			return null;
		}

		// Unwrap paginated workflow_runs wrapper for actions list
		if (data?.workflow_runs && Array.isArray(data.workflow_runs)) {
			data = data.workflow_runs;
		}

		let md = `# ${owner}/${repo} — ${featureLabel}\n\n`;
		md += `> via GitHub API\n\n`;

		// Special handling for individual CI runs — fetch job details
		if (
			feature === "actions" &&
			rest[0] === "runs" &&
			rest[1] &&
			data &&
			!Array.isArray(data)
		) {
			const run = data;
			const runId = rest[1];
			const highlightJobId = rest[2] === "job" && rest[3] ? rest[3] : null;

			const statusIcon =
				run.conclusion === "success"
					? "✅"
					: run.conclusion === "failure"
						? "❌"
						: run.conclusion === "cancelled"
							? "⏹️"
							: run.status === "in_progress"
								? "🔄"
								: "⏳";
			md += `${statusIcon} **${run.display_title || run.name}** (#${run.run_number})\n`;
			md += `- **Status:** ${run.status} / ${run.conclusion || "pending"}\n`;
			md += `- **Branch:** ${run.head_branch} (${run.head_sha?.slice(0, 7)})\n`;
			md += `- **Trigger:** ${run.event} by ${run.actor?.login || "unknown"}\n`;
			if (run.pull_requests?.length) {
				md += `- **PRs:** ${run.pull_requests.map((p: any) => `#${p.number}`).join(", ")}\n`;
			}
			md += `\n[View on GitHub](${run.html_url})\n`;

			// Fetch jobs
			try {
				const jobsData = (await ghFetch(
					`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=20`,
				)) as any;
				let jobs = jobsData?.jobs || [];

				// If a specific job ID is in the URL, fetch it individually and show first
				if (highlightJobId) {
					try {
						const singleJob = await ghFetch(
							`/repos/${owner}/${repo}/actions/jobs/${highlightJobId}`,
						);
						if (singleJob && !(singleJob as any).message) {
							// Replace or add this job at the top
							jobs = jobs.filter((j: any) => j.id !== (singleJob as any).id);
							jobs.unshift(singleJob);
						}
					} catch {
						/* best effort */
					}
				}

				if (jobs.length) {
					md += `\n## Jobs (${jobs.length})\n\n`;
					for (const job of jobs) {
						const isHighlighted =
							highlightJobId && String(job.id) === highlightJobId;
						const jIcon =
							job.conclusion === "success"
								? "✅"
								: job.conclusion === "failure"
									? "❌"
									: job.conclusion === "cancelled"
										? "⏹️"
										: job.status === "in_progress"
											? "🔄"
											: "⏳";
						md += `### ${jIcon} ${isHighlighted ? "👉 " : ""}${job.name}\n\n`;
						md += `- **Status:** ${job.status} / ${job.conclusion || "pending"}\n`;
						if (job.completed_at)
							md += `- **Completed:** ${job.completed_at}\n`;

						// If highlighting a specific job, fetch its log
						if (
							isHighlighted &&
							job.status === "completed" &&
							job.conclusion === "failure"
						) {
							try {
								const logRes = await fetch(job.logs_url || `${job.url}/logs`, {
									headers: { Accept: "text/plain", "User-Agent": "pi-webaio" },
								});
								if (
									logRes.ok &&
									logRes.headers.get("content-type")?.includes("text/plain")
								) {
									const logText = await logRes.text();
									// Extract lines that look like errors or the last 50 lines
									const lines = logText.split("\n");
									const errorLines = lines.filter((l) =>
										/error|fail|Error|FAIL/i.test(l),
									);
									const tail = lines.slice(-50);
									const logExcerpt =
										errorLines.length > 0
											? errorLines.slice(-15).join("\n")
											: tail.join("\n");
									md += `\n<details>\n<summary>📋 Failed job log excerpt</summary>\n\n\`\`\`\n${logExcerpt.slice(0, 3000)}\n\`\`\`\n</details>\n\n`;
								}
							} catch {
								/* best effort */
							}
						}

						if (job.steps?.length) {
							md += `\n| Step | Status |\n|------|--------|\n`;
							for (const step of job.steps) {
								const sIcon =
									step.conclusion === "success"
										? "✅"
										: step.conclusion === "failure"
											? "❌"
											: step.conclusion === "cancelled"
												? "⏹️"
												: step.conclusion === "skipped"
													? "⏭️"
													: "⏳";
								md += `| ${sIcon} ${step.name} | ${step.conclusion || step.status} |\n`;
							}
							md += `\n`;
						}
						if (job.html_url) md += `[View job logs](${job.html_url})\n\n`;
					}
				}
			} catch {
				md += `\n_(job details unavailable)_\n`;
			}

			return {
				ok: true,
				url,
				title: `${owner}/${repo} — ${featureLabel}`,
				content: md,
			};
		}

		if (Array.isArray(data)) {
			const items = data.slice(0, 20);
			if (!items.length) {
				md += "_(no items found)_\n";
			} else {
				for (const item of items) {
					const title =
						item.title ||
						item.name ||
						item.display_title ||
						item.headline ||
						"";
					const state = item.state ? ` _${item.state}_` : "";
					const number = item.number ? `#${item.number}` : "";
					const link = item.html_url || "";
					const label = item.rule?.description || item.severity || "";
					const extra = label ? ` (${label})` : "";
					const linkLabel = link ? ` — [view](${link})` : "";
					md += `- ${number}${state} ${title}${extra}${linkLabel}\n`;
				}
			}
		} else if (typeof data === "object" && data !== null) {
			// Single item (e.g. single issue, single commit)
			const title = data.title || data.commit?.message?.split("\n")[0] || "";
			const state = data.state ? ` _${data.state}_` : "";
			const link = data.html_url || "";
			if (title) md += `${state} ${title}\n`;
			if (link) md += `\n[View on GitHub](${link})\n`;
			// Include body/description for single items
			const body = data.body || data.description || "";
			if (body) md += `\n${body.slice(0, 2000)}\n`;
		} else {
			md += `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
		}

		return {
			ok: true,
			url,
			title: `${owner}/${repo} — ${featureLabel}`,
			content: md,
		};
	} catch {
		return null;
	}
}

async function githubApiFetch(path: string): Promise<unknown | null> {
	try {
		return await ghFetch(path);
	} catch {
		return null;
	}
}

async function fetchGitHubRaw(
	owner: string,
	repo: string,
	ref: string,
	path: string,
): Promise<PullResult> {
	// Collect branches to try: caller-provided ref, then main, then master.
	// If ref is a commit SHA (40 hex chars), query the API for the default branch
	// so we don't waste 3 failed requests.
	const tried = new Set<string>();
	const branches: string[] = [ref];
	tried.add(ref);

	for (const b of ["main", "master"]) {
		if (!tried.has(b)) {
			branches.push(b);
			tried.add(b);
		}
	}

	// If ref looks like a SHA (40 hex chars), query the repo's default branch
	if (/^[0-9a-f]{40}$/i.test(ref)) {
		try {
			const repoInfo = (await ghFetch(`/repos/${owner}/${repo}`)) as any;
			const defaultBranch = repoInfo?.default_branch;
			if (defaultBranch && !tried.has(defaultBranch)) {
				branches.splice(1, 0, defaultBranch); // try right after the SHA
				tried.add(defaultBranch);
			}
		} catch {
			// API unavailable — continue with current list
		}
	}

	for (const b of branches) {
		const res = await smartFetch(
			`https://raw.githubusercontent.com/${owner}/${repo}/${b}/${path}`,
		);
		if (res?.status && res.status < 400) {
			return {
				ok: true,
				url: `https://github.com/${owner}/${repo}/blob/${b}/${path}`,
				title: path.split("/").pop() || path,
				content: res.text,
			};
		}
	}
	return {
		ok: false,
		url: `https://github.com/${owner}/${repo}`,
		error: `Raw file not found: ${path}`,
	};
}

async function fetchGitHubTree(ref: GitHubRef): Promise<PullResult> {
	const { owner, repo, ref: branch, path = "" } = ref;
	const apiPath = path
		? `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch || "main"}`
		: `/repos/${owner}/${repo}/contents`;

	const data = await githubApiFetch(apiPath);
	if (!data)
		return { ok: false, url: ref.toString(), error: "GitHub API failed" };

	if (!Array.isArray(data)) {
		return fetchGitHubRaw(owner, repo, branch || "main", path);
	}

	const pathSuffix = path ? `/${path}` : "";
	let md = `# ${owner}/${repo}${pathSuffix}\n\n`;
	md += `## Directory Contents\n\n`;

	for (const item of data as any[]) {
		const icon = item.type === "dir" ? "📁" : "📄";
		md += `- ${icon} [${item.name}](${item.html_url})\n`;
	}

	const readmeItem = (data as any[]).find(
		(i: any) => i.type === "file" && /^readme\.md$/i.test(i.name),
	);
	if (readmeItem?.download_url) {
		const r = await smartFetch(readmeItem.download_url);
		if (r?.status && r.status < 400) {
			md += `\n---\n\n## README\n\n${r.text}\n`;
		}
	}

	const treeUrl = path ? `/tree/${branch}/${path}` : "";
	return {
		ok: true,
		url: `https://github.com/${owner}/${repo}${treeUrl}`,
		title: `${owner}/${repo}`,
		content: md,
	};
}

async function cloneGitHubRepo(
	owner: string,
	repo: string,
	outDir: string,
): Promise<{ ok: boolean; path: string; error?: string }> {
	try {
		await mkdir(outDir, { recursive: true });

		// Prefer gh CLI (handles auth, private repos)
		const ghPath = resolveBinary("gh");
		if (ghPath) {
			await new Promise<void>((resolve, reject) => {
				const proc = spawn(
					ghPath,
					["repo", "clone", `${owner}/${repo}`, outDir, "--", "--depth", "1"],
					{
						stdio: "pipe",
					},
				);
				let stderr = "";
				proc.stderr.on("data", (d: Buffer) => (stderr += d));
				proc.on("close", (code: number) => {
					if (code === 0) resolve();
					else reject(new Error(stderr || `gh repo clone exit ${code}`));
				});
				proc.on("error", reject);
			});
			return { ok: true, path: outDir };
		}

		// Fallback: git clone. If GITHUB_TOKEN is available, inject it for private repos.
		let cloneUrl = `https://github.com/${owner}/${repo}.git`;
		const token = await getGithubToken();
		if (token) {
			cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
		}
		const gitPath = resolveBinary("git") || "git";
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(gitPath, ["clone", "--depth", "1", cloneUrl, outDir], {
				stdio: "pipe",
			});
			let stderr = "";
			proc.stderr.on("data", (d: Buffer) => (stderr += d));
			proc.on("close", (code: number) => {
				if (code === 0) resolve();
				else reject(new Error(stderr || `git clone exited with ${code}`));
			});
			proc.on("error", reject);
		});
		return { ok: true, path: outDir };
	} catch (err: any) {
		return { ok: false, path: outDir, error: err?.message ?? "Clone failed" };
	}
}

// ─── Architecture detection (inspired by repocrunch) ───────────────

/** File-pattern signals for CI/CD platforms. */
const CI_PATTERNS: [RegExp, string][] = [
	[/^\.github\/workflows\//, "GitHub Actions"],
	[/^\.gitlab-ci\.yml$/, "GitLab CI"],
	[/^Jenkinsfile$/, "Jenkins"],
	[/^\.circleci\//, "CircleCI"],
	[/^\.travis\.yml$/, "Travis CI"],
	[/^azure-pipelines\.yml$/, "Azure Pipelines"],
	[/^bitbucket-pipelines\.yml$/, "Bitbucket Pipelines"],
];

/** File-pattern signals for test frameworks. */
const TEST_PATTERNS: [RegExp, string][] = [
	[/^jest\.config\./, "Jest"],
	[/^vitest\.config\./, "Vitest"],
	[/^playwright\.config\./, "Playwright"],
	[/^cypress\.config\./, "Cypress"],
	[/^(.*\/)?conftest\.py$/, "pytest"],
	[/^pytest\.ini$/, "pytest"],
	[/^\.mocharc\./, "Mocha"],
	[/^karma\.conf\./, "Karma"],
];

/** File-pattern signals for monorepo tooling. */
const MONOREPO_PATTERNS: [RegExp, string][] = [
	[/^lerna\.json$/, "Lerna"],
	[/^nx\.json$/, "Nx"],
	[/^turbo\.json$/, "Turborepo"],
	[/^pnpm-workspace\.yaml$/, "pnpm workspaces"],
	[/^rush\.json$/, "Rush"],
];

/** Lock-file → package manager mapping. */
const LOCKFILE_MAP: Record<string, string> = {
	"package-lock.json": "npm",
	"yarn.lock": "yarn",
	"pnpm-lock.yaml": "pnpm",
	"bun.lockb": "bun",
	"uv.lock": "uv",
	"poetry.lock": "poetry",
	"Pipfile.lock": "pipenv",
	"Cargo.lock": "cargo",
	"Gemfile.lock": "bundler",
};

function matched(patterns: [RegExp, string][], paths: string[]): string[] {
	const found = new Set<string>();
	for (const p of paths) {
		for (const [re, label] of patterns) {
			if (re.test(p)) found.add(label);
		}
	}
	return [...found];
}

/** Analyze a list of relative file paths and return an architecture summary. */
function detectArchitectureSignals(paths: string[]): string {
	const lines: string[] = [];

	// Docker
	if (
		paths.some((p) =>
			/^(Dockerfile|docker-compose\.(yml|yaml)|\.dockerignore)$/.test(p),
		)
	)
		lines.push("- 🐳 **Docker:** yes");

	// CI/CD
	const ciCd = matched(CI_PATTERNS, paths);
	if (ciCd.length) lines.push(`- 🔄 **CI/CD:** ${ciCd.join(", ")}`);

	// Tests
	const tests = matched(TEST_PATTERNS, paths);
	const hasTestDir = paths.some(
		(p) =>
			p.startsWith("__tests__/") ||
			p.startsWith("tests/") ||
			p.startsWith("test/") ||
			p.startsWith("spec/"),
	);
	if (hasTestDir && !tests.length) tests.push("(test dir present)");
	if (tests.length) lines.push(`- 🧪 **Tests:** ${tests.join(", ")}`);

	// Monorepo tooling
	const monorepo = matched(MONOREPO_PATTERNS, paths);
	// Also detect multiple package.json in subdirectories (classic monorepo signal)
	const pkgJsons = paths.filter((p) => p.endsWith("/package.json"));
	if (pkgJsons.length > 1 && !monorepo.length) monorepo.push("multi-package");
	if (monorepo.length) lines.push(`- 📦 **Monorepo:** ${monorepo.join(", ")}`);

	// Package manager (from lockfiles)
	const pms = new Set<string>();
	for (const [file, pm] of Object.entries(LOCKFILE_MAP)) {
		if (paths.some((p) => p === file || p.endsWith(`/${file}`))) pms.add(pm);
	}
	if (pms.size) lines.push(`- 📋 **Package managers:** ${[...pms].join(", ")}`);

	// Security
	const secSignals: string[] = [];
	if (paths.some((p) => p === "SECURITY.md")) secSignals.push("SECURITY.md");
	if (paths.some((p) => p === ".env")) secSignals.push("⚠ .env committed");
	if (
		paths.some(
			(p) => p === ".github/dependabot.yml" || p === ".github/dependabot.yaml",
		)
	)
		secSignals.push("Dependabot");
	if (secSignals.length)
		lines.push(`- 🔒 **Security:** ${secSignals.join(", ")}`);

	if (!lines.length) return "";
	return `\n## Architecture\n\n${lines.join("\n")}\n`;
}

async function buildRepoMarkdown(outDir: string): Promise<string> {
	// Build a file tree and include README
	const { readdir } = await import("node:fs/promises");
	const allPaths: string[] = [];

	async function tree(dir: string, prefix = ""): Promise<string> {
		const entries = await readdir(dir, { withFileTypes: true });
		const lines: string[] = [];
		const sorted = entries
			.filter((e) => !e.name.startsWith("."))
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			});
		for (let i = 0; i < sorted.length; i++) {
			const e = sorted[i]!;
			const isLast = i === sorted.length - 1;
			const branch = isLast ? "└── " : "├── ";
			lines.push(`${prefix}${branch}${e.name}`);
			if (e.isDirectory()) {
				const ext = isLast ? "    " : "│   ";
				lines.push(await tree(join(dir, e.name), prefix + ext));
			}
		}
		return lines.join("\n");
	}

	// First pass: collect all file paths
	async function collectPaths(dir: string, rel: string): Promise<void> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const e of entries) {
				const relPath = rel ? `${rel}/${e.name}` : e.name;
				allPaths.push(relPath);
				if (e.isDirectory()) {
					await collectPaths(join(dir, e.name), relPath);
				}
			}
		} catch {
			/* ignore */
		}
	}

	await collectPaths(outDir, "");

	let md = "## File Tree\n\n```\n";
	try {
		md += await tree(outDir);
	} catch {
		md += "(empty)";
	}
	md += "\n```\n";

	// Architecture detection from file tree
	const arch = detectArchitectureSignals(allPaths);
	if (arch) md += arch;

	md += "\n";

	// Try to include README
	for (const name of ["README.md", "readme.md", "Readme.md"]) {
		try {
			const readme = await readFile(join(outDir, name), "utf8");
			md += `---\n\n## README\n\n${readme}\n`;
			break;
		} catch {
			/* ignore */
		}
	}

	return md;
}

async function fetchGitHubRepo(ref: GitHubRef): Promise<PullResult> {
	const { owner, repo } = ref;

	// Try cloning first (much better for agent exploration)
	const cloneDir = join(BASE_TEMP, "github", `${owner}--${repo}`);
	const cloned = await cloneGitHubRepo(owner, repo, cloneDir);

	if (cloned.ok) {
		const treeMd = await buildRepoMarkdown(cloneDir);
		return {
			ok: true,
			url: `https://github.com/${owner}/${repo}`,
			title: `${owner}/${repo}`,
			content: `# ${owner}/${repo}\n\n> Cloned to: ${cloneDir}\n\n${treeMd}`,
		};
	}

	// Fallback to API
	const repoInfo = await githubApiFetch(`/repos/${owner}/${repo}`);

	// If the API also failed with 404 (or any "message" response, which
	// GitHub uses for errors), the repo doesn't exist or is private.
	// Return a clear error instead of an empty directory listing.
	if (
		!repoInfo ||
		(typeof repoInfo === "object" && (repoInfo as any).message)
	) {
		const errMsg =
			(repoInfo as any)?.message ?? "Repository not found or inaccessible";
		return {
			ok: false,
			url: `https://github.com/${owner}/${repo}`,
			error: `GitHub repo ${owner}/${repo}: ${errMsg}`,
		};
	}

	let md = "";
	const info = repoInfo as any;
	const repoName = info.full_name || `${owner}/${repo}`;
	md = `# ${repoName}\n\n`;
	if (info.description) md += `> ${info.description}\n\n`;
	if (info.topics?.length) md += `**Topics:** ${info.topics.join(", ")}\n\n`;
	md += `- **Language:** ${info.language || "N/A"}\n`;
	md += `- **Stars:** ${info.stargazers_count ?? 0}\n`;
	md += `- **Forks:** ${info.forks_count ?? 0}\n`;
	md += `- **License:** ${info.license?.spdx_id || "N/A"}\n\n`;

	const treeResult = await fetchGitHubTree(ref);
	if (treeResult.ok && treeResult.content) {
		const treeContent = treeResult.content.replace(/^#[^\n]+\n\n/, "");
		md += treeContent;
	}

	return {
		ok: true,
		url: `https://github.com/${owner}/${repo}`,
		title: `${owner}/${repo}`,
		content: md,
	};
}
