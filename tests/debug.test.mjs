import assert from "node:assert";
import test from "node:test";
import { debug, debugEnabled } from "../src/debug.ts";

// ─── Central debug() helper (observability audit P8) ──────────────────────

test("debugEnabled reflects PI_WEBAIO_DEBUG lazily", () => {
	const prev = process.env.PI_WEBAIO_DEBUG;
	try {
		delete process.env.PI_WEBAIO_DEBUG;
		assert.equal(debugEnabled(), false);
		process.env.PI_WEBAIO_DEBUG = "1";
		assert.equal(debugEnabled(), true);
		process.env.PI_WEBAIO_DEBUG = "0";
		assert.equal(debugEnabled(), false);
		process.env.PI_WEBAIO_DEBUG = "true";
		assert.equal(debugEnabled(), false, "only the literal '1' enables it");
	} finally {
		if (prev === undefined) delete process.env.PI_WEBAIO_DEBUG;
		else process.env.PI_WEBAIO_DEBUG = prev;
	}
});

test("debug is a safe no-op when disabled", () => {
	const prev = process.env.PI_WEBAIO_DEBUG;
	delete process.env.PI_WEBAIO_DEBUG;
	try {
		assert.doesNotThrow(() => debug("test", "hello", { a: 1 }, null));
	} finally {
		if (prev !== undefined) process.env.PI_WEBAIO_DEBUG = prev;
	}
});

test("debug writes a namespaced line to stderr when enabled", () => {
	const prev = process.env.PI_WEBAIO_DEBUG;
	process.env.PI_WEBAIO_DEBUG = "1";
	const origErr = console.error;
	let captured = "";
	console.error = (...a) => {
		captured += a.map(String).join(" ");
	};
	try {
		debug("search", "cooled down", 42);
		assert.match(captured, /\[pi-webaio:search\]/);
		assert.match(captured, /cooled down/);
		assert.match(captured, /42/);
	} finally {
		console.error = origErr;
		if (prev === undefined) delete process.env.PI_WEBAIO_DEBUG;
		else process.env.PI_WEBAIO_DEBUG = prev;
	}
});
