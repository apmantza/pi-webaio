/**
 * MCP server integration tests — drives a real stdio handshake.
 *
 * Tests:
 *  1. Spawn the built MCP server (dist/src/mcp-server.js via bin entry).
 *  2. Run initialize → notifications/initialized → tools/list.
 *  3. Assert all 7 aio-* tools are listed with valid object inputSchema.
 *  4. tools/call aio-webquery against a fixture corpus built with buildIndex.
 *     No live network is used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

// ─── MCP stdio client helper ──────────────────────────────────────────────

/**
 * Spawn the MCP server and provide:
 *   request(method, params) → Promise<result>   (sets id, waits for response)
 *   notify(method, params)                       (no id, fire-and-forget)
 *   kill()
 */
function spawnMcpServer() {
	const binPath = join(ROOT, "bin", "pi-webaio-mcp.mjs");
	const proc = spawn(process.execPath, [binPath], {
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env },
	});

	let buffer = "";
	let nextId = 1;
	/** Map<id, {resolve, reject}> */
	const pending = new Map();

	proc.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let msg;
			try {
				msg = JSON.parse(trimmed);
			} catch {
				continue;
			}
			// Only handle responses (messages with an id).
			if (msg.id !== undefined && pending.has(msg.id)) {
				const { resolve, reject } = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error) reject(new Error(JSON.stringify(msg.error)));
				else resolve(msg);
			}
		}
	});

	function request(method, params = {}) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			proc.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
			);
		});
	}

	function notify(method, params = {}) {
		proc.stdin.write(
			JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
		);
	}

	function kill() {
		try { proc.stdin.end(); } catch { /* ignore */ }
		try { proc.kill(); } catch { /* ignore */ }
	}

	return { request, notify, kill };
}

// ─── Shared handshake ─────────────────────────────────────────────────────

async function doHandshake(client) {
	const initResp = await client.request("initialize", {
		protocolVersion: "2024-11-05",
		clientInfo: { name: "test-client", version: "0.0.0" },
		capabilities: {},
	});
	assert.equal(initResp.jsonrpc, "2.0", "initialize is JSON-RPC 2.0");
	assert.ok(initResp.result, "initialize has result");
	client.notify("notifications/initialized");
	// Small delay to let the server process the notification.
	await new Promise((r) => setTimeout(r, 30));
}

// ─── Test 1: tools/list ───────────────────────────────────────────────────

test("MCP server lists all 7 aio-* tools with valid object inputSchema", async () => {
	const client = spawnMcpServer();
	try {
		await doHandshake(client);

		const listResp = await client.request("tools/list");
		assert.equal(listResp.jsonrpc, "2.0", "tools/list is JSON-RPC 2.0");
		assert.ok(listResp.result, "tools/list has result");
		assert.ok(Array.isArray(listResp.result.tools), "result.tools is array");

		const expected = [
			"aio-websearch",
			"aio-webfetch",
			"aio-webcontent",
			"aio-webresult",
			"aio-webmap",
			"aio-webpull",
			"aio-webquery",
		];

		const names = listResp.result.tools.map((t) => t.name);
		assert.equal(listResp.result.tools.length, 7, "Exactly 7 tools listed");
		for (const name of expected) {
			assert.ok(names.includes(name), `Tool ${name} is present`);
		}

		for (const tool of listResp.result.tools) {
			assert.ok(tool.name, "Tool has name");
			assert.ok(
				typeof tool.description === "string" && tool.description.length > 0,
				`Tool ${tool.name} has description`,
			);
			assert.ok(
				tool.inputSchema && typeof tool.inputSchema === "object",
				`Tool ${tool.name} has inputSchema`,
			);
			assert.equal(
				tool.inputSchema.type,
				"object",
				`Tool ${tool.name} inputSchema.type === "object"`,
			);
			assert.ok(
				tool.inputSchema.properties && typeof tool.inputSchema.properties === "object",
				`Tool ${tool.name} inputSchema has properties`,
			);

			// Regression (sanitizeJsonSchema): `type: "object"` must not be
			// injected into non-schema nodes. A `properties` map is a plain
			// dictionary of property-name → schema; a `type` key inside it means
			// the sanitizer treated it as a schema and corrupted it.
			assert.ok(
				!("type" in tool.inputSchema.properties),
				`Tool ${tool.name} properties map must not contain an injected "type" key`,
			);
			// Union params (anyOf) must not get a conflicting sibling type.
			for (const [prop, schema] of Object.entries(tool.inputSchema.properties)) {
				if (schema && typeof schema === "object" && Array.isArray(schema.anyOf)) {
					assert.ok(
						!("type" in schema),
						`Tool ${tool.name} param ${prop}: anyOf schema must not have injected sibling "type"`,
					);
				}
			}
		}
	} finally {
		client.kill();
	}
});

// ─── Test 2: aio-webquery offline ─────────────────────────────────────────

test("MCP server calls aio-webquery against fixture corpus (offline)", async () => {
	// Create a fixture corpus.
	const corpusDir = await mkdtemp(join(tmpdir(), "pi-webaio-mcp-test-"));
	await writeFile(
		join(corpusDir, "intro.md"),
		`---\ntitle: "Introduction"\nurl: "https://example.com/intro"\n---\n# Introduction\n\nThis is the introduction page covering basic concepts.\n`,
		"utf8",
	);
	await writeFile(
		join(corpusDir, "api.md"),
		`---\ntitle: "API Reference"\nurl: "https://example.com/api"\n---\n# API Reference\n\nThe API provides endpoints for querying and updating data resources.\n`,
		"utf8",
	);

	// Build the BM25 index using the same logic webpull uses.
	const { buildIndex } = await import(
		pathToFileURL(join(ROOT, "dist", "src", "webquery-index.js")).href
	);
	await buildIndex(corpusDir);

	const client = spawnMcpServer();
	try {
		await doHandshake(client);

		const callResp = await client.request("tools/call", {
			name: "aio-webquery",
			arguments: { query: "API endpoints data", dir: corpusDir, topK: 3 },
		});

		assert.equal(callResp.jsonrpc, "2.0", "tools/call is JSON-RPC 2.0");
		assert.ok(callResp.result, "tools/call has result");
		assert.ok(!callResp.result.isError, "no tool error");

		const content = callResp.result.content;
		assert.ok(Array.isArray(content) && content.length > 0, "result has content");
		assert.equal(content[0].type, "text", "content[0] is text");
		assert.ok(
			typeof content[0].text === "string" && content[0].text.length > 0,
			"text is non-empty",
		);

		// Should mention the API content since we searched for "API endpoints data"
		const text = content[0].text;
		assert.ok(
			text.toLowerCase().includes("api") || text.toLowerCase().includes("endpoint"),
			`Result references API content (got: ${text.slice(0, 300)})`,
		);
	} finally {
		client.kill();
	}
});
