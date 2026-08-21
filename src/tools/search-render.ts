// ─── aio-websearch TUI rendering ───────────────────────────────────
// Live per-provider progress (partial results) and status-colored final
// rendering for the websearch tool. Mirrors the component patterns from
// render-result.ts (webfetch): pure functions over a details snapshot,
// Text-based components with render(width)/invalidate, spinner frames
// re-emitted by the tool's onUpdate tick.
//
// Agent-facing text output is unchanged — this module only affects what the
// human sees in the pi TUI.

// Spinner animation shared shape with render-result.ts, but deliberately
// duplicated here instead of imported: render-result.ts transitively loads
// @earendil-works/pi-coding-agent (getMarkdownTheme), which statically imports
// the optional @earendil-works/pi-tui peer. Keeping this module off that
// graph preserves the "websearch registers/renders without pi-tui" guarantee
// exercised by tests/tui-compat.test.mjs.
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

/** Milliseconds between spinner ticks (matches webfetch's cadence). */
export const SPINNER_INTERVAL_MS = 100;

import { Text } from "./tui-compat.ts";
import type { EngineStatus } from "../search.ts";

/** Lifecycle of one search provider row in the TUI. */
export type SearchProviderStatus =
	| "pending"
	| "running"
	| "ok"
	| "empty"
	| "error"
	| "timeout"
	| "skipped";

/** One provider's live/final state for the progress + result views. */
export interface SearchProviderProgress {
	id: string;
	label: string;
	status: SearchProviderStatus;
	count?: number;
	latencyMs?: number;
	/** Short human reason for error/timeout rows (e.g. "HTTP 429"). */
	detail?: string;
}

type ThemeLike = {
	fg(color: string, value: string): string;
	bg(color: string, value: string): string;
	bold(value: string): string;
};

function truncate(value: string, width: number): string {
	if (value.length <= width) return value;
	return `${value.slice(0, Math.max(1, width - 1))}…`;
}

function formatLatency(ms: number | undefined): string {
	if (!ms || ms <= 0) return "";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Map one engineStatus entry to a TUI provider row. Pure — covers every
 * EngineStatus variant so degraded engines render truthfully.
 */
export function providerFromEngineStatus(
	id: string,
	label: string,
	entry:
		| {
				count: number;
				status: EngineStatus;
				latencyMs: number;
		  }
		| undefined,
): SearchProviderProgress {
	if (!entry) return { id, label, status: "skipped", detail: "no data" };
	switch (entry.status) {
		case "ok":
			return {
				id,
				label,
				status: "ok",
				count: entry.count,
				latencyMs: entry.latencyMs,
			};
		case "empty":
			return { id, label, status: "empty", count: 0, latencyMs: entry.latencyMs };
		case "timeout":
			return {
				id,
				label,
				status: "timeout",
				detail: `timed out after ${formatLatency(entry.latencyMs)}`,
			};
		case "quota":
			return { id, label, status: "error", detail: "rate-limited" };
		case "cooled_down":
			return { id, label, status: "skipped", detail: "cooled down" };
		case "disabled":
			return { id, label, status: "skipped" };
		default: {
			const httpMatch = /^http_(\d+)$/.exec(entry.status);
			return {
				id,
				label,
				status: "error",
				detail: httpMatch ? `HTTP ${httpMatch[1]}` : entry.status,
			};
		}
	}
}

/**
 * Glyph + color for a provider status. Spinner frames advance with
 * `spinnerTick` so running rows animate.
 */
export function renderProviderGlyph(
	status: SearchProviderStatus,
	spinnerTick: number,
	theme: ThemeLike,
): string {
	const frame = SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length] ?? "⠋";
	switch (status) {
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "timeout":
			return theme.fg("warning", "⏱");
		case "empty":
			return theme.fg("muted", "∅");
		case "skipped":
			return theme.fg("muted", "–");
		case "pending":
			return theme.fg("muted", "·");
		default:
			return theme.fg("accent", frame);
	}
}

/** Human text for the right-hand side of a provider row. */
export function renderProviderStatusText(
	provider: SearchProviderProgress,
	theme: ThemeLike,
): string {
	switch (provider.status) {
		case "pending":
			return theme.fg("muted", "waiting…");
		case "running":
			return theme.fg("accent", "searching…");
		case "ok": {
			const count = `${provider.count ?? 0} result${(provider.count ?? 0) === 1 ? "" : "s"}`;
			const latency = formatLatency(provider.latencyMs);
			return theme.fg("muted", latency ? `${count} (${latency})` : count);
		}
		case "empty":
			return theme.fg("muted", "0 results");
		case "error":
			return theme.fg("error", provider.detail ?? "error");
		case "timeout":
			return theme.fg("warning", provider.detail ?? "timed out");
		case "skipped":
			return theme.fg("muted", provider.detail ?? "disabled");
	}
}

/**
 * Overall elapsed-vs-target bar for the in-flight view. Classic block fill
 * advances with elapsed time toward the response target and caps at full;
 * past the target the fill turns red.
 */
export function renderElapsedBar(
	elapsedMs: number,
	targetMs: number | undefined,
	width: number,
	theme: ThemeLike,
): string {
	const innerWidth = Math.max(8, width - 2);
	const ratio = targetMs && targetMs > 0 ? Math.min(1, elapsedMs / targetMs) : 0;
	const filled = Math.round(ratio * innerWidth);
	const empty = innerWidth - filled;
	const elapsedText = `${(elapsedMs / 1000).toFixed(1)}s`;
	const targetText = targetMs ? ` / ${(targetMs / 1000).toFixed(1)}s` : "";
	const fillColor =
		targetMs && targetMs > 0 && elapsedMs > targetMs ? "error" : "accent";
	return [
		theme.fg(fillColor, "█".repeat(filled)),
		theme.fg("muted", "░".repeat(empty)),
		theme.fg("muted", ` ${elapsedText}${targetText}`),
	].join("");
}

/**
 * One stable provider row: glyph + padded label + right-hand status text.
 * Shared by the in-flight and final views so the schema never changes
 * mid-search — rows fill in place as lanes settle.
 */
function renderProviderRow(
	provider: SearchProviderProgress,
	spinnerTick: number,
	labelWidth: number,
	theme: ThemeLike,
): string {
	const glyph = renderProviderGlyph(provider.status, spinnerTick, theme);
	const label = theme.fg("text", provider.label.padEnd(labelWidth));
	return `${glyph} ${label} ${renderProviderStatusText(provider, theme)}`;
}

/**
 * Progress component for partial (in-flight) results: header with query +
 * elapsed/target bar, then one animated row per provider.
 */
export function createSearchProgressComponent(
	details: {
		query: string;
		providers?: SearchProviderProgress[];
		spinnerTick?: number;
		elapsedMs?: number;
		responseTargetMs?: number;
	},
	theme: ThemeLike,
) {
	const text = new Text("", 0, 0);

	function buildRows(): string[] {
		const lines: string[] = [];
		const providers = details.providers ?? [];
		const labelWidth = Math.max(...providers.map((p) => p.label.length), 4);
		for (const p of providers) {
			lines.push(renderProviderRow(p, details.spinnerTick ?? 0, labelWidth, theme));
		}
		return lines;
	}

	return {
		render(_width: number): string[] {
			const header =
				theme.fg("toolTitle", theme.bold("aio-websearch ")) +
				theme.fg("accent", `"${truncate(details.query, 70)}"`);
			const bar =
				details.elapsedMs === undefined
					? ""
					: " " +
						renderElapsedBar(details.elapsedMs, details.responseTargetMs, 24, theme);
			const rows = buildRows();
			text.setText([header + bar, ...rows].join("\n"));
			return text.render(_width);
		},
		invalidate(): void {
			text.invalidate();
		},
	};
}

/**
 * Final-result component — same schema as the in-flight view so the layout
 * never jumps: header with query, the elapsed/target bar now full, then one
 * settled row per engine (count + timing), then engine notes. Expanded adds
 * ranked result rows with sourceType tags, domain, URL, and snippet.
 */
export function createSearchResultComponent(
	details: {
		query?: string;
		providers?: SearchProviderProgress[];
		resultCount?: number;
		durationMs?: number;
		responseTargetMs?: number;
		timedOut?: boolean;
		engineNotes?: string[];
		results?: Array<{
			title?: string;
			url?: string;
			domain?: string;
			snippet?: string;
			sources?: string[];
			sourceType?: string;
		}>;
	},
	expanded: boolean,
	theme: ThemeLike,
) {
	const text = new Text("", 0, 0);

	function buildHeader(): string {
		const title = theme.fg("toolTitle", theme.bold("aio-websearch "));
		const query = details.query
			? theme.fg("accent", `"${truncate(details.query, 70)}"`)
			: "";
		return title + query;
	}

	function buildBarLine(): string {
		const target = details.responseTargetMs;
		const elapsed = details.durationMs ?? target ?? 0;
		const bar = target ? renderElapsedBar(elapsed, target, 24, theme) + " " : "";
		const parts: string[] = [];
		const count = details.resultCount ?? 0;
		const countText = `${count} result${count === 1 ? "" : "s"}`;
		parts.push(
			count > 0
				? theme.fg("success", `✓ ${countText}`)
				: theme.fg("warning", countText),
		);
		if (details.durationMs !== undefined && details.durationMs > 0) {
			parts.push(theme.fg("muted", `in ${formatLatency(details.durationMs)}`));
		}
		if (details.timedOut) {
			parts.push(theme.fg("warning", "response budget hit"));
		}
		return bar + parts.join(" ");
	}

	function buildProviderRows(): string[] {
		const providers = details.providers ?? [];
		if (!providers.length) return [];
		const labelWidth = Math.max(...providers.map((p) => p.label.length), 4);
		return providers.map((p) => renderProviderRow(p, 0, labelWidth, theme));
	}

	function buildExpandedRows(): string[] {
		const rows: string[] = [];
		const visibleLimit = 8;
		const results = details.results ?? [];
		results.slice(0, visibleLimit).forEach((r, i) => {
			const rank = theme.fg("accent", `${String(i + 1).padStart(2)}. `);
			const typeTag = r.sourceType ? theme.fg("muted", `[${r.sourceType}] `) : "";
			const domainTag = r.domain ? theme.fg("dim", ` (${r.domain})`) : "";
			const srcTag =
				r.sources && r.sources.length > 1
					? theme.fg("dim", ` — ${r.sources.join("+")}`)
					: "";
			rows.push(
				`${rank}${typeTag}${theme.fg("accent", (r.title ?? "").slice(0, 80))}${domainTag}${srcTag}`,
			);
			if (r.url) rows.push(theme.fg("dim", `   ${r.url.slice(0, 100)}`));
			if (r.snippet) rows.push(theme.fg("muted", `   ${r.snippet.slice(0, 140)}`));
		});
		if (results.length > visibleLimit) {
			rows.push(theme.fg("dim", `… ${results.length - visibleLimit} more`));
		}
		return rows;
	}

	return {
		render(_width: number): string[] {
			const lines: string[] = [buildHeader(), buildBarLine()];
			lines.push(...buildProviderRows());
			for (const note of details.engineNotes ?? []) {
				lines.push(theme.fg("dim", note));
			}
			if (expanded) lines.push(...buildExpandedRows());
			text.setText(lines.filter((l) => l.length > 0).join("\n"));
			return text.render(_width);
		},
		invalidate(): void {
			text.invalidate();
		},
	};
}
