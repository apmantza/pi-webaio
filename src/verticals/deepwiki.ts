// ─── DeepWiki repo-Q&A extractor ───────────────────────────────────
// Asks a natural-language question about a public GitHub repository using
// DeepWiki's hosted MCP server (https://mcp.deepwiki.com/mcp) via a minimal
// JSON-RPC 2.0 client. No API key required.
//
// Flow (MCP Streamable HTTP transport):
//   1. initialize            → captures the mcp-session-id header
//   2. notifications/initialized  (notification, no id)
//   3. tools/call ask_question { repoName, question }
//
// The synthesized answer plus file citations are returned as markdown.
// A direct fetch-based JSON-RPC POST is used intentionally (no MCP SDK
// client) to keep the vertical dependency-light and easy to test.

import type { VerticalResult } from "./types.ts";

const DEEPWIKI_MCP = "https://mcp.deepwiki.com/mcp";
const PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_QUESTION =
	"Give an overview of this repository: its purpose, architecture, main components, and how they fit together.";

export interface DeepWikiCitation {
	filePath: string;
	lineStart?: number;
	lineEnd?: number;
	snippet?: string;
}

export interface DeepWikiAnswer {
	answer: string;
	citations: DeepWikiCitation[];
}

/**
 * Match DeepWiki repo URLs, e.g. https://deepwiki.com/facebook/react.
 * Requires an owner/repo path so the bare site is left to the HTML pipeline.
 */
export function matchesDeepWiki(url: string): boolean {
	return parseDeepWikiUrl(url) !== null;
}

/**
 * Extract the repo (owner/name) and the question from a DeepWiki URL. The
 * question comes from a ?q= / ?question= param when present, otherwise a
 * default overview question is used so a bare repo URL still yields output.
 */
export function parseDeepWikiUrl(
	url: string,
): { repoName: string; question: string } | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (!/(^|\.)deepwiki\.com$/i.test(u.hostname)) return null;

	const m = u.pathname.match(/^\/([^/]+)\/([^/]+)/);
	if (!m) return null;
	const owner = m[1];
	const repo = m[2];
	if (!owner || !repo) return null;

	const question =
		u.searchParams.get("q") ||
		u.searchParams.get("question") ||
		DEFAULT_QUESTION;
	return { repoName: `${owner}/${repo}`, question };
}

/**
 * Parse a JSON-RPC response body that may be plain JSON or an SSE stream
 * (text/event-stream with one or more `data: {...}` lines). Returns the
 * parsed JSON-RPC message, or null if nothing parseable was found.
 */
export function parseDeepWikiRpcBody(
	text: string,
): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	// Plain JSON fast path.
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const j = JSON.parse(trimmed);
			if (j && typeof j === "object") return j as Record<string, unknown>;
		} catch {
			// fall through to SSE parsing
		}
	}

	// SSE: collect `data:` payloads and return the last JSON-RPC message
	// (the final tools/call result follows any progress notifications).
	let last: Record<string, unknown> | null = null;
	for (const line of trimmed.split(/\r?\n/)) {
		const l = line.trim();
		if (!l.startsWith("data:")) continue;
		const payload = l.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const j = JSON.parse(payload);
			if (j && typeof j === "object") last = j as Record<string, unknown>;
		} catch {
			// ignore non-JSON keepalive lines
		}
	}
	return last;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizeCitation(raw: unknown): DeepWikiCitation | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	const filePath =
		(typeof c.file_path === "string" && c.file_path) ||
		(typeof c.filePath === "string" && c.filePath) ||
		(typeof c.path === "string" && c.path) ||
		(typeof c.file === "string" && c.file) ||
		"";
	if (!filePath) return null;
	const cit: DeepWikiCitation = { filePath };
	const lineStart =
		asNumber(c.line_start) ?? asNumber(c.lineStart) ?? asNumber(c.start);
	const lineEnd =
		asNumber(c.line_end) ?? asNumber(c.lineEnd) ?? asNumber(c.end);
	if (lineStart !== undefined) cit.lineStart = lineStart;
	if (lineEnd !== undefined) cit.lineEnd = lineEnd;
	if (typeof c.snippet === "string" && c.snippet) cit.snippet = c.snippet;
	else if (typeof c.content === "string" && c.content) cit.snippet = c.content;
	return cit;
}

/**
 * Interpret a DeepWiki tools/call JSON-RPC response into an answer +
 * citations. The ask_question result content is an array of text blocks;
 * the text is either plain markdown or a JSON string of the form
 * { answer, citations|sources }. Both shapes are handled.
 */
export function parseAskQuestionResult(
	rpc: Record<string, unknown> | null,
): DeepWikiAnswer | null {
	if (!rpc) return null;
	if (rpc.error) return null;

	const result = rpc.result as Record<string, unknown> | undefined;
	if (!result) return null;
	if (result.isError === true) return null;

	const content = result.content;
	if (!Array.isArray(content)) return null;

	const textBlocks: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (typeof b.text === "string") textBlocks.push(b.text);
		}
	}
	if (!textBlocks.length) return null;

	// Try each text block as structured JSON first (answer + citations).
	for (const text of textBlocks) {
		const t = text.trim();
		if (!t.startsWith("{")) continue;
		try {
			const j = JSON.parse(t) as Record<string, unknown>;
			if (typeof j.answer === "string") {
				let rawCits: unknown[] = [];
				if (Array.isArray(j.citations)) rawCits = j.citations;
				else if (Array.isArray(j.sources)) rawCits = j.sources;
				const citations = rawCits
					.map(normalizeCitation)
					.filter((c): c is DeepWikiCitation => c !== null);
				return { answer: j.answer, citations };
			}
		} catch {
			// not JSON — fall through to plain-text handling
		}
	}

	// Plain markdown answer, no structured citations.
	return { answer: textBlocks.join("\n\n").trim(), citations: [] };
}

/**
 * Render file citations as a markdown list with optional line ranges and
 * code snippets.
 */
export function formatDeepWikiCitations(citations: DeepWikiCitation[]): string {
	if (!citations.length) return "";
	let md = "\n## Citations\n\n";
	for (const c of citations) {
		let loc = `\`${c.filePath}\``;
		if (c.lineStart !== undefined && c.lineEnd !== undefined) {
			loc += ` (lines ${c.lineStart}-${c.lineEnd})`;
		} else if (c.lineStart !== undefined) {
			loc += ` (line ${c.lineStart})`;
		}
		md += `- ${loc}\n`;
		if (c.snippet) {
			md += `  \`\`\`\n${c.snippet
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n")}\n  \`\`\`\n`;
		}
	}
	return md;
}

interface RpcResponse {
	status: number;
	json: Record<string, unknown> | null;
	sessionId: string | null;
}

async function rpcCall(
	method: string,
	params: Record<string, unknown>,
	id: number | null,
	sessionId: string | null,
): Promise<RpcResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"User-Agent": "pi-webaio",
	};
	if (sessionId) headers["mcp-session-id"] = sessionId;

	const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
	if (id !== null) body.id = id;

	const res = await fetch(DEEPWIKI_MCP, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const nextSession = res.headers.get("mcp-session-id") || sessionId;
	const text = await res.text();
	return {
		status: res.status,
		json: parseDeepWikiRpcBody(text),
		sessionId: nextSession,
	};
}

/**
 * Ask DeepWiki a question about a repo and render the answer as markdown.
 */
export async function extractDeepWiki(
	url: string,
): Promise<VerticalResult | null> {
	const parsed = parseDeepWikiUrl(url);
	if (!parsed) return null;

	try {
		// 1. initialize — captures the session id.
		const init = await rpcCall(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-webaio", version: "0.7.3" },
			},
			1,
			null,
		);
		const sessionId = init.sessionId;

		// 2. initialized notification (best-effort; some servers require it).
		try {
			await rpcCall("notifications/initialized", {}, null, sessionId);
		} catch {
			// non-fatal — proceed to the tools/call
		}

		// 3. tools/call ask_question.
		const call = await rpcCall(
			"tools/call",
			{
				name: "ask_question",
				arguments: { repoName: parsed.repoName, question: parsed.question },
			},
			2,
			sessionId,
		);

		if (call.status >= 400) {
			return {
				ok: false,
				url,
				content: "",
				error: `DeepWiki request failed with HTTP ${call.status}.`,
			};
		}

		const answer = parseAskQuestionResult(call.json);
		if (!answer) {
			const errObj = call.json?.error as Record<string, unknown> | undefined;
			const msg =
				errObj && typeof errObj.message === "string"
					? errObj.message
					: "DeepWiki returned no answer.";
			return { ok: false, url, content: "", error: msg };
		}

		let md = `# DeepWiki: ${parsed.repoName}\n\n`;
		md += `> **Question:** ${parsed.question}\n\n`;
		md += `## Answer\n\n${answer.answer.trim()}\n`;
		md += formatDeepWikiCitations(answer.citations);

		return {
			ok: true,
			url,
			title: `${parsed.repoName} — DeepWiki`,
			content: md,
		};
	} catch (err) {
		return {
			ok: false,
			url,
			content: "",
			error: `DeepWiki query failed: ${(err as Error).message}`,
		};
	}
}
