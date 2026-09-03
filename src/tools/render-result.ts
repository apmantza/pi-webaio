/**
 * TUI renderer for aio-webfetch and aio-webpull results.
 *
 * Provides width-aware progress bars, status glyphs, collapsed previews,
 * and expandable content panes using pi-tui widgets. Inspired by
 * Thinkscape/agent-smart-fetch's pi-smart-fetch renderer.
 *
 * Two component types:
 * - createProgressComponent(details, theme) — partial result (in-flight)
 * - createResultComponent(details, expanded, theme) — final result
 *
 * Both return Component-shaped objects with `render(width)` and
 * `invalidate()`. The execute() function mutates `details` and calls
 * `onUpdate` to push fresh state to the TUI.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
} from "./tui-compat.ts";
import { redactSecrets } from "../redact.ts";
import type { OutlineHeading } from "../outline.ts";

/** Spinner frames for the in-flight progress glyph. */
export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];

/** Minimum render interval for spinner animation. */
export const SPINNER_INTERVAL_MS = 100;

/** Maximum lines shown in the collapsed preview. */
const COLLAPSED_PREVIEW_LINES = 7;

/** Status values used in the progress display. */
export type FetchStatus =
	| "queued"
	| "connecting"
	| "fetching"
	| "loading"
	| "processing"
	| "done"
	| "error";

/** Per-URL progress item. Mirrors the shape used by smart-fetch's batch renderer. */
export type FetchItemProgress = {
	index: number;
	url: string;
	status: FetchStatus;
	progress: number; // 0..1
	error?: string;
	/** Wall time (ms) spent on this item. Set at status=loading/done/error. */
	elapsedMs?: number;
};

/** Partial/final details shape used by the renderer. */
export type WebfetchDetails = {
	// ── Progress (partial) ──
	total?: number;
	completed?: number;
	succeeded?: number;
	failed?: number;
	items?: FetchItemProgress[];

	// ── Result (final) ──
	outPath?: string;
	title?: string;
	url?: string;
	responseId?: string;
	browser?: string;
	os?: string;
	proxy?: string;
	truncated?: boolean;
	summarized?: boolean;
	fullLength?: number;
	summaryLength?: number;
	packagePath?: string;
	filePath?: string;
	fileSize?: number;
	mimeType?: string;

	// ── Renderer-only fields ──
	/** Preview body for the rendered result view. Large full bodies stay in tool content/storage. */
	content?: string;
	/** Output format hint (controls Markdown highlighting). */
	format?: "markdown" | "text" | "html" | "json" | "raw";
	/** UX1: when true, render the compact heading outline instead of the body. */
	outlineMode?: boolean;
	/** UX1/UX4: compact heading outline (document order; levels encode the tree). */
	outline?: OutlineHeading[];
	/** UX4: total word count of the fetched content. */
	wordCount?: number;
	/** Short error message for collapsed error view. */
	errorText?: string;
	/** 1-line user-facing error summary (red) in TUI. */
	userErrorSummary?: string;
	/** Suggested retry timeout (ms) for timeout-class errors, or undefined. */
	suggestedTimeoutMs?: number;
	/** FetchError.phase — shown as a small badge in the error view. */
	errorPhase?: string;
	/** FetchError.category — shown as a small badge in the error view. */
	errorCategory?: string;
	/** FetchError.retryable — controls whether the retry hint is shown. */
	errorRetryable?: boolean;
	/** Internal: spinner tick (mutated by execute). */
	spinnerTick?: number;
	/** Internal: current fetch status for single-item display. */
	status?: FetchStatus;
	/** Internal: optimistic 0..1 progress for the bar fill. */
	progress?: number;
};

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Truncate a string to fit `width` columns, ellipsizing the middle.
 * e.g. "https://very-long-url.example.com/path" with width 30 →
 *      "https://very-…ple.com/path"
 */
export function truncateMiddle(value: string, width: number): string {
	if (width <= 0) return "";
	if (value.length <= width) return value;
	if (width === 1) return "…";
	const left = Math.ceil((width - 1) / 2);
	const right = Math.floor((width - 1) / 2);
	return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

/**
 * Strip common markdown syntax to produce a plain-text approximation.
 * Handles: headers, bold/italic, code spans/blocks, links, images,
 * list markers, blockquote markers, horizontal rules, HTML tags.
 * Not perfect — for high-fidelity conversion use a library like
 * `remove-markdown` — but covers the common cases.
 */
export function markdownToText(md: string): string {
	if (!md) return "";
	let s = md;
	// Code blocks (fenced) first so we don't process their contents
	s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|\n?```/g, ""));
	// Inline code
	s = s.replace(/`([^`]+)`/g, "$1");
	// Images ![alt](url) → alt
	s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
	// Links [text](url) → text
	s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	// Headers # ## ### etc
	s = s.replace(/^#{1,6}[ \t]+/gm, "");
	// Blockquote markers (use [ \t] not \s so we don't eat newlines)
	s = s.replace(/^[ \t]*>[ \t]?/gm, "");
	// Horizontal rules
	s = s.replace(/^[-*_]{3,}[ \t]*$/gm, "");
	// Unordered list markers
	s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "");
	// Ordered list markers
	s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
	// Bold + italic (asterisk & underscore variants)
	s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
	s = s.replace(/(\*|_)(.*?)\1/g, "$2");
	// Strikethrough
	s = s.replace(/~~(.*?)~~/g, "$1");
	// Raw HTML tags — strip tags without crossing nested `<` boundaries,
	// and repeat until stable so nested/overlapping tags (e.g.
	// `<<script>script>`) cannot survive sanitization. Capped at 3
	// iterations: 2 passes cover the `<<tag>tag>` re-introduction class
	// (CodeQL js/incomplete-multi-character-sanitization), 3 is a safety
	// margin — avoids O(n*passes) on large docs with many tags.
	let previous: string;
	let iter = 0;
	do {
		previous = s;
		s = s.replace(/<[^<>]*>/g, "");
	} while (s !== previous && ++iter < 3);
	// Collapse 3+ newlines to 2
	s = s.replace(/\n{3,}/g, "\n\n");
	// Trim trailing whitespace on each line
	s = s
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n");
	return s.trim();
}

/** Valid format values accepted by aio-webfetch's `format` param. */
type FetchOutputFormat = "markdown" | "html" | "text" | "json" | "raw";

export const FETCH_OUTPUT_FORMATS: ReadonlySet<string> =
	new Set<FetchOutputFormat>(["markdown", "html", "text", "json", "raw"]);

/**
 * Apply a `format` choice to a PullResult and return a structured
 * `{format, body, savedToDisk, contentLength}` record. The result
 * can be used to:
 *   - build the per-item worker return value
 *   - decide whether to write the body to a file (markdown only)
 *   - populate the TUI's "format" badge
 */
export interface FormattedOutput {
	format: FetchOutputFormat;
	body: string;
	savedToDisk: boolean;
	contentLength: number;
}

export function applyFormat(
	result: {
		ok: true;
		url: string;
		title?: string;
		content?: string;
		rawHtml?: string;
		author?: string;
		published?: string;
		site?: string;
		language?: string;
		wordCount?: number;
		mimeType?: string;
	},
	format: string | undefined,
	markdown: string,
): FormattedOutput {
	const fmt: FetchOutputFormat =
		format && FETCH_OUTPUT_FORMATS.has(format)
			? (format as FetchOutputFormat)
			: "markdown";

	switch (fmt) {
		case "markdown":
			return {
				format: "markdown",
				body: markdown,
				savedToDisk: true,
				contentLength: markdown.length,
			};
		case "html": {
			const body = result.rawHtml ?? result.content ?? "";
			return {
				format: "html",
				body,
				savedToDisk: false,
				contentLength: body.length,
			};
		}
		case "text": {
			const body = markdownToText(result.content ?? "");
			return {
				format: "text",
				body,
				savedToDisk: false,
				contentLength: body.length,
			};
		}
		case "json": {
			const body = JSON.stringify(
				{
					url: result.url,
					title: result.title,
					author: result.author,
					published: result.published,
					site: result.site,
					language: result.language,
					wordCount: result.wordCount,
					mimeType: result.mimeType,
					contentLength: result.content?.length ?? 0,
					rawHtmlLength: result.rawHtml?.length ?? 0,
					content: result.content ?? "",
					rawHtml: result.rawHtml,
				},
				null,
				2,
			);
			return {
				format: "json",
				body,
				savedToDisk: false,
				contentLength: body.length,
			};
		}
		case "raw": {
			// We don't preserve the original HTTP response in PullResult,
			// so `raw` is a best-effort approximation: surface what we have.
			const body = result.rawHtml ?? result.content ?? "";
			return {
				format: "raw",
				body,
				savedToDisk: false,
				contentLength: body.length,
			};
		}
	}
}

/**
 * Slowly advance the displayed progress so the bar doesn't look stuck
 * during the "processing" / extraction phase.
 */
export function getOptimisticProgress(
	status: FetchStatus,
	baseProgress: number,
	elapsedMs: number,
): number {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
	switch (status) {
		case "queued":
			return 0;
		case "connecting":
			return Math.min(0.1, Math.max(baseProgress, seconds * 0.01));
		case "fetching":
			return Math.min(0.4, Math.max(baseProgress, 0.11 + seconds * 0.05));
		case "loading":
			return Math.min(0.85, Math.max(baseProgress, 0.41 + seconds * 0.05));
		case "processing":
			return Math.min(0.99, Math.max(baseProgress, 0.86 + seconds * 0.01));
		case "done":
			return 1;
		case "error":
			return 1;
	}
}

// ─── Progress bar renderer ──────────────────────────────────────────────

type ThemeLike = {
	fg(color: string, value: string): string;
	bg(color: string, value: string): string;
	bold(value: string): string;
};

/**
 * Render a status glyph for a single fetch item.
 *   done   → ✓ (success color)
 *   error  → ✗ (error color)
 *   queued → muted spinner
 *   other  → accent-color spinner
 */
function renderStatusGlyph(
	status: FetchStatus,
	spinnerIndex: number,
	theme: ThemeLike,
): string {
	const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋";
	switch (status) {
		case "done":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "queued":
			return theme.fg("muted", frame);
		default:
			return theme.fg("accent", frame);
	}
}

/**
 * Render a progress bar of the form `[██████░░░░]` with a status label
 * centered in the bar. Status colors follow pi theme conventions.
 */
function renderProgressBar(
	progress: number,
	status: FetchStatus,
	width: number,
	theme: ThemeLike,
): string {
	const innerWidth = Math.max(10, width - 2);
	const filled = Math.max(
		0,
		Math.min(innerWidth, Math.round(progress * innerWidth)),
	);

	const barBg =
		status === "error"
			? "toolErrorBg"
			: status === "done"
				? "toolSuccessBg"
				: status === "queued"
					? "toolPendingBg"
					: "selectedBg";

	const label = status;
	const centered = (() => {
		if (label.length >= innerWidth) return label.slice(0, innerWidth);
		const pad = innerWidth - label.length;
		const left = Math.floor(pad / 2);
		const right = pad - left;
		return `${" ".repeat(left)}${label}${" ".repeat(right)}`;
	})();

	const filledLabel = centered.slice(0, filled);
	const emptyLabel = centered.slice(filled);

	return [
		theme.fg("muted", "["),
		theme.bg(barBg, theme.fg("text", filledLabel)),
		theme.bg("toolPendingBg", theme.fg("muted", emptyLabel)),
		theme.fg("muted", "]"),
	].join("");
}

/**
 * Render the header row: `<glyph> <truncated-url> <progress-bar>`.
 * Shared between single-item and per-batch-item progress display.
 */
function renderProgressRow(
	item: FetchItemProgress,
	width: number,
	spinnerTick: number,
	theme: ThemeLike,
): string {
	const availableRowWidth = Math.max(24, width);
	const showElapsed = item.elapsedMs !== undefined && item.elapsedMs >= 1000;
	const elapsedText = showElapsed
		? `${(item.elapsedMs! / 1000).toFixed(1)}s`
		: "";
	// Reserve space for the trailing " X.Xs" only when we actually render it.
	const elapsedWidth = elapsedText.length === 0 ? 0 : elapsedText.length + 1;
	const progressWidth = Math.max(
		12,
		Math.min(18, Math.floor((availableRowWidth - elapsedWidth) * 0.2)),
	);
	const glyphWidth = 2;
	const urlWidth = Math.max(
		12,
		availableRowWidth - glyphWidth - progressWidth - elapsedWidth - 2,
	);

	const glyph = renderStatusGlyph(item.status, spinnerTick + item.index, theme);
	// H2: mask any credential embedded in the echoed URL (e.g.
	// https://user:pass@host or ?api_key=…). No-op on clean URLs.
	const url = theme.fg(
		"accent",
		truncateMiddle(redactSecrets(item.url), urlWidth),
	);
	const bar = renderProgressBar(
		item.progress,
		item.status,
		progressWidth,
		theme,
	);
	const elapsed = showElapsed ? ` ${theme.fg("muted", elapsedText)}` : "";

	return `${glyph} ${url} ${bar}${elapsed}`;
}

// ─── Public factories ────────────────────────────────────────────────────

/**
 * Create a width-aware progress component for partial (in-flight) results.
 *
 * `details` is a live, mutable object — the tool's execute() function
 * updates it via `onUpdate` callbacks. Each `setText` call invalidates
 * the underlying Text cache so the bar re-renders on next `render(width)`.
 */
export function createProgressComponent(
	details: WebfetchDetails,
	theme: ThemeLike,
) {
	const text = new Text("", 0, 0);
	const spinnerTick = details.spinnerTick ?? 0;

	// Build a synthetic single-item list for single-URL fetches.
	function buildItems(): FetchItemProgress[] {
		if (details.items && details.items.length > 0) {
			return details.items;
		}
		// Single-item case: synthesize from flat fields.
		const url = details.url ?? "";
		return [
			{
				index: 0,
				url,
				status: details.status ?? "connecting",
				progress: details.progress ?? 0,
				error: details.errorText,
			},
		];
	}

	function buildSummary(): string {
		const total = details.total ?? 1;
		const completed = details.completed ?? 0;
		const succeeded = details.succeeded ?? 0;
		const failed = details.failed ?? 0;
		if (total > 1) {
			return (
				theme.fg("toolTitle", theme.bold("aio-webfetch ")) +
				theme.fg("muted", `${completed}/${total} · ok ${succeeded} · err ${failed}`)
			);
		}
		// Single URL: just show tool title + URL.
		const items = buildItems();
		const item = items[0];
		if (!item) {
			return theme.fg("toolTitle", theme.bold("aio-webfetch "));
		}
		return (
			theme.fg("toolTitle", theme.bold("aio-webfetch ")) +
			theme.fg("accent", truncateMiddle(redactSecrets(item.url), 60))
		);
	}

	function buildRows(width: number): string {
		const items = buildItems();
		return items
			.map((item) => {
				const base = renderProgressRow(item, width, spinnerTick, theme);
				if (item.error) {
					return `${base}\n  ${theme.fg("error", `error: ${redactSecrets(item.error)}`)}`;
				}
				return base;
			})
			.join("\n");
	}

	return {
		render(width: number): string[] {
			const summary = buildSummary();
			const rows = buildRows(width);
			text.setText(rows ? `${summary}\n${rows}` : summary);
			return text.render(width);
		},
		invalidate(): void {
			text.invalidate();
		},
	};
}

/**
 * Render a single labeled metadata field for the result view.
 * e.g. `Title: Example Article` with `Title:` in syntaxKeyword and the value in syntaxString.
 */
function renderUserMetadataLine(
	label: string,
	value: string | number,
	theme: ThemeLike,
): string {
	return (
		theme.fg("syntaxKeyword", `${label}: `) +
		theme.fg("syntaxString", String(value))
	);
}

/**
 * Build the collapsed preview (first N non-empty lines) from the content.
 * Returns preview text and count of remaining lines.
 */
function buildCollapsedPreview(details: WebfetchDetails): {
	previewContent: string;
	remainingLines: number;
	totalLines: number;
} {
	const content = details.content ?? "";
	if (!content) {
		return { previewContent: "", remainingLines: 0, totalLines: 0 };
	}
	const contentLines = content.split("\n");
	const previewLines: string[] = [];
	let count = 0;
	for (const line of contentLines) {
		if (count >= COLLAPSED_PREVIEW_LINES) break;
		previewLines.push(line);
		count++;
	}
	return {
		previewContent: previewLines.join("\n"),
		remainingLines: Math.max(0, contentLines.length - previewLines.length),
		totalLines: contentLines.length,
	};
}

/**
 * Build the file metadata block (size, mime, path) for `kind: "file"` results.
 */
function buildFileMetadataLines(
	details: WebfetchDetails,
	theme: ThemeLike,
): string[] {
	const lines: string[] = [];
	if (details.fileSize !== undefined) {
		lines.push(theme.fg("muted", `File size: ${details.fileSize} bytes`));
	}
	if (details.mimeType) {
		lines.push(theme.fg("muted", `Mime type: ${details.mimeType}`));
	}
	if (details.filePath) {
		lines.push(theme.fg("muted", `File path: ${details.filePath}`));
	}
	return lines;
}

/**
 * Build the standard result metadata block (title, URL, response id, etc.).
 */
function buildResultMetadataLines(
	details: WebfetchDetails,
	theme: ThemeLike,
): string[] {
	const rows: Array<[label: string, value: string | number | undefined]> = [
		["Title", details.title],
		// H2: mask credentials embedded in the echoed URL.
		["URL", details.url ? redactSecrets(details.url) : details.url],
	];
	if (details.responseId) {
		rows.push(["Response ID", details.responseId]);
	}
	if (details.summarized) {
		rows.push([
			"Summarized",
			`AI summary (${details.summaryLength ?? 0} chars) · full content ${details.fullLength ?? 0} chars saved`,
		]);
	} else if (details.truncated && details.fullLength !== undefined) {
		rows.push(["Truncated", `${details.fullLength} chars total`]);
	}
	if (details.outPath) {
		rows.push(["Saved to", details.outPath]);
	}
	if (details.format && details.format !== "markdown") {
		rows.push(["Format", details.format]);
	}
	if (details.packagePath) {
		rows.push(["Package", details.packagePath]);
	}
	if (details.browser || details.os) {
		rows.push(["Profile", `${details.browser ?? "?"}/${details.os ?? "?"}`]);
	}
	return rows
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([label, value]) =>
			renderUserMetadataLine(label, value as string | number, theme),
		);
}

/**
 * UX1: build the compact outline rendering for the TUI (one line per heading,
 * level conveyed by indentation, per-section word counts parenthesized).
 */
function buildOutlineLines(
	details: WebfetchDetails,
	theme: ThemeLike,
): string[] {
	const headings = details.outline ?? [];
	const lines: string[] = [
		theme.fg(
			"muted",
			`Outline: ${details.wordCount ?? 0} words, ${headings.length} section${headings.length === 1 ? "" : "s"}`,
		),
	];
	if (headings.length === 0) {
		lines.push(theme.fg("muted", "- (no headings — flat document)"));
	}
	for (const h of headings) {
		const indent = "  ".repeat(Math.max(0, h.level - 1));
		const wc = h.words !== undefined ? theme.fg("muted", ` (${h.words})`) : "";
		lines.push(`${indent}- ${theme.fg("text", h.text)}${wc}`);
	}
	return lines;
}

/**
 * Decide whether the body content should be wrapped in a Markdown widget
 * (for syntax highlighting) or shown as plain text.
 */
function shouldHighlight(
	format: WebfetchDetails["format"] | undefined,
): boolean {
	return format === undefined || format === "markdown";
}

/**
 * Create the final-result component (collapsed or expanded).
 *
 * Layout:
 *   ┌─ metadata lines ─┐
 *   │ Title: foo       │
 *   │ URL: https://…   │
 *   │ Saved to: /tmp/… │
 *   ├──────────────────┤
 *   │ content (preview │
 *   │ or expanded)     │
 *   │ …                │
 *   │                  │
 *   │ (N more lines,   │
 *   │  Ctrl+O to       │
 *   │  expand)         │
 *   └──────────────────┘
 */
export function createResultComponent(
	details: WebfetchDetails,
	expanded: boolean,
	theme: ThemeLike,
	markdownTheme: MarkdownTheme = getMarkdownTheme(),
) {
	const container = new Container();

	// Error path: show a one-line red summary. The full error lives in
	// `result.content[0].text` for the agent, so the TUI can be terse.
	if (details.userErrorSummary || details.errorText) {
		const summary = redactSecrets(
			details.userErrorSummary ?? details.errorText ?? "Fetch failed",
		);
		container.addChild(new Text(theme.fg("error", summary), 0, 0));
		// Phase / category badge — helps the agent decide whether to retry
		// with a different mode (e.g. switch to browser on 'blocked').
		if (details.errorPhase || details.errorCategory) {
			const bits: string[] = [];
			if (details.errorPhase) bits.push(`phase: ${details.errorPhase}`);
			if (details.errorCategory) bits.push(`category: ${details.errorCategory}`);
			container.addChild(new Text(theme.fg("muted", bits.join("  ·  ")), 0, 0));
		}
		// Suggested retry timeout — only shown when the error is retryable
		// and we have a meaningful suggestion.
		if (details.suggestedTimeoutMs && details.errorRetryable !== false) {
			const suggestion = `↻ Retry with timeout ≈ ${(details.suggestedTimeoutMs / 1000).toFixed(1)}s`;
			container.addChild(new Text(theme.fg("muted", suggestion), 0, 0));
		}
		return container;
	}

	// File result: show file metadata only (no body content).
	if (details.filePath && details.content === undefined) {
		const fileLines = buildFileMetadataLines(details, theme);
		if (fileLines.length > 0) {
			container.addChild(new Text(fileLines.join("\n"), 0, 0));
		}
		return container;
	}

	const metadataLines = buildResultMetadataLines(details, theme);
	if (metadataLines.length > 0) {
		container.addChild(new Text(metadataLines.join("\n"), 0, 0));
	}

	// UX1: outline mode renders the compact heading outline instead of the
	// body (the full content stays saved/cached; only the view changes).
	if (details.outlineMode) {
		if (metadataLines.length > 0) {
			container.addChild(new Spacer(1));
		}
		container.addChild(
			new Text(buildOutlineLines(details, theme).join("\n"), 0, 0),
		);
		return container;
	}

	const content = details.content ?? "";
	if (!content) {
		return container;
	}

	if (metadataLines.length > 0) {
		container.addChild(new Spacer(1));
	}

	if (expanded) {
		// H2: mask high-precision secrets in the rendered body preview.
		// Only unambiguous shapes (JWTs, private keys, auth headers,
		// password-URLs, real secret assignments) are masked, so
		// legitimate documentation prose is left intact.
		const safeContent = redactSecrets(content);
		if (shouldHighlight(details.format)) {
			container.addChild(new Markdown(safeContent, 0, 0, markdownTheme));
		} else {
			container.addChild(new Text(safeContent, 0, 0));
		}
	} else {
		const { previewContent, remainingLines } = buildCollapsedPreview(details);
		const safePreview = redactSecrets(previewContent);
		if (shouldHighlight(details.format)) {
			container.addChild(new Markdown(safePreview, 0, 0, markdownTheme));
		} else {
			container.addChild(new Text(safePreview, 0, 0));
		}

		if (remainingLines > 0) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("muted", `... (${remainingLines} more lines, `) +
						theme.fg("dim", "Ctrl+O") +
						theme.fg("muted", " to expand)"),
					0,
					0,
				),
			);
		}
	}

	return container;
}

/**
 * Create the call header component (e.g. `aio-webfetch https://example.com`).
 */
export function createCallComponent(
	args: Record<string, unknown>,
	theme: ThemeLike,
) {
	const url =
		(typeof args.url === "string" && args.url) ||
		(Array.isArray(args.urls) && (args.urls[0] as string)) ||
		"...";
	const count = Array.isArray(args.urls) ? args.urls.length : 1;
	const label = count > 1 ? `aio-webfetch ×${count}` : "aio-webfetch";
	// H2: mask any credential embedded in the echoed URL.
	return new Text(
		`${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", redactSecrets(url))}`,
		0,
		0,
	);
}
