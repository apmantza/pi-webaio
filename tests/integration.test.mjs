import assert from "node:assert";
import test from "node:test";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { fetch as wreqFetch } from "wreq-js";

// NOTE: These tests hit real network endpoints.
// They may be slow or flaky depending on network conditions.
// Run with: node tests/integration.test.mjs
//
// External services sometimes block CI/datacenter IPs (401/403), rate-limit (429),
// or are transiently unavailable (5xx / network errors). Those are environment
// issues, not code defects, so `fetchOrSkip` turns them into a SKIP instead of
// hard-failing the gating suite. When a service IS reachable, the real
// assertions below still run unchanged.

const TIMEOUT = 30000;

// Statuses that indicate "the external service refused/us" rather than a bug in
// our code. 404 is deliberately NOT here — a 404 on an endpoint we expect to
// exist is a real signal and should still fail.
const SKIP_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);

async function fetchOrSkip(t, label, url, opts) {
	let res;
	try {
		res = await wreqFetch(url, opts);
	} catch (err) {
		const msg = String(err?.message || err).split("\n")[0].slice(0, 100);
		t.skip(`${label}: network error (${msg}) — skipping live check`);
		return null;
	}
	if (res && SKIP_STATUSES.has(res.status)) {
		t.skip(
			`${label}: external service returned ${res.status} — skipping live check`,
		);
		return null;
	}
	return res;
}

test("wreq-js can fetch example.com", { timeout: TIMEOUT }, async (t) => {
	const res = await fetchOrSkip(t, "example.com", "https://example.com", {
		browser: "chrome_145",
		os: "windows",
	});
	if (!res) return;
	assert.strictEqual(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("Example Domain"));
});

test("wreq-js can fetch DuckDuckGo HTML", { timeout: TIMEOUT }, async (t) => {
	const res = await fetchOrSkip(
		t,
		"DuckDuckGo",
		"https://html.duckduckgo.com/html/?q=typescript",
		{
			headers: {
				Accept: "text/html",
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
		},
	);
	if (!res) return;
	assert.strictEqual(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("result") || text.includes("duckduckgo"));
});

test("Jina AI reader returns markdown", { timeout: TIMEOUT }, async (t) => {
	const res = await fetchOrSkip(
		t,
		"Jina AI reader",
		`https://r.jina.ai/${encodeURIComponent("https://example.com")}`,
	);
	if (!res) return;
	assert.strictEqual(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("Example Domain") || text.length > 50);
});

test("Readability extracts article text", { timeout: TIMEOUT }, async (t) => {
	const res = await fetchOrSkip(
		t,
		"example.com (readability)",
		"https://example.com",
		{
			browser: "chrome_145",
			os: "windows",
		},
	);
	if (!res) return;
	const html = await res.text();
	const { document } = parseHTML(html);
	const reader = new Readability(document);
	const article = reader.parse();
	assert.ok(article);
	assert.ok(article.title);
	assert.ok(article.textContent.length > 50);
});

test("pdf-parse extracts text from dummy PDF", {
	timeout: TIMEOUT,
}, async (t) => {
	const res = await fetchOrSkip(
		t,
		"w3.org dummy PDF",
		"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
	);
	if (!res) return;
	assert.strictEqual(res.status, 200);
	const buf = Buffer.from(await res.arrayBuffer());
	assert.ok(buf.length > 0);

	const { loadPdfParseCtor } = await import("../src/types.ts");
	const PDFParse = await loadPdfParseCtor();
	const parser = new PDFParse({ data: new Uint8Array(buf) });

	await parser.load();
	const data = await parser.getText();
	assert.ok(data.text.includes("Dummy PDF file"));
	assert.strictEqual(data.total, 1);
});
