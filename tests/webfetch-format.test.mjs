// ─── Regression: aio-webfetch single-URL success path with non-markdown formats ───
//
// Background: aio-webfetch with format=html|text|json|raw used to throw
// "The 'path' argument must be of type string or an instance of Buffer
// or URL. Received undefined" in the single-URL success path.
//
// Root cause: the success path did `readFile(r.outPath, "utf8")` to
// build a preview, but for non-markdown formats, `outPath` is
// undefined (those formats don't write to disk). The fix uses the
// in-memory `r.body` (populated by `applyFormat` for every format) as
// the preview source, eliminating the disk read entirely.
//
// This file pins down the regression precondition: the post-success
// `body` must be populated and self-contained for every format, so
// the consumer can use it directly without a disk read. The full
// `applyFormat` contract is tested in `tests/format.test.mjs`; this
// file is a single targeted regression marker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFormat } from "../src/tools/render-result.ts";

test("regression: every format populates body so the success path can skip disk read", () => {
	const result = {
		ok: true,
		content: "hello",
		rawHtml: "<p>hello</p>",
		url: "https://example.com",
		title: "Example",
	};
	for (const fmt of ["markdown", "html", "text", "json", "raw"]) {
		const out = applyFormat(result, fmt, "hello");
		assert.equal(
			typeof out.body,
			"string",
			`format=${fmt} should populate body as a string`,
		);
		assert.ok(
			out.body.length > 0,
			`format=${fmt} should produce a non-empty body so the single-URL success path can use it without readFile`,
		);
	}
});
