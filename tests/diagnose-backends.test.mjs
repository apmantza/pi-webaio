// Offline tests for scripts/diagnose-backends.mjs.
// Probes are dependency-injected, so these exercise the pure helpers and
// the probe logic with fakes — no network, no real child processes.
import test from "node:test";
import assert from "node:assert/strict";

import {
	parseArgs,
	statusGlyph,
	summarize,
	formatLine,
	formatReport,
	parseGhAccount,
	playwrightBrowsersDir,
	findChromeBinary,
	httpProbe,
	probeGh,
	probePlaywright,
	probeChrome,
	probeSearchEngines,
	probeJina,
	SEARCH_ENGINES,
} from "../scripts/diagnose-backends.mjs";

// ─── formatting helpers ─────────────────────────────────────────────

test("statusGlyph maps every status", () => {
	assert.equal(statusGlyph("ok"), "✓");
	assert.equal(statusGlyph("missing"), "✗");
	assert.equal(statusGlyph("warn"), "⚠");
	assert.equal(statusGlyph("skipped"), "⊘");
	assert.equal(statusGlyph("bogus"), "?");
});

test("summarize counts statuses", () => {
	const s = summarize([
		{ status: "ok" },
		{ status: "ok" },
		{ status: "missing" },
		{ status: "warn" },
		{ status: "skipped" },
	]);
	assert.deepEqual(s, { ok: 2, missing: 1, warn: 1, skipped: 1 });
});

test("formatLine renders glyph, message, hint and detail", () => {
	const line = formatLine(
		{
			name: "X",
			status: "missing",
			message: "gone",
			hint: "fix it",
			detail: ["sub 1", "sub 2"],
		},
		4,
	);
	assert.match(line, /✗/);
	assert.match(line, /gone/);
	assert.match(line, /hint: fix it/);
	assert.match(line, /sub 1/);
	assert.match(line, /sub 2/);
});

test("formatLine omits hint/detail when absent", () => {
	const line = formatLine({ name: "Y", status: "ok", message: "fine" }, 4);
	assert.doesNotMatch(line, /hint:/);
	assert.equal(line.split("\n").length, 1);
});

test("formatReport includes header, glyphs and summary", () => {
	const report = formatReport(
		[
			{ name: "A", status: "ok", message: "up" },
			{ name: "B", status: "missing", message: "down", hint: "h" },
			{ name: "C", status: "skipped", message: "skip" },
		],
		{ live: true },
	);
	assert.match(report, /pi-webaio backend doctor/);
	assert.match(report, /✓/);
	assert.match(report, /✗/);
	assert.match(report, /⊘/);
	assert.match(report, /Summary: 1 available, 1 missing, 0 degraded, 1 skipped/);
	assert.match(report, /live network probes enabled/);
});

// ─── parseArgs ──────────────────────────────────────────────────────

test("parseArgs defaults", () => {
	assert.deepEqual(parseArgs([]), {
		live: false,
		strict: false,
		timeoutMs: 3000,
	});
});

test("parseArgs flags", () => {
	assert.deepEqual(parseArgs(["--live", "--strict", "--timeout-ms", "5000"]), {
		live: true,
		strict: true,
		timeoutMs: 5000,
	});
});

test("parseArgs rejects unknown option", () => {
	assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
});

test("parseArgs rejects bad timeout", () => {
	assert.throws(() => parseArgs(["--timeout-ms", "abc"]), /positive integer/);
	assert.throws(() => parseArgs(["--timeout-ms", "0"]), /positive integer/);
});

// ─── small pure helpers ─────────────────────────────────────────────

test("parseGhAccount extracts handle", () => {
	assert.equal(
		parseGhAccount("Logged in to github.com as @octocat (GH_TOKEN)"),
		"octocat",
	);
	assert.equal(parseGhAccount("account @monalisa"), "monalisa");
	assert.equal(parseGhAccount("You are not logged into any GitHub hosts."), null);
	assert.equal(parseGhAccount(""), null);
});

test("playwrightBrowsersDir honors env override", () => {
	assert.equal(
		playwrightBrowsersDir("linux", { PLAYWRIGHT_BROWSERS_PATH: "/x/y" }),
		"/x/y",
	);
});

test("playwrightBrowsersDir per-platform defaults", () => {
	assert.match(
		playwrightBrowsersDir("win32", { LOCALAPPDATA: "C:/AppData" }),
		/ms-playwright$/,
	);
	assert.match(
		playwrightBrowsersDir("darwin", { HOME: "/Users/me" }),
		/Library.Caches.ms-playwright|Library\/Caches\/ms-playwright/,
	);
	assert.match(
		playwrightBrowsersDir("linux", { HOME: "/home/me" }),
		/\.cache.ms-playwright|\.cache\/ms-playwright/,
	);
});

test("findChromeBinary prefers CHROME_PATH", () => {
	const seen = [];
	const bin = findChromeBinary({
		platform: "linux",
		env: { CHROME_PATH: "/custom/chrome" },
		existsSync: (p) => {
			seen.push(p);
			return p === "/custom/chrome";
		},
	});
	assert.equal(bin, "/custom/chrome");
});

test("findChromeBinary scans platform candidates", () => {
	const bin = findChromeBinary({
		platform: "linux",
		env: {},
		existsSync: (p) => p === "/usr/bin/chromium",
	});
	assert.equal(bin, "/usr/bin/chromium");
});

test("findChromeBinary returns null when nothing exists", () => {
	const bin = findChromeBinary({
		platform: "win32",
		env: {},
		existsSync: () => false,
	});
	assert.equal(bin, null);
});

// ─── httpProbe ──────────────────────────────────────────────────────

test("httpProbe treats <500 as reachable", async () => {
	const r = await httpProbe(async () => ({ status: 200 }), "https://x", 1000);
	assert.equal(r.ok, true);
	assert.equal(r.status, 200);
});

test("httpProbe treats 5xx and throws as unreachable", async () => {
	const bad = await httpProbe(async () => ({ status: 503 }), "https://x", 1000);
	assert.equal(bad.ok, false);
	const threw = await httpProbe(
		async () => {
			throw new Error("boom");
		},
		"https://x",
		1000,
	);
	assert.equal(threw.ok, false);
	assert.match(threw.error, /boom/);
});

// ─── probeGh ────────────────────────────────────────────────────────

test("probeGh: binary missing → missing", async () => {
	const r = await probeGh({
		platform: "linux",
		timeoutMs: 100,
		runCommand: () => ({ ok: false, stdout: "", stderr: "", timedOut: false }),
	});
	assert.equal(r.status, "missing");
	assert.equal(r.required, true);
	assert.match(r.hint, /gh auth login|cli\.github\.com/);
});

test("probeGh: present but not authed → missing with hint", async () => {
	const r = await probeGh({
		platform: "linux",
		timeoutMs: 100,
		runCommand: (cmd, args) => {
			if (cmd === "which") return { ok: true, stdout: "/usr/bin/gh\n" };
			if (args[0] === "auth")
				return {
					ok: false,
					stdout: "",
					stderr: "You are not logged into any GitHub hosts.",
					timedOut: false,
				};
			return { ok: false, stdout: "", stderr: "", timedOut: false };
		},
	});
	assert.equal(r.status, "missing");
	assert.match(r.message, /not authenticated/);
	assert.equal(r.hint, "run `gh auth login`");
});

test("probeGh: authed → ok with account", async () => {
	const r = await probeGh({
		platform: "win32",
		timeoutMs: 100,
		runCommand: (cmd, args) => {
			if (cmd === "where")
				return { ok: true, stdout: "C:/bin/gh.exe\n" };
			if (args[0] === "auth")
				return {
					ok: true,
					stdout: "",
					stderr: "Logged in to github.com as @octocat",
					timedOut: false,
				};
			return { ok: false, stdout: "", stderr: "", timedOut: false };
		},
	});
	assert.equal(r.status, "ok");
	assert.match(r.message, /@octocat/);
	assert.match(r.message, /C:\/bin\/gh\.exe/);
});

// ─── probePlaywright ────────────────────────────────────────────────

test("probePlaywright: not importable → missing", async () => {
	const r = await probePlaywright({
		platform: "linux",
		env: { HOME: "/h" },
		timeoutMs: 100,
		importModule: async () => {
			throw new Error("cannot find module");
		},
		listDir: () => [],
	});
	assert.equal(r.status, "missing");
	assert.match(r.hint, /npm install playwright/);
});

test("probePlaywright: importable, no browsers → warn", async () => {
	const r = await probePlaywright({
		platform: "linux",
		env: { HOME: "/h" },
		timeoutMs: 100,
		importModule: async () => ({}),
		listDir: () => ["firefox-1234"],
	});
	assert.equal(r.status, "warn");
	assert.match(r.hint, /npx playwright install chromium/);
});

test("probePlaywright: importable + chromium → ok", async () => {
	const r = await probePlaywright({
		platform: "linux",
		env: { HOME: "/h" },
		timeoutMs: 100,
		importModule: async () => ({}),
		listDir: () => ["chromium-1091", "chromium_headless_shell-1091"],
	});
	assert.equal(r.status, "ok");
});

// ─── probeChrome ────────────────────────────────────────────────────

test("probeChrome: no binary → missing", async () => {
	const r = await probeChrome({
		platform: "linux",
		env: {},
		timeoutMs: 100,
		packageRoot: "/root",
		existsSync: () => false,
	});
	assert.equal(r.status, "missing");
	assert.equal(r.required, true);
	assert.match(r.hint, /CHROME_PATH/);
});

test("probeChrome: binary + all assets → ok", async () => {
	const r = await probeChrome({
		platform: "linux",
		env: {},
		timeoutMs: 100,
		packageRoot: "/root",
		existsSync: (p) =>
			p === "/usr/bin/google-chrome" ||
			p.replace(/\\/g, "/").startsWith("/root/"),
	});
	assert.equal(r.status, "ok");
	assert.match(r.message, /CDP assets present/);
});

test("probeChrome: binary but missing assets → warn with detail", async () => {
	const r = await probeChrome({
		platform: "linux",
		env: {},
		timeoutMs: 100,
		packageRoot: "/root",
		// binary exists, but no CDP assets
		existsSync: (p) => p === "/usr/bin/google-chrome",
	});
	assert.equal(r.status, "warn");
	assert.ok(r.detail.length > 0);
	assert.match(r.detail[0], /missing CDP assets/);
});

// ─── probeSearchEngines ─────────────────────────────────────────────

test("probeSearchEngines: offline → skipped", async () => {
	const r = await probeSearchEngines({ live: false, timeoutMs: 100 });
	assert.equal(r.status, "skipped");
	assert.match(r.hint, /--live/);
});

test("probeSearchEngines: live, all reachable → ok", async () => {
	let calls = 0;
	const r = await probeSearchEngines({
		live: true,
		timeoutMs: 100,
		fetchImpl: async () => {
			calls++;
			return { status: 200 };
		},
	});
	assert.equal(r.status, "ok");
	assert.equal(calls, SEARCH_ENGINES.length);
	assert.match(r.message, new RegExp(`${SEARCH_ENGINES.length}/${SEARCH_ENGINES.length}`));
});

test("probeSearchEngines: live, none reachable → missing", async () => {
	const r = await probeSearchEngines({
		live: true,
		timeoutMs: 100,
		fetchImpl: async () => {
			throw new Error("offline");
		},
	});
	assert.equal(r.status, "missing");
	assert.match(r.message, /^0\//);
});

test("probeSearchEngines: live, partial → warn", async () => {
	let n = 0;
	const r = await probeSearchEngines({
		live: true,
		timeoutMs: 100,
		fetchImpl: async () => ({ status: n++ === 0 ? 200 : 503 }),
	});
	assert.equal(r.status, "warn");
});

// ─── probeJina ──────────────────────────────────────────────────────

test("probeJina: offline → skipped", async () => {
	const r = await probeJina({ live: false, timeoutMs: 100 });
	assert.equal(r.status, "skipped");
});

test("probeJina: live reachable → ok", async () => {
	const r = await probeJina({
		live: true,
		timeoutMs: 100,
		fetchImpl: async () => ({ status: 200 }),
	});
	assert.equal(r.status, "ok");
});

test("probeJina: live unreachable → warn", async () => {
	const r = await probeJina({
		live: true,
		timeoutMs: 100,
		fetchImpl: async () => {
			throw new Error("dns fail");
		},
	});
	assert.equal(r.status, "warn");
	assert.match(r.hint, /unavailable/);
});
