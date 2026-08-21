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
 * Overall elapsed-vs-target bar. Classic block fill advances with elapsed
 * time toward the response target and caps at full. In live views the fill
 * turns red past the target; pass `colorOverride` (e.g. "success") for
 * completed views — durationMs is measured after the budget wait, so it
 * routinely lands a few ms past target on perfectly healthy searches.
 */
export function renderElapsedBar(
	elapsedMs: number,
	targetMs: number | undefined,
	width: number,
	theme: ThemeLike,
	colorOverride?: string,
): string {
	const innerWidth = Math.max(8, width - 2);
	const ratio = targetMs && targetMs > 0 ? Math.min(1, elapsedMs / targetMs) : 0;
	const filled = Math.round(ratio * innerWidth);
	const empty = innerWidth - filled;
	const elapsedText = `${(elapsedMs / 1000).toFixed(1)}s`;
	const targetText = targetMs ? ` / ${(targetMs / 1000).toFixed(1)}s` : "";
	const fillColor =
		colorOverride ??
		(targetMs && targetMs > 0 && elapsedMs > targetMs ? "error" : "accent");
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
 *
 * Width-aware: pi hard-clips rendered lines to the component width
 * (truncateToWidth with an ellipsis), so long detail text is degraded
 * progressively — latency first, then wording — to keep every row's
 * count/status actually visible on narrow terminals instead of clipped.
 */
function renderProviderRow(
	provider: SearchProviderProgress,
	spinnerTick: number,
	theme: ThemeLike,
	width = Number.POSITIVE_INFINITY,
): string {
	const glyph = renderProviderGlyph(provider.status, spinnerTick, theme);
	const labelPlain = provider.label;
	const prefixPlain = `${plainGlyph(provider.status, spinnerTick)} ${labelPlain}`;

	// Candidate right-hand texts, longest (most informative) first.
	const candidates: string[] = [];
	switch (provider.status) {
		case "ok": {
			const count = provider.count ?? 0;
			const countText = `${count} result${count === 1 ? "" : "s"}`;
			const latency = formatLatency(provider.latencyMs);
			if (latency) candidates.push(`${countText} (${latency})`);
			candidates.push(countText, `${count}`);
			break;
		}
		case "empty":
			candidates.push("0 results", "0");
			break;
		case "error":
			candidates.push(provider.detail ?? "error", "error");
			break;
		case "timeout":
			candidates.push(provider.detail ?? "timed out", "timed out", "⏱");
			break;
		case "skipped":
			candidates.push(provider.detail ?? "disabled", "–");
			break;
		default:
			candidates.push("searching…");
	}
	const chosen =
		candidates.find((c) => prefixPlain.length + 1 + c.length <= width) ??
		candidates[candidates.length - 1];

	const label = theme.fg("text", labelPlain);
	return `${glyph} ${label} ${statusTextColor(provider.status, chosen, theme)}`;
}

/** Plain (unstyled) glyph character for width math. */
function plainGlyph(status: SearchProviderStatus, spinnerTick: number): string {
	switch (status) {
		case "ok":
			return "✓";
		case "error":
			return "✗";
		case "timeout":
			return "⏱";
		case "empty":
			return "∅";
		case "skipped":
			return "–";
		case "pending":
			return "·";
		default:
			return SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length] ?? "⠋";
	}
}

/** Style a (possibly degraded) status text with the color for its status. */
function statusTextColor(
	status: SearchProviderStatus,
	text: string,
	theme: ThemeLike,
): string {
	switch (status) {
		case "error":
			return theme.fg("error", text);
		case "timeout":
			return theme.fg("warning", text);
		case "running":
			return theme.fg("accent", text);
		default:
			return theme.fg("muted", text);
	}
}

/**
 * Progress component for partial (in-flight) results: elapsed/target bar
 * sized to the available width, then one animated row per provider.
 * No in-component header — pi renders renderCall (`aio-websearch "query"`)
 * directly above this view.
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

	function buildRows(width: number): string[] {
		const providers = details.providers ?? [];
		return providers.map((p) =>
			renderProviderRow(p, details.spinnerTick ?? 0, theme, width),
		);
	}

	return {
		render(width: number): string[] {
			const lines: string[] = [];
			if (details.elapsedMs !== undefined) {
				// Bar fills the line it has, never wider than the terminal.
				const barWidth = Math.max(8, Math.min(24, width - 2));
				lines.push(
					renderElapsedBar(
						details.elapsedMs,
						details.responseTargetMs,
						barWidth,
						theme,
					),
				);
			}
			lines.push(...buildRows(width));
			text.setText(lines.join("\n"));
			return text.render(width);
		},
		invalidate(): void {
			text.invalidate();
		},
	};
}

/**
 * Final-result component — same schema as the in-flight view so the layout
 * never jumps: the bar now full, then one settled row per engine (count +
 * timing), then engine notes. Expanded adds ranked result rows with
 * sourceType tags, domain, URL, and snippet. No in-component header —
 * pi renders renderCall above this view.
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

	function buildSummaryParts(): { styled: string; plain: string } {
		const parts: string[] = [];
		const plains: string[] = [];
		const count = details.resultCount ?? 0;
		const countText = `${count} result${count === 1 ? "" : "s"}`;
		parts.push(
			count > 0
				? theme.fg("success", `✓ ${countText}`)
				: theme.fg("warning", countText),
		);
		plains.push(`✓ ${countText}`);
		if (details.durationMs !== undefined && details.durationMs > 0) {
			parts.push(theme.fg("muted", `in ${formatLatency(details.durationMs)}`));
			plains.push(`in ${formatLatency(details.durationMs)}`);
		}
		if (details.timedOut) {
			parts.push(theme.fg("warning", "response budget hit"));
			plains.push("response budget hit");
		}
		// Degrade gracefully on narrow terminals: drop the duration first,
		// then the budget note — the count always survives.
		while (
			plains.length > 1 &&
			plains.join(" ").length > Math.max(width - 2, 10)
		) {
			parts.pop();
			plains.pop();
		}
		return { styled: parts.join(" "), plain: plains.join(" ") };
	}

	function buildProviderRows(width: number): string[] {
		return (details.providers ?? []).map((p) =>
			renderProviderRow(p, 0, theme, width),
		);
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

	let width = Number.POSITIVE_INFINITY;

	return {
		render(w: number): string[] {
			width = w;
			const lines: string[] = [];
			// Full bar on its own line when present — never clipped, since its
			// width adapts to the terminal.
			if (details.responseTargetMs) {
				const elapsed = details.durationMs ?? details.responseTargetMs;
				const barWidth = Math.max(8, Math.min(24, w - 2));
				lines.push(
					renderElapsedBar(
						elapsed,
						details.responseTargetMs,
						barWidth,
						theme,
						"success",
					),
				);
			}
			lines.push(buildSummaryParts().styled);
			lines.push(...buildProviderRows(w));
			for (const note of details.engineNotes ?? []) {
				lines.push(theme.fg("dim", note));
			}
			if (expanded) lines.push(...buildExpandedRows());
			text.setText(lines.filter((l) => l.length > 0).join("\n"));
			return text.render(w);
		},
		invalidate(): void {
			text.invalidate();
		},
	};
}
