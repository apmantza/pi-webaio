// ─── Tests for fetch-progress.ts: readResponseTextWithProgress + SmartFetchResult ───

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	readResponseText,
	readResponseTextWithProgress,
} from "../src/fetch.ts";

// ─── readResponseTextWithProgress: synthetic responses ──────────────

/**
 * Build a fake Response whose body is a stream of byte chunks.
 * @param {{ headers?: Map<string, string>, body: string | null | Uint8Array[] }} opts
 */
function fakeResponse(opts) {
	const { headers = new Map(), body } = opts;
	const headersObj = {
		get: (name) => headers.get(name.toLowerCase()) ?? null,
	};
	if (body === null) {
		return {
			body: null,
			headers: headersObj,
			text: async () => "",
		};
	}
	const chunks = Array.isArray(body) ? body : [new TextEncoder().encode(body)];
	const encoder = new TextEncoder();
	const full = chunks
		.map((c) => (typeof c === "string" ? encoder.encode(c) : c))
		.reduce((acc, c) => {
			const next = new Uint8Array(acc.length + c.length);
			next.set(acc, 0);
			next.set(c, acc.length);
			return next;
		}, new Uint8Array(0));
	return {
		body: {
			getReader: () => {
				let i = 0;
				return {
					read: async () => {
						if (i >= chunks.length) return { done: true, value: undefined };
						const v = chunks[i++];
						return {
							done: false,
							value: typeof v === "string" ? encoder.encode(v) : v,
						};
					},
					cancel: async () => {},
				};
			},
		},
		headers: headersObj,
		text: async () => new TextDecoder().decode(full),
	};
}

test("readResponseTextWithProgress: streaming body returns bytesRead and contentLength", async () => {
	const res = fakeResponse({
		headers: new Map([["content-length", "13"]]),
		body: ["Hello, ", "world!"],
	});
	const r = await readResponseTextWithProgress(res);
	assert.equal(r.text, "Hello, world!");
	assert.equal(r.bytesRead, 13);
	assert.equal(r.contentLength, 13);
});

test("readResponseTextWithProgress: missing body falls back to response.text()", async () => {
	const res = fakeResponse({ body: null });
	res.text = async () => "no body";
	const r = await readResponseTextWithProgress(res);
	assert.equal(r.text, "no body");
	// bytesRead should be the BYTE length, not char length
	assert.equal(r.bytesRead, 7); // 7 ASCII bytes
	assert.equal(r.contentLength, null);
});

test("readResponseTextWithProgress: missing body uses byte length for UTF-8", async () => {
	// "中文" = 6 bytes in UTF-8, 2 chars
	const res = fakeResponse({ body: null });
	res.text = async () => "中文";
	const r = await readResponseTextWithProgress(res);
	assert.equal(r.text, "中文");
	assert.equal(r.bytesRead, 6, "should be 6 bytes, not 2 chars");
	assert.equal(r.contentLength, null);
});

test("readResponseTextWithProgress: Content-Length > limit throws ERR_RESPONSE_TOO_LARGE with size", async () => {
	const res = fakeResponse({
		headers: new Map([["content-length", String(60 * 1024 * 1024)]]),
		body: [],
	});
	await assert.rejects(readResponseTextWithProgress(res), (e) => {
		assert.equal(e.code, "ERR_RESPONSE_TOO_LARGE");
		assert.equal(e.bytesRead, 0);
		assert.equal(e.contentLength, 60 * 1024 * 1024);
		return true;
	});
});

test("readResponseTextWithProgress: streaming > limit throws with partial bytesRead", async () => {
	// Stream chunks until we exceed the 50MB limit
	const big = new Uint8Array(60 * 1024 * 1024);
	let delivered = false;
	const res = {
		body: {
			getReader: () => ({
				read: async () => {
					if (!delivered) {
						delivered = true;
						return { done: false, value: big };
					}
					return { done: true, value: undefined };
				},
				cancel: async () => {},
			}),
		},
		headers: { get: () => null },
	};
	await assert.rejects(readResponseTextWithProgress(res), (e) => {
		assert.equal(e.code, "ERR_RESPONSE_TOO_LARGE");
		assert.equal(e.bytesRead, 60 * 1024 * 1024);
		return true;
	});
});

test("readResponseText: returns just the text (backward compat)", async () => {
	const res = fakeResponse({ body: ["hello"] });
	const text = await readResponseText(res);
	assert.equal(text, "hello");
});

// ─── Regression: unhandled rejections from reader.cancel() must never crash ───
// GitHub issue #41: a slow site's reader.cancel() returns a promise
// rejected with the stream's stored error (WHATWG Streams spec). A bare
// `reader.cancel()` left that rejection floating -> unhandledRejection ->
// uncaughtException -> host process death.

test("readResponseTextWithProgress: reader.cancel() rejection on read error does not leak an unhandled rejection", async () => {
	const streamErr = new Error(
		"error decoding response body: error reading a body from connection: timed out",
	);
	const res = {
		body: {
			getReader: () => ({
				read: async () => {
					throw streamErr;
				},
				cancel: () => Promise.reject(streamErr),
			}),
		},
		headers: { get: () => null },
	};

	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await assert.rejects(readResponseTextWithProgress(res));
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(
			unhandled.length,
			0,
			"reader.cancel()'s rejected promise must not become an unhandledRejection",
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("readResponseTextWithProgress: reader.cancel() rejection on over-byte-limit path does not leak an unhandled rejection", async () => {
	const cancelErr = new Error("stream errored");
	const big = new Uint8Array(60 * 1024 * 1024);
	let delivered = false;
	const res = {
		body: {
			getReader: () => ({
				read: async () => {
					if (!delivered) {
						delivered = true;
						return { done: false, value: big };
					}
					return { done: true, value: undefined };
				},
				cancel: () => Promise.reject(cancelErr),
			}),
		},
		headers: { get: () => null },
	};

	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await assert.rejects(readResponseTextWithProgress(res), (e) => {
			assert.equal(e.code, "ERR_RESPONSE_TOO_LARGE");
			return true;
		});
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(
			unhandled.length,
			0,
			"reader.cancel()'s rejected promise must not become an unhandledRejection",
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

// ─── Body-read deadline ──────────────────────────────────────────────

test("readResponseTextWithProgress: times out when the body stalls, independent of MAX_RESPONSE_BYTES", async () => {
	const res = {
		body: {
			getReader: () => ({
				read: () => new Promise(() => {}), // never resolves
				cancel: async () => {},
			}),
		},
		headers: { get: () => null },
	};

	const start = Date.now();
	await assert.rejects(readResponseTextWithProgress(res, 50), (e) => {
		assert.match(e.message, /timed out/);
		assert.equal(e.code, "ETIMEDOUT");
		return true;
	});
	assert.ok(
		Date.now() - start < 1000,
		"should time out promptly, not hang for the full default deadline",
	);
});
