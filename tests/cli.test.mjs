/**
 * CLI integration tests — drives the built CLI (bin/pi-webaio-cli.mjs) as a
 * real child process.
 *
 * Tests:
 *  1. `list` prints all 8 aio-* tools.
 *  2. `--help` prints usage.
 *  3. Unknown tool → exit 2 with a clear message.
 *  4. `aio-webquery` offline against a fixture corpus (key-value flags).
 *  5. `aio-webquery` offline via a single JSON object positional.
 *  6. `--json` prints a structured JSON result (text + details).
 *
 * No live network is used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const EXPECTED_TOOLS = [
	"aio-websearch",
	"aio-webfetch",
	"aio-webcontent",
	"aio-webresult",
	"aio-webmap",
	"aio-webpull",
	"aio-webquery",
	"aio-webresearch",
];

/** Run the CLI as a child process; resolve with { code, stdout, stderr }. */
function runCli(args) {
	return new Promise((resolve, reject) => {
		const binPath = join(ROOT, "bin", "pi-webaio-cli.mjs");
		const proc = spawn(process.execPath, [binPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (c) => (stdout += c.toString("utf8")));
		proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));
		proc.on("error", reject);
		proc.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/** Build a tiny fixture corpus (same logic aio-webpull uses) for offline aio-webquery. */
async function buildFixtureCorpus() {
	const corpusDir = await mkdtemp(join(tmpdir(), "pi-webaio-cli-test-"));
	await writeFile(
		join(corpusDir, "intro.md"),
		`---\ntitle: "Introduction"\nurl: "https://example.com/intro"\n---\n# Introduction\n\nThis is the introduction page covering basic concepts.\n`,
		"utf8",
	);
	await writeFile(
		join(corpusDir, "api.md"),
		`---\ntitle: "API Reference"\nurl: "https://example.com/api"\n---\n# API Reference\n\nThe API provides endpoints for querying and updating data resources.\n`,
		"utf8",
	);
	const { buildIndex } = await import(
		pathToFileURL(join(ROOT, "dist", "src", "webquery-index.js")).href
	);
	await buildIndex(corpusDir);
	return corpusDir;
}

// ─── Test 1: list ─────────────────────────────────────────────────────────

test("CLI `list` prints all 8 aio-* tools", async () => {
	const { code, stdout, stderr } = await runCli(["list"]);
	assert.equal(code, 0, `exit 0 (stderr: ${stderr})`);
	for (const name of EXPECTED_TOOLS) {
		assert.ok(stdout.includes(name), `stdout lists ${name}`);
	}
});

// ─── Test 2: --help ───────────────────────────────────────────────────────

test("CLI `--help` prints usage", async () => {
	const { code, stdout } = await runCli(["--help"]);
	assert.equal(code, 0, "exit 0");
	assert.ok(stdout.includes("Usage:"), "usage shown");
	assert.ok(stdout.includes("pi-webaio-cli"), "program name shown");
});

// ─── Test 3: unknown tool ─────────────────────────────────────────────────

test("CLI unknown tool exits 2 with a clear message", async () => {
	const { code, stdout, stderr } = await runCli(["does-not-exist"]);
	assert.equal(code, 2, "exit 2 (usage error)");
	assert.ok(
		stderr.includes("Unknown tool"),
		`stderr says unknown tool (got: ${stderr})`,
	);
	assert.ok(stdout.includes("Usage:"), "usage shown on stderr path");
});

// ─── Test 4: aio-webquery offline (key-value flags) ──────────────────────

test("CLI aio-webquery via key-value flags (offline)", async () => {
	const corpusDir = await buildFixtureCorpus();
	const { code, stdout, stderr } = await runCli([
		"aio-webquery",
		"--query",
		"API endpoints data",
		"--dir",
		corpusDir,
		"--topK",
		"3",
	]);
	assert.equal(code, 0, `exit 0 (stderr: ${stderr})`);
	assert.ok(stdout.length > 0, "non-empty result");
	assert.ok(
		stdout.toLowerCase().includes("api") ||
			stdout.toLowerCase().includes("endpoint"),
		`result references API content (got: ${stdout.slice(0, 300)})`,
	);
});

// ─── Test 5: aio-webquery offline (JSON positional) ──────────────────────

test("CLI aio-webquery via JSON object positional (offline)", async () => {
	const corpusDir = await buildFixtureCorpus();
	const params = JSON.stringify({
		query: "API endpoints data",
		dir: corpusDir,
		topK: 3,
	});
	const { code, stdout, stderr } = await runCli(["aio-webquery", params]);
	assert.equal(code, 0, `exit 0 (stderr: ${stderr})`);
	assert.ok(stdout.length > 0, "non-empty result");
	assert.ok(
		stdout.toLowerCase().includes("api") ||
			stdout.toLowerCase().includes("endpoint"),
		`result references API content (got: ${stdout.slice(0, 300)})`,
	);
});

// ─── Test 6: --json structured output ────────────────────────────────────

test("CLI --json prints a structured JSON result", async () => {
	const corpusDir = await buildFixtureCorpus();
	const { code, stdout, stderr } = await runCli([
		"--json",
		"aio-webquery",
		"--query",
		"API endpoints data",
		"--dir",
		corpusDir,
		"--topK",
		"3",
	]);
	assert.equal(code, 0, `exit 0 (stderr: ${stderr})`);
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		assert.fail(`stdout is not JSON (got: ${stdout.slice(0, 300)})`);
	}
	assert.equal(parsed.tool, "aio-webquery", "tool name in JSON");
	assert.ok(
		typeof parsed.text === "string" && parsed.text.length > 0,
		"text is non-empty",
	);
	assert.ok(parsed.details !== undefined, "details present");
});
