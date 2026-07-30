#!/usr/bin/env node
// ─── Backend doctor ─────────────────────────────────────────────────
// Probes the OPTIONAL external backends pi-webaio leans on and prints a
// ✓ available / ✗ missing / ⊘ skipped report with actionable hints. It is
// a report, not a gate: it exits 0 even when backends are missing (pass
// --strict to exit 1 when a required backend is unavailable).
//
// Offline checks run by default so the script never hangs: gh CLI present
// + authenticated, Playwright importable + browsers installed, headless
// Chrome binary locatable + CDP assets present. Network reachability
// probes (search engines, Jina reader proxy) are opt-in behind --live.
//
// Usage:
//   npm run diagnose:backends
//   npm run diagnose:backends -- --live
//   npm run diagnose:backends -- --strict
//   npm run diagnose:backends -- --timeout-ms 5000

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 3000;

// CDP assets shipped at the package root (mirrors cdpAvailable() in
// src/google-ai.ts). Relative to the pi-webaio package root.
const CDP_ASSETS = [
	"bin/cdp.mjs",
	"bin/launch.mjs",
	"extractors/google-ai.mjs",
	"extractors/google-search.mjs",
	"extractors/common.mjs",
	"extractors/consent.mjs",
	"extractors/selectors.mjs",
];

// Plain-HTTP search engines (mirrors enginesBase in src/search.ts).
export const SEARCH_ENGINES = [
	{ id: "ddg", url: "https://html.duckduckgo.com/html/" },
	{ id: "brave", url: "https://search.brave.com/" },
	{ id: "yahoo", url: "https://search.yahoo.com/" },
	{ id: "bing", url: "https://www.bing.com/" },
];

export const JINA_URL = "https://r.jina.ai/";

// ─── CLI parsing / help ─────────────────────────────────────────────

export function parseArgs(argv) {
	const opts = {
		live: false,
		strict: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--live") {
			opts.live = true;
		} else if (a === "--strict") {
			opts.strict = true;
		} else if (a === "--timeout-ms") {
			opts.timeoutMs = Number.parseInt(argv[++i] ?? "3000", 10);
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown option ${a}`);
		}
	}
	if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
		throw new Error("--timeout-ms must be a positive integer");
	}
	return opts;
}

function printHelp() {
	process.stdout.write(`pi-webaio backend doctor\n\n`);
	process.stdout.write(
		`Probes optional backends (gh CLI, Playwright, headless Chrome, search engines, Jina).\n`,
	);
	process.stdout.write(
		`Offline checks run by default; network reachability needs --live.\n\n`,
	);
	process.stdout.write(`Options:\n`);
	process.stdout.write(
		`  --live            enable network reachability probes (search engines, Jina)\n`,
	);
	process.stdout.write(
		`  --strict          exit 1 if a required backend is missing\n`,
	);
	process.stdout.write(
		`  --timeout-ms <n>  per-probe timeout (default ${DEFAULT_TIMEOUT_MS})\n`,
	);
	process.stdout.write(`  --help, -h        show this help\n`);
}

// ─── Pure formatting helpers ────────────────────────────────────────

export function statusGlyph(status) {
	switch (status) {
		case "ok":
			return "✓";
		case "missing":
			return "✗";
		case "warn":
			return "⚠";
		case "skipped":
			return "⊘";
		default:
			return "?";
	}
}

export function summarize(results) {
	const s = { ok: 0, missing: 0, warn: 0, skipped: 0 };
	for (const r of results) {
		s[r.status] = (s[r.status] || 0) + 1;
	}
	return s;
}

export function formatLine(result, nameWidth = 0) {
	const glyph = statusGlyph(result.status);
	const name = result.name.padEnd(nameWidth);
	const lines = [`  ${glyph} ${name}  ${result.message}`];
	if (result.hint) lines.push(`      hint: ${result.hint}`);
	if (result.detail?.length) {
		for (const d of result.detail) lines.push(`      ${d}`);
	}
	return lines.join("\n");
}

export function formatReport(results, opts = {}) {
	const nameWidth = results.reduce((m, r) => Math.max(m, r.name.length), 0);
	const lines = ["pi-webaio backend doctor", ""];
	for (const r of results) lines.push(formatLine(r, nameWidth));
	lines.push("");
	const s = summarize(results);
	lines.push(
		`Summary: ${s.ok} available, ${s.missing} missing, ${s.warn} degraded, ${s.skipped} skipped`,
	);
	if (opts.live) lines.push("(live network probes enabled)");
	return `${lines.join("\n")}\n`;
}

// ─── Small pure helpers ─────────────────────────────────────────────

// Extract the logged-in account from `gh auth status` output (it writes to
// stderr, e.g. "Logged in to github.com as @octocat").
export function parseGhAccount(text) {
	if (!text) return null;
	const m =
		text.match(/Logged in to \S+ as @?([A-Za-z0-9-]+)/i) ||
		text.match(/account @?([A-Za-z0-9-]+)/i);
	return m ? m[1] : null;
}

// Resolve the Playwright browser registry directory (offline check).
export function playwrightBrowsersDir(platform, env) {
	if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
	if (platform === "win32") {
		const local =
			env.LOCALAPPDATA || join(env.USERPROFILE || "", "AppData", "Local");
		return join(local, "ms-playwright");
	}
	if (platform === "darwin") {
		return join(env.HOME || "", "Library", "Caches", "ms-playwright");
	}
	return join(env.HOME || "", ".cache", "ms-playwright");
}

// Locate a Chrome/Chromium binary (mirrors findChrome() in bin/launch.mjs,
// plus the CHROME_PATH override that launch.mjs honors).
export function findChromeBinary(deps) {
	const { platform, env, existsSync: exists } = deps;
	if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH;
	const candidates =
		platform === "win32"
			? [
					"C:/Program Files/Google/Chrome/Application/chrome.exe",
					"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
				]
			: platform === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium-browser",
						"/usr/bin/chromium",
						"/snap/bin/chromium",
					];
	return candidates.find((c) => exists(c)) || null;
}

// ─── Command / HTTP runners (injectable for tests) ──────────────────

// Run a command synchronously with a hard timeout. Never throws.
export function runCommand(cmd, args, timeoutMs) {
	try {
		const out = spawnSync(cmd, args, {
			encoding: "utf8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const timedOut =
			out.error?.code === "ETIMEDOUT" || out.signal === "SIGTERM";
		return {
			ok: !out.error && out.status === 0,
			code: out.status,
			stdout: out.stdout || "",
			stderr: out.stderr || "",
			timedOut,
		};
	} catch (err) {
		return {
			ok: false,
			code: null,
			stdout: "",
			stderr: String(err?.message || err),
			timedOut: false,
		};
	}
}

// Probe a URL for reachability. Any HTTP status < 500 counts as reachable.
export async function httpProbe(fetchImpl, url, timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			signal: ctrl.signal,
			redirect: "follow",
			headers: { "User-Agent": "pi-webaio-doctor/1.0" },
		});
		return { ok: res.status > 0 && res.status < 500, status: res.status };
	} catch (err) {
		return { ok: false, status: 0, error: String(err?.message || err) };
	} finally {
		clearTimeout(timer);
	}
}

// ─── Probes ─────────────────────────────────────────────────────────
// Each probe takes a `deps` object so tests can inject fakes instead of
// touching the network or spawning real processes.

export async function probeGh(deps) {
	const name = "GitHub CLI (gh)";
	const which = deps.platform === "win32" ? "where" : "which";
	const found = deps.runCommand(which, ["gh"], deps.timeoutMs);
	if (!found.ok) {
		return {
			name,
			status: "missing",
			required: true,
			message: "gh CLI not found on PATH",
			hint: "install from https://cli.github.com/, then run `gh auth login`",
		};
	}
	const ghPath = (found.stdout || "").trim().split(/\r?\n/)[0] || "gh";
	const auth = deps.runCommand(ghPath, ["auth", "status"], deps.timeoutMs);
	if (!auth.ok) {
		const reason = auth.timedOut ? "auth check timed out" : "not authenticated";
		return {
			name,
			status: "missing",
			required: true,
			message: `found at ${ghPath} but ${reason}`,
			hint: "run `gh auth login`",
		};
	}
	const account = parseGhAccount(`${auth.stderr}\n${auth.stdout}`);
	return {
		name,
		status: "ok",
		required: true,
		message: `authenticated${account ? ` as @${account}` : ""} (${ghPath})`,
		hint: null,
	};
}

export async function probePlaywright(deps) {
	const name = "Playwright";
	try {
		await deps.importModule("playwright");
	} catch {
		return {
			name,
			status: "missing",
			required: false,
			message: "playwright module not importable",
			hint: "run `npm install playwright` (optional dependency)",
		};
	}
	const dir = playwrightBrowsersDir(deps.platform, deps.env);
	const entries = deps.listDir(dir);
	const hasChromium = entries.some((e) =>
		/^chromium(-headless-shell)?-\d+/.test(e),
	);
	if (!hasChromium) {
		return {
			name,
			status: "warn",
			required: false,
			message: `importable, but no chromium browser under ${dir}`,
			hint: "run `npx playwright install chromium`",
		};
	}
	return {
		name,
		status: "ok",
		required: false,
		message: `importable, chromium installed (${dir})`,
		hint: null,
	};
}

export async function probeChrome(deps) {
	const name = "Headless Chrome (CDP)";
	const binary = findChromeBinary(deps);
	const missingAssets = CDP_ASSETS.filter(
		(a) => !deps.existsSync(join(deps.packageRoot, a)),
	);
	const detail = missingAssets.length
		? [`missing CDP assets: ${missingAssets.join(", ")}`]
		: [];
	if (!binary) {
		return {
			name,
			status: "missing",
			required: true,
			message: "no Chrome/Chromium binary found",
			hint: "install Google Chrome, or set CHROME_PATH to the executable",
			detail,
		};
	}
	if (missingAssets.length) {
		return {
			name,
			status: "warn",
			required: true,
			message: `binary at ${binary}; some CDP assets missing`,
			hint: "reinstall pi-webaio to restore bin/ and extractors/",
			detail,
		};
	}
	return {
		name,
		status: "ok",
		required: true,
		message: `binary at ${binary}; CDP assets present`,
		hint: null,
	};
}

export async function probeSearchEngines(deps) {
	const name = "Search engines";
	if (!deps.live) {
		return {
			name,
			status: "skipped",
			required: false,
			message: "network probe disabled",
			hint: "re-run with --live to test DDG/Brave/Yahoo/Bing reachability",
		};
	}
	const detail = [];
	let reachable = 0;
	for (const e of SEARCH_ENGINES) {
		const r = await httpProbe(deps.fetchImpl, e.url, deps.timeoutMs);
		if (r.ok) reachable++;
		detail.push(
			`${e.id} → ${r.ok ? `reachable (HTTP ${r.status})` : `unreachable${r.error ? `: ${r.error}` : ""}`}`,
		);
	}
	const status =
		reachable === SEARCH_ENGINES.length
			? "ok"
			: reachable === 0
				? "missing"
				: "warn";
	return {
		name,
		status,
		required: false,
		message: `${reachable}/${SEARCH_ENGINES.length} reachable`,
		hint:
			reachable === 0 ? "check network/proxy; search will return empty" : null,
		detail,
	};
}

export async function probeJina(deps) {
	const name = "Jina reader proxy";
	if (!deps.live) {
		return {
			name,
			status: "skipped",
			required: false,
			message: "network probe disabled",
			hint: "re-run with --live to test r.jina.ai reachability",
		};
	}
	const r = await httpProbe(deps.fetchImpl, JINA_URL, deps.timeoutMs);
	if (r.ok) {
		return {
			name,
			status: "ok",
			required: false,
			message: `reachable (HTTP ${r.status})`,
			hint: null,
		};
	}
	return {
		name,
		status: "warn",
		required: false,
		message: `unreachable${r.error ? `: ${r.error}` : ""}`,
		hint: "optional extraction fallback will be unavailable",
	};
}

// ─── Wiring ─────────────────────────────────────────────────────────

function resolvePackageRoot() {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultDeps(opts) {
	return {
		platform: process.platform,
		env: process.env,
		timeoutMs: opts.timeoutMs,
		live: opts.live,
		packageRoot: resolvePackageRoot(),
		runCommand: (cmd, args, timeoutMs) => runCommand(cmd, args, timeoutMs),
		existsSync: (p) => existsSync(p),
		listDir: (p) => {
			try {
				return readdirSync(p);
			} catch {
				return [];
			}
		},
		importModule: (spec) => import(spec),
		fetchImpl: (url, init) => fetch(url, init),
	};
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${String(err?.message || err)}\n`);
		printHelp();
		process.exit(2);
	}

	const deps = defaultDeps(opts);
	const results = [
		await probeGh(deps),
		await probePlaywright(deps),
		await probeChrome(deps),
		await probeSearchEngines(deps),
		await probeJina(deps),
	];

	process.stdout.write(formatReport(results, { live: opts.live }));

	if (opts.strict) {
		const failed = results.filter((r) => r.required && r.status === "missing");
		if (failed.length) {
			process.stderr.write(
				`\n--strict: ${failed.length} required backend(s) missing: ${failed
					.map((r) => r.name)
					.join(", ")}\n`,
			);
			process.exit(1);
		}
	}
	process.exit(0);
}

const isMain = process.argv[1]
	? import.meta.url === pathToFileURL(process.argv[1]).href
	: false;
if (isMain) {
	main().catch((err) => {
		process.stderr.write(`${String(err?.message || err)}\n`);
		process.exit(2);
	});
}
