/**
 * Offline tests for the Context7 + DeepWiki verticals (roadmap F9).
 *
 * Both verticals are keyless API clients. These tests stub globalThis.fetch
 * to simulate the Context7 search + docs endpoints and the DeepWiki MCP
 * JSON-RPC server, so no real network calls are made.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

const {
	matchesContext7,
	parseContext7Url,
	parseContext7Body,
	extractContext7,
} = await import("../src/verticals/context7.ts");

const {
	matchesDeepWiki,
	parseDeepWikiUrl,
	parseDeepWikiRpcBody,
	parseAskQuestionResult,
	formatDeepWikiCitations,
	extractDeepWiki,
} = await import("../src/verticals/deepwiki.ts");

const {
	findVerticalExtractor,
	runVerticalExtractor,
} = await import("../src/verticals/registry.ts");

// ─── Context7: URL matching ────────────────────────────────────────

test("Context7: matchesContext7 matches library pages", () => {
	assert.strictEqual(
		matchesContext7("https://context7.com/reactjs/react.dev"),
		true,
	);
	assert.strictEqual(
		matchesContext7("https://www.context7.com/library/react"),
		true,
	);
	assert.strictEqual(
		matchesContext7("https://context7.com/"),
		false,
		"bare site should not match",
	);
	assert.strictEqual(
		matchesContext7("https://example.com/reactjs/react.dev"),
		false,
		"non-context7 host should not match",
	);
});

test("Context7: parseContext7Url derives library path + query", () => {
	const a = parseContext7Url("https://context7.com/reactjs/react.dev");
	assert.deepEqual(a, { libraryPath: "/reactjs/react.dev", query: "react.dev" });

	const b = parseContext7Url("https://context7.com/library/react");
	assert.deepEqual(b, { libraryPath: "/library/react", query: "react" });

	assert.strictEqual(parseContext7Url("https://context7.com/"), null);
	assert.strictEqual(parseContext7Url("not a url"), null);
});

// ─── Context7: content-type sniffing ───────────────────────────────

test("Context7: parseContext7Body sniffs JSON despite text/plain header", () => {
	const body = JSON.stringify({
		content: "Use the hook like this...",
		metadata: { title: "React", url: "https://context7.com/reactjs/react.dev" },
	});
	// Context7 lies: claims text/plain but sends JSON.
	const docs = parseContext7Body(body, "text/plain", "/reactjs/react.dev");
	assert.strictEqual(docs.title, "React");
	assert.strictEqual(docs.sourceUrl, "https://context7.com/reactjs/react.dev");
	assert.ok(docs.content.includes("Use the hook"));
});

test("Context7: parseContext7Body treats plain text as content", () => {
	const body = "# Getting Started\n\nInstall with npm install react.";
	const docs = parseContext7Body(body, "text/plain", "/vercel/next.js");
	assert.strictEqual(docs.content, body);
	assert.strictEqual(docs.title, "vercel/next.js");
	assert.strictEqual(docs.sourceUrl, "https://context7.com/vercel/next.js");
});

test("Context7: parseContext7Body handles v2 snippet arrays", () => {
	const body = JSON.stringify({
		codeSnippets: [{ content: "const x = 1;" }],
		infoSnippets: [{ text: "Some info." }],
	});
	const docs = parseContext7Body(body, "application/json", "/foo/bar");
	assert.ok(docs.content.includes("const x = 1;"));
	assert.ok(docs.content.includes("Some info."));
});

// ─── Context7: two-step flow + optional key ────────────────────────

/**
 * Stub fetch for Context7. Routes by URL:
 *   - /api/v1/search?query=...  → search results (with trust/benchmark)
 *   - /api/v1/<id>?type=txt...  → docs body
 * Records every request's headers for assertion.
 */
function stubContext7Fetch(opts) {
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, init = {}) => {
		const u = String(url);
		requests.push({ url: u, headers: init.headers || {} });
		if (u.includes("/api/v1/search")) {
			return new Response(JSON.stringify(opts.search ?? { results: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		// docs endpoint
		return new Response(opts.docsBody ?? "", {
			status: opts.docsStatus ?? 200,
			headers: { "content-type": opts.docsType ?? "text/plain" },
		});
	};
	return {
		requests,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

test("Context7: two-step flow resolves ID then fetches docs", async () => {
	const stub = stubContext7Fetch({
		search: {
			results: [
				{
					id: "/reactjs/react.dev",
					name: "React",
					version: "19.0.0",
					trustScore: 0.95,
					benchmarkScore: 0.88,
				},
			],
		},
		docsBody: "React is a library for building UIs.",
	});
	try {
		const result = await extractContext7(
			"https://context7.com/library/react",
		);
		assert.strictEqual(result?.ok, true);
		assert.strictEqual(result?.title, "reactjs/react.dev");
		assert.ok(result.content.includes("- **Library:** React"));
		assert.ok(result.content.includes("- **Version:** 19.0.0"));
		assert.ok(result.content.includes("- **Trust score:** 0.95"));
		assert.ok(result.content.includes("- **Benchmark score:** 0.88"));
		assert.ok(result.content.includes("React is a library for building UIs."));

		// The docs request must use the resolved ID from search, and the
		// search request must carry the query derived from the URL.
		const searchReq = stub.requests.find((r) => r.url.includes("/search"));
		assert.ok(searchReq.url.includes("query=react"));
		const docsReq = stub.requests.find((r) => r.url.includes("type=txt"));
		assert.ok(
			docsReq.url.includes("/api/v1/reactjs/react.dev"),
			`docs should use resolved id. got: ${docsReq.url}`,
		);
	} finally {
		stub.restore();
	}
});

test("Context7: falls back to URL-derived ID when search is empty", async () => {
	const stub = stubContext7Fetch({
		search: { results: [] },
		docsBody: "Docs body here.",
	});
	try {
		const result = await extractContext7(
			"https://context7.com/reactjs/react.dev",
		);
		assert.strictEqual(result?.ok, true);
		const docsReq = stub.requests.find((r) => r.url.includes("type=txt"));
		assert.ok(docsReq.url.includes("/api/v1/reactjs/react.dev"));
	} finally {
		stub.restore();
	}
});

test("Context7: sends Bearer header only when CONTEXT7_API_KEY is set", async () => {
	const prev = process.env.CONTEXT7_API_KEY;
	try {
		// With a key.
		process.env.CONTEXT7_API_KEY = "ctx_secret_key";
		const withKey = stubContext7Fetch({ docsBody: "x" });
		await extractContext7("https://context7.com/library/react");
		assert.ok(
			withKey.requests.every(
				(r) => r.headers.Authorization === "Bearer ctx_secret_key",
			),
			"every request should carry the Bearer key",
		);
		withKey.restore();

		// Without a key.
		delete process.env.CONTEXT7_API_KEY;
		const noKey = stubContext7Fetch({ docsBody: "x" });
		await extractContext7("https://context7.com/library/react");
		assert.ok(
			noKey.requests.every((r) => r.headers.Authorization === undefined),
			"no Authorization header when key is unset",
		);
		noKey.restore();
	} finally {
		if (prev === undefined) delete process.env.CONTEXT7_API_KEY;
		else process.env.CONTEXT7_API_KEY = prev;
	}
});

test("Context7: 404 on docs reports not-found error", async () => {
	const stub = stubContext7Fetch({ docsStatus: 404, docsBody: "" });
	try {
		const result = await extractContext7(
			"https://context7.com/nope/nothing",
		);
		assert.strictEqual(result?.ok, false);
		assert.strictEqual(result?.content, "");
		assert.ok(/not found|no context7/i.test(result?.error ?? ""));
	} finally {
		stub.restore();
	}
});

// ─── DeepWiki: URL matching ────────────────────────────────────────

test("DeepWiki: matchesDeepWiki matches repo URLs", () => {
	assert.strictEqual(matchesDeepWiki("https://deepwiki.com/facebook/react"), true);
	assert.strictEqual(
		matchesDeepWiki("https://www.deepwiki.com/vercel/next.js"),
		true,
	);
	assert.strictEqual(matchesDeepWiki("https://deepwiki.com/facebook"), false);
	assert.strictEqual(matchesDeepWiki("https://deepwiki.com/"), false);
	assert.strictEqual(
		matchesDeepWiki("https://example.com/facebook/react"),
		false,
	);
});

test("DeepWiki: parseDeepWikiUrl extracts repo + question", () => {
	const a = parseDeepWikiUrl("https://deepwiki.com/facebook/react");
	assert.strictEqual(a.repoName, "facebook/react");
	assert.ok(a.question.length > 0, "default question should be non-empty");

	const b = parseDeepWikiUrl(
		"https://deepwiki.com/facebook/react?q=How does Fiber work?",
	);
	assert.strictEqual(b.question, "How does Fiber work?");

	assert.strictEqual(parseDeepWikiUrl("https://deepwiki.com/only"), null);
});

// ─── DeepWiki: RPC body parsing ────────────────────────────────────

test("DeepWiki: parseDeepWikiRpcBody parses plain JSON", () => {
	const j = parseDeepWikiRpcBody('{"jsonrpc":"2.0","id":2,"result":{}}');
	assert.strictEqual(j.id, 2);
	assert.ok(j.result);
});

test("DeepWiki: parseDeepWikiRpcBody parses SSE streams (last message wins)", () => {
	const sse = [
		"event: message",
		'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
		"",
		"event: message",
		'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
		"",
	].join("\n");
	const j = parseDeepWikiRpcBody(sse);
	assert.strictEqual(j.id, 2);
	assert.ok(j.result);
});

test("DeepWiki: parseDeepWikiRpcBody returns null on empty/garbage", () => {
	assert.strictEqual(parseDeepWikiRpcBody(""), null);
	assert.strictEqual(parseDeepWikiRpcBody("not json at all"), null);
});

// ─── DeepWiki: result + citation parsing ───────────────────────────

test("DeepWiki: parseAskQuestionResult parses structured JSON answer", () => {
	const rpc = {
		jsonrpc: "2.0",
		id: 2,
		result: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						answer: "React uses a Fiber reconciler.",
						citations: [
							{
								type: "file",
								file_path: "src/ReactFiber.js",
								line_start: 10,
								line_end: 20,
								snippet: "function FiberNode() {}",
							},
						],
					}),
				},
			],
		},
	};
	const a = parseAskQuestionResult(rpc);
	assert.strictEqual(a.answer, "React uses a Fiber reconciler.");
	assert.strictEqual(a.citations.length, 1);
	assert.strictEqual(a.citations[0].filePath, "src/ReactFiber.js");
	assert.strictEqual(a.citations[0].lineStart, 10);
	assert.strictEqual(a.citations[0].lineEnd, 20);
	assert.ok(a.citations[0].snippet.includes("FiberNode"));
});

test("DeepWiki: parseAskQuestionResult falls back to plain markdown", () => {
	const rpc = {
		result: { content: [{ type: "text", text: "Just a plain answer." }] },
	};
	const a = parseAskQuestionResult(rpc);
	assert.strictEqual(a.answer, "Just a plain answer.");
	assert.strictEqual(a.citations.length, 0);
});

test("DeepWiki: parseAskQuestionResult returns null on error/empty", () => {
	assert.strictEqual(parseAskQuestionResult(null), null);
	assert.strictEqual(parseAskQuestionResult({ error: { message: "x" } }), null);
	assert.strictEqual(parseAskQuestionResult({ result: { isError: true } }), null);
	assert.strictEqual(parseAskQuestionResult({ result: {} }), null);
});

test("DeepWiki: formatDeepWikiCitations renders ranges + snippets", () => {
	const md = formatDeepWikiCitations([
		{ filePath: "a.ts", lineStart: 1, lineEnd: 5, snippet: "code" },
		{ filePath: "b.ts" },
	]);
	assert.ok(md.includes("`a.ts` (lines 1-5)"));
	assert.ok(md.includes("`b.ts`"));
	assert.ok(md.includes("code"));
	assert.strictEqual(formatDeepWikiCitations([]), "");
});

// ─── DeepWiki: full JSON-RPC flow ──────────────────────────────────

/**
 * Stub fetch for the DeepWiki MCP server. Routes by the JSON-RPC method in
 * the request body. Captures the mcp-session-id header sent on each call.
 */
function stubDeepWikiFetch(opts = {}) {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (_url, init = {}) => {
		const body = JSON.parse(init.body || "{}");
		const headers = init.headers || {};
		calls.push({ method: body.method, sessionId: headers["mcp-session-id"] });

		if (body.method === "initialize") {
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: { protocolVersion: "2025-03-26", capabilities: {} },
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						"mcp-session-id": "sess-123",
					},
				},
			);
		}
		if (body.method === "notifications/initialized") {
			return new Response("", { status: 202 });
		}
		if (body.method === "tools/call") {
			const payload = opts.answer ?? {
				answer: "The answer.",
				citations: [],
			};
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("{}", { status: 200 });
	};
	return {
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

test("DeepWiki: full flow returns answer + citations, forwards session", async () => {
	const stub = stubDeepWikiFetch({
		answer: {
			answer: "Next.js uses a router.",
			citations: [
				{ file_path: "packages/next/router.ts", line_start: 1, line_end: 9 },
			],
		},
	});
	try {
		const result = await extractDeepWiki(
			"https://deepwiki.com/vercel/next.js?q=How does routing work?",
		);
		assert.strictEqual(result?.ok, true);
		assert.ok(result.content.includes("Next.js uses a router."));
		assert.ok(result.content.includes("`packages/next/router.ts` (lines 1-9)"));
		assert.ok(result.content.includes("How does routing work?"));

		// Handshake order: initialize → initialized → tools/call.
		const methods = stub.calls.map((c) => c.method);
		assert.deepEqual(methods, [
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		// The session id from initialize must be forwarded on later calls.
		const toolCall = stub.calls.find((c) => c.method === "tools/call");
		assert.strictEqual(toolCall.sessionId, "sess-123");
	} finally {
		stub.restore();
	}
});

test("DeepWiki: HTTP error surfaces a structured error", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init = {}) => {
		const body = JSON.parse(init.body || "{}");
		if (body.method === "initialize") {
			return new Response("{}", { status: 200 });
		}
		return new Response("boom", { status: 503 });
	};
	try {
		const result = await extractDeepWiki("https://deepwiki.com/foo/bar");
		assert.strictEqual(result?.ok, false);
		assert.strictEqual(result?.content, "");
		assert.ok(/503/.test(result?.error ?? ""));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ─── Registry wiring ───────────────────────────────────────────────

test("Registry: routes context7 + deepwiki URLs to the new verticals", () => {
	assert.strictEqual(
		findVerticalExtractor("https://context7.com/reactjs/react.dev"),
		"context7",
	);
	assert.strictEqual(
		findVerticalExtractor("https://deepwiki.com/facebook/react"),
		"deepwiki",
	);
});

test("Registry: runVerticalExtractor dispatches to Context7", async () => {
	const stub = stubContext7Fetch({ docsBody: "Dispatched docs." });
	try {
		const noop = async () => null;
		const result = await runVerticalExtractor(
			"https://context7.com/library/react",
			noop,
			noop,
			noop,
		);
		assert.strictEqual(result?.ok, true);
		assert.ok(result.content.includes("Dispatched docs."));
	} finally {
		stub.restore();
	}
});
