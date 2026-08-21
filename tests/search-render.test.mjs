// ─── Search-render tests ────────────────────────────────────────────
// Offline unit tests for the aio-websearch TUI rendering helpers in
// src/tools/search-render.ts. No network, no Chrome. A stub Theme wraps
// text in sentinel tags so we can assert on output and color usage.

import assert from "node:assert";
import test from "node:test";
import {
	createSearchProgressComponent,
	createSearchResultComponent,
	providerFromEngineStatus,
	renderElapsedBar,
	renderProviderGlyph,
	renderProviderStatusText,
} from "../src/tools/search-render.ts";

// ─── Minimal theme stub (same shape as render-result tests) ─────────

function makeTheme() {
	const colorLog = [];
	// Emit REAL ANSI escapes (like the production Theme) so the installed
	// pi-tui Text treats them as zero-width — literal <tag> placeholders
	// would inflate string length and skew word-wrap/width math.
	const wrap = (color, text) => {
		colorLog.push(`${color}:${text.length}`);
		return `\x1b[90m${text}\x1b[0m`;
	};
	return {
		wrap,
		fg: wrap,
		bg: (_color, text) => `\x1b[7m${text}\x1b[0m`,
		bold: (text) => `\x1b[1m${text}\x1b[0m`,
		colorLog,
	};
}

// Strip ANSI escapes (and any stray tag markup) for plain-text assertions.
function strip(s) {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

// ─── providerFromEngineStatus ───────────────────────────────────────

test("providerFromEngineStatus: missing entry → skipped", () => {
	const p = providerFromEngineStatus("ddg", "DDG", undefined);
	assert.strictEqual(p.status, "skipped");
	assert.strictEqual(p.label, "DDG");
});

test("providerFromEngineStatus: ok → ok with count + latency", () => {
	const p = providerFromEngineStatus("ddg", "DDG", {
		count: 12,
		status: "ok",
		latencyMs: 820,
	});
	assert.strictEqual(p.status, "ok");
	assert.strictEqual(p.count, 12);
	assert.strictEqual(p.latencyMs, 820);
});

test("providerFromEngineStatus: empty → empty with zero count", () => {
	const p = providerFromEngineStatus("ddg", "DDG", {
		count: 0,
		status: "empty",
		latencyMs: 100,
	});
	assert.strictEqual(p.status, "empty");
	assert.strictEqual(p.count, 0);
});

test("providerFromEngineStatus: timeout carries formatted detail", () => {
	const p = providerFromEngineStatus("bing", "Bing", {
		count: 0,
		status: "timeout",
		latencyMs: 2700,
	});
	assert.strictEqual(p.status, "timeout");
	assert.match(p.detail, /2\.7s/);
});

test("providerFromEngineStatus: quota → error rate-limited", () => {
	const p = providerFromEngineStatus("brave", "Brave", {
		count: 0,
		status: "quota",
		latencyMs: 50,
	});
	assert.strictEqual(p.status, "error");
	assert.match(p.detail, /rate-limited/);
});

test("providerFromEngineStatus: http_NNN → error with HTTP code", () => {
	const p = providerFromEngineStatus("yahoo", "Yahoo", {
		count: 0,
		status: "http_503",
		latencyMs: 90,
	});
	assert.strictEqual(p.status, "error");
	assert.match(p.detail, /HTTP 503/);
});

test("providerFromEngineStatus: cooled_down → skipped with reason", () => {
	const p = providerFromEngineStatus("reddit", "Reddit", {
		count: 0,
		status: "cooled_down",
		latencyMs: 0,
	});
	assert.strictEqual(p.status, "skipped");
	assert.match(p.detail, /cooled down/);
});

test("providerFromEngineStatus: disabled → skipped", () => {
	const p = providerFromEngineStatus("google", "Google", {
		count: 0,
		status: "disabled",
		latencyMs: 0,
	});
	assert.strictEqual(p.status, "skipped");
});

// ─── renderProviderGlyph ────────────────────────────────────────────

test("renderProviderGlyph: settled statuses use fixed glyphs/colors", () => {
	const theme = makeTheme();
	assert.match(renderProviderGlyph("ok", 0, theme), /✓/);
	assert.ok(theme.colorLog.some((c) => c.startsWith("success:")));
	assert.match(renderProviderGlyph("error", 0, theme), /✗/);
	assert.match(renderProviderGlyph("timeout", 0, theme), /⏱/);
	assert.match(renderProviderGlyph("empty", 0, theme), /∅/);
	assert.match(renderProviderGlyph("skipped", 0, theme), /–/);
	assert.match(renderProviderGlyph("pending", 0, theme), /·/);
});

test("renderProviderGlyph: running advances spinner frames with tick", () => {
	const theme = makeTheme();
	const f0 = strip(renderProviderGlyph("running", 0, theme));
	const f3 = strip(renderProviderGlyph("running", 3, theme));
	const f6 = strip(renderProviderGlyph("running", 6, theme));
	assert.notStrictEqual(f0, f3);
	assert.notStrictEqual(f3, f6);
	// Wraps around without crashing.
	assert.strictEqual(strip(renderProviderGlyph("running", 10, theme)), f0);
});

// ─── renderProviderStatusText ───────────────────────────────────────

test("renderProviderStatusText: running/pending show progress text", () => {
	const theme = makeTheme();
	assert.match(
		strip(
			renderProviderStatusText({ id: "x", label: "X", status: "running" }, theme),
		),
		/searching/,
	);
	assert.match(
		strip(
			renderProviderStatusText({ id: "x", label: "X", status: "pending" }, theme),
		),
		/waiting/,
	);
});

test("renderProviderStatusText: ok includes count and latency", () => {
	const theme = makeTheme();
	const out = strip(
		renderProviderStatusText(
			{ id: "ddg", label: "DDG", status: "ok", count: 7, latencyMs: 900 },
			theme,
		),
	);
	assert.match(out, /7 results? \(900ms\)/);

	const noLatency = strip(
		renderProviderStatusText(
			{ id: "ddg", label: "DDG", status: "ok", count: 1 },
			theme,
		),
	);
	assert.match(noLatency, /^1 result$/);
});

test("renderProviderStatusText: error/timeout prefer detail over fallback", () => {
	const theme = makeTheme();
	const err = strip(
		renderProviderStatusText(
			{ id: "b", label: "B", status: "error", detail: "HTTP 429" },
			theme,
		),
	);
	assert.match(err, /HTTP 429/);
	const to = strip(
		renderProviderStatusText({ id: "b", label: "B", status: "timeout" }, theme),
	);
	assert.match(to, /timed out/);
});

// ─── renderElapsedBar ───────────────────────────────────────────────

test("renderElapsedBar: fills proportionally toward the target", () => {
	const theme = makeTheme();
	const early = strip(renderElapsedBar(250, 3000, 24, theme));
	const late = strip(renderElapsedBar(2800, 3000, 24, theme));
	assert.match(early, /█/);
	assert.match(late, /█/);
	// Late bar is more filled than early bar.
	const filledCount = (s) => (s.match(/█/g) || []).length;
	assert.ok(filledCount(late) > filledCount(early));
});

test("renderElapsedBar: caps at full past the target", () => {
	const theme = makeTheme();
	const out = strip(renderElapsedBar(9999, 2900, 24, theme));
	const innerWidth = Math.max(8, 24 - 2);
	assert.strictEqual((out.match(/█/g) || []).length, innerWidth);
	assert.doesNotMatch(out, /░/);
});

test("renderElapsedBar: handles missing target gracefully", () => {
	const theme = makeTheme();
	const out = strip(renderElapsedBar(1200, undefined, 24, theme));
	assert.match(out, /1\.2s/);
	assert.strictEqual((out.match(/█/g) || []).length, 0);
	assert.doesNotThrow(() => renderElapsedBar(1200, 0, 24, theme));
});

// ─── createSearchProgressComponent ──────────────────────────────────

const PROGRESS_DETAILS = {
	query: "pi coding agent",
	providers: [
		{ id: "ddg", label: "DDG", status: "ok", count: 9, latencyMs: 800 },
		{ id: "brave", label: "Brave", status: "running" },
		{ id: "yahoo", label: "Yahoo", status: "running" },
		{ id: "bing", label: "Bing", status: "running" },
		{ id: "google", label: "Google", status: "running" },
		{ id: "reddit", label: "Reddit", status: "skipped", detail: "disabled" },
	],
	spinnerTick: 2,
	elapsedMs: 1400,
	responseTargetMs: 2900,
};

test("progress component renders bar + one row per provider", () => {
	const theme = makeTheme();
	const comp = createSearchProgressComponent(PROGRESS_DETAILS, theme);
	const plain = strip(comp.render(120).join("\n"));
	// No in-component header — pi renders renderCall above this view.
	assert.doesNotMatch(plain, /aio-websearch/);
	for (const label of ["DDG", "Brave", "Yahoo", "Bing", "Google", "Reddit"]) {
		assert.ok(plain.includes(label), `missing ${label}`);
	}
	assert.match(plain, /1\.4s \/ 2\.9s/);
	assert.match(plain, /searching/);
	assert.match(plain, /9 results \(800ms\)/);
});

test("progress component animates: different ticks change output", () => {
	const theme = makeTheme();
	const a = createSearchProgressComponent(PROGRESS_DETAILS, theme)
		.render(120)
		.join("");
	const b = createSearchProgressComponent(
		{ ...PROGRESS_DETAILS, spinnerTick: 5 },
		theme,
	)
		.render(120)
		.join("");
	assert.notStrictEqual(a, b);
});

test("progress component shows elapsed/target bar when elapsed present", () => {
	const theme = makeTheme();
	const comp = createSearchProgressComponent(
		{ query: "q", providers: [], elapsedMs: 500, responseTargetMs: 2900 },
		theme,
	);
	// Word-wrapping in Text can split the bar from its label, so assert
	// both parts independently rather than one contiguous string.
	const plain = strip(comp.render(120).join("\n"));
	assert.match(plain, /0\.5s/);
	assert.match(plain, /2\.9s/);
});

test("progress component tolerates missing providers/details", () => {
	const theme = makeTheme();
	const comp = createSearchProgressComponent({ query: "solo" }, theme);
	assert.doesNotThrow(() => comp.render(80));
});

// ─── createSearchResultComponent ────────────────────────────────────

const RESULT_PROVIDERS = [
	{ id: "ddg", label: "DDG", status: "ok", count: 9, latencyMs: 800 },
	{ id: "brave", label: "Brave", status: "ok", count: 6, latencyMs: 1200 },
	{ id: "yahoo", label: "Yahoo", status: "empty", count: 0, latencyMs: 300 },
	{ id: "bing", label: "Bing", status: "error", detail: "HTTP 429" },
	{ id: "google", label: "Google", status: "ok", count: 15, latencyMs: 2100 },
	{
		id: "reddit",
		label: "Reddit",
		status: "timeout",
		detail: "timed out after 2.9s",
	},
];

const RESULT_ROWS = [
	{
		title: "First hit",
		url: "https://example.com/a",
		domain: "example.com",
		snippet: "An example snippet.",
		sources: ["http", "google"],
		sourceType: "official-docs",
	},
	{
		title: "Second hit",
		url: "https://other.org/b",
		domain: "other.org",
		sourceType: "repo",
	},
];

test("result component collapsed: full bar + one settled row per engine", () => {
	const theme = makeTheme();
	const comp = createSearchResultComponent(
		{
			query: "stable schema",
			responseTargetMs: 2900,
			resultCount: 2,
			durationMs: 2870,
			timedOut: false,
			engineNotes: ["note one"],
			results: RESULT_ROWS,
			providers: RESULT_PROVIDERS,
		},
		false,
		theme,
	);
	const plain = strip(comp.render(200).join("\n"));
	// Stable schema: full bar + summary line (header comes from renderCall)…
	assert.doesNotMatch(plain, /aio-websearch/);
	assert.match(plain, /█+ \/? ?.*2\.9s/);
	assert.match(plain, /✓ 2 results in 2\.9s/);
	// …then one row per engine with count and timing.
	for (const row of [
		/✓ DDG\s+9 results \(800ms\)/,
		/✓ Brave\s+6 results \(1\.2s\)/,
		/∅ Yahoo\s+0 results/,
		/✗ Bing\s+HTTP 429/,
		/✓ Google\s+15 results \(2\.1s\)/,
		/⏱ Reddit\s+timed out after 2\.9s/,
	]) {
		assert.match(plain, row);
	}
	assert.match(plain, /note one/);
	assert.doesNotMatch(
		plain,
		/First hit/,
		"expanded rows must be collapsed away",
	);
});

test("result component colors engine rows by outcome", () => {
	const theme = makeTheme();
	const comp = createSearchResultComponent(
		{ resultCount: 2, providers: RESULT_PROVIDERS },
		false,
		theme,
	);
	const raw = comp.render(200).join("\n");
	assert.ok(
		theme.colorLog.some((c) => c.startsWith("success:")),
		"ok rows should be success-colored",
	);
	assert.ok(
		raw.includes("HTTP 429") &&
			theme.colorLog.some((c) => c.startsWith("error:")),
		"error rows should be error-colored",
	);
	assert.ok(theme.colorLog.some((c) => c.startsWith("warning:")));
});

test("final view keeps the in-flight row schema (stability)", () => {
	const theme = makeTheme();
	const providers = RESULT_PROVIDERS;
	const progressRows = strip(
		createSearchProgressComponent(
			{ query: "q", providers, spinnerTick: 3 },
			theme,
		)
			.render(200)
			.join("\n"),
	);
	const finalRows = strip(
		createSearchResultComponent({ providers }, false, theme)
			.render(200)
			.join("\n"),
	);
	// Every settled engine renders the exact same row text in both views.
	for (const p of providers) {
		if (p.status === "running") continue;
		const rowRe = new RegExp(
			`${p.label}\\s+${p.status === "ok" ? `${p.count} results?` : (p.detail ?? "0 results").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
		);
		assert.match(progressRows, rowRe, `progress view row for ${p.label}`);
		assert.match(finalRows, rowRe, `final view row for ${p.label}`);
	}
});

test("result component flags a timed-out search in the header", () => {
	const theme = makeTheme();
	const comp = createSearchResultComponent(
		{ resultCount: 1, durationMs: 2905, timedOut: true, providers: [] },
		false,
		theme,
	);
	assert.match(strip(comp.render(200).join("\n")), /response budget hit/);
});

test("result component expanded: rank numbers, sourceType tags, urls, snippets", () => {
	const theme = makeTheme();
	const comp = createSearchResultComponent(
		{
			resultCount: 2,
			durationMs: 2800,
			providers: [],
			results: RESULT_ROWS,
		},
		true,
		theme,
	);
	const plain = strip(comp.render(240).join("\n"));
	assert.match(
		plain,
		/\b1\. \[official-docs\] First hit \(example\.com\) — http\+google/,
	);
	assert.match(plain, /\b2\. \[repo\] Second hit \(other\.org\)/);
	assert.match(plain, /https:\/\/example\.com\/a/);
	assert.match(plain, /An example snippet\./);
});

test("result component caps visible rows at 8 with a 'more' line", () => {
	const theme = makeTheme();
	const many = Array.from({ length: 12 }, (_, i) => ({
		title: `Hit ${i + 1}`,
		url: `https://x.example/${i}`,
	}));
	const plain = strip(
		createSearchResultComponent({ providers: [], results: many }, true, theme)
			.render(200)
			.join("\n"),
	);
	assert.ok(plain.includes("Hit 8"));
	assert.doesNotMatch(plain, /Hit 9\b/);
	assert.match(plain, /… 4 more/);
});

test("result component renders zero-result searches without crashing", () => {
	const theme = makeTheme();
	const comp = createSearchResultComponent({}, false, theme);
	assert.doesNotThrow(() => comp.render(80));
});

test("rows degrade gracefully at narrow widths instead of being clipped", () => {
	const theme = makeTheme();
	// pi hard-clips lines with an ellipsis at the component width; simulate
	// a ~22-column layout (observed in real TUIs) and require that every
	// row still shows its glyph + label + count/status within 22 columns.
	const comp = createSearchResultComponent(
		{
			responseTargetMs: 2900,
			resultCount: 14,
			durationMs: 2870,
			providers: RESULT_PROVIDERS,
		},
		false,
		theme,
	);
	const lines = strip(comp.render(22).join("\n")).split("\n");
	for (const line of lines) {
		assert.ok(
			line.trimEnd().length <= 22,
			`line exceeds width: "${line}" (${line.length})`,
		);
	}
	const plain = lines.join("\n");
	// Counts survive clipping because rows degrade before pi can clip.
	for (const label of ["DDG", "Brave", "Yahoo", "Bing", "Google", "Reddit"]) {
		assert.ok(plain.includes(label), `missing ${label} at narrow width`);
	}
	assert.match(plain, /9 results/, "ok row keeps its count");
});
