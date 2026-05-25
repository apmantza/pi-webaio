// ─── Shared types ───────────────────────────────────────────────────
// Extracted from index.ts for use across all pi-webaio modules.

import { createRequire } from "node:module";

// ─── pdf-parse loose typing (CJS, no bundled .d.ts) ────────────────

const nodeRequire = createRequire(import.meta.url);
export const pdfParse: (
	buf: Buffer,
) => Promise<{ text: string; numpages: number }> = nodeRequire("pdf-parse");

// ─── Core interfaces ───────────────────────────────────────────────

export interface Page {
	url: string;
	title: string;
	markdown: string;
}

export interface FetchErrorInfo {
	message: string;
	code?:
		| "invalid_url"
		| "http_error"
		| "timeout"
		| "network_error"
		| "no_content"
		| "blocked"
		| "processing_error"
		| "download_error"
		| "too_many_redirects"
		| "unknown";
	phase?: "validation" | "connecting" | "waiting" | "loading" | "processing";
	retryable?: boolean;
	statusCode?: number;
}

export interface PullResult {
	ok: boolean;
	url: string;
	title?: string;
	content?: string;
	error?: string;
	errorInfo?: FetchErrorInfo;
	filePath?: string;
	author?: string;
	published?: string;
	site?: string;
	language?: string;
	description?: string;
	wordCount?: number;
	rawHtml?: string;
}

export type ScrapeMode = "fast" | "fingerprint" | "browser" | "auto";

export interface FetchOpts {
	browser?: string;
	os?: string;
	headers?: Record<string, string>;
	proxy?: string;
	mode?: ScrapeMode;
	interactive?: boolean;
	pruneTokens?: number;
	adaptive?: boolean;
}

export interface StoredContent {
	url: string;
	title?: string;
	content: string;
	timestamp: number;
	filePath?: string;
	/** Optional metadata fields for rich content display */
	author?: string;
	published?: string;
	site?: string;
	language?: string;
	wordCount?: number;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	domain?: string;
	sources?: string[];
}

export interface EngineHealthRecord {
	successes: number;
	failures: number;
	consecutiveFailures: number;
	lastFailureReason?: string;
	lastLatencyMs?: number;
	totalLatencyMs: number;
	samples: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	coolDownUntil?: number;
}

export interface EngineSource {
	engine: string;
	result: SearchResult;
	weight: number;
}

export interface GitHubRef {
	owner: string;
	repo: string;
	ref?: string;
	type: "blob" | "tree" | "repo";
	path?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────

export function formatErrorInfo(info: FetchErrorInfo): string {
	const phaseLabels: Record<string, string> = {
		validation: "during validation",
		connecting: "while connecting",
		waiting: "while waiting for response",
		loading: "during download",
		processing: "during processing",
	};
	const codeLabels: Record<string, string> = {
		invalid_url: "Invalid URL",
		http_error: "HTTP error",
		timeout: "Timed out",
		network_error: "Network error",
		no_content: "No content",
		blocked: "Blocked",
		processing_error: "Processing error",
		download_error: "Download error",
		too_many_redirects: "Too many redirects",
		unknown: "Unknown error",
	};

	const parts: string[] = [];
	const codeLabel = codeLabels[info.code ?? "unknown"] ?? "Error";
	parts.push(codeLabel);
	if (info.statusCode) parts.push(`(HTTP ${info.statusCode})`);
	if (info.phase) parts.push(phaseLabels[info.phase] ?? info.phase);
	if (
		info.message &&
		info.message !== codeLabel &&
		info.message !== "Request failed"
	) {
		parts.push(`— ${info.message}`);
	}
	if (info.retryable) parts.push("— retry may help");
	return parts.join(" ");
}
