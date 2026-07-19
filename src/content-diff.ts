// ─── Content diff (issue #45) ───────────────────────────────────────
// Zero-dependency section-level markdown diff. Splits both the old and
// new content into sections keyed by their heading, then classifies
// each section as unchanged / changed / added / removed.
//
// Falls back to a compact unified-style line diff when content has no
// headings (e.g. plain-text or API JSON bodies).

// ─── Section splitting ─────────────────────────────────────────────

export interface Section {
	/** Full heading line, e.g. "## Installation" */
	heading: string;
	/** Normalized heading text for identity comparison */
	key: string;
	/** Body text following the heading (trimmed) */
	body: string;
}

/** Split markdown into sections by H1–H6 headings. */
export function splitSections(markdown: string): Section[] {
	const lines = markdown.split("\n");
	const sections: Section[] = [];
	let currentHeading = "(preamble)";
	let currentKey = "__preamble__";
	let bodyLines: string[] = [];

	function flush() {
		const body = bodyLines.join("\n").trim();
		if (body || currentKey !== "__preamble__") {
			sections.push({ heading: currentHeading, key: currentKey, body });
		}
		bodyLines = [];
	}

	for (const line of lines) {
		const hm = line.match(/^(#{1,6})\s+(.+)/);
		if (hm) {
			flush();
			currentHeading = line.trim();
			currentKey = hm[2]!.trim().toLowerCase().replace(/\s+/g, " ");
		} else {
			bodyLines.push(line);
		}
	}
	flush();
	return sections;
}

// ─── LCS-based line diff (for no-heading fallback) ─────────────────

function lcsLength(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	// Use two-row DP to stay O(m*n) in time, O(n) in space.
	let prev = new Array<number>(n + 1).fill(0);
	let curr = new Array<number>(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
		}
		[prev, curr] = [curr, prev];
		curr.fill(0);
	}
	// Return full table needed for backtracking — rebuild with full DP
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i]![j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1]![j - 1]! + 1
					: Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
		}
	}
	return dp;
}

interface LineDiff {
	added: string[];
	removed: string[];
	unchanged: number;
}

function lineDiff(oldLines: string[], newLines: string[]): LineDiff {
	const dp = lcsLength(oldLines, newLines);
	const added: string[] = [];
	const removed: string[] = [];
	let unchanged = 0;

	let i = oldLines.length;
	let j = newLines.length;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			unchanged++;
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
			added.push(newLines[j - 1]!);
			j--;
		} else {
			removed.push(oldLines[i - 1]!);
			i--;
		}
	}
	return { added, removed, unchanged };
}

// ─── Main diff function ────────────────────────────────────────────

export interface DiffResult {
	/** Human-readable diff summary string. */
	summary: string;
	/** True when content is identical. */
	unchanged: boolean;
	/** Added sections (heading keys). */
	addedSections: string[];
	/** Removed sections (heading keys). */
	removedSections: string[];
	/** Changed sections (heading keys). */
	changedSections: string[];
}

/**
 * Compute a readable section-level markdown diff between `oldContent`
 * and `newContent`. Falls back to a compact line-diff when neither
 * version has headings.
 */
export function diffContent(
	oldContent: string,
	newContent: string,
): DiffResult {
	// Exact match short-circuit.
	if (oldContent === newContent) {
		return {
			summary: "Content is identical.",
			unchanged: true,
			addedSections: [],
			removedSections: [],
			changedSections: [],
		};
	}

	const oldSections = splitSections(oldContent);
	const newSections = splitSections(newContent);

	// Use section-level diff only when at least one version has real headings.
	const hasHeadings =
		oldSections.some((s) => s.key !== "__preamble__") ||
		newSections.some((s) => s.key !== "__preamble__");

	if (!hasHeadings) {
		return fallbackLineDiff(oldContent, newContent);
	}

	const oldMap = new Map<string, Section>(oldSections.map((s) => [s.key, s]));
	const newMap = new Map<string, Section>(newSections.map((s) => [s.key, s]));

	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];

	// Sections in old but not new → removed
	for (const [key, sec] of oldMap) {
		if (!newMap.has(key)) {
			removed.push(sec.heading);
		}
	}

	// Sections in new but not old → added; overlap with changed body → changed
	for (const [key, newSec] of newMap) {
		const oldSec = oldMap.get(key);
		if (!oldSec) {
			added.push(newSec.heading);
		} else if (oldSec.body.trim() !== newSec.body.trim()) {
			changed.push(newSec.heading);
		}
	}

	const totalChanges = added.length + removed.length + changed.length;
	if (totalChanges === 0) {
		return {
			summary: "Content is identical.",
			unchanged: true,
			addedSections: [],
			removedSections: [],
			changedSections: [],
		};
	}

	const parts: string[] = [];

	if (added.length > 0) {
		parts.push(`## Added sections (${added.length})\n${added.map((h) => `+ ${h}`).join("\n")}`);
	}
	if (removed.length > 0) {
		parts.push(`## Removed sections (${removed.length})\n${removed.map((h) => `- ${h}`).join("\n")}`);
	}
	if (changed.length > 0) {
		parts.push(`## Changed sections (${changed.length})\n${changed.map((h) => `~ ${h}`).join("\n")}`);
	}

	return {
		summary: parts.join("\n\n"),
		unchanged: false,
		addedSections: added,
		removedSections: removed,
		changedSections: changed,
	};
}

// ─── Fallback: compact unified-style line diff ─────────────────────

function fallbackLineDiff(oldContent: string, newContent: string): DiffResult {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	// Bail out gracefully for very large content to avoid O(m*n) hang.
	const MAX_LINES = 2000;
	if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
		return {
			summary: `Content changed (${newLines.length} lines, too large for inline diff — full content cached).`,
			unchanged: false,
			addedSections: [],
			removedSections: [],
			changedSections: [],
		};
	}

	const { added, removed, unchanged } = lineDiff(oldLines, newLines);

	if (added.length === 0 && removed.length === 0) {
		return {
			summary: "Content is identical.",
			unchanged: true,
			addedSections: [],
			removedSections: [],
			changedSections: [],
		};
	}

	const MAX_SHOW = 10;
	const parts: string[] = [
		`${added.length} line${added.length === 1 ? "" : "s"} added, ${removed.length} removed, ${unchanged} unchanged.`,
	];
	if (added.length > 0) {
		const sample = added
			.slice(0, MAX_SHOW)
			.map((l) => `+ ${l}`)
			.join("\n");
		parts.push(
			`Added:\n${sample}${added.length > MAX_SHOW ? `\n… (${added.length - MAX_SHOW} more)` : ""}`,
		);
	}
	if (removed.length > 0) {
		const sample = removed
			.slice(0, MAX_SHOW)
			.map((l) => `- ${l}`)
			.join("\n");
		parts.push(
			`Removed:\n${sample}${removed.length > MAX_SHOW ? `\n… (${removed.length - MAX_SHOW} more)` : ""}`,
		);
	}

	return {
		summary: parts.join("\n\n"),
		unchanged: false,
		addedSections: [],
		removedSections: [],
		changedSections: [],
	};
}
