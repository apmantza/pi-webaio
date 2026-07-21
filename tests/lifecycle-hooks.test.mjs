/**
 * Tests for lifecycle hooks (issue #78).
 *
 * Hook modules are written to a temp directory for each test.
 * initUserHooks() is called with an explicit dirPath to keep tests isolated.
 */

import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	initUserHooks,
	getUserHooks,
	runAfterFetchHooks,
	runAfterExtractHooks,
} from "../src/hooks.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

async function makeTempDir() {
	return mkdtemp(join(tmpdir(), "pi-webaio-test-hooks-"));
}

async function writeMjs(dir, filename, content) {
	const p = join(dir, filename);
	await writeFile(p, content, "utf8");
	return p;
}

/** Reset hook registry to a clean state after each test */
async function resetHooks() {
	await initUserHooks("/nonexistent/path/$$reset$$");
}

// ─── Tests ───────────────────────────────────────────────────────────

test("missing directory is a no-op", async () => {
	await initUserHooks("/nonexistent/path/that/does/not/exist");
	assert.deepStrictEqual(getUserHooks(), []);
});

test("valid hook module loads and registers", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "my-hook.mjs", `
export default {
  pattern: "https://example.com/**",
  afterFetch(url, ctx) { return ctx.html + "<!-- hooked -->"; },
};
`);

	await initUserHooks(dir);
	const hooks = getUserHooks();
	assert.strictEqual(hooks.length, 1);
	assert.strictEqual(hooks[0].pattern, "https://example.com/**");
});

test("glob matching — matching URL triggers hook", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "hook.mjs", `
export default {
  pattern: "https://example.com/**",
  afterFetch(url, ctx) { return ctx.html + "<!--matched-->"; },
};
`);

	await initUserHooks(dir);
	const result = await runAfterFetchHooks("https://example.com/page", {
		status: 200,
		headers: {},
		html: "<html></html>",
	});
	assert.ok(result.includes("<!--matched-->"), "hook should have run for matching URL");
});

test("glob matching — non-matching URL skips hook", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "hook.mjs", `
export default {
  pattern: "https://example.com/**",
  afterFetch(url, ctx) { return ctx.html + "<!--matched-->"; },
};
`);

	await initUserHooks(dir);
	const result = await runAfterFetchHooks("https://other.com/page", {
		status: 200,
		headers: {},
		html: "<html></html>",
	});
	assert.ok(!result.includes("<!--matched-->"), "hook must not run for non-matching URL");
	assert.strictEqual(result, "<html></html>");
});

test("afterFetch hook transforms html", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "transform.mjs", `
export default {
  pattern: "https://**",
  afterFetch(url, ctx) {
    return ctx.html.replace("<body>", "<body data-fetched='true'>");
  },
};
`);

	await initUserHooks(dir);
	const result = await runAfterFetchHooks("https://example.com/", {
		status: 200,
		headers: {},
		html: "<html><body><p>Hello</p></body></html>",
	});
	assert.ok(result.includes("data-fetched='true'"), "html should be transformed");
});

test("afterExtract hook transforms result", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "extract-hook.mjs", `
export default {
  pattern: "https://example.com/**",
  afterExtract(url, result) {
    return { ...result, title: "Overridden Title" };
  },
};
`);

	await initUserHooks(dir);
	const input = { ok: true, url: "https://example.com/page", title: "Original", content: "Content" };
	const result = await runAfterExtractHooks("https://example.com/page", input);
	assert.strictEqual(result.title, "Overridden Title");
	assert.strictEqual(result.content, "Content");
});

test("hooks chain in load order", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	// a.mjs sorts before b.mjs — both match
	await writeMjs(dir, "a.mjs", `
export default {
  pattern: "https://**",
  afterFetch(url, ctx) { return ctx.html + "A"; },
};
`);
	await writeMjs(dir, "b.mjs", `
export default {
  pattern: "https://**",
  afterFetch(url, ctx) { return ctx.html + "B"; },
};
`);

	await initUserHooks(dir);
	const result = await runAfterFetchHooks("https://example.com/", {
		status: 200,
		headers: {},
		html: "",
	});
	// Both hooks should have run; the order depends on readdir order but both append
	assert.ok(result.includes("A"), "hook A should have run");
	assert.ok(result.includes("B"), "hook B should have run");
	// A comes before B in load order so AB not BA
	assert.ok(result.indexOf("A") < result.indexOf("B"), "A should run before B");
});

test("throwing afterFetch hook is skipped without failing", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "thrower.mjs", `
export default {
  pattern: "https://**",
  afterFetch(url, ctx) { throw new Error("intentional afterFetch error"); },
};
`);

	await initUserHooks(dir);

	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(" "));

	let threw = false;
	let result;
	try {
		result = await runAfterFetchHooks("https://example.com/", {
			status: 200,
			headers: {},
			html: "<html>original</html>",
		});
	} catch {
		threw = true;
	}

	console.error = origError;

	assert.strictEqual(threw, false, "runAfterFetchHooks must not throw");
	assert.strictEqual(result, "<html>original</html>", "original html must be returned when hook throws");
	assert.ok(
		errors.some((e) => e.includes("intentional afterFetch error")),
		"Expected error log about the throwing hook",
	);
});

test("throwing afterExtract hook is skipped without failing", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "thrower-extract.mjs", `
export default {
  pattern: "https://**",
  afterExtract(url, result) { throw new Error("intentional afterExtract error"); },
};
`);

	await initUserHooks(dir);

	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(" "));

	const input = { ok: true, url: "https://example.com/", title: "T", content: "C" };
	let threw = false;
	let result;
	try {
		result = await runAfterExtractHooks("https://example.com/", input);
	} catch {
		threw = true;
	}

	console.error = origError;

	assert.strictEqual(threw, false, "runAfterExtractHooks must not throw");
	assert.deepStrictEqual(result, input, "original result must be returned when hook throws");
	assert.ok(
		errors.some((e) => e.includes("intentional afterExtract error")),
		"Expected error log about the throwing hook",
	);
});

test("null return from afterFetch leaves html unchanged", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "null-hook.mjs", `
export default {
  pattern: "https://**",
  afterFetch(url, ctx) { return null; },
};
`);

	await initUserHooks(dir);
	const html = "<html><body>Hello</body></html>";
	const result = await runAfterFetchHooks("https://example.com/", {
		status: 200,
		headers: {},
		html,
	});
	assert.strictEqual(result, html, "null return must leave html unchanged");
});

test("null return from afterExtract leaves result unchanged", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "null-extract.mjs", `
export default {
  pattern: "https://**",
  afterExtract(url, result) { return null; },
};
`);

	await initUserHooks(dir);
	const input = { ok: true, url: "https://example.com/", title: "T", content: "C" };
	const result = await runAfterExtractHooks("https://example.com/", input);
	assert.deepStrictEqual(result, input, "null return must leave result unchanged");
});

test("invalid module (missing pattern) is skipped with error", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "bad-hook.mjs", `
export default {
  afterFetch(url, ctx) { return ctx.html; },
};
`);

	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(" "));

	await initUserHooks(dir);

	console.error = origError;

	assert.strictEqual(getUserHooks().length, 0, "invalid hook must not be registered");
	assert.ok(
		errors.some((e) => e.includes("bad-hook.mjs")),
		"Expected an error mentioning bad-hook.mjs",
	);
});

test("no hooks loaded means runners are near-zero-cost no-ops", async () => {
	await initUserHooks("/nonexistent/path/$$reset$$");
	assert.strictEqual(getUserHooks().length, 0);

	const html = "<html>test</html>";
	const fetchResult = await runAfterFetchHooks("https://example.com/", {
		status: 200,
		headers: {},
		html,
	});
	assert.strictEqual(fetchResult, html);

	const input = { ok: true, url: "https://example.com/", content: "test" };
	const extractResult = await runAfterExtractHooks("https://example.com/", input);
	assert.deepStrictEqual(extractResult, input);
});

test("afterExtract chaining: each hook receives previous output", async (t) => {
	const dir = await makeTempDir();
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
		await resetHooks();
	});

	await writeMjs(dir, "a-extract.mjs", `
export default {
  pattern: "https://**",
  afterExtract(url, result) {
    return { ...result, content: result.content + " A" };
  },
};
`);
	await writeMjs(dir, "b-extract.mjs", `
export default {
  pattern: "https://**",
  afterExtract(url, result) {
    return { ...result, content: result.content + " B" };
  },
};
`);

	await initUserHooks(dir);
	const input = { ok: true, url: "https://example.com/", content: "start" };
	const result = await runAfterExtractHooks("https://example.com/", input);
	assert.strictEqual(result.content, "start A B", "hooks must chain in order");
});
