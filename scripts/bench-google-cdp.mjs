#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Manual-only F22 benchmark. It never runs as part of npm test/test:all.

const BENCH_MODES = new Set(["legacy", "broker", "both"]);
const COLD_SHUTDOWN_WAIT_MS = 10_000;

export function parseArgs(argv) {
	const args = {
		live: false,
		query: null,
		samples: 3,
		mode: "both",
		cold: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--live") args.live = true;
		else if (arg === "--query") args.query = argv[++i];
		else if (arg === "--samples") args.samples = Number(argv[++i]);
		else if (arg === "--mode") args.mode = argv[++i];
		else if (arg === "--cold") args.cold = true;
		else if (arg === "--help" || arg === "-h") args.help = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (
		!args.help &&
		(!args.query || !Number.isInteger(args.samples) || args.samples < 1)
	)
		throw new Error("--query and a positive integer --samples are required");
	if (!args.help && !BENCH_MODES.has(args.mode))
		throw new Error("--mode must be one of legacy, broker, or both");
	return args;
}

function percentile(values, fraction) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
	];
}

export function summarize(samples) {
	const totals = samples.map((sample) => sample.totalMs);
	return {
		count: samples.length,
		p50Ms: percentile(totals, 0.5),
		p95Ms: percentile(totals, 0.95),
		completed: samples.filter((sample) => sample.ok).length,
	};
}

function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// Always the dedicated profile: google-ai.ts hardcodes it for both the legacy
// and broker lanes (and sets CDP_PROFILE_DIR itself for child processes).
// Honoring an externally exported CDP_PROFILE_DIR here could send Browser.close
// to the wrong Chrome while the benched one survives.
function coldProfileDir() {
	return join(tmpdir(), "greedysearch-chrome-profile");
}

async function cdpPortResponds(port) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1_000);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
			signal: controller.signal,
		});
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Best-effort graceful stop of the dedicated CDP Chrome so a sample measures
 * Chrome startup too. Reads DevToolsActivePort, asks the browser websocket
 * for Browser.close, then waits (bounded) for the port file to disappear or
 * the port to stop responding. Never throws: any failure is logged and the
 * sample simply runs warm.
 */
async function stopColdChrome() {
	const portPath = join(coldProfileDir(), "DevToolsActivePort");
	let port;
	try {
		const content = await readFile(portPath, "utf8");
		port = Number.parseInt(String(content).split(/\r?\n/, 1)[0], 10);
	} catch (error) {
		if (error?.code === "ENOENT") {
			console.log("cold: no DevToolsActivePort; Chrome already stopped");
			return;
		}
		console.log(
			`cold: DevToolsActivePort unreadable (${error.message}); running sample warm`,
		);
		return;
	}
	if (!Number.isInteger(port) || port <= 0) {
		console.log(
			"cold: DevToolsActivePort holds no usable port; running sample warm",
		);
		return;
	}
	let webSocketDebuggerUrl;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		webSocketDebuggerUrl = (await response.json()).webSocketDebuggerUrl;
	} catch {
		console.log(
			`cold: port ${port} not responding; treating as already cold`,
		);
		return;
	}
	if (!webSocketDebuggerUrl) {
		console.log(
			"cold: /json/version has no webSocketDebuggerUrl; running sample warm",
		);
		return;
	}
	let WebSocketImpl;
	try {
		({ default: WebSocketImpl } = await import("ws"));
	} catch (error) {
		console.log(
			`cold: ws package unavailable (${error.message}); running sample warm`,
		);
		return;
	}
	try {
		await new Promise((resolveClose, rejectClose) => {
			const socket = new WebSocketImpl(webSocketDebuggerUrl);
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					socket.close();
				} catch {}
				if (error) rejectClose(error);
				else resolveClose();
			};
			const timer = setTimeout(
				() => finish(new Error("Browser.close timed out")),
				5_000,
			);
			socket.on("open", () => {
				try {
					socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
				} catch (error) {
					finish(error);
				}
			});
			socket.on("message", (data) => {
				let message;
				try {
					message = JSON.parse(String(data));
				} catch {
					return;
				}
				if (message.id === 1) finish();
			});
			// Browser.close often drops the connection without answering; a
			// close still counts as the stop being delivered.
			socket.on("close", () => finish());
			socket.on("error", (error) => finish(error));
		});
		console.log("cold: Browser.close sent");
	} catch (error) {
		console.log(
			`cold: Browser.close failed (${error.message}); waiting for shutdown anyway`,
		);
	}
	const deadline = Date.now() + COLD_SHUTDOWN_WAIT_MS;
	while (Date.now() < deadline) {
		let portFileExists = true;
		try {
			await readFile(portPath, "utf8");
		} catch {
			portFileExists = false;
		}
		if (!portFileExists || !(await cdpPortResponds(port))) {
			console.log("cold: Chrome stopped");
			return;
		}
		await sleep(250);
	}
	console.log(
		"cold: Chrome did not confirm shutdown within 10s; continuing",
	);
}

async function measure(
	label,
	query,
	googleAi,
	sampleCount,
	results,
	useBroker,
	options,
) {
	const { googleSearch, ensureChrome } = googleAi;
	const previous = process.env.PI_WEBAIO_CDP_BROKER;
	if (useBroker) process.env.PI_WEBAIO_CDP_BROKER = "1";
	else delete process.env.PI_WEBAIO_CDP_BROKER;
	try {
		for (let index = 0; index < sampleCount; index++) {
			if (options.cold) {
				await stopColdChrome();
				// A broker connected to the killed Chrome can never serve the
				// restarted browser; drop it so the sample respawns/reconnects
				// and the measured search includes broker startup too.
				if (useBroker) await googleAi.closeGoogleBroker?.();
			}
			const started = performance.now();
			const startupStarted = performance.now();
			let startupMs = null;
			try {
				await ensureChrome();
				startupMs = performance.now() - startupStarted;
				const result = await googleSearch(query, {
					timeoutMs: 45_000,
					maxResults: 10,
				});
				const totalMs = performance.now() - started;
				// Broker samples expose phase timings from the broker envelope;
				// legacy samples (and broker samples that fell back) stay null.
				const timings = result.timings;
				results.push({
					label,
					index: index + 1,
					ok: true,
					startupMs,
					brokerIpcMs: null,
					targetSetupMs: numberOrNull(timings?.targetSetupMs),
					navigationExtractionMs:
						numberOrNull(timings?.navigationMs) !== null &&
						numberOrNull(timings?.extractionMs) !== null
							? timings.navigationMs + timings.extractionMs
							: null,
					resetMs: numberOrNull(timings?.resetMs),
					totalMs,
					resultCount: result.results.length,
				});
			} catch (error) {
				results.push({
					label,
					index: index + 1,
					ok: false,
					startupMs,
					brokerIpcMs: null,
					targetSetupMs: null,
					navigationExtractionMs: null,
					resetMs: null,
					totalMs: performance.now() - started,
					error: String(error?.message || error).slice(0, 160),
				});
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PI_WEBAIO_CDP_BROKER;
		else process.env.PI_WEBAIO_CDP_BROKER = previous;
	}
}

function printReport(results) {
	for (const [label, rows] of Object.entries(results)) {
		const summary = summarize(rows);
		console.log(
			`${label}: n=${summary.count} completed=${summary.completed} p50=${summary.p50Ms?.toFixed(1) ?? "n/a"}ms p95=${summary.p95Ms?.toFixed(1) ?? "n/a"}ms`,
		);
		const hasBrokerTimings = rows.some(
			(row) =>
				row.targetSetupMs !== null || row.navigationExtractionMs !== null,
		);
		const brokerPhases = hasBrokerTimings
			? "target-setup=derived(broker timings) navigation/extraction=derived(broker timings) reset=derived(broker timings)"
			: "target-setup=not-instrumented navigation/extraction=not-instrumented";
		console.log(
			`  phases: startup=measured broker-ipc=not-instrumented ${brokerPhases} total=measured`,
		);
	}
	console.log(
		"No speedup is inferred automatically. Compare like-for-like cold/warm labels and inspect completion/errors.",
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(
			'Usage: node scripts/bench-google-cdp.mjs --live --query "query" [--samples N] [--mode legacy|broker|both] [--cold]',
		);
		return;
	}
	if (!args.live && process.env.PI_WEBAIO_LIVE_BENCH !== "1")
		throw new Error(
			"Live Google benchmark blocked: pass --live or set PI_WEBAIO_LIVE_BENCH=1",
		);
	const distModule = fileURLToPath(
		new URL("../dist/src/google-ai.js", import.meta.url),
	);
	const sourceModule = fileURLToPath(
		new URL("../src/google-ai.ts", import.meta.url),
	);
	const googleAi = await import(
		pathToFileURL(existsSync(distModule) ? distModule : sourceModule).href
	);
	const laneSuffix = args.cold ? "cold" : "warm";
	const lanes = [];
	if (args.mode === "legacy" || args.mode === "both")
		lanes.push({ label: `legacy-first/${laneSuffix}`, useBroker: false });
	if (args.mode === "broker" || args.mode === "both")
		lanes.push({ label: `broker-first/${laneSuffix}`, useBroker: true });
	const results = Object.fromEntries(lanes.map((lane) => [lane.label, []]));
	try {
		for (const lane of lanes)
			await measure(
				lane.label,
				args.query,
				googleAi,
				args.samples,
				results[lane.label],
				lane.useBroker,
				{ cold: args.cold },
			);
		printReport(results);
	} finally {
		await googleAi.closeGoogleBroker?.();
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(`bench-google-cdp: ${error.message}`);
		process.exitCode = 1;
	});
}
