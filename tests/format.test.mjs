// ─── Tests for P3: format parameter (markdown | html | text | json | raw) ───

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyFormat,
	FETCH_OUTPUT_FORMATS,
	markdownToText,
} from "../src/tools/render-result.ts";

// ─── markdownToText ─────────────────────────────────────────────────

test("markdownToText: strips headers", () => {
	assert.equal(markdownToText("# Title\n\nBody text"), "Title\n\nBody text");
	assert.equal(markdownToText("## Sub\n\nMore"), "Sub\n\nMore");
});

test("markdownToText: strips bold/italic", () => {
	assert.equal(markdownToText("**bold** and *italic*"), "bold and italic");
	assert.equal(markdownToText("__bold__ and _italic_"), "bold and italic");
	assert.equal(markdownToText("~~strike~~"), "strike");
});

test("markdownToText: strips code spans and fenced code blocks (preserves code content)", () => {
	assert.equal(markdownToText("Use `npm` to install"), "Use npm to install");
	// Code block content is preserved (just the fences + lang stripped).
	assert.equal(
		markdownToText("```js\nconst x = 1;\n```\nAfter"),
		"const x = 1;\nAfter",
	);
});

test("markdownToText: strips link syntax, keeps label", () => {
	assert.equal(
		markdownToText("[click here](https://example.com)"),
		"click here",
	);
	assert.equal(markdownToText("![alt text](image.png)"), "alt text");
});

test("markdownToText: strips list markers and blockquotes", () => {
	const input = `- a\n- b\n- c\n\n1. one\n2. two\n\n> quoted\n> line\n`;
	const out = markdownToText(input);
	assert.equal(out, "a\nb\nc\n\none\ntwo\n\nquoted\nline");
});

test("markdownToText: strips HTML tags", () => {
	assert.equal(
		markdownToText("<span>hello</span> <b>world</b>"),
		"hello world",
	);
});

test("markdownToText: strips nested/overlapping HTML tags in repeated passes", () => {
	// Regression for CodeQL js/incomplete-multi-character-sanitization:
	// a single-pass regex leaves `<script>` when tags are nested.
	assert.equal(markdownToText("<<script>script>alert(1)</script>"), "alert(1)");
	assert.equal(markdownToText("<<b>b>bold</b>"), "bold");
});

test("markdownToText: collapses excessive newlines", () => {
	assert.equal(markdownToText("a\n\n\n\n\nb"), "a\n\nb");
});

test("markdownToText: handles empty input", () => {
	assert.equal(markdownToText(""), "");
});

// ─── FETCH_OUTPUT_FORMATS ───────────────────────────────────────────

test("FETCH_OUTPUT_FORMATS: contains the 5 supported formats", () => {
	for (const f of ["markdown", "html", "text", "json", "raw"]) {
		assert.ok(FETCH_OUTPUT_FORMATS.has(f), `missing ${f}`);
	}
	assert.equal(FETCH_OUTPUT_FORMATS.size, 5);
});

// ─── applyFormat ────────────────────────────────────────────────────

const baseResult = {
	ok: true,
	url: "https://example.com/post",
	title: "Example Post",
	content: "# Title\n\nThis is **bold** text with `code`.",
	rawHtml: "<html><body><h1>Title</h1><p>Body</p></body></html>",
	author: "Alice",
	published: "2026-01-15",
	site: "Example",
	language: "en",
	wordCount: 8,
	mimeType: "text/html",
};

test("applyFormat: markdown returns the input markdown", () => {
	const out = applyFormat(baseResult, "markdown", "# Markdown");
	assert.equal(out.format, "markdown");
	assert.equal(out.body, "# Markdown");
	assert.equal(out.savedToDisk, true);
	assert.equal(out.contentLength, "# Markdown".length);
});

test("applyFormat: html returns rawHtml", () => {
	const out = applyFormat(baseResult, "html", "# Markdown");
	assert.equal(out.format, "html");
	assert.equal(out.body, baseResult.rawHtml);
	assert.equal(out.savedToDisk, false);
	assert.equal(out.contentLength, baseResult.rawHtml.length);
});

test("applyFormat: html falls back to content if rawHtml missing", () => {
	const noHtml = { ...baseResult, rawHtml: undefined };
	const out = applyFormat(noHtml, "html", "# M");
	assert.equal(out.body, baseResult.content);
	assert.equal(out.savedToDisk, false);
});

test("applyFormat: text strips markdown from content", () => {
	const out = applyFormat(baseResult, "text", "# M");
	// Should be: "Title\n\nThis is bold text with code."
	assert.equal(out.format, "text");
	assert.equal(out.body, "Title\n\nThis is bold text with code.");
	assert.equal(out.savedToDisk, false);
});

test("applyFormat: json returns structured object", () => {
	const out = applyFormat(baseResult, "json", "# M");
	assert.equal(out.format, "json");
	assert.equal(out.savedToDisk, false);
	const parsed = JSON.parse(out.body);
	assert.equal(parsed.url, "https://example.com/post");
	assert.equal(parsed.title, "Example Post");
	assert.equal(parsed.author, "Alice");
	assert.equal(parsed.published, "2026-01-15");
	assert.equal(parsed.site, "Example");
	assert.equal(parsed.language, "en");
	assert.equal(parsed.wordCount, 8);
	assert.equal(parsed.mimeType, "text/html");
	assert.equal(parsed.content, baseResult.content);
	assert.equal(parsed.rawHtml, baseResult.rawHtml);
});

test("applyFormat: raw returns rawHtml as body", () => {
	const out = applyFormat(baseResult, "raw", "# M");
	assert.equal(out.format, "raw");
	assert.equal(out.body, baseResult.rawHtml);
	assert.equal(out.savedToDisk, false);
});

test("applyFormat: unknown format defaults to markdown", () => {
	const out = applyFormat(baseResult, "yaml", "# M");
	assert.equal(out.format, "markdown");
	assert.equal(out.body, "# M");
	assert.equal(out.savedToDisk, true);
});

test("applyFormat: undefined format defaults to markdown", () => {
	const out = applyFormat(baseResult, undefined, "# M");
	assert.equal(out.format, "markdown");
	assert.equal(out.body, "# M");
	assert.equal(out.savedToDisk, true);
});
