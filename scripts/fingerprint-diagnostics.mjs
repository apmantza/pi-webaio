#!/usr/bin/env node
// ─── Optional live fingerprint diagnostics ──────────────────────────
// This script is intentionally not part of default CI. It probes live
// fingerprinting pages/endpoints and writes artifacts for manual review.
//
// Usage:
//   npm run diagnose:fingerprint -- --target tls
//   npm run diagnose:fingerprint -- --target sannysoft
//   npm run diagnose:fingerprint -- --target creepjs --visible
//   npm run diagnose:fingerprint -- --target all --out /tmp/pi-webaio-fp

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_OS,
	applyStealth,
	getLatestChromeProfile,
	smartFetch,
} from "../src/fetch.ts";

const TARGETS = {
	tls: "https://tls.peet.ws/api/all",
	sannysoft: "https://bot.sannysoft.com/",
	creepjs: "https://abrahamjuliot.github.io/creepjs/",
};

function parseArgs(argv) {
	const args = {
		target: "all",
		out: join(tmpdir(), "pi-webaio-fingerprint-diagnostics"),
		visible: false,
		waitMs: 8000,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--target") {
			args.target = argv[++i] ?? "all";
		} else if (a === "--out") {
			args.out = argv[++i] ?? args.out;
		} else if (a === "--visible") {
			args.visible = true;
		} else if (a === "--wait-ms") {
			args.waitMs = Number.parseInt(argv[++i] ?? "8000", 10);
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	if (!["all", ...Object.keys(TARGETS)].includes(args.target)) {
		throw new Error(`Unknown --target ${args.target}`);
	}
	if (!Number.isFinite(args.waitMs) || args.waitMs < 0) {
		throw new Error("--wait-ms must be a non-negative integer");
	}
	return args;
}

function printHelp() {
	process.stdout.write(`Fingerprint diagnostics\n\n`);
	process.stdout.write(`Options:\n`);
	process.stdout.write(`  --target <all|tls|sannysoft|creepjs>\n`);
	process.stdout.write(`  --out <directory>\n`);
	process.stdout.write(`  --visible\n`);
	process.stdout.write(`  --wait-ms <milliseconds>\n`);
}

async function writeJson(path, value) {
	await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function runTls(outDir) {
	const profile = getLatestChromeProfile();
	const result = await smartFetch(TARGETS.tls, {
		browser: profile,
		os: DEFAULT_OS,
	});
	if (!result) throw new Error("TLS endpoint fetch returned null");

	let payload;
	try {
		payload = JSON.parse(result.text);
	} catch (err) {
		throw new Error(`TLS endpoint returned non-JSON payload: ${String(err)}`);
	}

	const summary = {
		target: "tls",
		url: TARGETS.tls,
		browserProfile: profile,
		os: DEFAULT_OS,
		status: result.status,
		userAgent: payload.user_agent,
		httpVersion: payload.http_version,
		ja3: payload.tls?.ja3,
		ja3Hash: payload.tls?.ja3_hash,
		ja4: payload.tls?.ja4,
		akamaiFingerprint: payload.http2?.akamai_fingerprint,
		akamaiFingerprintHash: payload.http2?.akamai_fingerprint_hash,
	};

	await writeJson(join(outDir, "tls.summary.json"), summary);
	await writeJson(join(outDir, "tls.raw.json"), payload);
	process.stdout.write(`[tls] ${summary.userAgent ?? "unknown UA"}\n`);
	process.stdout.write(
		`[tls] ja3=${summary.ja3Hash ?? summary.ja3 ?? "n/a"}\n`,
	);
	process.stdout.write(`[tls] ja4=${summary.ja4 ?? "n/a"}\n`);
}

async function launchChromium(visible) {
	const { chromium } = await import("playwright");
	for (const opts of [{ channel: "chrome" }, {}]) {
		try {
			return await chromium.launch({
				...opts,
				headless: !visible,
			});
		} catch {
			// Try bundled Chromium if channel chrome is unavailable.
		}
	}
	throw new Error("Could not launch Playwright Chromium");
}

async function runBrowserTarget(name, url, outDir, opts) {
	const browser = await launchChromium(opts.visible);
	try {
		const page = await browser.newPage({
			viewport: { width: 1365, height: 768 },
			locale: "en-US",
		});
		await applyStealth(page);
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: 45_000,
		});
		if (opts.waitMs > 0) {
			await page.waitForTimeout(opts.waitMs);
		}

		const diagnostics = await page.evaluate(() => ({
			url: location.href,
			title: document.title,
			userAgent: navigator.userAgent,
			webdriver: navigator.webdriver,
			platform: navigator.platform,
			languages: navigator.languages,
			pluginsLength: navigator.plugins?.length ?? null,
			mimeTypesLength: navigator.mimeTypes?.length ?? null,
			hardwareConcurrency: navigator.hardwareConcurrency,
			deviceMemory: navigator.deviceMemory ?? null,
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			bodyTextSample: document.body?.innerText?.slice(0, 4000) ?? "",
		}));
		const html = await page.content();
		const screenshot = await page.screenshot({ fullPage: true });

		await writeJson(join(outDir, `${name}.summary.json`), diagnostics);
		await writeFile(join(outDir, `${name}.html`), html, "utf8");
		await writeFile(join(outDir, `${name}.png`), screenshot);

		process.stdout.write(`[${name}] title=${diagnostics.title}\n`);
		process.stdout.write(
			`[${name}] webdriver=${String(diagnostics.webdriver)}\n`,
		);
		process.stdout.write(`[${name}] userAgent=${diagnostics.userAgent}\n`);
	} finally {
		await browser.close().catch(() => {});
	}
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${String(err.message || err)}\n`);
		printHelp();
		process.exit(2);
	}

	await mkdir(args.out, { recursive: true });
	process.stdout.write(`Writing diagnostics to ${args.out}\n`);

	if (args.target === "all" || args.target === "tls") {
		await runTls(args.out);
	}
	if (args.target === "all" || args.target === "sannysoft") {
		await runBrowserTarget("sannysoft", TARGETS.sannysoft, args.out, args);
	}
	if (args.target === "all" || args.target === "creepjs") {
		await runBrowserTarget("creepjs", TARGETS.creepjs, args.out, args);
	}
}

main().catch((err) => {
	process.stderr.write(`${String(err.stack || err.message || err)}\n`);
	process.exit(1);
});
