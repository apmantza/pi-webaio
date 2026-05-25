import assert from "node:assert";
import test from "node:test";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { fetch as wreqFetch } from "wreq-js";

// NOTE: These tests hit real network endpoints.
// They may be slow or flaky depending on network conditions.
// Run with: node tests/integration.test.mjs

const TIMEOUT = 30000;

test("wreq-js can fetch example.com", { timeout: TIMEOUT }, async () => {
	const res = await wreqFetch("https://example.com", {
		browser: "chrome_145",
		os: "windows",
	});
	assert.strictEqual(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("Example Domain"));
});

test("wreq-js can fetch DuckDuckGo HTML", { timeout: TIMEOUT }, async () => {
	const res = await wreqFetch(
		"https://html.duckduckgo.com/html/?q=typescript",
		{
			headers: {
				Accept: "text/html",
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
		},
	);
	assert.strictEqual(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("result") || text.includes("duckduckgo"));
});

test("Jina AI reader returns markdown", { timeout: TIMEOUT }, async () => {
	const res = await wreqFetch(
		`https://r.jina.ai/${encodeURIComponent("https://example.com")}`,
	);
	assert.strictEqual(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("Example Domain") || text.length > 50);
});

test("Readability extracts article text", { timeout: TIMEOUT }, async () => {
	const res = await wreqFetch("https://example.com", {
		browser: "chrome_145",
		os: "windows",
	});
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
}, async () => {
	const res = await wreqFetch(
		"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
	);
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
