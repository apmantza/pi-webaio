import assert from "node:assert";
import test from "node:test";
import { registerWebfetchTool } from "../src/tools/webfetch.ts";

// ─── Batch throw-isolation (aio-webfetch multi-URL path) ──────────────────
//
// A URL that THROWS during fetch (e.g. the SSRF guard throws blocked_ssrf)
// used to reject runInBatches' bare Promise.all, aborting the WHOLE batch:
// the outer catch then mis-attributed a single error to targets[0] and every
// other URL was silently lost ("Fetched 0/2" with one error). The per-URL
// handler now catches a thrown FetchError and records it as that URL's error,
// so the remaining targets still complete.
//
// These tests drive the REAL execute handler (captured via the same mock-pi
// shim the MCP server uses) and are fully offline — SSRF blocks fire in the
// pre-flight guard, no network required.

function getWebfetchExecute() {
	const tools = [];
	const piShim = {
		registerTool(config) {
			tools.push({ name: config.name, execute: config.execute });
		},
	};
	registerWebfetchTool(piShim);
	const wf = tools.find((t) => t.name === "aio-webfetch");
	assert.ok(wf, "aio-webfetch tool registered");
	return wf.execute;
}

function textOf(result) {
	return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

test("a thrown block on one URL no longer aborts the batch — both blocked URLs report", async () => {
	const execute = getWebfetchExecute();
	const result = await execute(
		"test-batch-ssrf",
		{ urls: ["http://169.254.169.254/", "http://127.0.0.1/"] },
		undefined,
		() => {},
	);
	const text = textOf(result);
	// Before the fix only targets[0] (169.254.169.254) was reported — the
	// second URL vanished when the first throw rejected the batch. Both must
	// now appear, each with its own blocked_ssrf error.
	assert.match(text, /169\.254\.169\.254/);
	assert.match(text, /127\.0\.0\.1/);
	assert.match(text, /blocked_ssrf/);
});

test("each thrown URL gets its own error line (no silent loss, no mis-attribution)", async () => {
	const execute = getWebfetchExecute();
	const result = await execute(
		"test-batch-ssrf-2",
		{ urls: ["http://127.0.0.1/", "http://169.254.169.254/"] },
		undefined,
		() => {},
	);
	const text = textOf(result);
	// Reversed order — the discriminator URL (169.254.169.254) is now
	// targets[1]; the old code would only have shown targets[0] (127.0.0.1).
	assert.match(text, /127\.0\.0\.1/);
	assert.match(text, /169\.254\.169\.254/);
	// Two distinct error lines, one per URL.
	const errorLines = text
		.split("\n")
		.filter((l) => l.includes("✗") || l.includes("[blocked_ssrf]"));
	assert.ok(
		errorLines.length >= 2,
		`expected ≥2 per-URL error lines, got ${errorLines.length}:\n${text}`,
	);
});
