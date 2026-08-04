#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Manual-only F22 benchmark. It never runs as part of npm test/test:all.

export function parseArgs(argv) {
	const args = { live: false, query: null, samples: 3 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--live") args.live = true;
		else if (arg === "--query") args.query = argv[++i];
		else if (arg === "--samples") args.samples = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") args.help = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (
		!args.help &&
		(!args.query || !Number.isInteger(args.samples) || args.samples < 1)
	)
		throw new Error("--query and a positive integer --samples are required");
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

async function measure(
	label,
	query,
	googleSearch,
	ensureChrome,
	sampleCount,
	results,
	useBroker,
) {
	const previous = process.env.PI_WEBAIO_CDP_BROKER;
	if (useBroker) process.env.PI_WEBAIO_CDP_BROKER = "1";
	else delete process.env.PI_WEBAIO_CDP_BROKER;
	try {
		for (let index = 0; index < sampleCount; index++) {
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
				results.push({
					label,
					index: index + 1,
					ok: true,
					startupMs,
					brokerIpcMs: null,
					targetSetupMs: null,
					navigationExtractionMs: null,
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
		console.log(
			"  phases: startup=measured broker-ipc=not-instrumented target-setup=not-instrumented navigation/extraction=not-instrumented total=measured",
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
			'Usage: node scripts/bench-google-cdp.mjs --live --query "query" [--samples N]',
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
	const { googleSearch, ensureChrome } = googleAi;
	const results = { "legacy-first/warm": [], "broker-first/warm": [] };
	try {
		await measure(
			"legacy-first/warm",
			args.query,
			googleSearch,
			ensureChrome,
			args.samples,
			results["legacy-first/warm"],
			false,
		);
		await measure(
			"broker-first/warm",
			args.query,
			googleSearch,
			ensureChrome,
			args.samples,
			results["broker-first/warm"],
			true,
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
