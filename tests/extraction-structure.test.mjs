// ─── Extraction structure regression (issue #165, cluster A: F2 / F3 / F11) ───
//
// The dominant extraction rung (Readability) used to return
// `article.textContent`, which destroys every block boundary: headings vanish,
// adjacent paragraphs are glued into one run-on sentence, and heading anchor
// permalinks (`#`) are inlined into the text. Because that plain-text body is
// what `outline`, `budgetTokens`, `prune`, answer mode and `aio-webresearch`
// all consume, the degradation is silent and system-wide.
//
// Recurrence each test prevents:
//  - F2  — "outline:true returns 1 bogus section on a page with 40 headings"
//          (live: docs.python.org/3/library/subprocess.html).
//  - F11 — "…single executable.After installation, verify…" glued text
//          (live: bun.com/docs/installation).
//  - F3  — a `# comment` line inside a code sample becoming the document's
//          only H1 (live: the CPython docs line `# becomes`).
//
// Everything here is offline: pages are fed as HTML strings through the real
// `runHtmlPipeline`, and the Jina transport is stubbed so no network is touched
// (same convention as tests/perf-extraction.test.mjs).
import assert from "node:assert";
import test, { afterEach } from "node:test";
import { runHtmlPipeline, articleHtmlToMarkdown, chooseArticleBody } from "../src/content.ts";
import { extractOutline } from "../src/outline.ts";
import { __setJinaTransportForTests } from "../src/fetch-jina.ts";

const URL_OK = "http://93.184.216.34/structured.html"; // public IP literal: no DNS

function page(body) {
	return `<!DOCTYPE html><html><head><title>Doc</title></head><body><article>${body}</article></body></html>`;
}

const LOREM =
	"Continuous integration is a software engineering practice where developers " +
	"merge their changes into a shared branch frequently and verify them with an " +
	"automated build and an automated test cycle that fails the build quickly. ";

// A docs-shaped article: three headings, one list, one fenced code block, and
// enough prose that Readability accepts it (well over MIN_LOCAL_WORDS).
function docsArticle() {
	const para = `<p>${LOREM.repeat(3)}</p>`;
	return page(`
		<h1>Getting Started<a class="anchor" href="#getting-started">#</a></h1>
		${para}
		<h2>Installing<a class="anchor" href="#installing">#</a></h2>
		${para}
		<ul><li>install the package</li><li>initialise the config file</li></ul>
		<h2>Configuration<a class="anchor" href="#configuration">#</a></h2>
		${para}
		<pre><code># becomes
	config = load("app.yaml")
	# reload on change
	watch(config)</code></pre>
		<p>${LOREM.repeat(2)}</p>
	`);
}

// A two-paragraph article whose sentences must stay separate.
function glueArticle() {
	return page(`
		<h2>Overview<a href="#overview">#</a></h2>
		<p>Bun ships as a single executable.</p>
		<p>After installation, verify with bun --version.</p>
		<p>Linux users need the unzip package.</p>
		${`<p>${LOREM}</p>`.repeat(4)}
	`);
}

afterEach(() => __setJinaTransportForTests(null));

test("F2: a docs-shaped page yields a real heading outline, not a flat document", async () => {
	const r = await runHtmlPipeline(docsArticle(), URL_OK, URL_OK, undefined, undefined);
	assert.equal(r.ok, true);

	const outline = extractOutline(r.content);
	const texts = outline.headings.map((h) => h.text.toLowerCase());

	assert.ok(
		outline.headings.length >= 3,
		`expected >=3 headings, got ${outline.headings.length}: ${JSON.stringify(texts)}`,
	);
	for (const want of ["getting started", "installing", "configuration"]) {
		assert.ok(
			texts.some((t) => t.includes(want)),
			`heading "${want}" missing from outline: ${JSON.stringify(texts)}`,
		);
	}
	// The heading anchor permalink must not be glued into the heading text.
	assert.ok(
		!texts.some((t) => /#\s*$/.test(t) || t.includes("#getting")),
		`anchor '#' leaked into heading text: ${JSON.stringify(texts)}`,
	);
});

test("F11: adjacent block elements are not glued into one run-on sentence", async () => {
	const r = await runHtmlPipeline(glueArticle(), URL_OK, URL_OK, undefined, undefined);
	const content = r.content;

	// The exact defect shape: `<p>A.</p><p>B.</p>` collapsing to "A.B."
	assert.ok(
		!/executable\.After/i.test(content),
		"sentence boundary lost between paragraphs (textContent glue)",
	);
	assert.ok(
		/ships as a single executable\.\s*\n\s*\n?.*After installation/i.test(content),
		`expected the two sentences to be separated, got: ${JSON.stringify(content.slice(0, 240))}`,
	);
	// Heading must sit on its own line, not run into the following paragraph.
	assert.ok(
		/^#+\s*Overview\s*$/m.test(content),
		`"Overview" is not a standalone heading line: ${JSON.stringify(content.slice(0, 240))}`,
	);
});

test("F3: a `#` comment inside a code block is not read as a heading", async () => {
	const r = await runHtmlPipeline(docsArticle(), URL_OK, URL_OK, undefined, undefined);
	const outline = extractOutline(r.content);
	const texts = outline.headings.map((h) => h.text.trim().toLowerCase());

	assert.ok(
		!texts.includes("becomes"),
		`code comment became a heading: ${JSON.stringify(texts)}`,
	);
	// The code must still be present, and fenced so outline's fence tracker protects it.
	assert.ok(/config\s*=\s*load\(/.test(r.content), "code sample was dropped");
	assert.ok(/```|~~~/.test(r.content), "code block was not fenced");
});

test("no regression: the structured body keeps at least as much text as the flat one", async () => {
	const r = await runHtmlPipeline(docsArticle(), URL_OK, URL_OK, undefined, undefined);
	// Every word of the source prose must survive serialization.
	for (const needle of [
		"Continuous integration",
		"automated test cycle",
		"install the package",
		"initialise the config file",
	]) {
		assert.ok(r.content.includes(needle), `body lost text: ${needle}`);
	}
	// List items must be list items, not prose.
	assert.match(r.content, /^\s*[-*]\s+install the package/m);
});

test("articleHtmlToMarkdown returns null for unusable input instead of throwing", async () => {
	assert.equal(await articleHtmlToMarkdown("", URL_OK), null);
	assert.equal(await articleHtmlToMarkdown("   ", URL_OK), null);
});

test("chooseArticleBody keeps the flat body when markdown would lose content", () => {
	const flat = "one two three four five six seven eight nine ten";
	// Structured pass produced almost nothing -> the flat body must win.
	assert.equal(chooseArticleBody("one two", flat), flat);
	// Structured pass retained the prose -> structure wins.
	assert.equal(chooseArticleBody("# H\n\n" + flat, flat), "# H\n\n" + flat);
	// No structured body at all -> flat body.
	assert.equal(chooseArticleBody(null, flat), flat);
});
