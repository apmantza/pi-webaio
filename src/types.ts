// ─── Shared types ───────────────────────────────────────────────────
// Extracted from index.ts for use across all pi-webaio modules.

// ─── pdf-parse lazy loading ───────────────────────────────────────
// Importing pdf-parse at module load can throw when optional native canvas
// bindings are omitted (for example in CI with npm --omit=optional). Keep the
// extension importable for non-PDF pages and only load pdf-parse for PDF input.

export type PdfParseCtor = new (opts: {
	data: Uint8Array;
}) => {
	load: () => Promise<void>;
	getText: () => Promise<{ text: string; total: number }>;
};

function ensurePdfDomPolyfills(): void {
	const g = globalThis as Record<string, unknown>;
	if (typeof g.DOMMatrix === "undefined") {
		g.DOMMatrix = class DOMMatrix {
			constructor(_init?: unknown) {}
			multiplySelf() {
				return this;
			}
			preMultiplySelf() {
				return this;
			}
			translateSelf() {
				return this;
			}
			scaleSelf() {
				return this;
			}
			rotateSelf() {
				return this;
			}
		};
	}
	if (typeof g.ImageData === "undefined") {
		g.ImageData = class ImageData {
			data?: unknown;
			width?: number;
			height?: number;
			constructor(data?: unknown, width?: number, height?: number) {
				this.data = data;
				this.width = width;
				this.height = height;
			}
		};
	}
	if (typeof g.Path2D === "undefined") {
		g.Path2D = class Path2D {
			constructor(_path?: unknown) {}
		};
	}
}

export async function loadPdfParseCtor(): Promise<PdfParseCtor> {
	ensurePdfDomPolyfills();
	const mod = (await import("pdf-parse")) as unknown as {
		PDFParse?: PdfParseCtor;
		default?: PdfParseCtor;
	};
	const ctor = mod.PDFParse ?? mod.default;
	if (!ctor) throw new Error("pdf-parse did not export PDFParse");
	return ctor;
}

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
	browserPool?: {
		acquirePage: () => Promise<{ page: any; release: () => void }>;
	};
	/** wreq-js session for cookie persistence and connection reuse */
	wreqSession?: any;
	/**
	 * Enable paywall bypass. When the primary fetch returns content
	 * that looks paywalled, retry using a chain of bypass strategies
	 * (bot UA, archive.org, JS script blocking) before giving up.
	 * See src/paywall.ts for details.
	 */
	bypass?: boolean;
	/**
	 * Override the default paywall bypass strategy chain. Useful for
	 * one-off fetches where you know exactly which trick works.
	 * e.g. ["archive"] to skip UA spoofer and go straight to Wayback.
	 */
	bypassStrategies?: Array<
		| "ua:googlebot"
		| "ua:bingbot"
		| "ua:facebookbot"
		| "ua:custom"
		| "referer:google"
		| "block_js"
		| "archive"
		| "archive_first"
		| "cookies"
		| "auto"
	>;
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
