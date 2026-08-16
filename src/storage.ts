// ─── Persistent result storage ─────────────────────────────────────
// Durable storage with response IDs that survive restarts.
// Uses a JSON metadata index + content-addressed blobs under os.tmpdir().

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent as sha256 } from "./content-hash.ts";

const BASE_TEMP = join(tmpdir(), "pi-webaio");
const STORAGE_DIR = join(BASE_TEMP, "results");
const INDEX_FILE = join(STORAGE_DIR, "index.json");
const MAX_RESULTS = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface StoredResult {
	id: string;
	url: string;
	title?: string;
	content: string;
	/** Path to persisted blob file */
	blobPath: string;
	createdAt: number;
	/** Expiration timestamp; 0 = no expiration */
	expiresAt: number;
	/** Tool that created this result */
	source: "webfetch" | "webpull" | "websearch" | "webmap";
	/** Optional metadata */
	meta?: Record<string, unknown>;
}

interface IndexEntry {
	id: string;
	url: string;
	title?: string;
	blobPath: string;
	createdAt: number;
	expiresAt: number;
	source: StoredResult["source"];
	contentHash: string;
	meta?: Record<string, unknown>;
}

let _index: Map<string, IndexEntry> | null = null;
let _indexLoaded = false;

async function ensureStorage(): Promise<void> {
	await mkdir(STORAGE_DIR, { recursive: true });
}

async function loadIndex(): Promise<Map<string, IndexEntry>> {
	if (_index) return _index;
	if (_indexLoaded) return (_index = new Map());

	try {
		const raw = await readFile(INDEX_FILE, "utf8");
		const data = JSON.parse(raw) as Record<string, IndexEntry>;
		const now = Date.now();
		const entries = Object.entries(data).filter(
			([_, entry]) => entry.expiresAt === 0 || entry.expiresAt > now,
		);
		_index = new Map(entries);
	} catch {
		_index = new Map();
	}
	_indexLoaded = true;
	return _index;
}

async function saveIndex(): Promise<void> {
	const idx = await loadIndex();
	const data = Object.fromEntries(idx.entries());
	await ensureStorage();
	await writeFile(INDEX_FILE, JSON.stringify(data, null, 2), "utf8");
}

function hashContent(content: string): string {
	// Truncated digest preserved for index-format continuity; the shared
	// SHA-256 helper lives in content-hash.ts (F6).
	return sha256(content).slice(0, 16);
}

function makeId(): string {
	const ts = Date.now().toString(36);
	const rand = randomUUID().split("-")[0]!;
	return `${ts}-${rand}`;
}

/**
 * Store a result persistently and return its ID.
 */
export async function storeResult(
	url: string,
	content: string,
	source: StoredResult["source"],
	options?: {
		title?: string;
		ttlSeconds?: number;
		meta?: Record<string, unknown>;
	},
): Promise<string> {
	await ensureStorage();
	const idx = await loadIndex();

	// Enforce max results with simple LRU (remove oldest)
	while (idx.size >= MAX_RESULTS) {
		let oldest: IndexEntry | null = null;
		for (const entry of idx.values()) {
			if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
		}
		if (oldest) {
			idx.delete(oldest.id);
			try {
				await unlink(oldest.blobPath);
			} catch {
				/* ignore */
			}
		}
	}

	const id = makeId();
	const contentHash = hashContent(content);
	const blobPath = join(STORAGE_DIR, `${id}.md`);
	const now = Date.now();
	const ttlMs =
		options?.ttlSeconds !== undefined
			? options.ttlSeconds * 1000
			: DEFAULT_TTL_MS;
	const expiresAt = ttlMs === 0 ? 0 : now + ttlMs;

	const entry: IndexEntry = {
		id,
		url,
		title: options?.title,
		blobPath,
		createdAt: now,
		expiresAt,
		source,
		contentHash,
		meta: options?.meta,
	};

	await writeFile(blobPath, content, "utf8");
	idx.set(id, entry);
	await saveIndex();

	return id;
}

/**
 * Retrieve a stored result by ID.
 */
export async function getResult(id: string): Promise<StoredResult | null> {
	const idx = await loadIndex();
	const entry = idx.get(id);
	if (!entry) return null;
	if (entry.expiresAt !== 0 && entry.expiresAt < Date.now()) {
		idx.delete(id);
		try {
			await unlink(entry.blobPath);
		} catch {
			/* ignore */
		}
		await saveIndex();
		return null;
	}

	try {
		const content = await readFile(entry.blobPath, "utf8");
		return {
			id: entry.id,
			url: entry.url,
			title: entry.title,
			content,
			blobPath: entry.blobPath,
			createdAt: entry.createdAt,
			expiresAt: entry.expiresAt,
			source: entry.source,
			meta: entry.meta,
		};
	} catch {
		idx.delete(id);
		await saveIndex();
		return null;
	}
}

/**
 * List stored results, optionally filtered by source.
 */
export async function listResults(
	filterSource?: StoredResult["source"],
): Promise<
	Array<{
		id: string;
		url: string;
		title?: string;
		createdAt: number;
		source: string;
	}>
> {
	const idx = await loadIndex();
	const now = Date.now();
	const results: Array<{
		id: string;
		url: string;
		title?: string;
		createdAt: number;
		source: string;
	}> = [];

	for (const entry of idx.values()) {
		if (entry.expiresAt !== 0 && entry.expiresAt < now) continue;
		if (filterSource && entry.source !== filterSource) continue;
		results.push({
			id: entry.id,
			url: entry.url,
			title: entry.title,
			createdAt: entry.createdAt,
			source: entry.source,
		});
	}

	// Sort by createdAt descending
	results.sort((a, b) => b.createdAt - a.createdAt);
	return results;
}

/**
 * Delete a stored result by ID.
 */
async function deleteResult(id: string): Promise<boolean> {
	const idx = await loadIndex();
	const entry = idx.get(id);
	if (!entry) return false;
	idx.delete(id);
	try {
		await unlink(entry.blobPath);
	} catch {
		/* ignore */
	}
	await saveIndex();
	return true;
}
