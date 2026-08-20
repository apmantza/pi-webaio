import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EventEmitter } from "node:events";
import {
	GoogleCdpBrokerClient,
	GoogleCdpBrokerClientError,
} from "../extractors/google-cdp-broker-client.mjs";

function startFakeBroker({ delaySearchMs = 0 } = {}) {
	let searchDelayMs = delaySearchMs;
	const cancelRequests = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line);
				if (request.op === "register") {
					socket.write(
						`${JSON.stringify({
							id: request.id,
							ok: true,
							result: {
								clientId: request.clientId,
								sessionId: request.sessionId,
								capability: "fake-capability-012345678901234567890123456789",
							},
						})}\n`,
					);
				} else if (request.op === "cancel") {
					cancelRequests.push(request);
					socket.write(
						`${JSON.stringify({
							id: request.id,
							ok: true,
							result: { cancelled: true, requestId: request.requestId },
						})}\n`,
					);
				} else if (request.op === "search") {
					// Mirror the real broker: search requires provider "google-search".
					if (request.provider !== "google-search") {
						socket.write(
							`${JSON.stringify({
								id: request.id,
								ok: false,
								error: {
									code: "unsupported_provider",
									message: "Search is only available for provider google-search",
								},
							})}\n`,
						);
						return;
					}
					setTimeout(() => {
						if (!socket.destroyed)
							socket.write(
								`${JSON.stringify({
									id: request.id,
									ok: true,
									result: {
										query: request.query,
										url: "https://www.google.com/search",
										results: [],
									},
								})}\n`,
							);
					}, searchDelayMs);
				}
			}
		});
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				server,
				path: String(server.address().port),
				cancelRequests,
				setSearchDelayMs: (value) => {
					searchDelayMs = value;
				},
			}),
		),
	);
}

test("client registers once, frames high-level search, and closes cleanly", async () => {
	const fake = await startFakeBroker();
	const client = new GoogleCdpBrokerClient({
		socketPath: fake.path,
		connectImpl: (path) =>
			net.createConnection({ port: Number(path), host: "127.0.0.1" }),
	});
	try {
		const first = await client.search("one", { deadlineAt: Date.now() + 1000 });
		const second = await client.search("two", {
			deadlineAt: Date.now() + 1000,
		});
		assert.equal(first.query, "one");
		assert.equal(second.query, "two");
		assert.equal(
			client.identity().sessionId.startsWith("pi-webaio-session-"),
			true,
		);
	} finally {
		client.close();
		await new Promise((resolve) => fake.server.close(resolve));
	}
});

test("client fences an aborted request and sends broker cancellation", async () => {
	const fake = await startFakeBroker({ delaySearchMs: 200 });
	const client = new GoogleCdpBrokerClient({
		socketPath: fake.path,
		connectImpl: (path) =>
			net.createConnection({ port: Number(path), host: "127.0.0.1" }),
	});
	const controller = new AbortController();
	try {
		const pending = client.search("cancel-me", {
			deadlineAt: Date.now() + 1000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(
			pending,
			(error) =>
				error instanceof GoogleCdpBrokerClientError &&
				error.code === "request_fenced",
		);
	} finally {
		client.close();
		await new Promise((resolve) => fake.server.close(resolve));
	}
});

test("client reports request deadline expiry separately from caller cancellation", async () => {
	const fake = await startFakeBroker({ delaySearchMs: 600 });
	const client = new GoogleCdpBrokerClient({
		socketPath: fake.path,
		connectImpl: (path) =>
			net.createConnection({ port: Number(path), host: "127.0.0.1" }),
	});
	try {
		await assert.rejects(
			client.search("deadline-me", { deadlineAt: Date.now() + 300 }),
			(error) =>
				error instanceof GoogleCdpBrokerClientError &&
				error.code === "deadline_expired",
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fake.cancelRequests.length, 1);
		assert.match(fake.cancelRequests[0].requestId, /^client-/);

		// Let the original response arrive after the fence. It must be ignored,
		// and the same client must still accept a later request.
		await new Promise((resolve) => setTimeout(resolve, 350));
		fake.setSearchDelayMs(0);
		const followUp = await client.search("after-deadline", {
			deadlineAt: Date.now() + 1000,
		});
		assert.equal(followUp.query, "after-deadline");
	} finally {
		client.close();
		await new Promise((resolve) => fake.server.close(resolve));
	}
});

test("client enforces absolute connection deadlines", async () => {
	const client = new GoogleCdpBrokerClient({
		socketPath: "unused",
		connectImpl: () => {
			const socket = new EventEmitter();
			socket.destroyed = false;
			socket.destroy = () => {
				socket.destroyed = true;
			};
			return socket;
		},
	});
	await assert.rejects(
		client.connect({ deadlineAt: Date.now() - 1 }),
		(error) => error.code === "deadline_expired",
	);
});
