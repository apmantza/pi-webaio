// ─── Issue #171: `prune` must bound what is RETURNED, not what is STORED ───
//
// The tool description groups `prune`, `budgetTokens` and `max_length` as
// "output-limit knobs (pick one)" where "output" means what the agent gets, and
// promises "Full content is ALWAYS saved to disk + cached".
//
// `prune` did the opposite of both: it reassigned `contentBody` to the pruned
// text BEFORE the file write and `storeContent()`, so the durable copy held the
// excerpt while the returned text kept the full body.
//
// Reproduced on the installed extension, real page, no stubs:
//
//   aio-webfetch(https://expressjs.com/en/guide/routing.html, prune: 300)
//   aio-webcontent(same url)  -> Length: 1134 chars   (page is 13160)
//
//   aio-webfetch(same page, budgetTokens: 120)
//   aio-webcontent(same url)  -> Length: 13160 chars  (correct)
//
// A 13-section, 1937-word document was stored as 1 section, and the truncation
// footer tells the agent to go and read that record back.
//
// Recurrence prevented: a `prune`d fetch silently degrading the content cache
// that `aio-webcontent` and `aio-webresult` retrieve from.

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitPrunedDisplay } from "../src/tools/webfetch.ts";
import { estimateTokens } from "../src/token-count.ts";
import { registerWebfetchTool } from "../src/tools/webfetch.ts";
import { getStoredContent, normalizeCacheKey, sessionStore } from "../src/session-store.ts";
import {
	maybeChunkMarkdown,
	projectResultsForPrune,
} from "../src/tools/webfetch.ts";

// ─── Pure seam: the storage/display split ─────────────────────────────

/** Two clearly separable sections, big enough that a small budget must drop one. */
function twoSectionBody() {
	return [
		"## Kept section",
		"",
		"keepme ".repeat(400),
		"",
		"## Dropped section",
		"",
		"dropme ".repeat(400),
	].join("\n");
}

test("#171: pruning leaves the stored copy byte-identical to the full body", () => {
	const body = twoSectionBody();
	const split = splitPrunedDisplay(body, 300);

	assert.equal(
		split.stored,
		body,
		"stored content must not be pruned — the file and the content cache are the durable record",
	);
	assert.ok(
		/dropme/.test(split.stored),
		"the dropped section must still be present in what is stored",
	);
});

test("#171: pruning still bounds the returned text", () => {
	const body = twoSectionBody();
	const split = splitPrunedDisplay(body, 300);

	assert.ok(
		estimateTokens(split.returned) <= estimateTokens(body),
		"the returned text must not grow",
	);
	assert.ok(
		!/dropme/.test(split.returned),
		"the returned text must be the bounded excerpt, not the whole page",
	);
});

test("#171: no prune, or a body already inside the budget, is a no-op on both sides", () => {
	const body = "## Small\n\njust a little text";
	assert.deepEqual(splitPrunedDisplay(body, 300), {
		stored: body,
		returned: body,
		pruned: false,
	});
	const big = twoSectionBody();
	const split = splitPrunedDisplay(big, undefined);
	assert.equal(split.stored, big);
	assert.equal(split.returned, big);
});

test("#171: the split reports that it pruned, so the caller can say so", () => {
	const split = splitPrunedDisplay(twoSectionBody(), 300);
	assert.equal(split.pruned, true, "the caller must be able to tell the user it pruned");
	const noop = splitPrunedDisplay("tiny", 300);
	assert.equal(noop.pruned, false);
});

// ─── Production path: the invariant that actually broke ───────────────
//
// The pure test above pins the seam, but the defect lived in the wiring: which
// of the two values reached `writeFile`/`storeContent`. This test drives the
// registered tool and asserts the cache holds at least as much as was returned.
//
// It needs the network, so it skips when unavailable rather than pretending.

function captureWebfetchTool() {
	let tool;
	registerWebfetchTool({
		registerTool(t) {
			tool = t;
		},
	});
	return tool;
}

const LIVE_URL = "https://expressjs.com/en/guide/routing/";

test("#171: a pruned fetch stores the full body (live)", async (t) => {
	const tool = captureWebfetchTool();
	let result;
	try {
		result = await tool.execute(
			"p171",
			{ url: `${LIVE_URL}?p171=${Date.now()}`, prune: 200 },
			undefined,
			undefined,
			{},
		);
	} catch (err) {
		t.skip(`network unavailable: ${err?.message}`);
		return;
	}
	if (!result?.details?.url) {
		t.skip("fetch did not complete (network or bot protection)");
		return;
	}

	const stored = getStoredContent(result.details.url);
	if (!stored) {
		t.skip("nothing was cached for this URL");
		return;
	}

	const returned = result.content[0].text;
	assert.ok(
		stored.content.length >= returned.length,
		`the cache holds ${stored.content.length} chars but the tool returned ${returned.length} — pruning leaked into the durable record`,
	);
	// The page is ~13k chars; a 200-token prune must not be all that survives.
	assert.ok(
		stored.content.length > 2000,
		`stored content is only ${stored.content.length} chars — the durable copy looks pruned`,
	);

	sessionStore.delete(normalizeCacheKey(result.details.url));
});

// ─── CodeRabbit on #172: `prune` + `chunks` bypassed the bound ──────────
//
// Reviewer finding, verified before accepting: all three `maybeChunkMarkdown`
// call sites chunk `(r as any).body` — the FULL body — while `prune` was moved to
// the preview. With both params set, the returned chunk list is generated from the
// unpruned page, so the requested reduction is bypassed by the largest part of the
// output.
//
// Pre-existing (the chunk path always read the full body), but the #171 fix made
// the inconsistency explicit: if `prune` bounds what is returned, it must bound the
// chunks too, because chunks ARE returned.
//
// Recurrence prevented: `prune: 300` on a 13k-char page returning 40 chunks of the
// whole document because the knob only ever touched the preview.

test("#171 follow-up: chunks are generated from the bounded display body", () => {
	const body = twoSectionBody();
	const errors = [];
	const chunks = maybeChunkMarkdown(
		body,
		{ chunks: true, prune: 300, maxTokens: 120 },
		errors,
	);
	assert.ok(chunks && chunks.length > 0, "chunking should have produced chunks");
	assert.equal(errors.length, 0, `chunking reported errors: ${errors.join("; ")}`);

	const joined = chunks.map((c) => c.text).join("\n");
	const totalTokens = chunks.reduce((n, c) => n + c.tokenCount, 0);
	assert.ok(
		!/dropme/.test(joined),
		"a chunk still carries the section `prune` was asked to drop",
	);
	assert.ok(
		totalTokens <= 400,
		`chunks total ${totalTokens} tokens against a 300-token prune budget`,
	);
});

test("#171 follow-up: without prune, chunks still cover the whole page", () => {
	const body = twoSectionBody();
	const chunks = maybeChunkMarkdown(body, { chunks: true, maxTokens: 120 }, []);
	assert.ok(chunks && chunks.length > 0);
	assert.ok(
		/dropme/.test(chunks.map((c) => c.text).join("\n")),
		"no prune means no reduction — chunking must still see the full page",
	);
});

// ─── CodeRabbit on #172 (thread 2): multi-URL mode ignored `prune` ──────
//
// `details: { results }` returns each worker result, and every result carries
// `body: formatted.body` — the FULL markdown. Nothing in the multi-URL path ever
// consulted `prune`, so on a batch fetch the knob did nothing whatsoever: the
// agent asked for a 300-token-per-page reduction and got every page whole.
//
// The projection must CLONE. The original result objects are what the file write,
// the content cache and chunking read, so mutating them in place would reintroduce
// exactly the #171 defect from the other side.
//
// Recurrence prevented: `prune` silently doing nothing on `urls: [...]` fetches.

test("#171 follow-up: multi-URL results are projected with bounded bodies", () => {
	const results = [
		{ ok: true, url: "https://a.test/x", body: twoSectionBody() },
		{ ok: true, url: "https://b.test/y", body: twoSectionBody() },
	];
	const projected = projectResultsForPrune(results, 300, undefined);

	assert.equal(projected.length, 2);
	for (const r of projected) {
		assert.ok(
			!/dropme/.test(r.body),
			`the returned body for ${r.url} still carries the dropped section`,
		);
	}
	// The originals must be untouched: they feed the file write and the cache.
	for (const r of results) {
		assert.ok(
			/dropme/.test(r.body),
			`projecting mutated the original result for ${r.url} — that is the #171 defect again`,
		);
	}
});

test("#171 follow-up: no prune means results are returned as-is", () => {
	const results = [{ ok: true, url: "https://a.test/x", body: twoSectionBody() }];
	assert.equal(projectResultsForPrune(results, undefined, undefined), results);
});

test("#171 follow-up: failed results pass through untouched", () => {
	const results = [{ ok: false, url: "https://a.test/x", error: "404" }];
	const projected = projectResultsForPrune(results, 300, undefined);
	assert.deepEqual(projected, results);
});

// ─── CodeRabbit on #172 round 2 ───────────────────────────────────────

// Thread 1: `pruneMarkdown` is a MARKDOWN pruner. Running it over serialized
// JSON or raw HTML can invalidate the document (cutting mid-structure), which is
// the same reason `budgetTokens` is documented as markdown-only. An absent
// format means the default markdown path.
test("#172: prune never touches non-markdown result bodies", () => {
	const json = '{"a":1,"b":"' + "x".repeat(4000) + '"}';
	const results = [
		{ ok: true, url: "https://a.test/1", body: json, format: "json" },
		{ ok: true, url: "https://a.test/2", body: `<p>${"y".repeat(4000)}</p>`, format: "html" },
		{ ok: true, url: "https://a.test/3", body: "z".repeat(4000), format: "text" },
		{ ok: true, url: "https://a.test/4", body: "w".repeat(4000), format: "raw" },
	];
	const projected = projectResultsForPrune(results, 300, undefined);
	projected.forEach((r, i) => {
		assert.equal(
			r.body,
			results[i].body,
			`${results[i].format} body was pruned — trimming a raw document mid-structure yields an unusable artifact`,
		);
	});
});

test("#172: an absent format is the default markdown path and IS pruned", () => {
	const results = [{ ok: true, url: "https://a.test/x", body: twoSectionBody() }];
	const projected = projectResultsForPrune(results, 300, undefined);
	assert.ok(!/dropme/.test(projected[0].body));
});

// Thread 2: the worker populates BOTH `body` and `diffResult` from the same diff
// text. Bounding only `body` left the structured result still exposing the text
// `prune` removed.
test("#172: a projected result bounds diffResult alongside body", () => {
	const results = [
		{
			ok: true,
			url: "https://a.test/x",
			body: twoSectionBody(),
			diffResult: twoSectionBody(),
			format: "markdown",
		},
	];
	const projected = projectResultsForPrune(results, 300, undefined);
	assert.ok(!/dropme/.test(projected[0].body), "body should be bounded");
	assert.ok(
		!/dropme/.test(projected[0].diffResult),
		"diffResult still carries the text `prune` removed — the structured result contradicts the body",
	);
	// The original must still hold both, untouched, for the durable record.
	assert.ok(/dropme/.test(results[0].diffResult));
});
