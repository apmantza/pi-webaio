import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	searchParallel,
	fetchParallel,
	resolveParallelApiKey,
	parallelAvailable,
	isParallelRateLimited,
	resetParallelRateLimit,
} from "../src/parallel.ts";
import { setConfigDir } from "../src/config.ts";
import { ENGINE_WEIGHTS, buildEngineStatusMap } from "../src/search.ts";
import { TOOL_METADATA } from "../src/tools/lazy.ts";

// ─── Test scaffolding ───────────────────────────────────────────────

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const tmpDirs = [];

function makeConfigDir({ config, env } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "piwebaio-parallel-test-"));
	tmpDirs.push(dir);
	if (config !== undefined) {
		writeFileSync(join(dir, "config"), JSON.stringify(config));
	}
	if (env !== undefined) {
		writeFileSync(join(dir, ".env"), env);
	}
	setConfigDir(dir);
	return dir;
}

/** Install a fetch mock; returns the array of recorded calls. */
function mockFetch(handler) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return handler(url, init, calls);
	};
	return calls;
}

function jsonResponse(status, body, headers = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers(headers),
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

beforeEach(() => {
	resetParallelRateLimit();
	delete process.env.PARALLEL_API_KEY;
	makeConfigDir({});
});

afterEach(() => {
	globalThis.fetch = realFetch;
	process.env = savedEnv;
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── API key resolution ─────────────────────────────────────────────

test("resolveParallelApiKey prefers the explicit override", () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	assert.equal(
		resolveParallelApiKey("override-key-value-1"),
		"override-key-value-1",
	);
});

test("resolveParallelApiKey reads the JSON config file", () => {
	makeConfigDir({ config: { parallel: { apiKey: "json-key-value-1" } } });
	assert.equal(resolveParallelApiKey(), "json-key-value-1");
});

test("resolveParallelApiKey reads the .env file", () => {
	makeConfigDir({ env: "PARALLEL_API_KEY=dotenv-key-value-1\n" });
	assert.equal(resolveParallelApiKey(), "dotenv-key-value-1");
});

test("resolveParallelApiKey falls back to the environment variable", () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	assert.equal(resolveParallelApiKey(), "env-key-value-1");
});

test("resolveParallelApiKey: JSON config wins over the environment", () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	makeConfigDir({ config: { parallel: { apiKey: "json-key-value-1" } } });
	assert.equal(resolveParallelApiKey(), "json-key-value-1");
});

test("parallelAvailable reflects key presence", () => {
	assert.equal(parallelAvailable(), false);
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	assert.equal(parallelAvailable(), true);
});

// ─── Search API ─────────────────────────────────────────────────────

test("searchParallel returns null without an API key and never fetches", async () => {
	const calls = mockFetch(() => jsonResponse(200, { results: [] }));
	const r = await searchParallel("test query");
	assert.equal(r, null);
	assert.equal(calls.length, 0);
});

test("searchParallel sends objective, search_queries, mode, and the x-api-key header", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let captured;
	const calls = mockFetch(async (url, init) => {
		captured = {
			url: String(url),
			method: init.method,
			headers: init.headers,
			body: JSON.parse(init.body),
		};
		return jsonResponse(200, { results: [] });
	});
	await searchParallel("vector db benchmarks", { mode: "turbo" });
	assert.equal(captured.url, "https://api.parallel.ai/v1/search");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers["x-api-key"], "env-key-value-1");
	assert.equal(captured.body.objective, "vector db benchmarks");
	assert.deepEqual(captured.body.search_queries, ["vector db benchmarks"]);
	assert.equal(captured.body.mode, "turbo");
	assert.equal(calls.length, 1);
});

test("searchParallel defaults to fast mode", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let body;
	mockFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return jsonResponse(200, { results: [] });
	});
	await searchParallel("q");
	assert.equal(body.mode, "basic");
});

test("searchParallel maps url/title/excerpts and strips www from domains", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [
				{
					url: "https://www.example.com/docs",
					title: "  Example Docs  ",
					excerpts: ["first excerpt", "second excerpt"],
				},
			],
		}),
	);
	const r = await searchParallel("q");
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0].title, "Example Docs");
	assert.equal(r.results[0].url, "https://www.example.com/docs");
	assert.equal(r.results[0].snippet, "first excerpt second excerpt");
	assert.equal(r.results[0].domain, "example.com");
});

test("searchParallel truncates the snippet to 300 chars", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [
				{ url: "https://a.example/", title: "A", excerpts: ["x".repeat(500)] },
			],
		}),
	);
	const r = await searchParallel("q");
	assert.equal(r.results[0].snippet.length, 300);
});

test("searchParallel filters results without title or url", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [
				{ url: "https://a.example/", title: "A", excerpts: [] },
				{ url: "", title: "no url", excerpts: [] },
				{ url: "https://b.example/", title: "", excerpts: [] },
				{},
			],
		}),
	);
	const r = await searchParallel("q");
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0].url, "https://a.example/");
});

test("searchParallel honors maxResults", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: Array.from({ length: 10 }, (_, i) => ({
				url: `https://${i}.example/`,
				title: `R${i}`,
				excerpts: [],
			})),
		}),
	);
	const r = await searchParallel("q", { maxResults: 3 });
	assert.equal(r.results.length, 3);
});

test("searchParallel treats a non-ok response as empty results", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() => jsonResponse(500, { error: "boom" }));
	const r = await searchParallel("q");
	assert.deepEqual(r.results, []);
	assert.equal(typeof r.latencyMs, "number");
});

test("searchParallel treats a body without a results array as empty", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() => jsonResponse(200, { unexpected: true }));
	const r = await searchParallel("q");
	assert.deepEqual(r.results, []);
});

test("searchParallel degrades to empty results on a network error", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() => {
		throw new Error("connection reset");
	});
	const r = await searchParallel("q");
	assert.deepEqual(r.results, []);
});

// ─── Rate-limit cooldown ────────────────────────────────────────────

test("a 429 search response enters a cooldown and skips the next search", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let calls = 0;
	mockFetch(() => {
		calls += 1;
		return jsonResponse(429, { retry_after: 300 });
	});
	const first = await searchParallel("q");
	assert.deepEqual(first.results, []);
	assert.equal(isParallelRateLimited(), true);
	const second = await searchParallel("q");
	assert.deepEqual(second.results, []);
	assert.equal(calls, 1, "second search must be skipped during cooldown");
	assert.equal(second.latencyMs, 0);
	resetParallelRateLimit();
	assert.equal(isParallelRateLimited(), false);
});

test("a 429 extract response enters a cooldown and skips the next extract", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let calls = 0;
	mockFetch(() => {
		calls += 1;
		return jsonResponse(429, {});
	});
	assert.equal(await fetchParallel(["https://a.example/"]), null);
	assert.equal(await fetchParallel(["https://a.example/"]), null);
	assert.equal(calls, 1, "second extract must be skipped during cooldown");
});

test("searchParallel uses the default 600s cooldown when retry_after is absent", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() => jsonResponse(429, {}));
	await searchParallel("q");
	assert.equal(isParallelRateLimited(), true);
});

// ─── Extract API ────────────────────────────────────────────────────

test("fetchParallel returns null without an API key and never fetches", async () => {
	const calls = mockFetch(() => jsonResponse(200, { results: [] }));
	assert.equal(await fetchParallel(["https://a.example/"]), null);
	assert.equal(calls.length, 0);
});

test("fetchParallel requests full content via advanced_settings", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let captured;
	mockFetch(async (url, init) => {
		captured = { url: String(url), body: JSON.parse(init.body) };
		return jsonResponse(200, { results: [], errors: [] });
	});
	await fetchParallel(["https://a.example/"]);
	assert.equal(captured.url, "https://api.parallel.ai/v1/extract");
	assert.deepEqual(captured.body.urls, ["https://a.example/"]);
	assert.deepEqual(captured.body.advanced_settings, { full_content: true });
});

test("fetchParallel passes max_chars_per_result when given", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let body;
	mockFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return jsonResponse(200, { results: [], errors: [] });
	});
	await fetchParallel(["https://a.example/"], { maxCharsPerResult: 5000 });
	assert.deepEqual(body.advanced_settings, {
		full_content: { max_chars_per_result: 5000 },
	});
});

test("fetchParallel maps full_content, title, and publish_date", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [
				{
					url: "https://a.example/",
					title: "A",
					publish_date: "2026-09-01",
					full_content: "# A\n\nbody",
					excerpts: ["ignored"],
				},
			],
			errors: [],
		}),
	);
	const r = await fetchParallel(["https://a.example/"]);
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0].text, "# A\n\nbody");
	assert.equal(r.results[0].title, "A");
	assert.equal(r.results[0].publishDate, "2026-09-01");
});

test("fetchParallel falls back to joined excerpts when full_content is absent", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [
				{ url: "https://a.example/", title: "A", excerpts: ["one", "two"] },
			],
			errors: [],
		}),
	);
	const r = await fetchParallel(["https://a.example/"]);
	assert.equal(r.results[0].text, "one\n\ntwo");
});

test("fetchParallel drops results with no usable content", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [
				{ url: "https://a.example/", excerpts: [] },
				{ url: "https://b.example/", full_content: "   " },
			],
			errors: [],
		}),
	);
	const r = await fetchParallel(["https://a.example/", "https://b.example/"]);
	assert.deepEqual(r.results, []);
});

test("fetchParallel maps per-URL errors with type and HTTP status", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() =>
		jsonResponse(200, {
			results: [],
			errors: [
				{
					url: "https://a.example/",
					error_type: "fetch_error",
					http_status_code: 403,
					content: null,
				},
			],
		}),
	);
	const r = await fetchParallel(["https://a.example/"]);
	assert.deepEqual(r.results, []);
	assert.deepEqual(r.errors, [
		{ url: "https://a.example/", error: "fetch_error HTTP 403" },
	]);
});

test("fetchParallel truncates URLs to the 20-URL server limit", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	let body;
	mockFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return jsonResponse(200, { results: [], errors: [] });
	});
	const urls = Array.from({ length: 25 }, (_, i) => `https://${i}.example/`);
	await fetchParallel(urls);
	assert.equal(body.urls.length, 20);
});

test("fetchParallel short-circuits an empty URL list", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	const calls = mockFetch(() => jsonResponse(200, { results: [] }));
	const r = await fetchParallel([]);
	assert.deepEqual(r, { results: [], errors: [] });
	assert.equal(calls.length, 0);
});

test("fetchParallel returns null on a non-ok response", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() => jsonResponse(500, { error: "boom" }));
	assert.equal(await fetchParallel(["https://a.example/"]), null);
});

test("fetchParallel returns null on a network error", async () => {
	process.env.PARALLEL_API_KEY = "env-key-value-1";
	mockFetch(() => {
		throw new Error("connection reset");
	});
	assert.equal(await fetchParallel(["https://a.example/"]), null);
});

// ─── Search-engine wiring (src/search.ts) ───────────────────────────

test("parallel is a weighted engine on par with TinyFish", () => {
	assert.equal(ENGINE_WEIGHTS.parallel, 4);
	assert.equal(ENGINE_WEIGHTS.parallel, ENGINE_WEIGHTS.tinyfish);
});

test("buildEngineStatusMap includes a disabled parallel slot", () => {
	const map = buildEngineStatusMap([]);
	assert.deepEqual(map.parallel, { count: 0, status: "disabled", latencyMs: 0 });
});

// ─── Tool surface ───────────────────────────────────────────────────

test("aio-webfetch exposes a parallel parameter", () => {
	const params = TOOL_METADATA["aio-webfetch"].parameters;
	assert.ok(params.properties.parallel, "parallel param missing");
	assert.match(params.properties.parallel.description, /PARALLEL_API_KEY/);
});
