/**
 * Unit tests for the 4 new features:
 *   1. Request Queue
 *   2. Browser Pool  (light — skips Playwright-dependent tests)
 *   3. Session Router
 *   4. Adaptive Selector
 */

import assert from "node:assert";
import test from "node:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Import new modules (Node 24 strips .ts types natively) ─────────

import { RequestQueue, hasQueueFile } from "../src/request-queue.ts";
import { SessionRouter, parseRoutes } from "../src/session-router.ts";
import { captureFingerprint, locateByFingerprint } from "../src/adaptive-selector.ts";
import { parseHTML } from "linkedom";

// ═════════════════════════════════════════════════════════════════════
// 1. REQUEST QUEUE
// ═════════════════════════════════════════════════════════════════════

test("RequestQueue.create creates empty queue", async () => {
	const dir = join(tmpdir(), `rq-test-create-${Date.now()}`);
	const q = await RequestQueue.create(dir);
	assert.ok(q);
	assert.deepStrictEqual(q.stats(), { queued: 0, inProgress: 0, completed: 0, failed: 0, total: 0 });
	assert.strictEqual(q.isDone(), true);
	await q.close();
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue.add and next", async () => {
	const dir = join(tmpdir(), `rq-test-add-${Date.now()}`);
	const q = await RequestQueue.create(dir);
	await q.add(["https://a.com", "https://b.com", "https://c.com"]);

	const stats = q.stats();
	assert.strictEqual(stats.queued, 3);
	assert.strictEqual(stats.total, 3);
	assert.strictEqual(q.isDone(), false);

	// Dequeue one
	const url1 = await q.next();
	assert.strictEqual(url1, "https://a.com");
	assert.strictEqual(q.stats().inProgress, 1);

	// Dequeue remaining
	const url2 = await q.next();
	const url3 = await q.next();
	assert.strictEqual(url2, "https://b.com");
	assert.strictEqual(url3, "https://c.com");

	// All dequeued
	assert.strictEqual(await q.next(), null);

	await q.close();
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue.complete and fail transitions", async () => {
	const dir = join(tmpdir(), `rq-test-trans-${Date.now()}`);
	const q = await RequestQueue.create(dir);
	await q.add(["https://a.com", "https://b.com"]);

	const a = await q.next();
	assert.strictEqual(a, "https://a.com");
	await q.complete("https://a.com");

	const b = await q.next();
	assert.strictEqual(b, "https://b.com");
	const willRetry = await q.fail("https://b.com", "404 Not Found");

	// First failure → retry (queued again)
	assert.strictEqual(willRetry, true);
	assert.strictEqual(q.stats().queued, 1);
	assert.strictEqual(q.stats().failed, 0);

	// Consume it again, then fail 3 times to exhaust retries
	await q.next(); // b back to in_progress
	await q.fail("https://b.com", "404"); // retry 2
	await q.next(); // b again
	await q.fail("https://b.com", "404"); // retry 3 — exhausted
	assert.strictEqual(q.stats().failed, 1);
	assert.strictEqual(q.stats().completed, 1);
	assert.strictEqual(q.isDone(), true);

	await q.close();
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue persistence and resume", async () => {
	const dir = join(tmpdir(), `rq-test-persist-${Date.now()}`);
	const q = await RequestQueue.create(dir);
	await q.add(["https://a.com", "https://b.com", "https://c.com"]);

	// Simulate partial progress
	await q.next(); // a → in_progress
	await q.complete("https://a.com");
	await q.next(); // b → in_progress

	await q.close(); // flush to disk

	// Resume
	const resumed = await RequestQueue.resume(dir);
	assert.ok(resumed);
	const stats = resumed.stats();
	assert.strictEqual(stats.completed, 1); // a is done
	// b was in_progress → reset to queued
	assert.strictEqual(stats.queued + stats.inProgress, 2);
	assert.strictEqual(stats.total, 3);

	// Scan for .md files — none yet, so no extra completed
	const nextUrl = await resumed.next();
	assert.ok(nextUrl); // b or c

	await resumed.close();
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue can requeue completed entries whose output is missing", async () => {
	const dir = join(tmpdir(), `rq-test-missing-output-${Date.now()}`);
	const q = await RequestQueue.create(dir);
	await q.add(["https://example.com/missing"]);
	await q.next();
	await q.complete("https://example.com/missing");
	await q.close();

	const resumed = await RequestQueue.resume(dir);
	assert.ok(resumed);
	assert.strictEqual(await resumed.requeueCompletedMissingFiles(), 1);
	assert.strictEqual(await resumed.next(), "https://example.com/missing");

	await resumed.close();
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue resume detects existing .md files", async () => {
	const dir = join(tmpdir(), `rq-test-mdscan-${Date.now()}`);
	await mkdir(dir, { recursive: true });

	// Write a fake markdown file with frontmatter URL
	await writeFile(
		join(dir, "page-a.md"),
		"---\ntitle: \"Page A\"\nurl: \"https://example.com/page-a\"\n---\n\nContent here",
		"utf8",
	);

	// Create queue with that URL
	const q = await RequestQueue.create(dir);
	await q.add(["https://example.com/page-a", "https://example.com/page-b"]);
	await q.close();

	// Resume should detect page-a.md as completed
	const resumed = await RequestQueue.resume(dir);
	assert.ok(resumed);
	assert.strictEqual(resumed.stats().completed, 1);
	assert.strictEqual(resumed.stats().queued, 1); // page-b still queued

	await resumed.close();
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue resume marks a backfilled seed completed when its file exists", async () => {
	const dir = join(tmpdir(), `rq-test-seed-resume-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "page-seed.md"),
		"---\ntitle: \"Seed\"\nurl: \"https://example.com/seed.json\"\n---\n\nContent here",
		"utf8",
	);

	const q = await RequestQueue.create(dir);
	await q.add(["https://example.com/other"]);
	await q.close();

	const resumed = await RequestQueue.resume(dir);
	assert.ok(resumed);
	await resumed.addPreservingCompletedFiles([
		"https://example.com/seed.json?view=full#section",
	]);
	assert.strictEqual(resumed.stats().completed, 1);
	assert.strictEqual(resumed.stats().queued, 1);
	assert.strictEqual(await resumed.next(), "https://example.com/other");

	await resumed.close();
	await rm(dir, { recursive: true, force: true });
});

test("hasQueueFile detects queue", async () => {
	const dir = join(tmpdir(), `rq-test-hqf-${Date.now()}`);
	assert.strictEqual(hasQueueFile(dir), false);
	const q = await RequestQueue.create(dir);
	await q.add(["https://a.com"]);
	await q.close();
	assert.strictEqual(hasQueueFile(dir), true);
	await rm(dir, { recursive: true, force: true });
});

test("RequestQueue.getInProgress returns in-progress URLs", async () => {
	const dir = join(tmpdir(), `rq-test-ip-${Date.now()}`);
	const q = await RequestQueue.create(dir);
	await q.add(["https://a.com", "https://b.com"]);
	await q.next(); // a → in_progress
	const ip = q.getInProgress();
	assert.deepStrictEqual(ip, ["https://a.com"]);
	await q.close();
	await rm(dir, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════
// 2. SESSION ROUTER
// ═════════════════════════════════════════════════════════════════════

test("SessionRouter substring matching", () => {
	const router = new SessionRouter([
		{ pattern: "/api/", mode: "fast" },
		{ pattern: "/docs/", mode: "fingerprint" },
	]);

	let match = router.match("https://example.com/api/users");
	assert.ok(match);
	assert.strictEqual(match.mode, "fast");
	assert.strictEqual(match.extractor, undefined);

	match = router.match("https://example.com/docs/guide");
	assert.ok(match);
	assert.strictEqual(match.mode, "fingerprint");

	// No match → null
	match = router.match("https://example.com/blog");
	assert.strictEqual(match, null);
});

test("SessionRouter glob matching", () => {
	const router = new SessionRouter([
		{ pattern: "*/protected/*", mode: "browser" },
		{ pattern: "*/public/*", mode: "fast" },
	]);

	let match = router.match("https://example.com/protected/dashboard");
	assert.ok(match);
	assert.strictEqual(match.mode, "browser");

	match = router.match("https://example.com/public/landing");
	assert.ok(match);
	assert.strictEqual(match.mode, "fast");

	// No match
	match = router.match("https://example.com/other/page");
	assert.strictEqual(match, null);
});

test("SessionRouter regex matching", () => {
	const router = new SessionRouter([
		{ pattern: "/^\\/api\\/v\\d+/", mode: "fast" },
	]);

	let match = router.match("https://example.com/api/v2/users");
	assert.ok(match);
	assert.strictEqual(match.mode, "fast");

	match = router.match("https://example.com/api/v1/products");
	assert.ok(match);

	// No match
	match = router.match("https://example.com/api/legacy");
	assert.strictEqual(match, null);
});

test("SessionRouter first match wins", () => {
	const router = new SessionRouter([
		{ pattern: "/api/", mode: "fast" },
		{ pattern: "/api/v2/", mode: "browser" }, // more specific but later
	]);

	// First match is /api/ (less specific but earlier)
	const match = router.match("https://example.com/api/v2/users");
	assert.ok(match);
	assert.strictEqual(match.mode, "fast");
});

test("SessionRouter route ordering", () => {
	const router = new SessionRouter();
	router.add({ pattern: "/api/v2/", mode: "browser" });
	router.add({ pattern: "/api/", mode: "fast" });

	// Now /api/v2/ is first and wins over /api/
	const match = router.match("https://example.com/api/v2/users");
	assert.ok(match);
	assert.strictEqual(match.mode, "browser");
});

test("SessionRouter per-route overrides", () => {
	const router = new SessionRouter([
		{ pattern: "/api/", mode: "fast", browser: "firefox_147", extractor: "npm" },
	]);

	const match = router.match("https://example.com/api/packages");
	assert.ok(match);
	assert.strictEqual(match.mode, "fast");
	assert.strictEqual(match.browser, "firefox_147");
	assert.strictEqual(match.extractor, "npm");
	assert.strictEqual(match.os, undefined);
});

test("parseRoutes from Route objects", () => {
	const routes = parseRoutes([
		{ pattern: "/api/", mode: "fast" },
		{ pattern: "/docs/", mode: "browser", extractor: "wikipedia" },
	]);
	assert.strictEqual(routes.length, 2);
	assert.strictEqual(routes[0].pattern, "/api/");
	assert.strictEqual(routes[0].mode, "fast");
	assert.strictEqual(routes[1].extractor, "wikipedia");
});

test("parseRoutes from string JSON", () => {
	const routes = parseRoutes('[{"pattern":"/api/","mode":"fast"}]');
	assert.strictEqual(routes.length, 1);
	assert.strictEqual(routes[0].pattern, "/api/");
	assert.strictEqual(routes[0].mode, "fast");
});

test("parseRoutes from arrow syntax", () => {
	const routes = parseRoutes(["/api/ -> fast", "/docs/ -> browser"]);
	assert.strictEqual(routes.length, 2);
	assert.strictEqual(routes[0].pattern, "/api/");
	assert.strictEqual(routes[0].mode, "fast");
});

test("parseRoutes from whitespace syntax", () => {
	const routes = parseRoutes(["/api/ fast", "/docs/ browser"]);
	assert.strictEqual(routes.length, 2);
	assert.strictEqual(routes[0].pattern, "/api/");
	assert.strictEqual(routes[0].mode, "fast");
});

test("parseRoutes handles empty/null/undefined", () => {
	assert.deepStrictEqual(parseRoutes(null), []);
	assert.deepStrictEqual(parseRoutes(undefined), []);
	assert.deepStrictEqual(parseRoutes([]), []);
	assert.deepStrictEqual(parseRoutes(""), []);
});

// ═════════════════════════════════════════════════════════════════════
// 3. ADAPTIVE SELECTOR
// ═════════════════════════════════════════════════════════════════════

/**
 * Create a simple DOM from HTML using linkedom.
 */
function makeDoc(html) {
	const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
	return document;
}

/**
 * Find an element by CSS selector in a linkedom document.
 */
function $(doc, sel) {
	return doc.querySelector(sel);
}

test("captureFingerprint captures tag path", () => {
	const doc = makeDoc(`<main><article class="content"><p>Hello</p></article></main>`);
	const el = $(doc, "article");
	assert.ok(el);

	const fp = captureFingerprint(el);
	assert.ok(fp.tagPath.length >= 2);
	assert.ok(fp.tagPath.includes("article"));
	assert.strictEqual(fp.depth, fp.tagPath.length);
	assert.ok(fp.textDensity > 0);
});

test("captureFingerprint captures text density", () => {
	const doc = makeDoc(`<div class="content"><p>Hello world</p><p>More text</p></div>`);
	const el = $(doc, "div");
	const fp = captureFingerprint(el);
	// innerHTML is longer than textContent, so density < 1
	assert.ok(fp.textDensity > 0);
	assert.ok(fp.textDensity < 1);
});

test("captureFingerprint captures child tag signature", () => {
	const doc = makeDoc(`<div><p>A</p><p>B</p><a href="#">Link</a><p>C</p></div>`);
	const el = $(doc, "div");
	const fp = captureFingerprint(el);
	assert.ok(fp.childTagSignature.includes("p:3"));
	assert.ok(fp.childTagSignature.includes("a:1"));
});

test("captureFingerprint captures attributes", () => {
	const doc = makeDoc(`<main id="content" class="post-content" role="main"><p>Text</p></main>`);
	const el = $(doc, "main");
	const fp = captureFingerprint(el);
	assert.strictEqual(fp.attributes.id, "content");
	assert.strictEqual(fp.attributes.class, "post-content");
	assert.strictEqual(fp.attributes.role, "main");
});

test("captureFingerprint captures sibling position", () => {
	const doc = makeDoc(`<div><p>First</p><p>Second</p><p>Third</p></div>`);
	const paragraphs = doc.querySelectorAll("p");
	// linkedom's querySelectorAll returns an array-like
	const secondP = paragraphs[1];
	if (secondP) {
		const fp = captureFingerprint(secondP);
		assert.strictEqual(fp.siblingIndex, 1);
		assert.strictEqual(fp.siblingCount, 3);
	}
});

test("locateByFingerprint finds exact match by tag path", () => {
	const doc = makeDoc(`<div><main><article class="post"><p>Content</p></article></main></div>`);
	const el = $(doc, "article");
	const fp = captureFingerprint(el);

	// Same structure — should find it
	const result = locateByFingerprint(doc, fp);
	assert.ok(result, "Should locate by fingerprint");
	assert.ok(result.score >= 0.8, `Score should be high, got ${result.score}`);
});

test("locateByFingerprint survives class name change", () => {
	const doc = makeDoc(`<div><main><article class="post"><p>Content</p></article></main></div>`);
	const el = $(doc, "article");
	const fp = captureFingerprint(el);

	// Change the class name
	const doc2 = makeDoc(`<div><main><article class="new-class-name"><p>Content</p></article></main></div>`);
	const result = locateByFingerprint(doc2, fp);
	assert.ok(result, "Should still find element after class change");
	assert.ok(result.score >= 0.5, `Score should be reasonable, got ${result.score}`);
});

test("locateByFingerprint survives tag ID change", () => {
	const doc = makeDoc(`<div><article id="post-123"><p>Content</p></article></div>`);
	const el = $(doc, "article");
	const fp = captureFingerprint(el);

	// Change the id
	const doc2 = makeDoc(`<div><article id="post-456"><p>Content</p></article></div>`);
	const result = locateByFingerprint(doc2, fp);
	assert.ok(result, "Should still find element after id change");
	assert.ok(result.score >= 0.5);
});

test("locateByFingerprint prefers structurally similar elements", () => {
	const doc = makeDoc(`<div><section><p>Section content</p></section><article><p>Article content</p><ul><li>Item</li></ul></article></div>`);
	const el = $(doc, "article");
	const fp = captureFingerprint(el);

	// Create a doc with two candidates — article should match better than section
	const doc2 = makeDoc(`<div><section><p>Different</p></section><article><p>Same structure</p><ul><li>Item</li></ul></article></div>`);
	const result = locateByFingerprint(doc2, fp);
	assert.ok(result, "Should find an element");
	if (result && result.element) {
		assert.strictEqual(result.element.tagName?.toLowerCase(), "article",
			"Should prefer article over section due to tag path match");
	}
});

test("locateByFingerprint returns null for very different structure", () => {
	const doc = makeDoc(`<article class="post"><p>Content</p></article>`);
	const el = $(doc, "article");
	const fp = captureFingerprint(el);

	// Completely different document
	const doc2 = makeDoc(`<nav><ul><li><a href="#">Menu</a></li></ul></nav>`);
	const result = locateByFingerprint(doc2, fp, 0.6); // high threshold
	assert.strictEqual(result, null, "Should not match completely different structure");
});

// ═════════════════════════════════════════════════════════════════════
// 4. BROWSER POOL — light tests only (no Playwright in CI)
// ═════════════════════════════════════════════════════════════════════

test("BrowserPool constructor and stats", async () => {
	const { BrowserPool } = await import("../src/browser-pool.ts");
	const pool = new BrowserPool({ maxBrowsers: 2, maxPagesPerBrowser: 10 });
	assert.ok(pool);
	assert.strictEqual(pool.closed, false);
	const stats = pool.stats();
	assert.strictEqual(stats.browsers, 0);
	assert.strictEqual(stats.totalLaunched, 0);
	assert.strictEqual(stats.crashes, 0);
	await pool.drain();
	assert.strictEqual(pool.closed, true);
});

test("BrowserPool drain on empty pool", async () => {
	const { BrowserPool } = await import("../src/browser-pool.ts");
	const pool = new BrowserPool();
	await pool.drain(); // should not throw
	assert.strictEqual(pool.closed, true);
});

test("BrowserPool closed flag behavior", async () => {
	const { BrowserPool } = await import("../src/browser-pool.ts");
	const pool = new BrowserPool();
	await pool.drain();
	try {
		await pool.acquirePage();
		assert.fail("Should have thrown");
	} catch (err) {
		assert.ok(err.message.includes("closed"));
	}
});
