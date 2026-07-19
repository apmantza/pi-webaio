#!/usr/bin/env node
// ─── Extraction quality benchmark harness ──────────────────────────
// Runs a fixed corpus of URLs through the real extraction pipeline and
// reports a scorecard (success rate, marker hits, token counts, latency).
// Compares against a committed baseline to catch quality regressions.
//
// Usage:
//   npm run bench
//   npm run bench -- --json
//   npm run bench -- --baseline scripts/bench-baseline.json
//   npm run bench -- --update-baseline
//   npm run bench -- --filter wikipedia,arxiv
//   npm run bench -- --concurrency 2 --timeout 30000

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pullPageEnhanced } from "../src/content.ts";
import { estimateTokens } from "../src/token-count.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Arg parsing ───────────────────────────────────────────────────

export function parseArgs(argv) {
	const args = {
		json: false,
		baseline: null,
		updateBaseline: false,
		filter: null,
		concurrency: 2,
		timeout: 30_000,
		corpus: join(__dirname, "bench-corpus.json"),
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") {
			args.json = true;
		} else if (a === "--baseline") {
			args.baseline = argv[++i] ?? null;
		} else if (a === "--update-baseline") {
			args.updateBaseline = true;
		} else if (a === "--filter") {
			args.filter = (argv[++i] ?? "").split(",").filter(Boolean);
		} else if (a === "--concurrency") {
			args.concurrency = Number.parseInt(argv[++i] ?? "2", 10);
		} else if (a === "--timeout") {
			args.timeout = Number.parseInt(argv[++i] ?? "30000", 10);
		} else if (a === "--corpus") {
			args.corpus = argv[++i] ?? args.corpus;
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	return args;
}

function printHelp() {
	process.stdout.write(`Extraction quality benchmark harness\n\n`);
	process.stdout.write(`Options:\n`);
	process.stdout.write(
		`  --json                  Output full results as JSON to stdout\n`,
	);
	process.stdout.write(
		`  --baseline <path>       Compare results against a baseline JSON file\n`,
	);
	process.stdout.write(
		`  --update-baseline       Write current results as the new baseline\n`,
	);
	process.stdout.write(
		`  --filter <cat1,cat2>    Run only entries with matching category\n`,
	);
	process.stdout.write(
		`  --concurrency <n>       Number of parallel fetches (default: 2)\n`,
	);
	process.stdout.write(
		`  --timeout <ms>          Per-URL timeout in ms (default: 30000)\n`,
	);
	process.stdout.write(`  --corpus <path>         Path to corpus JSON file\n`);
}

// ─── Corpus validation ─────────────────────────────────────────────

/**
 * Validate a corpus entry. Returns an error string or null if valid.
 * Exported for unit tests.
 */
export function validateCorpusEntry(entry) {
	if (!entry || typeof entry !== "object") return "entry must be an object";
	if (typeof entry.url !== "string" || !entry.url)
		return "missing or empty url";
	try {
		new URL(entry.url);
	} catch {
		return `invalid URL: ${entry.url}`;
	}
	if (typeof entry.category !== "string" || !entry.category)
		return "missing or empty category";
	if (!entry.markers || typeof entry.markers !== "object")
		return "missing markers object";
	if (!Array.isArray(entry.markers.required) || entry.markers.required.length === 0)
		return "markers.required must be a non-empty array";
	for (const m of entry.markers.required) {
		if (typeof m !== "string" || !m) return `marker must be a non-empty string, got: ${JSON.stringify(m)}`;
	}
	return null;
}

export function validateCorpus(corpus) {
	if (!Array.isArray(corpus)) return ["corpus must be an array"];
	const errors = [];
	for (let i = 0; i < corpus.length; i++) {
		const err = validateCorpusEntry(corpus[i]);
		if (err) errors.push(`entry[${i}]: ${err}`);
	}
	return errors;
}

// ─── Benchmark a single URL ────────────────────────────────────────

/**
 * Run extraction for a single corpus entry with a timeout + one retry.
 * Returns a BenchResult. Exported for unit tests (can be mocked).
 */
export async function benchmarkUrl(entry, { timeout = 30_000, runExtraction = null } = {}) {
	const extractFn = runExtraction ?? defaultExtraction;
	const start = Date.now();

	let attempt = 0;
	let lastError = null;
	let networkError = false;

	while (attempt < 2) {
		attempt++;
		try {
			const result = await Promise.race([
				extractFn(entry.url),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("bench timeout")), timeout),
				),
			]);

			const latencyMs = Date.now() - start;
			const markdown = result?.text ?? result?.content ?? "";
			const tokens = markdown ? estimateTokens(markdown) : 0;

			const markersFound = [];
			const markersMissed = [];
			const lc = markdown.toLowerCase();

			for (const m of entry.markers.required) {
				if (lc.includes(m.toLowerCase())) {
					markersFound.push(m);
				} else {
					markersMissed.push(m);
				}
			}

			const success = !!markdown && markdown.length > 50;

			return {
				url: entry.url,
				category: entry.category,
				description: entry.description ?? "",
				success,
				networkError: false,
				markersFound,
				markersMissed,
				markerHitRate:
					entry.markers.required.length > 0
						? markersFound.length / entry.markers.required.length
						: 1,
				tokens,
				latencyMs,
				error: success ? null : "Extracted markdown too short or empty",
			};
		} catch (err) {
			lastError = err;
			const msg = String(err?.message || err);
			networkError =
				msg.includes("ECONNRESET") ||
				msg.includes("ETIMEDOUT") ||
				msg.includes("ENOTFOUND") ||
				msg.includes("ECONNREFUSED") ||
				msg.includes("fetch failed") ||
				msg.includes("bench timeout") ||
				msg.includes("getaddrinfo");

			if (attempt < 2) {
				// One retry with small backoff
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}

	const latencyMs = Date.now() - start;
	return {
		url: entry.url,
		category: entry.category,
		description: entry.description ?? "",
		success: false,
		networkError,
		markersFound: [],
		markersMissed: entry.markers.required,
		markerHitRate: 0,
		tokens: 0,
		latencyMs,
		error: String(lastError?.message || lastError),
	};
}

async function defaultExtraction(url) {
	return pullPageEnhanced(url);
}

// ─── Batch runner with concurrency ─────────────────────────────────

export async function runBenchmark(corpus, opts = {}) {
	const { concurrency = 2, timeout = 30_000, runExtraction = null, onProgress = null } = opts;
	const results = [];
	let idx = 0;

	async function worker() {
		while (idx < corpus.length) {
			const entry = corpus[idx++];
			if (onProgress) onProgress(entry, idx, corpus.length);
			const result = await benchmarkUrl(entry, { timeout, runExtraction });
			results.push(result);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, corpus.length) }, worker);
	await Promise.all(workers);
	return results;
}

// ─── Scorecard computation ─────────────────────────────────────────

/**
 * Compute a scorecard from an array of BenchResults.
 * Exported for unit tests.
 */
export function computeScorecard(results) {
	if (results.length === 0) {
		return {
			totalUrls: 0,
			successRate: 0,
			markerHitRate: 0,
			networkFailures: 0,
			extractionFailures: 0,
			medianTokens: 0,
			p50LatencyMs: 0,
			p95LatencyMs: 0,
			byCategory: {},
			results,
		};
	}

	const successes = results.filter((r) => r.success);
	const networkFails = results.filter((r) => !r.success && r.networkError);
	const extractionFails = results.filter((r) => !r.success && !r.networkError);

	const allMarkerHits = results.flatMap((r) => r.markersFound).length;
	const allMarkers = results.flatMap((r) => [...r.markersFound, ...r.markersMissed]).length;

	const sorted = [...results].sort((a, b) => a.latencyMs - b.latencyMs);
	const tokenSorted = [...results]
		.filter((r) => r.success && r.tokens > 0)
		.sort((a, b) => a.tokens - b.tokens);

	const p50 = sorted[Math.floor(sorted.length * 0.5)]?.latencyMs ?? 0;
	const p95 = sorted[Math.floor(sorted.length * 0.95)]?.latencyMs ?? 0;
	const medianTokens =
		tokenSorted[Math.floor(tokenSorted.length * 0.5)]?.tokens ?? 0;

	// Per-category breakdown
	const byCategory = {};
	for (const r of results) {
		if (!byCategory[r.category]) {
			byCategory[r.category] = { total: 0, success: 0, markerHits: 0, markers: 0, tokens: [], latencies: [] };
		}
		const cat = byCategory[r.category];
		cat.total++;
		if (r.success) cat.success++;
		cat.markerHits += r.markersFound.length;
		cat.markers += r.markersFound.length + r.markersMissed.length;
		if (r.tokens > 0) cat.tokens.push(r.tokens);
		cat.latencies.push(r.latencyMs);
	}

	return {
		totalUrls: results.length,
		successRate: successes.length / results.length,
		markerHitRate: allMarkers > 0 ? allMarkerHits / allMarkers : 0,
		networkFailures: networkFails.length,
		extractionFailures: extractionFails.length,
		medianTokens,
		p50LatencyMs: p50,
		p95LatencyMs: p95,
		byCategory,
		results,
	};
}

// ─── Baseline diff ─────────────────────────────────────────────────

const TOKEN_SWING_THRESHOLD = 0.3; // 30% swing

/**
 * Compare current results against a baseline, return regressions.
 * Exported for unit tests.
 */
export function diffAgainstBaseline(currentResults, baselineResults) {
	const baselineMap = new Map(baselineResults.map((r) => [r.url, r]));
	const regressions = [];

	for (const cur of currentResults) {
		const base = baselineMap.get(cur.url);
		if (!base) continue;

		// success → failure
		if (base.success && !cur.success) {
			regressions.push({
				url: cur.url,
				category: cur.category,
				type: "success-failure",
				detail: `was success, now ${cur.networkError ? "network failure" : "extraction failure"}: ${cur.error}`,
			});
		}

		// marker losses (only when we had success before)
		if (base.success && cur.success) {
			const lostMarkers = base.markersFound.filter(
				(m) => !cur.markersFound.includes(m),
			);
			if (lostMarkers.length > 0) {
				regressions.push({
					url: cur.url,
					category: cur.category,
					type: "marker-loss",
					detail: `lost markers: ${lostMarkers.join(", ")}`,
				});
			}

			// token count swing > 30%
			if (base.tokens > 0 && cur.tokens > 0) {
				const swing = Math.abs(cur.tokens - base.tokens) / base.tokens;
				if (swing > TOKEN_SWING_THRESHOLD) {
					regressions.push({
						url: cur.url,
						category: cur.category,
						type: "token-swing",
						detail: `tokens changed ${base.tokens} → ${cur.tokens} (${Math.round(swing * 100)}% swing)`,
					});
				}
			}
		}
	}

	return regressions;
}

// ─── Human-readable output ─────────────────────────────────────────

function pct(n) {
	return `${Math.round(n * 100)}%`;
}

function ms(n) {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

function pad(s, n) {
	return String(s).padEnd(n);
}

export function formatScorecard(scorecard, regressions) {
	const lines = [];
	lines.push(`\n${"═".repeat(60)}`);
	lines.push(`  Extraction Quality Benchmark`);
	lines.push(`${"═".repeat(60)}`);
	lines.push(`  URLs tested:        ${scorecard.totalUrls}`);
	lines.push(
		`  Success rate:       ${pct(scorecard.successRate)} (${
			scorecard.totalUrls -
			scorecard.networkFailures -
			scorecard.extractionFailures
		}/${scorecard.totalUrls})`,
	);
	lines.push(`  Marker hit rate:    ${pct(scorecard.markerHitRate)}`);
	lines.push(`  Network failures:   ${scorecard.networkFailures}`);
	lines.push(`  Extraction failures:${scorecard.extractionFailures}`);
	lines.push(`  Median tokens:      ${scorecard.medianTokens}`);
	lines.push(`  p50 latency:        ${ms(scorecard.p50LatencyMs)}`);
	lines.push(`  p95 latency:        ${ms(scorecard.p95LatencyMs)}`);
	lines.push(`\n  Per-category:`);
	lines.push(
		`  ${pad("Category", 16)} ${pad("OK/Total", 9)} ${pad("Markers", 9)} ${pad("MedianTok", 10)} ${pad("p50lat", 8)}`,
	);
	lines.push(`  ${"─".repeat(56)}`);

	for (const [cat, c] of Object.entries(scorecard.byCategory)) {
		const catTokenSorted = [...c.tokens].sort((a, b) => a - b);
		const medTok = catTokenSorted[Math.floor(catTokenSorted.length / 2)] ?? 0;
		const catLatSorted = [...c.latencies].sort((a, b) => a - b);
		const p50lat = catLatSorted[Math.floor(catLatSorted.length / 2)] ?? 0;
		lines.push(
			`  ${pad(cat, 16)} ${pad(`${c.success}/${c.total}`, 9)} ${pad(
				c.markers > 0 ? pct(c.markerHits / c.markers) : "N/A",
				9,
			)} ${pad(medTok, 10)} ${pad(ms(p50lat), 8)}`,
		);
	}

	if (regressions && regressions.length > 0) {
		lines.push(`\n  ${"!".repeat(60)}`);
		lines.push(`  REGRESSIONS DETECTED (${regressions.length}):`);
		lines.push(`  ${"!".repeat(60)}`);
		for (const r of regressions) {
			lines.push(`  [${r.type}] ${r.url}`);
			lines.push(`    ${r.detail}`);
		}
	} else if (regressions) {
		lines.push(`\n  No regressions vs baseline.`);
	}

	lines.push(`\n  Per-URL details:`);
	lines.push(
		`  ${pad("URL", 45)} ${pad("Status", 8)} ${pad("Markers", 8)} ${pad("Tokens", 7)} ${pad("Latency", 8)}`,
	);
	lines.push(`  ${"─".repeat(80)}`);
	for (const r of scorecard.results) {
		const shortUrl = r.url.length > 43 ? r.url.slice(0, 40) + "..." : r.url;
		const status = r.success ? "OK" : r.networkError ? "NET-ERR" : "EXT-ERR";
		const markers = `${r.markersFound.length}/${r.markersFound.length + r.markersMissed.length}`;
		lines.push(
			`  ${pad(shortUrl, 45)} ${pad(status, 8)} ${pad(markers, 8)} ${pad(r.tokens, 7)} ${ms(r.latencyMs)}`,
		);
	}

	lines.push(`${"═".repeat(60)}\n`);
	return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
	function ms(n) {
		return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
	}
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${String(err.message || err)}\n`);
		printHelp();
		process.exit(2);
	}

	// Load corpus
	let corpus;
	try {
		const raw = await readFile(args.corpus, "utf8");
		corpus = JSON.parse(raw);
	} catch (err) {
		process.stderr.write(`Failed to load corpus from ${args.corpus}: ${err.message}\n`);
		process.exit(1);
	}

	const errors = validateCorpus(corpus);
	if (errors.length > 0) {
		process.stderr.write(`Corpus validation failed:\n${errors.join("\n")}\n`);
		process.exit(1);
	}

	// Apply category filter
	if (args.filter) {
		corpus = corpus.filter((e) => args.filter.includes(e.category));
		if (corpus.length === 0) {
			process.stderr.write(`No corpus entries match filter: ${args.filter.join(",")}\n`);
			process.exit(1);
		}
	}

	// Load baseline if requested
	let baseline = null;
	if (args.baseline) {
		try {
			const raw = await readFile(args.baseline, "utf8");
			baseline = JSON.parse(raw);
		} catch (err) {
			process.stderr.write(`Failed to load baseline from ${args.baseline}: ${err.message}\n`);
			process.exit(1);
		}
	}

	process.stdout.write(`Running benchmark on ${corpus.length} URLs (concurrency=${args.concurrency}, timeout=${ms(args.timeout)})...\n`);

	const results = await runBenchmark(corpus, {
		concurrency: args.concurrency,
		timeout: args.timeout,
		onProgress: (entry, idx, total) => {
			process.stdout.write(`  [${idx}/${total}] ${entry.url}\n`);
		},
	});

	const scorecard = computeScorecard(results);
	const regressions = baseline ? diffAgainstBaseline(results, baseline) : null;

	if (args.json) {
		process.stdout.write(JSON.stringify({ scorecard, regressions }, null, 2) + "\n");
	} else {
		process.stdout.write(formatScorecard(scorecard, regressions));
	}

	if (args.updateBaseline) {
		const baselinePath =
			args.baseline ?? join(__dirname, "bench-baseline.json");
		await writeFile(baselinePath, JSON.stringify(results, null, 2) + "\n", "utf8");
		process.stdout.write(`Baseline written to ${baselinePath}\n`);
	}

	// Exit 1 if regressions found
	if (regressions && regressions.length > 0) {
		process.exit(1);
	}
}

// Only run when invoked as the main script, not when imported by tests.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("bench-extraction.mjs") ||
		process.argv[1].endsWith("bench-extraction"))
) {
	main().catch((err) => {
		process.stderr.write(`${String(err.stack || err.message || err)}\n`);
		process.exit(1);
	});
}
