// ─── arXiv: a PDF request must not be answered with metadata (#165, F9) ───
//
// Two defects, one URL: `aio-webfetch("https://arxiv.org/pdf/2005.11401")`.
//
// 1. `matchesArxiv()` claimed `/pdf/` URLs, so the vertical ran before the
//    binary/PDF path and returned the *abstract page* — authors, "PDF: …pdf",
//    the Abstract section — instead of the PDF text the user asked for. The
//    vertical then lost to the value scorer on its own terms: the Abstract was
//    dropped as low-value while the `> via arxiv` marker line survived.
// 2. Atom responses are XML, and nothing decoded entities, so the title came
//    back as `arXiv Query: search_query=&amp;id_list=2005.11401&amp;…`.
//
// Recurrence prevented: an explicit binary request answered with metadata, and
// raw XML entities in user-visible text.
import assert from "node:assert";
import test from "node:test";
import { matchesArxiv, extractArxiv } from "../src/verticals/arxiv.ts";
import { binarySignature } from "../src/http-text.ts";

// Shape captured from export.arxiv.org/api/query.
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <title>arXiv Query: search_query=&amp;id_list=2005.11401&amp;start=0&amp;max_results=1</title>
  <entry>
    <title>Generative Adversarial Networks &amp; the Future &#8212; a survey</title>
    <id>http://arxiv.org/abs/2005.11401v1</id>
    <published>2020-05-11T00:00:00Z</published>
    <summary>We present a framework &lt;GAN&gt; that costs &#39;nothing&#39; &amp; works.</summary>
    <author><name>Alice &amp; Bob</name></author>
    <category term="cs.LG"/>
    <link title="pdf" href="https://arxiv.org/pdf/2005.11401v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

const stub = (xml) => async () => xml;

// ─── Defect 1: a PDF URL must not be answered with metadata ───

test("F9: a /pdf/ URL is not claimed by the metadata vertical", () => {
	for (const url of [
		"https://arxiv.org/pdf/2005.11401",
		"https://arxiv.org/pdf/2005.11401v1",
		"https://arxiv.org/pdf/2005.11401.pdf",
	]) {
		assert.equal(
			matchesArxiv(url),
			false,
			`${url} must fall through to the binary/PDF pipeline`,
		);
	}
});

test("F9: /abs/ and the API query keep using the vertical", () => {
	assert.equal(matchesArxiv("https://arxiv.org/abs/2005.11401"), true);
	assert.equal(
		matchesArxiv("https://export.arxiv.org/api/query?id_list=2005.11401"),
		true,
	);
});

test("F9: a bare /pdf/ URL has no id to look up (documents the old path)", () => {
	// Old code extracted the id from the pdf URL to fetch metadata anyway.
	// Guard: the vertical is not consulted for it, so nothing to extract.
	assert.equal(matchesArxiv("https://arxiv.org/pdf/1512.03385"), false);
});

// ─── Defect 2: XML entities must be decoded ───

test("F9: entities are decoded in the title", async () => {
	const r = await extractArxiv("https://arxiv.org/abs/2005.11401", stub(ATOM));
	assert.ok(r);
	assert.ok(!r.title.includes("&amp;"), `raw entity in title: ${r.title}`);
	assert.ok(!r.title.includes("&#8212;"), `raw numeric entity: ${r.title}`);
	assert.match(r.title, /& the Future/);
	assert.match(r.title, /—/);
});

test("F9: entities are decoded in the abstract and authors", async () => {
	const r = await extractArxiv("https://arxiv.org/abs/2005.11401", stub(ATOM));
	assert.ok(r);
	assert.ok(!/&amp;|&lt;|&gt;|&#39;/.test(r.content), `raw entities:\n${r.content}`);
	assert.match(r.content, /<GAN>/);
	assert.match(r.content, /'nothing'/);
	assert.match(r.content, /Alice & Bob/);
});

test("F9: double-encoded entities decode exactly once", async () => {
	const double = ATOM.replace(
		"<summary>",
		"<summary>Literal &amp;amp;amp; stays &amp;lt;b&amp;gt;",
	);
	const r = await extractArxiv("https://arxiv.org/abs/2005.11401", stub(double));
	assert.ok(r);
	// One pass only. `/&amp;/` was too weak: it matches the UNDECODED fixture text
	// too, so the old assertion passed on a decoder that did nothing.
	//
	// This fixture is triple-encoded in the source (`&amp;amp;amp;`,
	// `&amp;lt;b&amp;gt;`), so the three outcomes differ from what a shorter fixture
	// would give. Measured inside the test, not inferred:
	//   zero passes -> "Literal &amp;amp;amp; stays &amp;lt;b&amp;gt;"
	//   one pass    -> "Literal &amp;amp; stays &lt;b&gt;"
	//   two passes  -> "Literal &amp; stays <b>"
	// Only the middle form matches, so a decoder that stalls and one that runs
	// twice are both detected.
	assert.match(r.content, /Literal &amp;amp; stays &lt;b&gt;/);
});

test("F9: the metadata shape is otherwise preserved", async () => {
	const r = await extractArxiv("https://arxiv.org/abs/2005.11401", stub(ATOM));
	assert.ok(r);
	assert.match(r.content, /Published:\*\* 2020-05-11/);
	assert.match(r.content, /Categories:\*\* cs\.LG/);
	assert.match(r.content, /PDF:\*\* https:\/\/arxiv\.org\/pdf\/2005\.11401v1/);
	assert.match(r.content, /## Abstract/);
});

test("F9: a PDF is recognised by its magic bytes, not its extension", () => {
	// The fix relies on this invariant: arXiv serves the paper at
	// `/pdf/2005.11401` with no `.pdf` suffix, and the extension-only test sent
	// that to the download branch instead of extracting the text.
	const pdfHead = Buffer.from("%PDF-1.5\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj", "latin1");
	assert.equal(binarySignature(pdfHead), "pdf");
	// And a non-PDF body is not misclassified as one.
	assert.notEqual(binarySignature(Buffer.from("<html><body>hi", "utf8")), "pdf");
});

test("F9: a missing numeric entity target is left alone, not corrupted", async () => {
	const odd = ATOM.replace(
		"<summary>",
		"<summary>stray &#xZZ; and &#12; here",
	);
	const r = await extractArxiv("https://arxiv.org/abs/2005.11401", stub(odd));
	assert.ok(r);
	assert.match(r.content, /stray &#xZZ; and &#12; here/);
});
