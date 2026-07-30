// ─── Tests for F8: local-knowledge pre-check before live fetch ─────────
//
// The pre-check is an opt-in step in aio-webfetch that searches a locally
// pulled aio-webpull corpus (via the shared BM25 query primitive queryIndex)
// before doing any network I/O, and surfaces a match as details.localKnowledge.
//
// These tests seed small on-disk corpora + indexes and assert:
//   - queryIndex (the reused primitive) ranks/returns hits correctly
//   - runLocalKnowledgePreCheck surfaces a hit when the param-driven check runs
//   - runLocalKnowledgePreCheck is a no-op (undefined) with no corpus / no match
//   - the aio-webfetch tool surfaces details.localKnowledge when localCheck:true
//     and is byte-for-byte a no-op (no key, no note) when the param is absent

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { buildIndex, queryIndex } from "../src/webquery-index.ts";
import {
	runLocalKnowledgePreCheck,
	registerWebfetchTool,
} from "../src/tools/webfetch.ts";
import { resolveCorpusDir } from "../src/tools/webquery.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

async function makeTempDir() {
	return mkdtemp(join(osTmpdir(), "local-precheck-test-"));
}

/** Write a minimal markdown file with YAML frontmatter into `dir`. */
async function writeMd(dir, relPath, url, body) {
	const full = join(dir, relPath);
	await mkdir(join(dir, relPath.split("/").slice(0, -1).join("/")), {
		recursive: true,
	});
	const content = `---\ntitle: "Test"\nurl: "${url}"\n---\n\n${body}`;
	await writeFile(full, content, "utf8");
}

/** A unique hostname so we never collide with a real pulled corpus. */
function uniqueHost(tag) {
	return `local-precheck-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.test`;
}

/** Seed a corpus at the exact dir resolveCorpusDir(host) targets, build its index. */
async function seedCorpus(host, pages) {
	const dir = resolveCorpusDir(host);
	await mkdir(dir, { recursive: true });
	for (const [relPath, url, body] of pages) {
		await writeMd(dir, relPath, url, body);
	}
	await buildIndex(dir);
	return dir;
}

/** Capture the registered aio-webfetch tool object via a fake pi. */
function captureWebfetchTool() {
	let tool;
	const pi = {
		registerTool: (t) => {
			tool = t;
		},
	};
	registerWebfetchTool(pi);
	assert.ok(tool, "registerWebfetchTool should register a tool");
	return tool;
}

// A URL that fails fast in the validation phase (blocked_secret) with NO
// network I/O, while carrying a controllable hostname for corpus resolution.
function fastFailUrl(host) {
	return `https://${host}/?token=ghp_${"x".repeat(36)}`;
}

// ─── queryIndex (the reused BM25 primitive) ───────────────────────────

test("queryIndex: returns ranked hits with attribution for a seeded corpus", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"dogs.md",
			"https://example.com/dogs",
			"Dogs are loyal animals. They make great companions and are playful.",
		);
		await writeMd(
			dir,
			"cats.md",
			"https://example.com/cats",
			"Cats are independent creatures known for agility and self-sufficiency.",
		);
		await buildIndex(dir);

		const result = await queryIndex(dir, "loyal dog companions", 5);
		assert.ok(result.ok, "queryIndex should succeed");
		assert.ok(result.hits.length > 0, "should find at least one hit");
		assert.ok(result.chunkCount > 0, "should report indexed chunk count");
		const top = result.hits[0];
		assert.equal(top.url, "https://example.com/dogs", "dogs page ranks first");
		assert.ok(top.file.includes("dogs.md"), "hit carries source file");
		assert.ok(top.score > 0, "hit carries a positive score");
		// ranked descending
		for (let i = 1; i < result.hits.length; i++) {
			assert.ok(result.hits[i - 1].score >= result.hits[i].score);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("queryIndex: returns ok:false reason=missing when there is no index", async () => {
	const dir = await makeTempDir();
	try {
		const result = await queryIndex(dir, "anything");
		assert.ok(!result.ok);
		assert.equal(result.reason, "missing");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("queryIndex: returns empty hits when nothing matches the query", async () => {
	const dir = await makeTempDir();
	try {
		await writeMd(
			dir,
			"apples.md",
			"https://example.com/apples",
			"Apples are a sweet fruit that grow on trees in orchards.",
		);
		await buildIndex(dir);
		const result = await queryIndex(dir, "zzz quantum bicycles nonexistent");
		assert.ok(result.ok, "corpus exists so the query itself succeeds");
		assert.equal(result.hits.length, 0, "no matching chunks");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("queryIndex: respects the topK cap", async () => {
	const dir = await makeTempDir();
	try {
		for (let i = 0; i < 8; i++) {
			await writeMd(
				dir,
				`page-${i}.md`,
				`https://example.com/page-${i}`,
				"Programming languages and software development techniques.",
			);
		}
		await buildIndex(dir);
		const result = await queryIndex(dir, "programming software development", 3);
		assert.ok(result.ok);
		assert.ok(
			result.hits.length <= 3,
			`expected <=3 hits, got ${result.hits.length}`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── runLocalKnowledgePreCheck ────────────────────────────────────────

test("runLocalKnowledgePreCheck: surfaces a local hit (query-driven)", async () => {
	const host = uniqueHost("q");
	let dir;
	try {
		dir = await seedCorpus(host, [
			[
				"guides/calibration.md",
				`https://${host}/guides/calibration`,
				"## Quantum Widget Calibration\n\nCalibrate the quantum widget using the reference oscillator before each run.",
			],
		]);
		const result = await runLocalKnowledgePreCheck(
			[`https://${host}/docs/anything`],
			"quantum widget calibration",
		);
		assert.ok(result, "should find local knowledge");
		assert.equal(result.checked, true);
		assert.equal(result.source, "query", "query came from the explicit query");
		assert.equal(result.corpusDir, dir);
		assert.ok(result.hits.length > 0, "should surface at least one hit");
		assert.equal(result.hits[0].url, `https://${host}/guides/calibration`);
		assert.ok(result.hits[0].file.includes("calibration.md"));
		assert.ok(result.hits[0].score > 0);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

test("runLocalKnowledgePreCheck: derives a query from the URL path when none given", async () => {
	const host = uniqueHost("url");
	let dir;
	try {
		dir = await seedCorpus(host, [
			[
				"gizmo-maintenance.md",
				`https://${host}/guides/gizmo-maintenance`,
				"Gizmo maintenance requires regular lubrication and inspection of the gizmo gears.",
			],
		]);
		const result = await runLocalKnowledgePreCheck([
			`https://${host}/guides/gizmo-maintenance`,
		]);
		assert.ok(result, "should find local knowledge from URL-derived query");
		assert.equal(result.source, "url");
		assert.ok(result.hits.length > 0);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

test("runLocalKnowledgePreCheck: no-op (undefined) when no corpus exists for the host", async () => {
	const result = await runLocalKnowledgePreCheck(
		[`https://${uniqueHost("nocorpus")}/docs`],
		"anything at all",
	);
	assert.equal(result, undefined, "no corpus → no local knowledge");
});

test("runLocalKnowledgePreCheck: no-op (undefined) when corpus exists but nothing matches", async () => {
	const host = uniqueHost("nomatch");
	let dir;
	try {
		dir = await seedCorpus(host, [
			[
				"apples.md",
				`https://${host}/apples`,
				"Apples are a sweet fruit that grow on trees in orchards.",
			],
		]);
		const result = await runLocalKnowledgePreCheck(
			[`https://${host}/`],
			"zzz quantum bicycles nonexistent terms",
		);
		assert.equal(result, undefined, "no match → no local knowledge surfaced");
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

// ─── aio-webfetch tool integration (opt-in vs default) ────────────────

test("aio-webfetch: localCheck=true surfaces details.localKnowledge + note", async () => {
	const host = uniqueHost("tool");
	let dir;
	try {
		dir = await seedCorpus(host, [
			[
				"api.md",
				`https://${host}/api`,
				"The REST API exposes widgets endpoints for creating and listing widgets.",
			],
		]);
		const tool = captureWebfetchTool();
		const result = await tool.execute(
			"test-id",
			{
				url: fastFailUrl(host),
				query: "widgets api endpoints",
				localCheck: true,
			},
			undefined,
			undefined,
			{},
		);
		assert.ok(
			result.details.localKnowledge,
			"details.localKnowledge should be set",
		);
		assert.equal(result.details.localKnowledge.checked, true);
		assert.ok(
			result.details.localKnowledge.hits.length > 0,
			"should list top hit(s)",
		);
		assert.equal(
			result.details.localKnowledge.hits[0].url,
			`https://${host}/api`,
		);
		assert.ok(
			result.content[0].text.includes("[Local knowledge pre-check"),
			"output should carry the local-knowledge note",
		);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

test("aio-webfetch: default (no localCheck) is a no-op — no key, no note", async () => {
	const host = uniqueHost("default");
	let dir;
	try {
		dir = await seedCorpus(host, [
			[
				"api.md",
				`https://${host}/api`,
				"The REST API exposes widgets endpoints for creating and listing widgets.",
			],
		]);
		const tool = captureWebfetchTool();
		// Same corpus exists, but the opt-in param is absent.
		const result = await tool.execute(
			"test-id",
			{ url: fastFailUrl(host), query: "widgets api endpoints" },
			undefined,
			undefined,
			{},
		);
		assert.ok(
			!("localKnowledge" in result.details),
			"localKnowledge key must be absent when the param is off",
		);
		assert.ok(
			!result.content[0].text.includes("[Local knowledge pre-check"),
			"no note should be appended when the param is off",
		);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});
