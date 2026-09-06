import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createStaticWebFetcher,
	DEFAULT_MAX_RESPONSE_BYTES,
} from "../src/webfetch-api.ts";

const encoder = new TextEncoder();

function response({
	url = "https://example.test/",
	status = 200,
	statusText = status === 200 ? "OK" : "",
	headers = {},
	body = "",
} = {}) {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	return {
		url,
		status,
		statusText,
		ok: status >= 200 && status < 300,
		headers: new Headers(headers),
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	};
}

function runtime(overrides = {}) {
	const calls = {
		validated: [],
		transports: [],
		requests: [],
		closed: 0,
		sleeps: [],
	};
	const dependencies = {
		validateUrl: async (url) => {
			calls.validated.push(url);
			return { dangerous: false, pinnedIps: ["93.184.216.34"] };
		},
		createTransport: async (options) => {
			calls.transports.push(options);
			return {
				async close() {
					calls.closed += 1;
				},
			};
		},
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return response({
				url,
				headers: { "content-type": "text/plain" },
				body: "ok",
			});
		},
		sleep: async (ms) => {
			calls.sleeps.push(ms);
		},
		...overrides,
	};
	return { fetchPage: createStaticWebFetcher(dependencies), calls };
}

test("rejects unsupported protocols before validation or transport", async () => {
	const { fetchPage, calls } = runtime();
	const result = await fetchPage("file:///etc/passwd");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "unsupported_protocol");
	assert.deepEqual(calls.validated, []);
	assert.deepEqual(calls.transports, []);
});

test("blocks an SSRF verdict before opening a transport", async () => {
	const { fetchPage, calls } = runtime({
		validateUrl: async (url) => {
			calls.validated.push(url);
			return { dangerous: true, reason: "private-range", pinnedIps: [] };
		},
	});
	const result = await fetchPage("http://127.0.0.1/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "blocked_ssrf");
	assert.deepEqual(calls.transports, []);
});

test("fails closed when a hostname has no validated DNS pins", async () => {
	const { fetchPage, calls } = runtime({
		validateUrl: async (url) => {
			calls.validated.push(url);
			return { dangerous: false, pinnedIps: [] };
		},
	});
	const result = await fetchPage("https://example.test/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "dns_error");
	assert.deepEqual(calls.transports, []);
});

test("validates and DNS-pins every redirect hop", async () => {
	const responses = [
		response({
			url: "https://a.example/start",
			status: 302,
			headers: { location: "https://b.example/final" },
		}),
		response({
			url: "https://b.example/final",
			headers: { "content-type": "text/plain" },
			body: "redirected",
		}),
	];
	const pins = {
		"https://a.example/start": ["203.0.113.10"],
		"https://b.example/final": ["203.0.113.11"],
	};
	const { fetchPage, calls } = runtime({
		validateUrl: async (url) => {
			calls.validated.push(url);
			return { dangerous: false, pinnedIps: pins[url] };
		},
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return responses.shift();
		},
	});
	const result = await fetchPage("https://a.example/start", {
		format: "raw",
		headers: {
			Authorization: "Bearer test-token",
			Cookie: "sid=secret",
			"X-API-Key": "redirect-secret",
			"X-Trace": "drop",
			"User-Agent": "Static fetch test",
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.finalUrl, "https://b.example/final");
	assert.equal(result.content, "redirected");
	assert.deepEqual(result.redirects, ["https://b.example/final"]);
	assert.deepEqual(calls.validated, [
		"https://a.example/start",
		"https://b.example/final",
	]);
	assert.deepEqual(calls.transports[0].resolve, {
		"a.example": ["203.0.113.10"],
	});
	assert.deepEqual(calls.transports[1].resolve, {
		"b.example": ["203.0.113.11"],
	});
	assert.equal(calls.requests[0].init.redirect, "manual");
	assert.equal(calls.requests[1].init.headers.Authorization, undefined);
	assert.equal(calls.requests[1].init.headers.Cookie, undefined);
	assert.equal(calls.requests[1].init.headers["X-API-Key"], undefined);
	assert.equal(calls.requests[1].init.headers["X-Trace"], undefined);
	assert.equal(calls.requests[1].init.headers["User-Agent"], "Static fetch test");
	assert.equal(calls.closed, 2);
});

test("detects a client-side redirect loop without issuing a repeated request", async () => {
	const start = "https://example.test/start";
	const final = "https://example.test/final";
	const responses = [
		response({
			url: start,
			headers: { "content-type": "text/html" },
			body: '<meta http-equiv="refresh" content="0; url=/final">',
		}),
		response({
			url: final,
			headers: { "content-type": "text/html" },
			body: '<script>location.replace("/start")</script>',
		}),
	];
	const { fetchPage, calls } = runtime({
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return responses.shift();
		},
	});
	const result = await fetchPage(start, { format: "raw" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "redirect_loop");
	assert.equal(calls.requests.length, 2);
});

test("blocks a redirect target before issuing the second request", async () => {
	const { fetchPage, calls } = runtime({
		validateUrl: async (url) => {
			calls.validated.push(url);
			return url.includes("127.0.0.1")
				? { dangerous: true, reason: "private-range", pinnedIps: [] }
				: { dangerous: false, pinnedIps: ["93.184.216.34"] };
		},
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return response({
				url,
				status: 302,
				headers: { location: "http://127.0.0.1/admin" },
			});
		},
	});
	const result = await fetchPage("https://example.test/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "blocked_ssrf");
	assert.equal(calls.requests.length, 1);
});

test("follows a literal client-side redirect through the same guard", async () => {
	const first = "https://example.test/start";
	const second = "https://example.test/final";
	const responses = [
		response({
			url: first,
			headers: { "content-type": "text/html" },
			body: '<meta http-equiv="refresh" content="0; url=/final">',
		}),
		response({
			url: second,
			headers: { "content-type": "text/plain" },
			body: "done",
		}),
	];
	const { fetchPage, calls } = runtime({
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return responses.shift();
		},
	});
	const result = await fetchPage(first, { format: "raw" });
	assert.equal(result.ok, true);
	assert.equal(result.finalUrl, second);
	assert.deepEqual(calls.validated, [first, second]);
});

test("drops custom headers across a client-side cross-origin redirect", async () => {
	const responses = [
		response({
			url: "https://a.example/start",
			headers: { "content-type": "text/html" },
			body: '<meta http-equiv="refresh" content="0; url=https://b.example/final">',
		}),
		response({
			url: "https://b.example/final",
			headers: { "content-type": "text/plain" },
			body: "done",
		}),
	];
	const { fetchPage, calls } = runtime({
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return responses.shift();
		},
	});
	const result = await fetchPage("https://a.example/start", {
		format: "raw",
		headers: { "X-API-Key": "do-not-forward", "X-Trace": "drop" },
	});
	assert.equal(result.ok, true);
	assert.equal(calls.requests[1].init.headers["X-API-Key"], undefined);
	assert.equal(calls.requests[1].init.headers["X-Trace"], undefined);
});

test("validates and pins an explicit proxy separately from the target", async () => {
	const { fetchPage, calls } = runtime({
		validateUrl: async (url) => {
			calls.validated.push(url);
			return {
				dangerous: false,
				pinnedIps: [url.includes("proxy") ? "203.0.113.20" : "203.0.113.10"],
			};
		},
	});
	const result = await fetchPage("https://example.test/", {
		format: "raw",
		proxy: "http://proxy.example:8080/",
	});
	assert.equal(result.ok, true);
	assert.equal(result.proxyUsed, true);
	assert.equal(result.targetPinning, "proxy-dependent");
	assert.deepEqual(calls.validated, [
		"http://proxy.example:8080/",
		"https://example.test/",
	]);
	assert.deepEqual(calls.transports[0].resolve, {
		"example.test": ["203.0.113.10"],
		"proxy.example": ["203.0.113.20"],
	});
});

test("rejects a declared body larger than the configured input cap", async () => {
	const { fetchPage, calls } = runtime({
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return response({
				url,
				headers: {
					"content-type": "text/plain",
					"content-length": String(DEFAULT_MAX_RESPONSE_BYTES + 1),
				},
				body: "small lie",
			});
		},
	});
	const result = await fetchPage("https://example.test/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "response_too_large");
	assert.equal(calls.closed, 1);
});

test("stops an undeclared stream when it crosses the input cap", async () => {
	let cancelled = false;
	const body = {
		getReader() {
			let reads = 0;
			return {
				async read() {
					reads += 1;
					if (reads <= 2) return { done: false, value: new Uint8Array(6) };
					return { done: true };
				},
				async cancel() {
					cancelled = true;
				},
			};
		},
	};
	const { fetchPage } = runtime({
		request: async (url) => ({
			...response({ url, headers: { "content-type": "text/plain" } }),
			body,
		}),
	});
	const result = await fetchPage("https://example.test/", {
		maxResponseBytes: 10,
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "response_too_large");
	assert.equal(cancelled, true);
});

test("applies the input cap across client-side redirect responses", async () => {
	const firstBody = '<meta http-equiv="refresh" content="0; url=/next">';
	const responses = [
		response({
			url: "https://example.test/start",
			headers: { "content-type": "text/html" },
			body: firstBody,
		}),
		response({
			url: "https://example.test/next",
			headers: { "content-type": "text/plain" },
			body: "more than four bytes",
		}),
	];
	const { fetchPage } = runtime({ request: async () => responses.shift() });
	const result = await fetchPage("https://example.test/start", {
		maxResponseBytes: encoder.encode(firstBody).byteLength + 4,
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "response_too_large");
});

test("charges failed partial streams against the retry byte budget", async () => {
	let attempts = 0;
	const { fetchPage, calls } = runtime({
		request: async (url, init) => {
			calls.requests.push({ url, init });
			attempts += 1;
			let reads = 0;
			return {
				...response({ url, headers: { "content-type": "text/plain" } }),
				body: {
					getReader() {
						return {
							async read() {
								reads += 1;
								if (reads === 1) {
									return {
										done: false,
										value: encoder.encode(attempts === 1 ? "12345678" : "123"),
									};
								}
								if (attempts === 1) {
									throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
								}
								return { done: true, value: undefined };
							},
							async cancel() {},
						};
					},
				},
			};
		},
	});
	const result = await fetchPage("https://example.test/", {
		format: "raw",
		maxResponseBytes: 10,
		maxRetries: 1,
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "response_too_large");
	assert.equal(calls.requests.length, 2);
});

test("returns an aborted result before opening a transport", async () => {
	const controller = new AbortController();
	controller.abort();
	const { fetchPage, calls } = runtime();
	const result = await fetchPage("https://example.test/", {
		signal: controller.signal,
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	assert.deepEqual(calls.transports, []);
});

test("closes a transport that finishes creating after cancellation", async () => {
	let resolveTransport;
	let closed = 0;
	const transport = {
		async close() {
			closed += 1;
		},
	};
	const { fetchPage, calls } = runtime({
		createTransport: () =>
			new Promise((resolve) => {
				resolveTransport = resolve;
			}),
	});
	const controller = new AbortController();
	const pending = fetchPage("https://example.test/", {
		signal: controller.signal,
	});
	while (!resolveTransport) await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	resolveTransport(transport);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(closed, 1);
});

test("the call timeout bounds a hanging transport close", async () => {
	const { fetchPage } = runtime({
		createTransport: async () => ({ close: () => new Promise(() => {}) }),
	});
	const startedAt = Date.now();
	const result = await fetchPage("https://example.test/", {
		format: "raw",
		timeoutMs: 5,
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "timeout");
	assert.ok(Date.now() - startedAt < 100);
});

test("cancels a response that arrives after cancellation", async () => {
	let resolveRequest;
	let cancelled = false;
	const lateResponse = response({
		url: "https://example.test/",
		headers: { "content-type": "text/plain" },
		body: "late",
	});
	lateResponse.body = {
		getReader: lateResponse.body.getReader.bind(lateResponse.body),
		async cancel() {
			cancelled = true;
		},
	};
	const { fetchPage } = runtime({
		request: () =>
			new Promise((resolve) => {
				resolveRequest = resolve;
			}),
	});
	const controller = new AbortController();
	const pending = fetchPage("https://example.test/", {
		signal: controller.signal,
	});
	while (!resolveRequest) await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	resolveRequest(lateResponse);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cancelled, true);
});

test("cancels a pending body read and closes the transport", async () => {
	let cancelled = false;
	const body = {
		getReader() {
			return {
				read: () => new Promise(() => {}),
				async cancel() {
					cancelled = true;
				},
			};
		},
	};
	const { fetchPage, calls } = runtime({
		request: async (url) => ({
			...response({ url, headers: { "content-type": "text/plain" } }),
			body,
		}),
	});
	const controller = new AbortController();
	const pending = fetchPage("https://example.test/", {
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 5);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	assert.equal(cancelled, true);
	assert.equal(calls.closed, 1);
});

test("destroys a PDF parser when extraction is cancelled", async () => {
	let parserStarted = false;
	let destroyed = 0;
	class FakePdfParser {
		constructor() {}
		load() {
			parserStarted = true;
			return new Promise(() => {});
		}
		async getText() {
			return { text: "", total: 0 };
		}
		async destroy() {
			destroyed += 1;
		}
	}
	const { fetchPage } = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "application/pdf" },
				body: encoder.encode("%PDF-test"),
			}),
		loadPdfParser: async () => FakePdfParser,
	});
	const controller = new AbortController();
	const pending = fetchPage("https://example.test/file.pdf", {
		signal: controller.signal,
	});
	while (!parserStarted) await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	assert.equal(destroyed, 1);
});

test("detects a mislabeled PDF and destroys the parser after success", async () => {
	let destroyed = 0;
	class FakePdfParser {
		constructor() {}
		async load() {}
		async getText() {
			return { text: "PDF body text", total: 1 };
		}
		async destroy() {
			destroyed += 1;
		}
	}
	const { fetchPage } = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "text/plain" },
				body: encoder.encode("%PDF-test"),
			}),
		loadPdfParser: async () => FakePdfParser,
	});
	const result = await fetchPage("https://example.test/file.pdf", {
		format: "text",
	});
	assert.equal(result.ok, true);
	assert.equal(result.content, "PDF body text");
	assert.equal(result.contentType, "application/pdf");
	assert.equal(destroyed, 1);
});

test("closes a failed attempt before retry backoff", async () => {
	const responses = [
		response({ url: "https://example.test/", status: 503 }),
		response({
			url: "https://example.test/",
			headers: { "content-type": "text/plain" },
			body: "recovered",
		}),
	];
	const events = [];
	const { fetchPage, calls } = runtime({
		createTransport: async (options) => {
			calls.transports.push(options);
			return {
				async close() {
					calls.closed += 1;
					events.push("close");
				},
			};
		},
		request: async (url, init) => {
			calls.requests.push({ url, init });
			return responses.shift();
		},
		sleep: async (ms) => {
			calls.sleeps.push(ms);
			events.push("sleep");
		},
	});
	const result = await fetchPage("https://example.test/", {
		format: "raw",
		maxRetries: 1,
	});
	assert.equal(result.ok, true);
	assert.equal(result.content, "recovered");
	assert.equal(calls.requests.length, 2);
	assert.equal(calls.transports.length, 2);
	assert.equal(calls.closed, 2);
	assert.equal(calls.sleeps.length, 1);
	assert.deepEqual(events.slice(0, 2), ["close", "sleep"]);
});

test("extracts markdown locally and forwards image and reply controls", async () => {
	const html = `<!doctype html><html lang="en"><head>
		<title>Example article</title>
		<meta name="author" content="A. Writer">
	</head><body><main><article><h1>Example article</h1>
		<p>This paragraph contains enough useful words for a stable extraction result in the local test.</p>
		<img src="https://example.test/image.png" alt="diagram">
	</article></main></body></html>`;
	const { fetchPage } = runtime({
		request: async (url) =>
			response({ url, headers: { "content-type": "text/html" }, body: html }),
	});
	const result = await fetchPage("https://example.test/article", {
		removeImages: true,
		includeReplies: false,
	});
	assert.equal(result.ok, true);
	assert.equal(result.format, "markdown");
	assert.equal(result.title, "Example article");
	assert.match(result.content, /enough useful words/);
	assert.doesNotMatch(result.content, /image\.png|diagram/);
	assert.equal(result.browserEscalated, false);
	assert.equal(result.remoteFallbackUsed, false);
	assert.equal(result.persisted, false);
});

test("prevents Defuddle site extractors from opening additional network requests", async () => {
	const originalFetch = globalThis.fetch;
	let unexpectedRequests = 0;
	globalThis.fetch = async () => {
		unexpectedRequests += 1;
		throw new Error("unexpected global fetch");
	};
	try {
		const html = `<!doctype html><html><head><title>Post</title></head><body>
			<main><h1>Post</h1><p>Locally supplied fallback content remains readable.</p></main>
		</body></html>`;
		const { fetchPage } = runtime({
			request: async () =>
				response({
					url: "https://x.com/user/status/123",
					headers: { "content-type": "text/html" },
					body: html,
				}),
		});
		const result = await fetchPage("https://x.com/user/status/123");
		assert.equal(result.ok, true);
		assert.match(result.content, /fallback content/);
		assert.equal(unexpectedRequests, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("supports raw, JSON, text, and cleaned HTML output", async () => {
	const jsonBody = '{"ok":true,"items":[1,2]}';
	const jsonRuntime = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "application/json" },
				body: jsonBody,
			}),
	});
	const raw = await jsonRuntime.fetchPage("https://example.test/data", {
		format: "raw",
	});
	assert.equal(raw.ok, true);
	assert.equal(raw.content, jsonBody);

	const json = await jsonRuntime.fetchPage("https://example.test/data", {
		format: "json",
	});
	assert.equal(json.ok, true);
	assert.equal(json.content, '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}');

	const htmlBody = "<html><head><title>T</title></head><body><main><h1>Heading</h1><p>Readable body.</p></main></body></html>";
	const htmlRuntime = runtime({
		request: async (url) =>
			response({ url, headers: { "content-type": "text/html" }, body: htmlBody }),
	});
	const text = await htmlRuntime.fetchPage("https://example.test/page", {
		format: "text",
	});
	assert.equal(text.ok, true);
	assert.match(text.content, /Heading/);
	assert.doesNotMatch(text.content, /<h1>/i);

	const html = await htmlRuntime.fetchPage("https://example.test/page", {
		format: "html",
	});
	assert.equal(html.ok, true);
	assert.match(html.content, /<H2>Heading<\/H2>|<h2>Heading<\/h2>/);
});

test("enforces format behavior across JSON, XML, text, and binary MIME types", async () => {
	const plainRuntime = runtime({
		request: async (url) =>
			response({ url, headers: { "content-type": "text/plain" }, body: "plain" }),
	});
	const htmlFromText = await plainRuntime.fetchPage("https://example.test/plain", {
		format: "html",
	});
	assert.equal(htmlFromText.ok, false);
	assert.equal(htmlFromText.error.code, "unexpected_content_type");

	const xmlRuntime = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "application/xml" },
				body: "<root><value>Readable XML</value></root>",
			}),
	});
	const xmlText = await xmlRuntime.fetchPage("https://example.test/data.xml", {
		format: "text",
	});
	assert.equal(xmlText.ok, true);
	assert.equal(xmlText.content, "Readable XML");

	const latinRuntime = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "text/plain; charset=iso-8859-1" },
				body: new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
			}),
	});
	const latin = await latinRuntime.fetchPage("https://example.test/latin", {
		format: "raw",
	});
	assert.equal(latin.ok, true);
	assert.equal(latin.content, "café");

	const invalidJsonRuntime = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "application/json" },
				body: "{",
			}),
	});
	const invalidJson = await invalidJsonRuntime.fetchPage(
		"https://example.test/data",
		{ format: "json" },
	);
	assert.equal(invalidJson.ok, false);
	assert.equal(invalidJson.error.code, "parse_error");

	for (const headers of [
		{ "content-type": "application/octet-stream" },
		{ "content-type": "text/plain" },
		{},
	]) {
		const binaryRuntime = runtime({
			request: async (url) =>
				response({
					url,
					headers,
					body: new Uint8Array([0, 1, 2, 0xff]),
				}),
		});
		const binary = await binaryRuntime.fetchPage("https://example.test/file", {
			format: "raw",
		});
		assert.equal(binary.ok, false, JSON.stringify(headers));
		assert.equal(binary.error.code, "binary_content");
	}
});

test("redacts encoded and low-entropy credentials from successful URL metadata", async () => {
	for (const secretUrl of [
		"https://example.test/path?token=%61%42%63%31%32%33",
		"https://example.test/path?%74oken=abc",
		"https://example.test/path?access_token=abc",
		"https://example.test/path?refresh_token=abc",
		"https://example.test/path?id_token=abc",
		"https://example.test/path#section?token=abc",
	]) {
		const { fetchPage } = runtime({
			request: async () =>
				response({
					url: secretUrl,
					headers: { "content-type": "text/plain" },
					body: "ok",
				}),
		});
		const result = await fetchPage(secretUrl, { format: "raw" });
		assert.equal(result.ok, true, secretUrl);
		assert.doesNotMatch(
			result.url,
			/%61%42%63|%74oken|(?:access_|refresh_|id_)?token=abc/i,
		);
		assert.doesNotMatch(
			result.finalUrl,
			/%61%42%63|%74oken|(?:access_|refresh_|id_)?token=abc/i,
		);
	}
});

test("redacts credential-like redirect URLs from successful metadata", async () => {
	const redirected = "https://b.example/final?token=aBcd1234-ZYX9876";
	const responses = [
		response({
			url: "https://a.example/start",
			status: 302,
			headers: { location: redirected },
		}),
		response({
			url: redirected,
			headers: { "content-type": "text/plain" },
			body: "ok",
		}),
	];
	const { fetchPage } = runtime({ request: async () => responses.shift() });
	const result = await fetchPage("https://a.example/start", { format: "raw" });
	assert.equal(result.ok, true);
	assert.doesNotMatch(result.finalUrl, /aBcd1234-ZYX9876/);
	assert.doesNotMatch(result.redirects[0], /aBcd1234-ZYX9876/);
});

test("redacts malformed secret-bearing URLs from fields and errors", async () => {
	const { fetchPage } = runtime();
	const result = await fetchPage("https://[bad]/?foo=1;access_token=abc");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalid_url");
	assert.doesNotMatch(result.url, /access_token=abc/);
	assert.doesNotMatch(result.error.message, /access_token=abc/);
});

test("redacts secret-bearing URLs embedded in transport errors", async () => {
	const { fetchPage } = runtime({
		request: async () => {
			throw new Error("Request failed for https://example.test/?access_token=abc");
		},
	});
	const result = await fetchPage("https://example.test/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "connect_error");
	assert.doesNotMatch(result.error.message, /access_token=abc/);
});

test("a transport-creation failure is a connecting error, not an unknown download error", async () => {
	// createTransport is awaited outside the request loop's try, so its
	// rejection must go through classifyTransportError too — otherwise an
	// unrecognized throw surfaces as the catch-all's "unknown" at phase
	// "downloading", a phase that never even started.
	const { fetchPage } = runtime({
		createTransport: async () => {
			throw new Error("quantum flux overflow");
		},
	});
	const result = await fetchPage("https://example.test/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "connect_error");
	assert.equal(result.error.phase, "connecting");
	assert.equal(result.error.category, "network");
	assert.match(result.error.message, /quantum flux overflow/);
});

test("redacts secret-bearing URLs from validation failures", async () => {
	const { fetchPage, calls } = runtime();
	const result = await fetchPage("https://user:secret-value@example.test/path");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "blocked_secret");
	assert.doesNotMatch(result.url, /secret-value/);
	assert.equal(calls.requests.length, 0);
});

test("accepts every public wreq browser alias", async () => {
	for (const browser of [
		"chrome",
		"edge",
		"firefox",
		"firefox_android",
		"firefox_private",
		"okhttp",
		"opera",
		"safari",
		"safari_ios",
		"safari_ipad",
	]) {
		const { fetchPage } = runtime();
		const result = await fetchPage("https://example.test/", {
			browser,
			format: "raw",
		});
		assert.equal(result.ok, true, browser);
	}
});

test("rejects invalid resource limits before network work", async () => {
	const { fetchPage, calls } = runtime();
	const result = await fetchPage("https://example.test/", { maxResponseBytes: 0 });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalid_option");
	assert.deepEqual(calls.validated, []);
	assert.deepEqual(calls.transports, []);

	const invalidUrl = await fetchPage(12345);
	assert.equal(invalidUrl.ok, false);
	assert.equal(invalidUrl.error.code, "invalid_url");
	for (const invalidOptions of [
		null,
		[],
		{ headers: ["bad"] },
		{ headers: { "X-Bad\nName": "value" } },
		{ headers: { "X-Test": "ok\r\nInjected: yes" } },
		{ headers: { Host: "attacker.test" } },
		{ headers: { "Content-Length": "1" } },
		{ proxy: 123 },
		{ unexpected: true },
		{ format: "xml" },
		{ browser: "netscape_4" },
		{ browser: "chrome_999" },
		{ os: "plan9" },
		{ removeImages: "yes" },
		{ includeReplies: "all" },
		{ signal: { aborted: false, addEventListener() {} } },
	]) {
		const invalid = await fetchPage("https://example.test/", invalidOptions);
		assert.equal(invalid.ok, false, JSON.stringify(invalidOptions));
		assert.equal(invalid.error.code, "invalid_option");
	}
	assert.deepEqual(calls.validated, []);
});

test("applies the caller's output bound without writing content state", async () => {
	const { fetchPage } = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "text/plain" },
				body: "one two three",
			}),
	});
	const result = await fetchPage("https://example.test/", {
		format: "raw",
		maxChars: 5,
	});
	assert.equal(result.ok, true);
	assert.equal(result.content, "one t");
	assert.equal(result.truncated, true);
	assert.equal(result.wordCount, 3);
	assert.equal(result.fullContentChars, 13);
	assert.equal(result.outputChars, 5);
	assert.equal(result.persisted, false);
});

test("the supported entrypoint has no browser, search, remote-reader, or storage imports", async () => {
	const source = [
		await readFile(new URL("../src/webfetch.ts", import.meta.url), "utf8"),
		await readFile(new URL("../src/webfetch-api.ts", import.meta.url), "utf8"),
	].join("\n");
	assert.doesNotMatch(
		source,
		/from ["']\.\/(?:browser|search|fetch-jina|session-store|storage|tools\/webfetch)/,
	);
	assert.doesNotMatch(source, /node:fs/);

	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.deepEqual(manifest.exports["./webfetch"], {
		types: "./dist/src/webfetch.d.ts",
		import: "./dist/src/webfetch.js",
	});
});

// ─── Shared error taxonomy (src/tools/fetch-error.ts) ──────────────

test("reports a corrupt PDF as a non-retryable parse_error, not a network error", async () => {
	let destroyed = 0;
	class BrokenPdfParser {
		constructor() {}
		async load() {
			throw new Error("Invalid PDF structure");
		}
		async getText() {
			return { text: "", total: 0 };
		}
		async destroy() {
			destroyed += 1;
		}
	}
	const { fetchPage } = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "application/pdf" },
				body: encoder.encode("%PDF-1.4 not really a pdf"),
			}),
		loadPdfParser: async () => BrokenPdfParser,
	});
	const result = await fetchPage("https://example.test/broken.pdf", {
		format: "markdown",
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "parse_error");
	assert.equal(result.error.phase, "processing");
	assert.equal(result.error.category, "processing");
	assert.equal(result.error.retryable, false);
	assert.match(result.error.message, /Invalid PDF structure/);
	// The parser is still destroyed on the failure path.
	assert.equal(destroyed, 1);
});

test("reports a missing PDF parser as parse_error, not a network error", async () => {
	const { fetchPage } = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "application/pdf" },
				body: encoder.encode("%PDF-1.4 body"),
			}),
		loadPdfParser: async () => {
			throw new Error("pdf-parse did not export PDFParse");
		},
	});
	const result = await fetchPage("https://example.test/doc.pdf");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "parse_error");
	assert.equal(result.error.phase, "processing");
	assert.equal(result.error.retryable, false);
});

test("every failure carries a category from the shared taxonomy", async () => {
	const { fetchErrorCategory } = await import("../src/tools/fetch-error.ts");
	const cases = [
		[runtime(), "file:///etc/passwd", undefined],
		[
			runtime({
				validateUrl: async () => ({
					dangerous: true,
					reason: "private-range",
					pinnedIps: [],
				}),
			}),
			"http://127.0.0.1/",
			undefined,
		],
		[runtime(), "https://example.test/", { format: "nope" }],
		[
			runtime({
				request: async (url) =>
					response({ url, status: 503, statusText: "Unavailable" }),
			}),
			"https://example.test/",
			undefined,
		],
	];
	for (const [harness, url, options] of cases) {
		const result = await harness.fetchPage(url, options);
		assert.equal(result.ok, false, url);
		assert.equal(
			result.error.category,
			fetchErrorCategory(result.error.code),
			`${result.error.code} should map to its canonical category`,
		);
	}
});

test("uses canonical phase names, never the retired 'loading' phase", async () => {
	const { fetchPage } = runtime({
		request: async (url) =>
			response({ url, status: 503, statusText: "Service Unavailable" }),
	});
	const result = await fetchPage("https://example.test/");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "http_error");
	assert.equal(result.error.phase, "headers");

	const loop = runtime({
		request: async () =>
			response({
				url: "https://a.example/one",
				status: 302,
				headers: { location: "https://a.example/two" },
			}),
	});
	const loopResult = await loop.fetchPage("https://a.example/one", {
		maxRedirects: 1,
	});
	assert.equal(loopResult.ok, false);
	assert.equal(loopResult.error.code, "too_many_redirects");
	assert.equal(loopResult.error.phase, "headers");

	const oversized = runtime({
		request: async (url) =>
			response({
				url,
				headers: { "content-type": "text/plain", "content-length": "99999999" },
				body: "small",
			}),
	});
	const oversizedResult = await oversized.fetchPage("https://example.test/", {
		maxResponseBytes: 1024,
	});
	assert.equal(oversizedResult.ok, false);
	assert.equal(oversizedResult.error.code, "response_too_large");
	assert.equal(oversizedResult.error.phase, "downloading");
});

// ─── Shared leaf helpers (no forked copies) ────────────────────────

test("shares the client-redirect and text helpers with the extraction pipeline", async () => {
	const api = await readFile(
		new URL("../src/webfetch-api.ts", import.meta.url),
		"utf8",
	);
	const content = await readFile(
		new URL("../src/content.ts", import.meta.url),
		"utf8",
	);

	// Both surfaces import the dependency-free leaves...
	assert.match(api, /from "\.\/client-redirect\.ts"/);
	assert.match(content, /from "\.\/client-redirect\.ts"/);
	assert.match(api, /from "\.\/http-text\.ts"/);
	assert.match(content, /from "\.\/http-text\.ts"/);

	// ...and neither keeps a forked copy that could drift.
	for (const forked of [
		"function clientRedirectTarget(",
		"function textFromHtml(",
		"function decodeBody(",
		"function contentTypeOf(",
		"function binarySignature(",
		"function looksBinary(",
		"function isJson(",
		"function isHtml(",
		"function isText(",
	]) {
		assert.equal(api.includes(forked), false, `webfetch-api.ts still forks ${forked}`);
	}
	for (const forked of [
		"function cleanText(",
		"export function isJsonContentType(",
		"export function isLikelyJsonBody(",
		"export function extractClientSideRedirect(",
	]) {
		assert.equal(content.includes(forked), false, `content.ts still forks ${forked}`);
	}
});

test("the shared client-redirect leaf has no pipeline imports", async () => {
	const source = await readFile(
		new URL("../src/client-redirect.ts", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(source, /^import /m);
	assert.doesNotMatch(source, /node:fs/);
});
