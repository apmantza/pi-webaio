// ─── Render-result tests ────────────────────────────────────────────
// Unit tests for the TUI renderer helpers in src/tools/render-result.ts.
// No network calls, no DOM. We stub a minimal Theme with fg/bg/bold so
// the renderer thinks it has a real terminal.

import assert from "node:assert";
import test from "node:test";
import {
	SPINNER_FRAMES,
	truncateMiddle,
	getOptimisticProgress,
	createProgressComponent,
	createResultComponent,
	createCallComponent,
} from "../src/tools/render-result.ts";

// ─── Minimal theme stub ────────────────────────────────────────────────
// The real Theme class has fg/bg/bold methods that wrap text in ANSI.
// We just wrap with a sentinel tag so we can assert on the *output* and
// also assert ordering (e.g. "toolTitle" wraps happen before "accent" wraps).

function makeTheme() {
	const colorLog = [];
	const wrap = (color, text) => {
		colorLog.push(`${color}:${text.length}`);
		return `<${color}>${text}</${color}>`;
	};
	return {
		wrap,
		fg: wrap,
		bg: (_color, text) => `<bg>${text}</bg>`,
		bold: (text) => `<b>${text}</b>`,
		italic: (text) => `<i>${text}</i>`,
		colorLog,
	};
}

// ─── truncateMiddle ─────────────────────────────────────────────────────

test("truncateMiddle: returns empty for width 0", () => {
	assert.strictEqual(truncateMiddle("hello world", 0), "");
});

test("truncateMiddle: returns value when shorter than width", () => {
	assert.strictEqual(truncateMiddle("hi", 10), "hi");
});

test("truncateMiddle: ellipsizes a long URL in the middle", () => {
	const long =
		"https://very-long-domain.example.com/some/very/long/path/to/the/article";
	const out = truncateMiddle(long, 30);
	assert.ok(out.includes("…"), "should contain ellipsis");
	assert.ok(out.length <= 30, `expected <= 30, got ${out.length}`);
	// Should preserve the start (scheme/host) and end (filename-ish).
	assert.ok(out.startsWith("https://"));
	assert.ok(
		out.endsWith("article") || out.endsWith("e/article"),
		`should preserve the tail, got: ${out}`,
	);
});

test("truncateMiddle: width 1 returns single ellipsis", () => {
	assert.strictEqual(truncateMiddle("hello", 1), "…");
});

test("truncateMiddle: width 2 returns ellipsis + one char", () => {
	const out = truncateMiddle("hello", 2);
	assert.ok(out.includes("…"));
	assert.strictEqual(out.length, 2);
});

// ─── getOptimisticProgress ──────────────────────────────────────────────

test("getOptimisticProgress: queued is always 0", () => {
	assert.strictEqual(getOptimisticProgress("queued", 0, 5000), 0);
});

test("getOptimisticProgress: connecting caps at 0.1", () => {
	assert.strictEqual(getOptimisticProgress("connecting", 0, 0), 0);
	assert.ok(getOptimisticProgress("connecting", 0, 20000) <= 0.1);
});

test("getOptimisticProgress: loading caps at 0.85", () => {
	assert.ok(getOptimisticProgress("loading", 0, 60000) <= 0.85);
});

test("getOptimisticProgress: processing caps at 0.99", () => {
	assert.ok(getOptimisticProgress("processing", 0, 120000) <= 0.99);
	assert.ok(getOptimisticProgress("processing", 0, 120000) > 0.86);
});

test("getOptimisticProgress: done returns 1", () => {
	assert.strictEqual(getOptimisticProgress("done", 0, 0), 1);
});

test("getOptimisticProgress: error returns 1", () => {
	assert.strictEqual(getOptimisticProgress("error", 0, 0), 1);
});

test("getOptimisticProgress: respects baseProgress floor", () => {
	assert.strictEqual(getOptimisticProgress("loading", 0.6, 0), 0.6);
});

// ─── createProgressComponent — single item ──────────────────────────────

test("createProgressComponent: emits tool title for single URL", () => {
	const theme = makeTheme();
	const details = {
		url: "https://example.com/article",
		status: "fetching",
		progress: 0.3,
		spinnerTick: 0,
	};
	const comp = createProgressComponent(details, theme);
	const lines = comp.render(80);
	const text = lines.join("\n");
	assert.ok(text.includes("aio-webfetch"), "should include tool name");
	assert.ok(
		/example\.com|…/.test(text),
		"should show URL",
	);
	// The status label is centered in the progress bar and may be split
	// between the filled and empty parts (depending on progress %), so we
	// just look for a stable fragment.
	assert.ok(
		text.includes("fetching") || text.includes("etching"),
		"should show status label (or label fragment after filled split)",
	);
});

test("createProgressComponent: status glyph varies with spinnerTick", () => {
	const theme = makeTheme();
	const a = createProgressComponent(
		{ url: "https://x", status: "fetching", progress: 0.5, spinnerTick: 0 },
		theme,
	);
	const b = createProgressComponent(
		{ url: "https://x", status: "fetching", progress: 0.5, spinnerTick: 3 },
		theme,
	);
	const textA = a.render(80).join("\n");
	const textB = b.render(80).join("\n");
	// Spinner frames at index 0 and 3 should differ
	const frame0 = SPINNER_FRAMES[0];
	const frame3 = SPINNER_FRAMES[3];
	assert.notStrictEqual(frame0, frame3);
	assert.ok(textA.includes(frame0));
	assert.ok(textB.includes(frame3));
});

test("createProgressComponent: shows ✓ for done status", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x",
		status: "done",
		progress: 1,
		spinnerTick: 0,
		items: [{ index: 0, url: "https://x", status: "done", progress: 1 }],
	};
	const comp = createProgressComponent(details, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("✓"), "should show success glyph");
});

test("createProgressComponent: shows ✗ for error status with message", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x",
		status: "error",
		progress: 1,
		spinnerTick: 0,
		items: [
			{
				index: 0,
				url: "https://x",
				status: "error",
				progress: 1,
				error: "DNS error: could not resolve hostname",
			},
		],
	};
	const comp = createProgressComponent(details, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("✗"), "should show error glyph");
	assert.ok(text.includes("DNS error"), "should show error message");
});

test("createProgressComponent: multi-item shows one row per URL", () => {
	const theme = makeTheme();
	const items = [
		{ index: 0, url: "https://a.example", status: "done", progress: 1 },
		{ index: 1, url: "https://b.example", status: "loading", progress: 0.5 },
		{ index: 2, url: "https://c.example", status: "queued", progress: 0 },
	];
	const comp = createProgressComponent(
		{
			url: "https://a.example",
			status: "loading",
			progress: 0.5,
			spinnerTick: 0,
			items,
			total: 3,
			completed: 1,
			succeeded: 1,
			failed: 0,
		},
		theme,
	);
	const text = comp.render(120).join("\n");
	assert.ok(text.includes("✓"), "should show done glyph for a.example");
	assert.ok(text.includes("a.example"));
	assert.ok(text.includes("b.example"));
	assert.ok(text.includes("c.example"));
	// Multi-item summary line
	assert.ok(text.includes("1/3"), "should show progress count");
	assert.ok(text.includes("ok 1"));
});

// ─── createResultComponent — error path ─────────────────────────────────

test("createResultComponent: error shows red summary", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x",
		userErrorSummary: "The server rate-limited this request.",
		errorText: "Server responded with 429",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("rate-limited"));
	// Should be wrapped in error color tag
	assert.ok(text.includes("<error>"));
});

test("createResultComponent: error uses errorText as fallback", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x",
		errorText: "Something blew up",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("blew up"));
});

// ─── createResultComponent — file path ──────────────────────────────────

test("createResultComponent: file result shows size + mime + path", () => {
	const theme = makeTheme();
	const details = {
		filePath: "/tmp/foo.pdf",
		fileSize: 1234567,
		mimeType: "application/pdf",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("1234567"), "should show file size in bytes");
	assert.ok(text.includes("application/pdf"));
	assert.ok(text.includes("/tmp/foo.pdf"));
});

// ─── createResultComponent — content path ───────────────────────────────

test("createResultComponent: collapsed preview shows first 7 lines + hint", () => {
	const theme = makeTheme();
	const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const details = {
		// Single-word title avoids Text widget word-wrap splitting it
		title: "ExampleArticle",
		url: "https://example.com",
		outPath: "/tmp/example.md",
		content: body,
		format: "markdown",
		fullLength: body.length,
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("line 1"), "should include first line");
	assert.ok(text.includes("line 7"), "should include 7th line");
	assert.ok(
		!text.includes("line 8"),
		"should not include 8th line in collapsed",
	);
	// The hint text "more lines" may be wrapped in muted color tags, so
	// check for a stable fragment.
	assert.ok(
		text.includes("more lines") ||
			(text.includes("more") && text.includes("expand")),
		"should hint at expand",
	);
	assert.ok(text.includes("Title:"), "should show metadata");
	assert.ok(text.includes("ExampleArticle"));
});

test("createResultComponent: expanded view shows full content", () => {
	const theme = makeTheme();
	const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const details = {
		title: "x",
		url: "https://x",
		outPath: "/tmp/x.md",
		content: body,
		format: "markdown",
	};
	const comp = createResultComponent(details, true, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("line 1"));
	assert.ok(text.includes("line 20"), "expanded should show last line");
	assert.ok(!text.includes("more lines"), "expanded should not show hint");
});

test("createResultComponent: empty content shows only metadata", () => {
	const theme = makeTheme();
	const details = {
		title: "Empty",
		url: "https://empty.example",
		outPath: "/tmp/empty.md",
		content: "",
		format: "markdown",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("Empty"));
	assert.ok(!text.includes("more lines"), "should not show expand hint");
});

test("createResultComponent: summarized result mentions AI summary", () => {
	const theme = makeTheme();
	const details = {
		title: "Big",
		url: "https://big",
		outPath: "/tmp/big.md",
		content: "first 7 lines of summary",
		fullLength: 50000,
		summaryLength: 1200,
		summarized: true,
		truncated: false,
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(120).join("\n");
	assert.ok(text.includes("Summarized"));
	assert.ok(text.includes("1200"));
	assert.ok(text.includes("50000"));
});

test("createResultComponent: responseId is shown in metadata", () => {
	const theme = makeTheme();
	const details = {
		title: "x",
		url: "https://x",
		outPath: "/tmp/x.md",
		responseId: "abc-123-def",
		content: "body",
		format: "markdown",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("abc-123-def"));
});

test("createResultComponent: package path is shown when present", () => {
	const theme = makeTheme();
	const details = {
		title: "x",
		url: "https://x",
		outPath: "/tmp/x.md",
		packagePath: "/tmp/packages/webfetch-1234",
		content: "body",
		format: "markdown",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("Package:"));
	assert.ok(text.includes("webfetch-1234"));
});

test("createResultComponent: browser/os profile is shown", () => {
	const theme = makeTheme();
	const details = {
		title: "x",
		url: "https://x",
		outPath: "/tmp/x.md",
		browser: "chrome_145",
		os: "windows",
		content: "body",
		format: "markdown",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("Profile:"));
	assert.ok(text.includes("chrome_145"));
	assert.ok(text.includes("windows"));
});

// ─── createCallComponent ────────────────────────────────────────────────

test("createCallComponent: shows tool name + URL", () => {
	const theme = makeTheme();
	const comp = createCallComponent({ url: "https://example.com" }, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("aio-webfetch"));
	assert.ok(/https:\/\/example\.com/.test(text));
});

test("createCallComponent: shows count for batch URL", () => {
	const theme = makeTheme();
	const comp = createCallComponent(
		{ urls: ["https://a", "https://b", "https://c"] },
		theme,
	);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("aio-webfetch"));
	assert.ok(text.includes("×3"));
});

test("createCallComponent: handles missing url with placeholder", () => {
	const theme = makeTheme();
	const comp = createCallComponent({}, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("aio-webfetch"));
	assert.ok(text.includes("..."));
});

// ─── Width handling ─────────────────────────────────────────────────────

test("createProgressComponent: respects narrow width (no overflow)", () => {
	const theme = makeTheme();
	const comp = createProgressComponent(
		{
			url: "https://very-long-domain-name-that-clearly-overflows.example.com/with/a/long/path",
			status: "loading",
			progress: 0.5,
			spinnerTick: 0,
		},
		theme,
	);
	const lines = comp.render(40);
	// Just verify it renders without throwing and truncates the URL.
	const joined = lines.join("\n");
	assert.ok(joined.includes("…"), "URL should be truncated at narrow width");
});

test("createProgressComponent: shows elapsed time on per-item row", () => {
	const theme = makeTheme();
	const comp = createProgressComponent(
		{
			items: [
				{
					index: 0,
					url: "https://x.example.com",
					status: "loading",
					progress: 0.5,
					elapsedMs: 3500,
				},
			],
			spinnerTick: 0,
		},
		theme,
	);
	const text = comp.render(120).join("\n");
	assert.ok(text.includes("3.5s"), `should show elapsed time, got: ${text}`);
});

test("createProgressComponent: omits elapsed time when < 1s", () => {
	const theme = makeTheme();
	const comp = createProgressComponent(
		{
			items: [
				{
					index: 0,
					url: "https://x.example.com",
					status: "loading",
					progress: 0.5,
					elapsedMs: 250,
				},
			],
			spinnerTick: 0,
		},
		theme,
	);
	const text = comp.render(120).join("\n");
	assert.ok(
		!text.includes("0.2s") && !text.includes("0.3s"),
		"should hide sub-second elapsed",
	);
});

test("createResultComponent: respects narrow width", () => {
	const theme = makeTheme();
	const comp = createResultComponent(
		{
			title: "A".repeat(200),
			url: "https://very-long-url.example.com/with/some/really/long/path",
			outPath: "/tmp/some-very-long-output-file-path-here.md",
			content: "x".repeat(200),
		},
		false,
		theme,
	);
	// Just verify it renders without throwing.
	const lines = comp.render(40);
	assert.ok(lines.length > 0);
});

test("createResultComponent: error view shows suggested retry timeout", () => {
	const theme = makeTheme();
	const details = {
		url: "https://slow.example.com",
		status: "error",
		userErrorSummary: "The server didn't reply in time.",
		suggestedTimeoutMs: 24000,
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("didn't reply in time"), "should show error");
	assert.ok(text.includes("24.0s"), "should show suggested timeout");
	assert.ok(text.includes("Retry"), "should mention retry");
});

test("createResultComponent: error view without suggestedTimeoutMs omits retry hint", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x.example.com",
		status: "error",
		userErrorSummary: "We couldn't find that page on the server. (HTTP 404)",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("404"));
	assert.ok(
		!text.includes("Retry with timeout"),
		"should not show retry hint when not applicable",
	);
});

test("createResultComponent: error view shows phase + category badge", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x.example.com",
		status: "error",
		userErrorSummary: "The server returned an error response. (HTTP 503)",
		errorPhase: "headers",
		errorCategory: "server",
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(text.includes("phase: headers"), "should show phase");
	assert.ok(text.includes("category: server"), "should show category");
});

test("createResultComponent: retry hint hidden when errorRetryable=false", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x.example.com",
		status: "error",
		userErrorSummary: "We couldn't find that page. (HTTP 404)",
		suggestedTimeoutMs: 24000,
		errorRetryable: false,
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(
		!text.includes("Retry with timeout"),
		"should hide retry hint for non-retryable errors",
	);
});

test("createResultComponent: retry hint shown when errorRetryable=true", () => {
	const theme = makeTheme();
	const details = {
		url: "https://x.example.com",
		status: "error",
		userErrorSummary: "The server didn't reply in time.",
		suggestedTimeoutMs: 24000,
		errorRetryable: true,
	};
	const comp = createResultComponent(details, false, theme);
	const text = comp.render(80).join("\n");
	assert.ok(
		text.includes("24.0s"),
		"should show retry hint for retryable errors",
	);
});
