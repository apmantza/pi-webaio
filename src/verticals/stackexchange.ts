// ─── Stack Exchange extractor ──────────────────────────────────────
// Uses the Stack Exchange REST API v2.3.
// No API key required for read-only access (300 req/day without key).
// Covers: Stack Overflow, Super User, Server Fault, Ask Ubuntu,
// MathOverflow, and all *.stackexchange.com sites.

import type { VerticalResult } from "./types.js";

/**
 * Map known Stack Exchange domain to API site parameter.
 */
function domainToSite(hostname: string): string | null {
	const h = hostname.toLowerCase();
	if (h === "stackoverflow.com") return "stackoverflow";
	if (h === "serverfault.com") return "serverfault";
	if (h === "superuser.com") return "superuser";
	if (h === "askubuntu.com") return "askubuntu";
	if (h === "mathoverflow.net") return "mathoverflow";
	// *.stackexchange.com
	const se = h.match(/^([^.]+)\.stackexchange\.com$/);
	if (se) return se[1]!;
	return null;
}

/**
 * Match Stack Exchange question URLs.
 * e.g. stackoverflow.com/questions/12345/slug
 *      superuser.com/questions/12345/slug
 *      *.stackexchange.com/questions/12345/slug
 */
export function matchesStackExchange(url: string): boolean {
	const u = url.toLowerCase();
	return (
		/\b(stackoverflow\.com|serverfault\.com|superuser\.com|askubuntu\.com|mathoverflow\.net|stackexchange\.com)\/questions\/\d+/i.test(
			u,
		) || /\b(stackexchange\.com)\/q\/\d+/i.test(u)
	);
}

export async function extractStackExchange(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return null;
	}
	const site = domainToSite(hostname);
	if (!site) return null;

	// Extract question ID
	const idMatch = url.match(/\bquestions?\/(\d+)/i);
	if (!idMatch) return null;
	const questionId = idMatch[1]!;

	// ── Fetch question + answers (with body) ─────────────────────────
	const apiUrl =
		`https://api.stackexchange.com/2.3/questions/${questionId}?` +
		`site=${site}&filter=withbody&order=desc&sort=votes`;

	const data = await fetchJson(apiUrl);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;
	const items = Array.isArray(d.items)
		? (d.items as Record<string, unknown>[])
		: [];
	if (items.length === 0) return null;

	const q = items[0]!;
	const title = String(q.title || "");
	const qBody = String(q.body_markdown || q.body || "");
	const score = Number(q.score || 0);
	const viewCount = Number(q.view_count || 0);
	const answerCount = Number(q.answer_count || 0);
	const isAnswered = Boolean(q.is_answered);
	const tags = Array.isArray(q.tags) ? (q.tags as string[]) : [];
	const createdDate = q.creation_date
		? new Date(Number(q.creation_date) * 1000).toISOString()
		: "";
	const owner =
		q.owner && typeof q.owner === "object"
			? (q.owner as Record<string, unknown>)
			: null;
	const author = owner ? String(owner.display_name || "") : "";
	const acceptedAnswerId = q.accepted_answer_id
		? Number(q.accepted_answer_id)
		: null;

	// ── Fetch answers ────────────────────────────────────────────────
	const answersUrl =
		`https://api.stackexchange.com/2.3/questions/${questionId}/answers?` +
		`site=${site}&filter=withbody&order=desc&sort=votes&pagesize=5`;

	const answerData = await fetchJson(answersUrl);
	let answers: Record<string, unknown>[] = [];
	let topAnswer: Record<string, unknown> | undefined;

	if (answerData && typeof answerData === "object") {
		const ad = answerData as Record<string, unknown>;
		if (Array.isArray(ad.items)) {
			answers = ad.items as Record<string, unknown>[];

			// Try to find the accepted answer first
			if (acceptedAnswerId) {
				topAnswer = answers.find(
					(a) => Number(a.answer_id) === acceptedAnswerId,
				);
			}
			// Fall back to highest-scored
			if (!topAnswer && answers.length > 0) {
				topAnswer = answers[0]!;
			}
		}
	}

	// ── Build markdown ───────────────────────────────────────────────
	let md = `# ${title}\n\n`;
	md += `- **Site:** ${hostname}\n`;
	if (author) md += `- **Author:** ${author}\n`;
	md += `- **Score:** ${score} points\n`;
	md += `- **Views:** ${viewCount}\n`;
	md += `- **Answers:** ${answerCount}${isAnswered ? " ✓" : ""}\n`;
	if (createdDate) md += `- **Asked:** ${createdDate}\n`;
	if (tags.length) md += `- **Tags:** ${tags.join(", ")}\n`;

	// Question body
	if (qBody) {
		md += `\n## Question\n\n${qBody}\n`;
	}

	// Accepted / Top answer
	if (topAnswer && typeof topAnswer.body_markdown === "string") {
		const answerBody = String(topAnswer.body_markdown);
		const answerScore = Number(topAnswer.score || 0);
		const answerOwner =
			topAnswer.owner && typeof topAnswer.owner === "object"
				? (topAnswer.owner as Record<string, unknown>)
				: null;
		const answerAuthor = answerOwner
			? String(answerOwner.display_name || "")
			: "";
		const isAccepted = acceptedAnswerId
			? Number(topAnswer.answer_id) === acceptedAnswerId
			: false;

		md += `\n## ${isAccepted ? "Accepted Answer" : "Top Answer"}`;
		if (answerAuthor) md += ` — ${answerAuthor}`;
		md += ` (${answerScore} pts)\n\n${answerBody}\n`;
	}

	// Other answers
	const otherAnswers = answers.filter(
		(a) => a !== topAnswer && typeof a.body_markdown === "string",
	);
	if (otherAnswers.length > 0) {
		md += `\n## More Answers\n\n`;
		for (const a of otherAnswers.slice(0, 4)) {
			const aBody = String(a.body_markdown || "").slice(0, 1000);
			const aScore = Number(a.score || 0);
			const aOwner =
				a.owner && typeof a.owner === "object"
					? (a.owner as Record<string, unknown>)
					: null;
			const aAuthor = aOwner ? String(aOwner.display_name || "") : "";
			md += `### ${aAuthor} (${aScore} pts)\n\n${aBody}\n\n`;
		}
	}

	return {
		ok: true,
		url,
		title,
		content: md,
	};
}
