import assert from "node:assert";
import test from "node:test";
import {
	extractDdgUrl,
	extractRSC,
	frontmatter,
	isLocalOrPrivateUrl,
	parseGitHubUrl,
} from "./lib.mjs";

// ─── isLocalOrPrivateUrl ───────────────────────────────────────────

test("isLocalOrPrivateUrl detects localhost", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://localhost:3000"), true);
	assert.strictEqual(isLocalOrPrivateUrl("http://localhost"), true);
});

test("isLocalOrPrivateUrl detects 127.0.0.1", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://127.0.0.1"), true);
	assert.strictEqual(isLocalOrPrivateUrl("https://127.0.0.1:8080"), true);
});

test("isLocalOrPrivateUrl detects ::1", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://[::1]"), true);
});

test("isLocalOrPrivateUrl detects .local", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://myhost.local"), true);
});

test("isLocalOrPrivateUrl detects 192.168.x.x", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://192.168.1.1"), true);
	assert.strictEqual(isLocalOrPrivateUrl("http://192.168.0.100"), true);
});

test("isLocalOrPrivateUrl detects 10.x.x.x", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://10.0.0.1"), true);
	assert.strictEqual(isLocalOrPrivateUrl("http://10.255.255.255"), true);
});

test("isLocalOrPrivateUrl detects 172.16-31.x.x", () => {
	assert.strictEqual(isLocalOrPrivateUrl("http://172.16.0.1"), true);
	assert.strictEqual(isLocalOrPrivateUrl("http://172.31.255.255"), true);
	assert.strictEqual(isLocalOrPrivateUrl("http://172.15.0.1"), false);
	assert.strictEqual(isLocalOrPrivateUrl("http://172.32.0.1"), false);
});

test("isLocalOrPrivateUrl rejects public URLs", () => {
	assert.strictEqual(isLocalOrPrivateUrl("https://example.com"), false);
	assert.strictEqual(isLocalOrPrivateUrl("https://github.com"), false);
	assert.strictEqual(isLocalOrPrivateUrl("https://192.167.1.1"), false);
});

// ─── parseGitHubUrl ────────────────────────────────────────────────

test("parseGitHubUrl parses root repo URL", () => {
	const r = parseGitHubUrl("https://github.com/owner/repo");
	assert.deepStrictEqual(r, { owner: "owner", repo: "repo", type: "repo" });
});

test("parseGitHubUrl parses blob URL", () => {
	const r = parseGitHubUrl(
		"https://github.com/owner/repo/blob/main/src/index.ts",
	);
	assert.deepStrictEqual(r, {
		owner: "owner",
		repo: "repo",
		ref: "main",
		path: "src/index.ts",
		type: "blob",
	});
});

test("parseGitHubUrl parses tree URL", () => {
	const r = parseGitHubUrl("https://github.com/owner/repo/tree/dev/docs");
	assert.deepStrictEqual(r, {
		owner: "owner",
		repo: "repo",
		ref: "dev",
		path: "docs",
		type: "tree",
	});
});

test("parseGitHubUrl returns null for non-GitHub URLs", () => {
	assert.strictEqual(parseGitHubUrl("https://example.com"), null);
});

// ─── frontmatter ───────────────────────────────────────────────────

test("frontmatter generates YAML frontmatter", () => {
	const fm = frontmatter("My Title", "https://example.com");
	assert.ok(fm.includes('title: "My Title"'));
	assert.ok(fm.includes('url: "https://example.com"'));
});

test("frontmatter escapes quotes in title", () => {
	const fm = frontmatter('Say "Hello"', "https://example.com");
	assert.ok(fm.includes('title: "Say \\"Hello\\""'));
});

// ─── extractRSC ────────────────────────────────────────────────────

test("extractRSC extracts Next.js flight data", () => {
	const html =
		'<script>self.__next_f.push([1, "This is some readable content from a Next.js application that should be extracted"])</script>';
	const rsc = extractRSC(html);
	assert.ok(rsc);
	assert.ok(rsc.includes("readable content"));
});

test("extractRSC returns null when no flight data", () => {
	assert.strictEqual(extractRSC("<html><body>Hello</body></html>"), null);
});

// ─── extractDdgUrl ─────────────────────────────────────────────────

test("extractDdgUrl unwraps DuckDuckGo redirect", () => {
	const encoded = encodeURIComponent("https://example.com/article");
	const href = `//duckduckgo.com/l/?uddg=${encoded}`;
	assert.strictEqual(extractDdgUrl(href), "https://example.com/article");
});

test("extractDdgUrl passes through plain URLs", () => {
	assert.strictEqual(
		extractDdgUrl("https://example.com"),
		"https://example.com",
	);
});
