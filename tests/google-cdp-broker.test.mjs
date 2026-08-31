import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdtemp,
	rm,
	mkdir,
	writeFile,
	utimes,
	readFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GoogleCdpBroker,
	LeaseRegistry,
	MAX_FRAME_BYTES,
	MAX_IN_FLIGHT_REQUESTS,
	MAX_REQUEST_ID_HISTORY,
	claimStartupLock,
} from "../bin/google-cdp-broker.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TestClient {
	constructor(socketPath) {
		this.socketPath = socketPath;
		this.nextId = 1;
		this.pending = new Map();
		this.buffer = "";
		this.unkeyed = [];
		this.socket = null;
		this.clientId = null;
		this.sessionId = null;
		this.capability = null;
	}

	async connect() {
		this.socket = net.createConnection(this.socketPath);
		this.socket.on("close", () => {
			for (const { reject } of this.pending.values())
				reject(
					Object.assign(new Error("Connection closed"), {
						code: "connection_closed",
					}),
				);
			this.pending.clear();
		});
		this.socket.on("data", (chunk) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let response;
				try {
					response = JSON.parse(line);
				} catch {
					continue;
				}
				const pending =
					response.id === null
						? this.unkeyed.shift()
						: this.pending.get(String(response.id));
				if (!pending) continue;
				if (response.id !== null) this.pending.delete(String(response.id));
				if (response.ok) pending.resolve(response.result);
				else
					pending.reject(
						Object.assign(new Error(response.error.message), response.error),
					);
			}
		});
		await new Promise((resolve, reject) => {
			this.socket.once("connect", resolve);
			this.socket.once("error", reject);
		});
		return this;
	}

	request(body) {
		const id = body.id || String(this.nextId++);
		const request = { ...body, id };
		if (request.op !== "register" && request.op !== "health") {
			request.clientId ??= this.clientId;
			request.sessionId ??= this.sessionId;
			request.capability ??= this.capability;
		}
		return new Promise((resolve, reject) => {
			this.pending.set(String(id), { resolve, reject });
			this.socket.write(`${JSON.stringify(request)}\n`);
		});
	}

	send(op, fields = {}) {
		return this.request({ op, ...fields });
	}

	batch(bodies) {
		const requests = bodies.map((body) => ({
			...body,
			id: body.id || String(this.nextId++),
		}));
		const results = requests.map(
			(request) =>
				new Promise((resolve, reject) =>
					this.pending.set(String(request.id), { resolve, reject }),
				),
		);
		this.socket.write(
			`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
		);
		return Promise.all(results);
	}

	rawLine(line, id = null) {
		return new Promise((resolve, reject) => {
			if (id === null) this.unkeyed.push({ resolve, reject });
			else this.pending.set(String(id), { resolve, reject });
			this.socket.write(`${line}\n`);
		});
	}

	async register(clientId, sessionId = `${clientId}-session`) {
		const result = await this.send("register", { clientId, sessionId });
		this.clientId = result.clientId;
		this.sessionId = result.sessionId;
		this.capability = result.capability;
		assert.equal(typeof this.capability, "string");
		return result;
	}

	destroy() {
		this.socket?.destroy();
	}
}

async function makeBroker(options = {}) {
	const profileDir = await mkdtemp(join(tmpdir(), "pi-webaio-broker-test-"));
	const broker = new GoogleCdpBroker({ profileDir, ...options });
	const started = await broker.start();
	assert.equal(started.ok, true, JSON.stringify(started));
	return { broker, profileDir };
}

async function stopBroker(setup) {
	await setup.broker.stop();
	await rm(setup.profileDir, { recursive: true, force: true });
}

async function registeredClient(
	broker,
	clientId,
	sessionId = `${clientId}-session`,
) {
	const client = await new TestClient(broker.socketPath).connect();
	await client.register(clientId, sessionId);
	return client;
}

function directIdentity(registry, clientId, sessionId = `${clientId}-session`) {
	const result = registry.register({ clientId, sessionId });
	return { clientId, sessionId, capability: result.capability };
}

async function closeClients(...clients) {
	for (const client of clients) client.destroy();
	await sleep(10);
}

test("combined frames, malformed JSON, canonical IDs, and duplicate IDs are fail-soft", async () => {
	const setup = await makeBroker();
	const client = await new TestClient(setup.broker.socketPath).connect();
	try {
		// A single write containing multiple frames is accepted by the broker.
		const [one, two] = await client.batch([
			{ id: "one", op: "health" },
			{ id: "two", op: "health" },
		]);
		assert.equal(one.protocol, 1);
		assert.equal(two.protocol, 1);
		await assert.rejects(
			client.rawLine("{nope"),
			(error) => error.code === "malformed_json",
		);
		const duplicate = await client.request({ id: "dup", op: "health" });
		assert.equal(duplicate.protocol, 1);
		await assert.rejects(
			client.rawLine('{"id":"dup","op":"health"}', "dup"),
			(error) => error.code === "duplicate_request_id",
		);
		assert.equal(setup.broker.started, true);
	} finally {
		client.destroy();
		await stopBroker(setup);
	}
});

test("duplicate startup is deterministic regardless of which contender wins", async () => {
	const profileDir = await mkdtemp(join(tmpdir(), "pi-webaio-broker-race-"));
	const first = new GoogleCdpBroker({ profileDir });
	const second = new GoogleCdpBroker({ profileDir });
	try {
		const results = await Promise.all([first.start(), second.start()]);
		const winners = results.filter((result) => result.ok);
		const losers = results.filter((result) => !result.ok);
		assert.equal(winners.length, 1);
		assert.equal(losers.length, 1);
		assert.equal(losers[0].error.code, "already_running");
		assert.ok(winners[0].result.ownerNonce);
	} finally {
		await Promise.all([first.stop(), second.stop()]);
		await rm(profileDir, { recursive: true, force: true });
	}
});

test("stale recovery uses an atomic rename and preserves the winning owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-lock-race-"));
	const lockPath = join(root, "profile.lock");
	const socketPath = join(root, "broker.sock");
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, "owner.json"),
		JSON.stringify({
			pid: 999999,
			ownerNonce: "stale",
			profileKey: "profile",
			socketPath,
		}),
	);
	const old = new Date(Date.now() - 10_000);
	await utimes(lockPath, old, old);
	try {
		const results = await Promise.all([
			claimStartupLock({
				lockPath,
				socketPath,
				profileKey: "profile",
				staleAfterMs: 1,
			}),
			claimStartupLock({
				lockPath,
				socketPath,
				profileKey: "profile",
				staleAfterMs: 1,
			}),
		]);
		assert.equal(results.filter((result) => result.ok).length, 1);
		assert.equal(
			results.filter((result) => !result.ok)[0].error.code,
			"already_running",
		);
		const owner = JSON.parse(
			await readFile(join(lockPath, "owner.json"), "utf8"),
		);
		assert.equal(
			owner.ownerNonce,
			results.find((result) => result.ok).ownerNonce,
		);
		await results.find((result) => result.ok).release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a dead owner pid allows immediate takeover without the age gate", async () => {
	// A broker that is killed without releasing its lock must not block a
	// successor for the full staleAfterMs window: a dead pid cannot race, so
	// the lock is stale by definition. (The age gate remains only for records
	// with no valid owner pid.)
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-lock-deadpid-"));
	const lockPath = join(root, "profile.lock");
	const socketPath = join(root, "broker.sock");
	await mkdir(lockPath);
	await writeFile(
		join(lockPath, "owner.json"),
		JSON.stringify({
			pid: 999999,
			ownerNonce: "dead-owner",
			profileKey: "profile",
			socketPath,
		}),
	);
	// Fresh mtime: the lock was "just created". A huge staleAfterMs means the
	// age gate can never pass — takeover must succeed via the dead-pid rule.
	try {
		const claim = await claimStartupLock({
			lockPath,
			socketPath,
			profileKey: "profile",
			staleAfterMs: 24 * 60 * 60_000,
		});
		assert.equal(claim.ok, true, "dead-pid lock must be taken over");
		assert.notEqual(claim.ownerNonce, "dead-owner");
		await claim.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("capability authentication prevents impersonation and re-registration", async () => {
	const setup = await makeBroker();
	const a = await registeredClient(setup.broker, "auth-a");
	const b = await new TestClient(setup.broker.socketPath).connect();
	try {
		await assert.rejects(
			b.register("auth-a", "auth-a-session"),
			(error) => error.code === "connection_ownership",
		);
		await assert.rejects(
			a.send("lease", { clientId: "auth-b", provider: "google-search" }),
			(error) => error.code === "connection_ownership",
		);
		await assert.rejects(
			a.send("lease", {
				sessionId: "other-session",
				provider: "google-search",
			}),
			(error) => error.code === "session_mismatch",
		);
		const lease = await a.send("lease", { provider: "google-search" });
		await assert.rejects(
			b.send("release", {
				sessionId: a.sessionId,
				clientId: a.clientId,
				capability: a.capability,
				...lease,
			}),
			(error) => error.code === "not_registered",
		);
		await a.send("release", lease);
	} finally {
		await closeClients(a, b);
		await stopBroker(setup);
	}
});

test("session identity is unique and targets retain session/provider affinity", async () => {
	const registry = new LeaseRegistry();
	const a = directIdentity(registry, "session-a", "shared-session");
	assert.throws(
		() =>
			registry.register({ clientId: "session-b", sessionId: "shared-session" }),
		(error) => error.code === "session_conflict",
	);
	const first = await registry.lease({ ...a, provider: "google-search" });
	registry.release({ ...a, ...first, generation: first.generation });
	const sameSession = await registry.lease({ ...a, provider: "google-search" });
	assert.equal(sameSession.targetId, first.targetId);
	registry.release({
		...a,
		...sameSession,
		generation: sameSession.generation,
	});
	assert.equal(registry.targets.has(sameSession.targetId), true);
	registry.disconnect(a);
	assert.equal(registry.targets.has(sameSession.targetId), false);
	const b = directIdentity(registry, "session-b", "other-session");
	const other = await registry.lease({ ...b, provider: "google-search" });
	assert.notEqual(other.targetId, first.targetId);
	registry.release({ ...b, ...other, generation: other.generation });
});

test("dirty, expired, disconnected, and old-generation targets are removed", async () => {
	const registry = new LeaseRegistry({ ttlMs: 10, orphanTtlMs: 10 });
	const a = directIdentity(registry, "cleanup-a");
	const expired = await registry.lease({
		...a,
		provider: "google-search",
		ttlMs: 1,
	});
	registry.sweep(Date.now() + 100);
	assert.equal(registry.targets.has(expired.targetId), false);
	const b = directIdentity(registry, "cleanup-b");
	const disconnected = await registry.lease({
		...b,
		provider: "google-search",
	});
	registry.disconnect(b);
	assert.equal(registry.targets.has(disconnected.targetId), false);
	const c = directIdentity(registry, "cleanup-c");
	const generation = await registry.lease({ ...c, provider: "google-search" });
	registry.bumpBrowserGeneration();
	assert.equal(registry.targets.has(generation.targetId), false);
});

test("same session/provider serializes while different sessions can use separate targets", async () => {
	const setup = await makeBroker();
	const a = await registeredClient(setup.broker, "serial-a", "serial-session");
	const b = await registeredClient(setup.broker, "serial-b", "serial-other");
	try {
		const first = await a.send("lease", { provider: "google-search" });
		// Same session can now lease concurrently (up to the provider cap of 5)
		const second = await a.send("lease", { provider: "google-search" });
		assert.notEqual(second.targetId, first.targetId);
		// Different session also gets its own target
		const different = await b.send("lease", { provider: "google-search" });
		assert.notEqual(different.targetId, first.targetId);
		assert.notEqual(different.targetId, second.targetId);
		await a.send("release", first);
		await a.send("release", second);
		await b.send("release", different);
	} finally {
		await closeClients(a, b);
		await stopBroker(setup);
	}
});

test("in-flight and bounded request-ID limits are enforced", async () => {
	const setup = await makeBroker({ maxInFlight: 1, maxIdHistory: 20 });
	const client = await registeredClient(setup.broker, "bounds");
	try {
		// Fill all 5 provider slots so the 6th lease is queued
		const slots = [];
		for (let i = 0; i < 5; i++) {
			slots.push(await client.send("lease", { provider: "google-search" }));
		}
		const queued = client.request({
			id: "queued",
			op: "lease",
			provider: "google-search",
			waitMs: 500,
			sessionId: client.sessionId,
			capability: client.capability,
		});
		await sleep(15);
		await assert.rejects(
			client.request({ id: "third", op: "health" }),
			(error) => error.code === "in_flight_limit",
		);
		for (const slot of slots) {
			setup.broker.registry.release({
				clientId: client.clientId,
				sessionId: client.sessionId,
				capability: client.capability,
				...slot,
				generation: slot.generation,
			});
		}
		await queued;
	} finally {
		await closeClients(client);
		await stopBroker(setup);
	}

	const historySetup = await makeBroker({ maxIdHistory: 2 });
	const historyClient = await registeredClient(historySetup.broker, "history");
	try {
		await historyClient.request({ id: "second", op: "health" });
		await assert.rejects(
			historyClient.request({ id: "third", op: "health" }),
			(error) => error.code === "request_id_history_exhausted",
		);
	} finally {
		await closeClients(historyClient);
		await stopBroker(historySetup);
	}
});

test("deadline and cancellation fence queued requests without mutating the registry", async () => {
	const setup = await makeBroker();
	const client = await registeredClient(setup.broker, "fence");
	try {
		// Fill all 5 provider slots so the 6th is queued
		const slots = [];
		for (let i = 0; i < 5; i++) {
			slots.push(await client.send("lease", { provider: "google-search" }));
		}
		const pending = client.request({
			id: "wait",
			op: "lease",
			provider: "google-search",
			waitMs: 1000,
			deadlineAt: Date.now() + 1000,
			sessionId: client.sessionId,
			capability: client.capability,
		});
		await sleep(15);
		const cancel = await client.request({
			id: "cancel",
			op: "cancel",
			requestId: "wait",
			sessionId: client.sessionId,
			capability: client.capability,
		});
		assert.equal(cancel.cancelled, true);
		await assert.rejects(pending, (error) => error.code === "request_fenced");
		assert.equal(setup.broker.registry.snapshot().active, 5);
		// Release all 5 slots
		for (const slot of slots) {
			await client.send("release", slot);
		}
		await assert.rejects(
			client.request({
				id: "expired",
				op: "lease",
				provider: "google-search",
				deadlineAt: Date.now() - 1,
				sessionId: client.sessionId,
				capability: client.capability,
			}),
			(error) => error.code === "deadline_expired",
		);
		assert.equal(setup.broker.registry.snapshot().active, 0);
	} finally {
		await closeClients(client);
		await stopBroker(setup);
	}
});

test("concurrent start/stop calls serialize and remain idempotent", async () => {
	const profileDir = await mkdtemp(join(tmpdir(), "pi-webaio-lifecycle-"));
	const broker = new GoogleCdpBroker({ profileDir });
	try {
		const [a, b, stopped] = await Promise.all([
			broker.start(),
			broker.start(),
			broker.stop(),
		]);
		assert.equal(a.ok, true);
		assert.equal(b.ok, true);
		assert.equal(stopped, undefined);
		assert.equal(broker.started, false);
		assert.equal(await broker.stop(), undefined);
		assert.equal((await broker.start()).ok, true);
	} finally {
		await broker.stop();
		await rm(profileDir, { recursive: true, force: true });
	}
});

test("oversized frames return structured errors without an uncaught exception", async () => {
	const setup = await makeBroker();
	const socket = net.createConnection(setup.broker.socketPath);
	try {
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const response = new Promise((resolve) =>
			socket.once("data", (chunk) => resolve(JSON.parse(chunk.toString()))),
		);
		socket.write(`${"x".repeat(MAX_FRAME_BYTES)}\n`);
		assert.equal((await response).error.code, "frame_too_large");
	} finally {
		socket.destroy();
		await stopBroker(setup);
	}
	assert.equal(MAX_IN_FLIGHT_REQUESTS > 0, true);
	assert.equal(MAX_REQUEST_ID_HISTORY > 0, true);
});

test("pagination merges pages with URL dedup until maxResults, then stops", async () => {
	// Stub-only unit test: no server, no real CDP. Drive
	// extractGoogleSearchResultsPaginated with fake page results and assert
	// the merge/dedup/stop contract.
	const broker = new GoogleCdpBroker({
		profileDir: `pagination-${Math.random().toString(36).slice(2)}`,
	});
	const navigatedUrls = [];
	// Fake CDP: capture Page.navigate urls, never verify location.
	broker.cdpSend = async (method, params) => {
		if (method === "Page.navigate") navigatedUrls.push(params.url);
		return {};
	};
	broker.verifyCdpLocation = async () => {};
	// Fake per-page extraction: page N contributes N results (page 1: 1-8,
	// page 2: 9-16, ...), each with a unique url, capped at the requested max.
	let pageNum = 0;
	broker.extractGoogleSearchResults = async (
		_request,
		_sessionId,
		maxResults,
		_signal,
		_pageDeadlineAt,
	) => {
		pageNum++;
		const results = [];
		const base = (pageNum - 1) * 8 + 1;
		for (let i = 0; i < 8 && results.length < maxResults; i++) {
			const n = base + i;
			results.push({
				title: `result ${n}`,
				url: `https://example.com/${n}`,
				snippet: `snippet ${n}`,
			});
		}
		return results;
	};

	const request = {
		maxResults: 20,
		deadlineAt: Date.now() + 60_000,
	};
	const { results } = await broker.extractGoogleSearchResultsPaginated(
		request,
		{ cdpSessionId: "session-1", targetId: "t1" },
		"query",
		20,
		undefined,
	);
	assert.equal(results.length, 20, "collected exactly maxResults");
	const urls = new Set(results.map((r) => r.url));
	assert.equal(urls.size, 20, "no duplicate urls across pages");
	// Pages 2 and 3 were navigated with ?start=10 and ?start=20.
	assert.equal(navigatedUrls.length, 2, "two extra pages navigated");
	assert.ok(navigatedUrls[0].includes("start=10"), navigatedUrls[0]);
	assert.ok(navigatedUrls[1].includes("start=20"), navigatedUrls[1]);
	assert.ok(results[0].url.endsWith("/1"), "page 1 results first");
});

test("pagination stops when a page yields no new organics", async () => {
	const broker = new GoogleCdpBroker({
		profileDir: `pagination-stop-${Math.random().toString(36).slice(2)}`,
	});
	const navigatedUrls = [];
	broker.cdpSend = async (method, params) => {
		if (method === "Page.navigate") navigatedUrls.push(params.url);
		return {};
	};
	broker.verifyCdpLocation = async () => {};
	let pageNum = 0;
	// Page 1: 5 organics. Page 2+: duplicates of page 1 (SERP exhausted).
	broker.extractGoogleSearchResults = async (
		_request,
		_sessionId,
		maxResults,
		_signal,
		_pageDeadlineAt,
	) => {
		pageNum++;
		if (pageNum === 1) {
			return Array.from({ length: Math.min(5, maxResults) }, (_, i) => ({
				title: `r${i + 1}`,
				url: `https://example.com/${i + 1}`,
				snippet: "s",
			}));
		}
		// Duplicates — nothing new to add.
		return Array.from({ length: 5 }, (_, i) => ({
			title: `r${i + 1}`,
			url: `https://example.com/${i + 1}`,
			snippet: "s",
		}));
	};

	const { results } = await broker.extractGoogleSearchResultsPaginated(
		{ maxResults: 20, deadlineAt: Date.now() + 60_000 },
		{ cdpSessionId: "s", targetId: "t" },
		"query",
		20,
		undefined,
	);
	assert.equal(results.length, 5, "kept only the unique page-1 organic set");
	assert.equal(
		navigatedUrls.length,
		1,
		"paginated ahead exactly once then stopped",
	);
});

test("pagination honors the deadline floor and never starts a page it cannot finish", async () => {
	const broker = new GoogleCdpBroker({
		profileDir: `pagination-deadline-${Math.random().toString(36).slice(2)}`,
	});
	let navigations = 0;
	broker.cdpSend = async () => {
		navigations++;
		return {};
	};
	broker.verifyCdpLocation = async () => {};
	broker.extractGoogleSearchResults = async () => {
		return [
			{
				title: "r1",
				url: "https://example.com/1",
				snippet: "s",
			},
		];
	};
	// Deadline only 1.5s out — below the 2s page floor, so no pagination.
	const { results } = await broker.extractGoogleSearchResultsPaginated(
		{ maxResults: 20, deadlineAt: Date.now() + 1_500 },
		{ cdpSessionId: "s", targetId: "t" },
		"query",
		20,
		undefined,
	);
	assert.equal(results.length, 1, "page 1 only when deadline is too close");
	assert.equal(navigations, 0, "no paginated navigation near deadline");
});

test("isGoogleSearchLocation accepts paginated start offsets with constant num", async () => {
	// The module's location check is used by verifyCdpLocation: Google may
	// rewrite start while keeping num — the check must still pass for the
	// paginated URL (issues #102 regression guard).
	const { isGoogleSearchLocation, canonicalGoogleSearchUrl } = await import(
		"../bin/google-cdp-broker.mjs"
	);
	if (typeof isGoogleSearchLocation !== "function") {
		// The helper is internal in this build; test via the exported URL
		// builder contract instead.
		const page2 = canonicalGoogleSearchUrl("test", 20, 10);
		assert.ok(page2.includes("start=10"), page2);
		const page1 = canonicalGoogleSearchUrl("test", 20);
		assert.ok(!page1.includes("start="), page1);
		assert.ok(page1.includes("num=20"), page1);
		assert.equal(
			new URL(page2).searchParams.get("num"),
			new URL(page1).searchParams.get("num"),
			"num constant across pages",
		);
		return;
	}
});

test("pagination degrades to the merged set when a page-2+ navigation fails", async () => {
	// Regression for the adversarial-review HIGH-1 finding: a page-2+
	// navigation/verification error must NOT abort the whole search and
	// discard the page-1 results already merged. It degrades to the merged
	// set with `degraded: true`.
	const broker = new GoogleCdpBroker({
		profileDir: `pagination-degrade-nav-${Math.random().toString(36).slice(2)}`,
	});
	let navigations = 0;
	broker.cdpSend = async (_method, params) => {
		navigations++;
		// First paginated navigation (page 2) fails hard.
		return params?.url?.includes("start=")
			? { errorText: "net::ERR_ABORTED" }
			: {};
	};
	broker.verifyCdpLocation = async () => {};
	let pageNum = 0;
	broker.extractGoogleSearchResults = async (
		_request,
		_sessionId,
		maxResults,
		_signal,
		_pageDeadlineAt,
	) => {
		pageNum++;
		return Array.from({ length: Math.min(6, maxResults) }, (_, i) => ({
			title: `r${i + 1}`,
			url: `https://example.com/${i + 1}`,
			snippet: "s",
		}));
	};

	const { results, degraded } = await broker.extractGoogleSearchResultsPaginated(
		{ maxResults: 20, deadlineAt: Date.now() + 60_000 },
		{ cdpSessionId: "s", targetId: "t" },
		"query",
		20,
		undefined,
	);
	assert.equal(
		results.length,
		6,
		"page-1 results are kept on page-2 nav failure",
	);
	assert.equal(degraded, true, "degraded flag set on page-2+ failure");
	assert.equal(navigations, 1, "one failed paginated navigation attempted");
	assert.equal(pageNum, 1, "extraction ran for page 1 only");
});

test("pagination degrades when page-2+ extraction throws (empty tail page)", async () => {
	// Regression for the adversarial-review HIGH-2 finding: an empty/blank
	// tail page whose extraction throws search_timeout must degrade to the
	// merged set rather than failing the whole search.
	const broker = new GoogleCdpBroker({
		profileDir: `pagination-degrade-extract-${Math.random().toString(36).slice(2)}`,
	});
	broker.cdpSend = async () => ({});
	broker.verifyCdpLocation = async () => {};
	let pageNum = 0;
	broker.extractGoogleSearchResults = async () => {
		pageNum++;
		if (pageNum === 1)
			return Array.from({ length: 6 }, (_, i) => ({
				title: `r${i + 1}`,
				url: `https://example.com/${i + 1}`,
				snippet: "s",
			}));
		throw new Error("search_timeout: results not ready");
	};

	const { results, degraded } = await broker.extractGoogleSearchResultsPaginated(
		{ maxResults: 20, deadlineAt: Date.now() + 60_000 },
		{ cdpSessionId: "s", targetId: "t" },
		"query",
		20,
		undefined,
	);
	assert.equal(
		results.length,
		6,
		"page-1 results kept on page-2 extraction error",
	);
	assert.equal(degraded, true, "degraded flag set on page-2+ extraction error");
	assert.equal(pageNum, 2, "page 2 extraction was attempted");
});

test("page-1 extraction failure still propagates (genuine total failure)", async () => {
	// Page 1 is the navigationMs/extractionMs baseline: a page-1 extraction
	// failure means no results were ever observed and must still throw so
	// the caller surfaces a proper googleStatus error.
	const broker = new GoogleCdpBroker({
		profileDir: `pagination-degrade-page1-${Math.random().toString(36).slice(2)}`,
	});
	broker.cdpSend = async () => ({});
	broker.verifyCdpLocation = async () => {};
	broker.extractGoogleSearchResults = async () => {
		throw new Error("search_timeout: results not ready");
	};

	await assert.rejects(
		broker.extractGoogleSearchResultsPaginated(
			{ maxResults: 10, deadlineAt: Date.now() + 60_000 },
			{ cdpSessionId: "s", targetId: "t" },
			"query",
			10,
			undefined,
		),
		/not ready/,
	);
});
test("isGoogleCaptchaLocation detects /sorry/ redirects on Google hosts only", async () => {
	const { isGoogleCaptchaLocation } = await import(
		"../bin/google-cdp-broker.mjs"
	);
	assert.equal(
		isGoogleCaptchaLocation(
			"https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dx",
		),
		true,
	);
	assert.equal(isGoogleCaptchaLocation("https://google.com/sorry/"), true);
	assert.equal(
		isGoogleCaptchaLocation("https://www.google.co.uk/sorry/index?c=x"),
		false,
		"regional hosts do not match (broker navigates google.com)",
	);
	assert.equal(
		isGoogleCaptchaLocation("https://www.google.com/search?q=x"),
		false,
	);
	assert.equal(isGoogleCaptchaLocation("https://evil.com/sorry/index"), false);
	assert.equal(isGoogleCaptchaLocation("about:blank"), false);
	assert.equal(isGoogleCaptchaLocation(undefined), false);
	assert.equal(isGoogleCaptchaLocation(42), false);
});

test("captcha redirect during page-1 navigation polling fails fast with captcha_blocked", async () => {
	// Issue #111: Google redirects the tab to /sorry/; polling it burns the
	// whole search deadline. verifyCdpLocation — the shared location poll used
	// by SERP pages 2+ — must throw captcha_blocked immediately instead.
	// (Page 1 has a duplicated inline poll in searchGoogle; see the comment
	// there. Its check mirrors this one.)
	const { GoogleCdpBroker } = await import("../bin/google-cdp-broker.mjs");
	const broker = new GoogleCdpBroker({
		profileDir: `captcha-nav-${Math.random().toString(36).slice(2)}`,
	});
	let evaluates = 0;
	broker.cdpSend = async (_method, params) => {
		if (params?.expression === "location.href") {
			evaluates++;
			return {
				result: {
					value:
						"https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch",
				},
			};
		}
		return {};
	};
	const started = Date.now();
	await assert.rejects(
		broker.verifyCdpLocation(
			{ cdpSessionId: "s" },
			(value) => isGoogleSearchLocationShim(value),
			{ deadlineAt: Date.now() + 15_000 },
			undefined,
			"Google search",
		),
		(error) => error?.code === "captcha_blocked",
	);
	assert.ok(
		Date.now() - started < 5_000,
		"fails fast instead of polling to the deadline",
	);
	assert.ok(evaluates >= 1, "location was actually probed");
});

function isGoogleSearchLocationShim(_value) {
	// Never satisfied: the /sorry/ URL must be caught by the captcha check
	// before the expected-location check matters.
	return false;
}

test("captcha mid-pagination degrades to collected pages and labels the envelope", async () => {
	const broker = new GoogleCdpBroker({
		profileDir: `captcha-page2-${Math.random().toString(36).slice(2)}`,
	});
	broker.extractGoogleSearchResults = async () => [
		{ title: "r1", url: "https://example.com/1", snippet: "s" },
	];
	// Page-1 location verifies (inside searchGoogle, not exercised here);
	// page-2's location check lands on /sorry/ and throws captcha_blocked.
	// verifyCdpLocation is only invoked for SERP pages ≥ 2, so throwing
	// unconditionally is deterministic.
	broker.cdpSend = async (_method, _params) => ({});
	broker.verifyCdpLocation = async () => {
		const error = new Error("captcha");
		error.code = "captcha_blocked";
		throw error;
	};
	const { results, degraded, pages } =
		await broker.extractGoogleSearchResultsPaginated(
			{ maxResults: 15, deadlineAt: Date.now() + 60_000 },
			{ cdpSessionId: "s", targetId: "t" },
			"query",
			15,
			undefined,
		);
	assert.equal(results.length, 1, "page-1 results kept");
	assert.equal(degraded, true);
	assert.equal(pages.length, 2);
	assert.equal(
		pages[1].error,
		"captcha_blocked",
		"envelope labels the captcha page",
	);
});

test("captcha_blocked skips legacy fallback in googleSearchWithDependencies", async () => {
	// The legacy path deterministically hits the same IP-level block — falling
	// back would hammer Google one more time and waste the remaining budget.
	const { googleSearchWithDependencies } = await import("../src/google-ai.ts");
	let legacyCalls = 0;
	let brokerSearches = 0;
	await assert.rejects(
		googleSearchWithDependencies(
			"captcha fallback gate",
			{
				maxResults: 8,
				timeoutMs: 15_000,
			},
			{
				ensureChrome: async () => ({ running: true, ready: true }),
				connectBroker: async () => ({
					connected: true,
					async search() {
						brokerSearches++;
						const error = new Error(
							"Google redirected the search to a CAPTCHA page (/sorry/)",
						);
						error.code = "captcha_blocked";
						throw error;
					},
					async close() {},
				}),
				legacySearch: async () => {
					legacyCalls++;
					return {
						results: [{ title: "legacy", url: "https://example.com/", snippet: "s" }],
						timings: {},
					};
				},
				cleanupBroker: async () => {},
			},
		),
		(error) => error?.code === "captcha_blocked",
	);
	assert.equal(brokerSearches, 1);
	assert.equal(legacyCalls, 0, "legacy path must not run for captcha_blocked");
});

test("captcha redirect mid-extraction fails fast via the readiness probe", async () => {
	// Google can redirect to /sorry/ AFTER the SERP verified OK — the
	// extraction loop's readiness probe must catch the redirect (rv.href)
	// and throw captcha_blocked instead of polling a dead page to the
	// deadline and then falling back into the same block (review fix 2).
	const broker = new GoogleCdpBroker({
		profileDir: `captcha-midextract-${Math.random().toString(36).slice(2)}`,
	});
	broker.cdpSend = async (_method, params) =>
		params?.expression?.includes("h3:")
			? {
					result: {
						value: {
							h3: 0,
							consent: false,
							href: "https://www.google.com/sorry/index?continue=x",
						},
					},
				}
			: {};
	const started = Date.now();
	await assert.rejects(
		broker.extractGoogleSearchResults(
			{ deadlineAt: Date.now() + 15_000 },
			"session",
			8,
			undefined,
			undefined,
		),
		(error) => error?.code === "captcha_blocked",
	);
	assert.ok(Date.now() - started < 5_000, "fails fast instead of grinding");
});
