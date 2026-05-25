// ─── SonarCloud (SonarQube Cloud) extractor ───────────────────────
// Uses the SonarCloud REST API.
// No API key required for publicly accessible projects.
// Covers security_hotspots, issues, overview, and activity pages.

import type { VerticalResult } from "./types.ts";

/**
 * Match SonarCloud project URLs.
 * e.g. sonarcloud.io/project/overview?id=...
 *      sonarcloud.io/project/issues?project=...
 *      sonarcloud.io/project/security_hotspots?id=...
 */
export function matchesSonarCloud(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== "sonarcloud.io") return false;
		const projectKey =
			u.searchParams.get("id") || u.searchParams.get("project");
		return projectKey !== null;
	} catch {
		return false;
	}
}

/**
 * Parse a SonarCloud URL and return the project key and page type.
 */
function parseUrl(
	url: string,
): { projectKey: string; page: string; params: URLSearchParams } | null {
	try {
		const u = new URL(url);
		if (u.hostname !== "sonarcloud.io") return null;
		const projectKey =
			u.searchParams.get("id") || u.searchParams.get("project");
		if (!projectKey) return null;
		const match = u.pathname.match(/\/project\/([^/?#]+)/);
		const page = match?.[1] || "overview";
		return { projectKey, page, params: u.searchParams };
	} catch {
		return null;
	}
}

/**
 * Map a SonarCloud page type to its API endpoint path.
 * Forwards relevant query parameters from the web UI URL to the API.
 */
function apiPath(
	page: string,
	projectKey: string,
	params: URLSearchParams,
): string | null {
	const forwarded = new URLSearchParams();
	for (const key of [
		"impactSoftwareQualities",
		"impactSeverities",
		"issueStatuses",
		"severities",
		"types",
		"tags",
		"resolved",
		"rules",
		"languages",
		"scopes",
		"owaspTop10",
		"sansTop25",
		"cwe",
		"sonarsourceSecurity",
		"statuses",
		"securityCategories",
	]) {
		const val = params.get(key);
		if (val) forwarded.set(key, val);
	}

	switch (page) {
		case "security_hotspots":
			forwarded.set("projectKey", projectKey);
			if (!forwarded.has("ps")) forwarded.set("ps", "50");
			return `/api/hotspots/search?${forwarded.toString()}`;
		case "issues":
			forwarded.set("componentKeys", projectKey);
			if (!forwarded.has("ps")) forwarded.set("ps", "50");
			if (!forwarded.has("issueStatuses"))
				forwarded.set("issueStatuses", "OPEN,CONFIRMED");
			return `/api/issues/search?${forwarded.toString()}`;
		case "overview":
			return `/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=security_hotspots_reviewed,issues,coverage,duplicated_lines_density,alert_status,quality_gate_details,bugs,vulnerabilities,code_smells,security_rating,security_review_rating,reliability_rating,sqale_rating,sqale_index,ncloc`;
		case "activity":
			return `/api/project_analyses/search?project=${encodeURIComponent(projectKey)}&ps=20`;
		default:
			return null;
	}
}

/**
 * Extract SonarCloud project data via the REST API.
 */
export async function extractSonarCloud(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const parsed = parseUrl(url);
	if (!parsed) return null;

	const endpoint = apiPath(parsed.page, parsed.projectKey, parsed.params);
	if (!endpoint) return null;

	const apiUrl = `https://sonarcloud.io${endpoint}`;
	const data = await fetchJson(apiUrl);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	let md = `# ${parsed.projectKey} — ${parsed.page}\n\n`;

	switch (parsed.page) {
		case "security_hotspots": {
			const hotspots = (Array.isArray(d.hotspots) ? d.hotspots : []) as Record<
				string,
				unknown
			>[];
			if (!hotspots.length) {
				md += "_(no security hotspots found)_\n";
			} else {
				const byCategory = new Map<string, Record<string, unknown>[]>();
				for (const h of hotspots) {
					const cat = String(h.securityCategory || "other");
					if (!byCategory.has(cat)) byCategory.set(cat, []);
					byCategory.get(cat)!.push(h);
				}

				const paging = d.paging as Record<string, unknown> | undefined;
				md += `**${hotspots.length} Security Hotspots** (${paging?.total ?? hotspots.length} total)\n\n`;

				for (const [cat, items] of byCategory) {
					const sevMap: Record<string, number> = {};
					for (const item of items) {
						const sev = String(item.vulnerabilityProbability || "unknown");
						sevMap[sev] = (sevMap[sev] || 0) + 1;
					}
					const sevBreakdown = Object.entries(sevMap)
						.map(([k, v]) => `${k}: ${v}`)
						.join("; ");
					md += `### ${cat} (${sevBreakdown})\n\n`;

					for (const item of items.slice(0, 20)) {
						const file =
							typeof item.component === "string"
								? item.component.split(":").pop() || "?"
								: "?";
						const line = item.line ? `:${item.line}` : "";
						const status =
							item.status === "TO_REVIEW"
								? "🟡"
								: item.status === "FIXED"
									? "✅"
									: item.status === "SAFE"
										? "🟢"
										: "🔴";
						const rule =
							item.rule && typeof item.rule === "object"
								? String(
										(item.rule as Record<string, unknown>).description || "",
									)
								: "";
						md += `${status} \`${file}${line}\` — ${item.message}${rule ? ` _(${rule})_` : ""}\n`;
					}
					md += "\n";
				}
			}
			break;
		}

		case "issues": {
			const issues = (Array.isArray(d.issues) ? d.issues : []) as Record<
				string,
				unknown
			>[];
			if (!issues.length) {
				md += "_(no issues found)_\n";
			} else {
				const paging = d.paging as Record<string, unknown> | undefined;
				md += `**${issues.length} Issues** (${paging?.total ?? issues.length} total)\n\n`;
				for (const issue of issues.slice(0, 30)) {
					const sev = String(issue.severity || "");
					const type = String(issue.type || "");
					const file =
						typeof issue.component === "string"
							? issue.component.split(":").pop() || "?"
							: "?";
					const line = issue.line ? `:${issue.line}` : "";
					const msg = String(issue.message || "");
					md += `- [${sev}] [${type}] \`${file}${line}\` — ${msg}\n`;
				}
			}
			break;
		}

		case "overview": {
			const measures = (
				Array.isArray(d.measures)
					? d.measures
					: Array.isArray(
								(d.component as Record<string, unknown> | undefined)?.measures,
							)
						? (d.component as Record<string, unknown>).measures
						: []
			) as Record<string, unknown>[];
			if (!measures.length) {
				md += "_(no measures found)_\n";
			} else {
				md += "| Metric | Value |\n|--------|-------|\n";
				for (const m of measures) {
					const val =
						m.value !== undefined
							? m.value
							: ((m.period as Record<string, unknown> | undefined)?.value ??
								"—");
					md += `| ${m.metric} | ${val} |\n`;
				}
			}
			break;
		}

		case "activity": {
			const analyses = (Array.isArray(d.analyses) ? d.analyses : []) as Record<
				string,
				unknown
			>[];
			if (!analyses.length) {
				md += "_(no activity found)_\n";
			} else {
				for (const a of analyses.slice(0, 20)) {
					const date = a.date
						? new Date(String(a.date)).toISOString().slice(0, 10)
						: "?";
					const events = Array.isArray(a.events)
						? (a.events as Record<string, unknown>[])
								.map((e) => e.name || e.category || "?")
								.join(", ")
						: "";
					md += `- ${date}: ${a.projectVersion || "?"}${events ? ` (${events})` : ""}\n`;
				}
			}
			break;
		}

		default:
			md += `Raw API response:\n\n\`\`\`json\n${JSON.stringify(d, null, 2).slice(0, 5000)}\n\`\`\`\n`;
	}

	return {
		ok: true,
		url,
		title: `${parsed.projectKey} — ${parsed.page}`,
		content: md,
	};
}
