/**
 * Request Queue — persistent, disk-backed URL queue with checkpoint/resume.
 *
 * Tracks queued / in-progress / completed / failed states so that a webpull
 * can be interrupted and resumed without re-fetching already-downloaded pages.
 *
 * Persists as a JSONL file alongside the output directory.
 */

import { readFile, writeFile, mkdir, readdir, open } from "node:fs/promises";

import { join } from "node:path";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────

type QueueStatus = "queued" | "in_progress" | "completed" | "failed";

export interface QueueEntry {
	url: string;
	/** Final URL whose markdown file was written, when the caller supplies it. */
	outputUrl?: string;
	status: QueueStatus;
	retries: number;
	lastError?: string;
	timestamp: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const QUEUE_FILENAME = ".pullqueue.jsonl";
const MAX_RETRIES = 3;
const SAVE_INTERVAL_MS = 5_000; // flush in-memory changes to disk every 5s

export function canonicalQueueUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.hash = url.search = "";
		return url.pathname === "/" ? url.origin : url.href;
	} catch {
		return raw;
	}
}

// ─── Public API ──────────────────────────────────────────────────────

export class RequestQueue {
	private readonly entries: Map<string, QueueEntry> = new Map();
	private readonly completedFileUrls: Set<string>;
	private readonly queuePath: string;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	/** Simple promise-based lock to prevent race conditions in next() */
	private lockPromise: Promise<void> = Promise.resolve();

	private constructor(
		outDir: string,
		entries: Map<string, QueueEntry>,
		completedFileUrls: Set<string> = new Set(),
	) {
		this.queuePath = join(outDir, QUEUE_FILENAME);
		this.entries = entries;
		this.completedFileUrls = completedFileUrls;
	}

	// ── Factory ─────────────────────────────────────────────────────

	/**
	 * Create a new empty queue.
	 */
	static async create(outDir: string): Promise<RequestQueue> {
		await mkdir(outDir, { recursive: true });
		const q = new RequestQueue(outDir, new Map());
		q.startAutoSave();
		return q;
	}

	/**
	 * Resume an existing queue from disk. Scans the output directory for
	 * already-downloaded markdown files and marks those URLs as completed.
	 * Returns null if no queue file exists.
	 */
	static async resume(outDir: string): Promise<RequestQueue | null> {
		const queuePath = join(outDir, QUEUE_FILENAME);
		if (!existsSync(queuePath)) {
			return null;
		}

		const entries = new Map<string, QueueEntry>();
		const raw = await readFile(queuePath, "utf8");
		for (const line of raw.split("\n").filter(Boolean)) {
			try {
				const entry: QueueEntry = JSON.parse(line);
				if (typeof entry.url !== "string" || !entry.url) continue;
				entry.url = canonicalQueueUrl(entry.url);
				if (typeof entry.outputUrl === "string")
					entry.outputUrl = canonicalQueueUrl(entry.outputUrl);
				else delete entry.outputUrl;
				// Only keep entries that aren't completed (or were in_progress/failed)
				if (entry.status !== "completed") {
					entry.status = "queued"; // reset in_progress to queued for retry
				}
				entries.set(entry.url, entry);
			} catch {
				// skip malformed lines
			}
		}

		// Scan existing .md files to mark URLs as completed. Only read the
		// frontmatter window; pulled pages can be large and the URL is near the top.
		const completedFileUrls = new Set<string>();
		const mdFiles = await scanMarkdownFiles(outDir);
		for (const mdPath of mdFiles) {
			const url = await readFrontmatterUrl(mdPath);
			if (!url) continue;
			const canonicalUrl = canonicalQueueUrl(url);
			completedFileUrls.add(canonicalUrl);
			const existing = [...entries.values()].find(
				(entry) => entry.url === canonicalUrl || entry.outputUrl === canonicalUrl,
			);
			if (existing) {
				existing.status = "completed";
				existing.outputUrl ??= canonicalUrl;
				existing.retries = 0;
			}
		}

		const q = new RequestQueue(outDir, entries, completedFileUrls);
		q.startAutoSave();
		return q;
	}

	// ── Mutation ────────────────────────────────────────────────────

	/**
	 * Enqueue a batch of URLs (idempotent — skips duplicates).
	 */
	async add(urls: string[]): Promise<void> {
		this.addInternal(urls, false);
	}

	/**
	 * Backfill URLs on a resumed queue without re-fetching matching markdown
	 * files that were written before the URL was persisted in the queue.
	 */
	async addPreservingCompletedFiles(urls: string[]): Promise<void> {
		this.addInternal(urls, true);
	}

	private addInternal(urls: string[], preserveCompletedFiles: boolean): void {
		const now = Date.now();
		for (const rawUrl of urls) {
			const url = canonicalQueueUrl(rawUrl);
			if (!url) continue;
			const existing = this.entries.get(url);
			if (existing) {
				// A queue entry can be marked completed just before a crash and
				// before its markdown file is written. A seed backfill must make
				// that missing output eligible for retry.
				if (
					preserveCompletedFiles &&
					!this.hasCompletedFile(existing) &&
					existing.status !== "queued"
				) {
					existing.status = "queued";
					existing.retries = 0;
					existing.lastError = undefined;
					existing.timestamp = now;
					this.dirty = true;
				}
				continue;
			}
			this.entries.set(url, {
				url,
				status:
					preserveCompletedFiles && this.completedFileUrls.has(url)
						? "completed"
						: "queued",
				retries: 0,
				timestamp: now,
			});
			this.dirty = true;
		}
	}

	/**
	 * Requeue completed entries whose output file is missing. This is intended
	 * for webpull resume: older versions marked a queue entry completed before
	 * writing markdown, so a crash could otherwise lose that page permanently.
	 */
	async requeueCompletedMissingFiles(): Promise<number> {
		let requeued = 0;
		const now = Date.now();
		for (const entry of this.entries.values()) {
			if (entry.status !== "completed" || this.hasCompletedFile(entry)) continue;
			entry.status = "queued";
			entry.retries = 0;
			entry.lastError = undefined;
			entry.timestamp = now;
			requeued++;
		}
		if (requeued > 0) this.dirty = true;
		return requeued;
	}

	private hasCompletedFile(entry: QueueEntry): boolean {
		return (
			this.completedFileUrls.has(entry.url) ||
			(entry.outputUrl !== undefined &&
				this.completedFileUrls.has(entry.outputUrl))
		);
	}

	/**
	 * Dequeue the next available URL (queued → in_progress).
	 * Returns null if no queued URLs remain.
	 * Lock-protected to prevent concurrent workers from grabbing the same URL.
	 */
	async next(): Promise<string | null> {
		// Acquire lock
		let releaseLock: () => void;
		const lockAcquired = new Promise<void>((r) => (releaseLock = r));
		const previousLock = this.lockPromise;
		this.lockPromise = previousLock.then(() => lockAcquired);
		await previousLock;

		try {
			const now = Date.now();
			for (const [, entry] of this.entries) {
				if (entry.status === "queued" && entry.retries < MAX_RETRIES) {
					entry.status = "in_progress";
					entry.timestamp = now;
					this.dirty = true;
					return entry.url;
				}
			}
			return null;
		} finally {
			releaseLock!();
		}
	}

	/**
	 * Mark a URL as completed successfully.
	 */
	async complete(url: string, outputUrl = url): Promise<void> {
		const entry = this.entries.get(canonicalQueueUrl(url));
		if (entry) {
			entry.status = "completed";
			entry.outputUrl = canonicalQueueUrl(outputUrl);
			entry.lastError = undefined;
			entry.timestamp = Date.now();
			this.dirty = true;
		}
	}

	/**
	 * Mark a URL as failed. Increments retry count.
	 * Returns true if the entry should be retried (retries < MAX_RETRIES).
	 */
	async fail(url: string, error: string): Promise<boolean> {
		const entry = this.entries.get(canonicalQueueUrl(url));
		if (!entry) return false;

		entry.retries++;
		entry.lastError = error;
		entry.timestamp = Date.now();

		if (entry.retries < MAX_RETRIES) {
			entry.status = "queued"; // will be retried
		} else {
			entry.status = "failed"; // give up
		}
		this.dirty = true;
		return entry.status === "queued";
	}

	/**
	 * Get and reset all URLs that were in_progress (for crash recovery).
	 */
	getInProgress(): string[] {
		const urls: string[] = [];
		for (const [, entry] of this.entries) {
			if (entry.status === "in_progress") {
				urls.push(entry.url);
			}
		}
		return urls;
	}

	/**
	 * Check if no more work remains.
	 */
	isDone(): boolean {
		for (const [, entry] of this.entries) {
			if (entry.status === "queued" || entry.status === "in_progress") {
				return false;
			}
		}
		return true;
	}

	// ── Stats ───────────────────────────────────────────────────────

	stats(): {
		queued: number;
		inProgress: number;
		completed: number;
		failed: number;
		total: number;
	} {
		let queued = 0,
			inProgress = 0,
			completed = 0,
			failed = 0;
		for (const [, entry] of this.entries) {
			switch (entry.status) {
				case "queued":
					queued++;
					break;
				case "in_progress":
					inProgress++;
					break;
				case "completed":
					completed++;
					break;
				case "failed":
					failed++;
					break;
			}
		}
		return { queued, inProgress, completed, failed, total: this.entries.size };
	}

	/**
	 * Snapshot all entries (for reporting).
	 */
	snapshot(): QueueEntry[] {
		return Array.from(this.entries.values());
	}

	/**
	 * Drain: flush pending writes and stop auto-save.
	 */
	async close(): Promise<void> {
		if (this.saveTimer) {
			clearInterval(this.saveTimer);
			this.saveTimer = null;
		}
		await this.flush();
	}

	// ── Persistence ─────────────────────────────────────────────────

	private startAutoSave(): void {
		const timer = setInterval(() => {
			if (this.dirty) {
				this.flush().catch(() => {});
			}
		}, SAVE_INTERVAL_MS);
		this.saveTimer = timer;
		timer.unref();
	}

	private async flush(): Promise<void> {
		if (!this.dirty) return;
		try {
			const lines: string[] = [];
			for (const [, entry] of this.entries) {
				lines.push(JSON.stringify(entry));
			}
			await writeFile(this.queuePath, lines.join("\n") + "\n", "utf8");
			this.dirty = false;
		} catch {
			// best-effort persistence
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Recursively scan a directory for .md files.
 */
async function scanMarkdownFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	let items: { name: string; isDirectory(): boolean; isFile(): boolean }[];
	try {
		const dirents = await readdir(dir, { withFileTypes: true });
		items = dirents as Dirent[];
	} catch {
		return results;
	}
	for (const item of items) {
		const full = join(dir, item.name);
		if (item.isDirectory && item.isDirectory() && !item.name.startsWith(".")) {
			const sub = await scanMarkdownFiles(full);
			results.push(...sub);
		} else if (item.isFile && item.isFile() && item.name.endsWith(".md")) {
			results.push(full);
		}
	}
	return results;
}

async function readFrontmatterUrl(path: string): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "r");
		const buf = Buffer.alloc(2048);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		const head = buf.toString("utf8", 0, bytesRead);
		const urlMatch = head.match(/^url:\s*(.+)$/m);
		return urlMatch ? urlMatch[1]!.trim().replace(/^"|"$/g, "") : null;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Check if a directory has a queue file (for resume detection).
 */
export function hasQueueFile(outDir: string): boolean {
	return existsSync(join(outDir, QUEUE_FILENAME));
}
