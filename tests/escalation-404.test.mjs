import assert from "node:assert";
import test from "node:test";
import { isSoftBlock404Resolved } from "../src/fetch.ts";

// ─── isSoftBlock404Resolved: the soft-block 404 → browser decision ──────
//
// smartFetch's Rung 1c escalates a wreq-rung 404 to the headless browser
// because Vercel / Next.js edges (e.g. react.dev) return a bare 404 to
// TLS-fingerprinted requests that a real browser receives as 200. The
// predicate below is the whole decision: only a 2xx browser render counts as
// a resolution. A genuine 404 also 404s in the browser, so it must NOT be
// treated as success — the caller then falls through and fails fast.

test("resolves the react.dev case: wreq 404 + browser 200 + html", () => {
	assert.equal(isSoftBlock404Resolved(404, 200, true), true);
});

test("accepts the whole 2xx range as a resolution", () => {
	assert.equal(isSoftBlock404Resolved(404, 200, true), true);
	assert.equal(isSoftBlock404Resolved(404, 204, true), true);
	assert.equal(isSoftBlock404Resolved(404, 299, true), true);
});

test("rejects a genuine 404 (the browser also 404s)", () => {
	assert.equal(isSoftBlock404Resolved(404, 404, true), false);
});

test("rejects when the browser failed / Playwright is unavailable (no html)", () => {
	assert.equal(isSoftBlock404Resolved(404, 0, false), false);
	// A 2xx status with no html is incoherent — still not a resolution.
	assert.equal(isSoftBlock404Resolved(404, 200, false), false);
});

test("rejects non-2xx browser renders (redirect / client / server error)", () => {
	assert.equal(isSoftBlock404Resolved(404, 301, true), false);
	assert.equal(isSoftBlock404Resolved(404, 300, true), false);
	assert.equal(isSoftBlock404Resolved(404, 199, true), false);
	assert.equal(isSoftBlock404Resolved(404, 403, true), false);
	assert.equal(isSoftBlock404Resolved(404, 500, true), false);
});

test("only escalates on a wreq 404 (not other statuses)", () => {
	assert.equal(isSoftBlock404Resolved(200, 200, true), false);
	assert.equal(isSoftBlock404Resolved(403, 200, true), false);
	assert.equal(isSoftBlock404Resolved(500, 200, true), false);
	assert.equal(isSoftBlock404Resolved(0, 200, true), false);
});

test("status boundaries: 200/299 pass, 199/300 fail", () => {
	assert.equal(isSoftBlock404Resolved(404, 199, true), false);
	assert.equal(isSoftBlock404Resolved(404, 200, true), true);
	assert.equal(isSoftBlock404Resolved(404, 299, true), true);
	assert.equal(isSoftBlock404Resolved(404, 300, true), false);
});

test("html is required even for a 2xx browser render", () => {
	// Guards against treating a status-only probe (empty body) as content.
	assert.equal(isSoftBlock404Resolved(404, 200, false), false);
	assert.equal(isSoftBlock404Resolved(404, 200, true), true);
});
