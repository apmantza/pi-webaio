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
	probeWreq,
	probeTempDir,
	probeMcp,
	probeDns,
	probeProxy,
	validateProxyUrl,
	tempBase,
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
	assert.match(
		report,
		/Summary: 1 available, 1 missing, 0 degraded, 1 skipped/,
	);
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
	assert.equal(
		parseGhAccount("You are not logged into any GitHub hosts."),
		null,
	);
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
			if (cmd === "where") return { ok: true, stdout: "C:/bin/gh.exe\n" };
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
	assert.match(
		r.message,
		new RegExp(`${SEARCH_ENGINES.length}/${SEARCH_ENGINES.length}`),
	);
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

// ─── validateProxyUrl (pure) ────────────────────────────────────────

test("validateProxyUrl accepts http/https/socks5", () => {
	assert.equal(validateProxyUrl("http://user:pass@proxy.local:8080").ok, true);
	assert.equal(validateProxyUrl("https://proxy.local:3128").ok, true);
	const socks = validateProxyUrl("socks5://127.0.0.1:1080");
	assert.equal(socks.ok, true);
	assert.equal(socks.hostname, "127.0.0.1");
});

test("validateProxyUrl rejects empty, garbage, and bad protocols", () => {
	assert.equal(validateProxyUrl("").ok, false);
	assert.equal(validateProxyUrl("   ").ok, false);
	assert.equal(validateProxyUrl("not a url").ok, false);
	const ftp = validateProxyUrl("ftp://proxy.local:21");
	assert.equal(ftp.ok, false);
	assert.match(ftp.reason, /unsupported protocol/);
});

test("tempBase joins under pi-webaio", () => {
	assert.match(tempBase("/tmp").replace(/\\/g, "/"), /\/tmp\/pi-webaio$/);
});

// ─── probeWreq ──────────────────────────────────────────────────────

test("probeWreq: import + construct → ok, required", async () => {
	let constructed = false;
	const r = await probeWreq({
		importModule: async () => ({
			createSession: async () => {
				constructed = true;
				return { fetch: async () => {} };
			},
		}),
	});
	assert.equal(r.status, "ok");
	assert.equal(r.required, true);
	assert.equal(constructed, true);
});

test("probeWreq: import throws → missing with message", async () => {
	const r = await probeWreq({
		importModule: async () => {
			throw new Error("Cannot find module 'wreq-js'");
		},
	});
	assert.equal(r.status, "missing");
	assert.equal(r.required, true);
	assert.match(r.message, /Cannot find module/);
});

test("probeWreq: createSession missing → missing", async () => {
	const r = await probeWreq({ importModule: async () => ({}) });
	assert.equal(r.status, "missing");
	assert.match(r.message, /createSession is not exported/);
});

test("probeWreq: session construction throws → missing with message", async () => {
	const r = await probeWreq({
		importModule: async () => ({
			createSession: async () => {
				throw new Error("native binding failed");
			},
		}),
	});
	assert.equal(r.status, "missing");
	assert.match(r.message, /native binding failed/);
});

// ─── probeTempDir ───────────────────────────────────────────────────

test("probeTempDir: write/read/delete success → ok", async () => {
	const store = new Map();
	const r = await probeTempDir({
		tempBase: "/tmp/pi-webaio",
		ensureDir: async () => {},
		writeFile: async (p, data) => {
			store.set(p, data);
		},
		readFile: async (p) => store.get(p),
		unlink: async (p) => {
			store.delete(p);
		},
	});
	assert.equal(r.status, "ok");
	assert.match(r.message, /writable/);
});

test("probeTempDir: write throws → missing with error", async () => {
	const r = await probeTempDir({
		tempBase: "/tmp/pi-webaio",
		ensureDir: async () => {},
		writeFile: async () => {
			throw new Error("EACCES: permission denied");
		},
		readFile: async () => "",
		unlink: async () => {},
	});
	assert.equal(r.status, "missing");
	assert.match(r.message, /EACCES/);
	assert.match(r.hint, /permissions|disk space/);
});

test("probeTempDir: read-back mismatch → warn", async () => {
	const r = await probeTempDir({
		tempBase: "/tmp/pi-webaio",
		ensureDir: async () => {},
		writeFile: async () => {},
		readFile: async () => "corrupted",
		unlink: async () => {},
	});
	assert.equal(r.status, "warn");
});

// ─── probeMcp ───────────────────────────────────────────────────────

test("probeMcp: import success → ok, optional", async () => {
	const r = await probeMcp({ importModule: async () => ({}) });
	assert.equal(r.status, "ok");
	assert.equal(r.required, false);
});

test("probeMcp: import throws → warn (not a strict gate)", async () => {
	const r = await probeMcp({
		importModule: async () => {
			throw new Error("cannot find module");
		},
	});
	assert.equal(r.status, "warn");
	assert.equal(r.required, false);
	assert.match(r.hint, /MCP server/);
});

// ─── probeDns (live-path logic, fake resolver) ──────────────────────

test("probeDns: offline → skipped", async () => {
	const r = await probeDns({ live: false, timeoutMs: 100 });
	assert.equal(r.status, "skipped");
	assert.match(r.hint, /--live/);
});

test("probeDns: live, resolves → ok with addresses", async () => {
	const r = await probeDns({
		live: true,
		timeoutMs: 100,
		resolveHost: async () => ["93.184.216.34"],
	});
	assert.equal(r.status, "ok");
	assert.match(r.message, /93\.184\.216\.34/);
});

test("probeDns: live, resolver throws → missing", async () => {
	const r = await probeDns({
		live: true,
		timeoutMs: 100,
		resolveHost: async () => {
			throw new Error("ENOTFOUND");
		},
	});
	assert.equal(r.status, "missing");
	assert.match(r.message, /ENOTFOUND/);
});

// ─── probeProxy (live-path logic, pure validation) ──────────────────

test("probeProxy: offline → skipped", async () => {
	const r = await probeProxy({
		live: false,
		env: { HTTPS_PROXY: "http://x:1" },
	});
	assert.equal(r.status, "skipped");
});

test("probeProxy: live, no proxy env → skipped", async () => {
	const r = await probeProxy({ live: true, env: {} });
	assert.equal(r.status, "skipped");
	assert.match(r.message, /no HTTPS_PROXY/);
});

test("probeProxy: live, valid proxy → ok", async () => {
	const r = await probeProxy({
		live: true,
		env: { HTTPS_PROXY: "http://proxy.local:8080" },
	});
	assert.equal(r.status, "ok");
	assert.match(r.message, /proxy\.local/);
});

test("probeProxy: live, invalid proxy → missing", async () => {
	const r = await probeProxy({
		live: true,
		env: { HTTP_PROXY: "not a url" },
	});
	assert.equal(r.status, "missing");
	assert.match(r.message, /invalid proxy URL/);
});
