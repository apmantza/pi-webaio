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
