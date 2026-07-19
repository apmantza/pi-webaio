/**
 * Tests for user-defined vertical extractor loading (issue #49).
 *
 * The loader is pointed at a temp fixture directory for each test.
 * The PI_WEBAIO_USER_VERTICALS_DIR env var is used to inject the
 * directory path into the registry, but we also call initUserExtractors()
 * with an explicit path argument to keep tests isolated.
 */

import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	loadUserExtractors,
} from "../src/verticals/user-loader.ts";

import {
	initUserExtractors,
	getUserExtractors,
	findVerticalExtractor,
	runVerticalExtractor,
} from "../src/verticals/registry.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

async function makeTempDir() {
	return mkdtemp(join(tmpdir(), "pi-webaio-test-verticals-"));
}

async function writeMjs(dir, filename, content) {
	const p = join(dir, filename);
	await writeFile(p, content, "utf8");
	return p;
}

/** Stub fetch helpers that always return null */
const noFetch = async () => null;

// ─── Tests ───────────────────────────────────────────────────────────

test("missing directory is a no-op", async () => {
	const result = await loadUserExtractors("/nonexistent/path/that/does/not/exist");
	assert.deepStrictEqual(result, []);
});

test("valid module loads and registers", async (t) => {
	const dir = await makeTempDir();
	t.after(() => rm(dir, { recursive: true, force: true }));

	await writeMjs(dir, "example.mjs", `
export default {
  name: "example",
  match(url) { return url.includes("example-site.internal"); },
  async extract(url) {
    return { ok: true, url, title: "Example", content: "# Example\\n\\nHello." };
  },
};
`);

	const loaded = await loadUserExtractors(dir);
	assert.strictEqual(loaded.length, 1);
	assert.strictEqual(loaded[0].name, "example");
	assert.strictEqual(typeof loaded[0].match, "function");
	assert.strictEqual(typeof loaded[0].extract, "function");
});

test("invalid module skipped with warning", async (t) => {
	const dir = await makeTempDir();
	t.after(() => rm(dir, { recursive: true, force: true }));

	// Missing `name` field
	await writeMjs(dir, "bad.mjs", `
export default {
  match(url) { return true; },
  async extract(url) { return null; },
};
`);

	const warnings = [];
	const origWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));

	const loaded = await loadUserExtractors(dir);

	console.warn = origWarn;

	assert.strictEqual(loaded.length, 0);
	assert.ok(
		warnings.some((w) => w.includes("bad.mjs")),
		"Expected a warning mentioning bad.mjs",
	);
});

test("module with syntax error is skipped with warning", async (t) => {
	const dir = await makeTempDir();
	t.after(() => rm(dir, { recursive: true, force: true }));

	await writeMjs(dir, "broken.mjs", `this is not valid javascript @@@@`);

	const warnings = [];
	const origWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));

	const loaded = await loadUserExtractors(dir);

	console.warn = origWarn;

	assert.strictEqual(loaded.length, 0);
	assert.ok(
		warnings.some((w) => w.includes("broken.mjs")),
		"Expected a warning mentioning broken.mjs",
	);
});

test("named export `extractor` is also accepted", async (t) => {
	const dir = await makeTempDir();
	t.after(() => rm(dir, { recursive: true, force: true }));

	await writeMjs(dir, "named.mjs", `
export const extractor = {
  name: "named-export",
  match(url) { return url.includes("named-export.example"); },
  async extract(url) {
    return { ok: true, url, title: "Named", content: "named" };
  },
};
`);

	const loaded = await loadUserExtractors(dir);
	assert.strictEqual(loaded.length, 1);
	assert.strictEqual(loaded[0].name, "named-export");
});

test("user extractor takes precedence over built-ins", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		rm(dir, { recursive: true, force: true });
		// reset registry state
		await initUserExtractors("/nonexistent/path/$$reset$$");
	});

	// Override the PyPI built-in for test purposes
	await writeMjs(dir, "mypypi.mjs", `
export default {
  name: "my-pypi-override",
  match(url) { return url.startsWith("https://pypi.org/"); },
  async extract(url) {
    return { ok: true, url, title: "Override", content: "overridden" };
  },
};
`);

	await initUserExtractors(dir);

	// findVerticalExtractor should return the user extractor name
	const name = findVerticalExtractor("https://pypi.org/project/requests");
	assert.strictEqual(name, "my-pypi-override");

	// runVerticalExtractor should return the user extractor result
	const result = await runVerticalExtractor(
		"https://pypi.org/project/requests",
		noFetch,
		noFetch,
		noFetch,
	);
	assert.ok(result);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.content, "overridden");
});

test("runtime error in user extractor falls through to built-in pipeline", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		rm(dir, { recursive: true, force: true });
		await initUserExtractors("/nonexistent/path/$$reset$$");
	});

	await writeMjs(dir, "erroring.mjs", `
export default {
  name: "erroring",
  match(url) { return url.includes("hackernews-special.test"); },
  async extract(url) { throw new Error("intentional test error"); },
};
`);

	await initUserExtractors(dir);

	const warnings = [];
	const origWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));

	// The URL doesn't match any built-in extractor, so we should get null (not a throw)
	let threw = false;
	let result = null;
	try {
		result = await runVerticalExtractor(
			"https://hackernews-special.test/item?id=1",
			noFetch,
			noFetch,
			noFetch,
		);
	} catch {
		threw = true;
	}

	console.warn = origWarn;

	assert.strictEqual(threw, false, "runVerticalExtractor must not throw");
	assert.strictEqual(result, null, "should return null when all extractors fail/miss");
	assert.ok(
		warnings.some((w) => w.includes("intentional test error")),
		"Expected warning about the error",
	);
});

test("multiple valid modules all load", async (t) => {
	const dir = await makeTempDir();
	t.after(() => rm(dir, { recursive: true, force: true }));

	for (const name of ["alpha", "beta", "gamma"]) {
		await writeMjs(dir, `${name}.mjs`, `
export default {
  name: "${name}",
  match(url) { return url.includes("${name}.example"); },
  async extract(url) { return { ok: true, url, content: "${name}" }; },
};
`);
	}

	const loaded = await loadUserExtractors(dir);
	assert.strictEqual(loaded.length, 3);
	const names = loaded.map((e) => e.name).sort();
	assert.deepStrictEqual(names, ["alpha", "beta", "gamma"]);
});
