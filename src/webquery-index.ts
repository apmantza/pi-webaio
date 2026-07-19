// ─── BM25 index builder and loader for aio-webpull corpus ────────────
// Serializes per-chunk metadata into a compact JSON file alongside the
// pulled markdown files. Loaded at query time by aio-webquery.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { chunkMarkdown } from "./chunker.ts";

/** Index format version — bump when the stored shape changes. */
export const INDEX_VERSION = 1;

/** Name of the index file written into the output directory. */
export const INDEX_FILENAME = ".webaio-index.json";

/** One indexed chunk stored in the JSON file. */
export interface IndexedChunk {
	/** Relative path from outDir to the source markdown file. */
	file: string;
	/** Original URL from YAML frontmatter. */
	url: string;
	/** Heading breadcrumb derived from the chunk (first # heading found). */
	heading: string;
	/** The chunk text itself. */
	text: string;
}

/** Full index file structure. */
export interface WebpullIndex {
	version: number;
	/** ISO timestamp of the last build. */
	builtAt: string;
	/** Absolute path of the output directory at build time. */
	outDir: string;
	chunks: IndexedChunk[];
}

// ─── Index building ────────────────────────────────────────────────────

/**
 * Extract the source URL from YAML frontmatter in a markdown file.
 * Returns an empty string if no frontmatter is found.
 */
function extractFrontmatterUrl(markdown: string): string {
	const match = markdown.match(/^---\n[\s\S]*?^url:\s*"?([^"\n]+)"?\s*$/m);
	return match ? match[1].trim() : "";
}

/**
 * Extract the first H1/H2 heading from a chunk of text as a breadcrumb.
 */
function extractHeading(text: string): string {
	const match = text.match(/^#{1,6}\s+(.+)$/m);
	return match ? match[1].trim() : "";
}

/**
 * Walk `outDir` recursively and collect all `.md` files.
 */
async function collectMarkdownFiles(outDir: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue; // skip hidden files/dirs
			const full = join(dir, entry);
			let info;
			try {
				info = await stat(full);
			} catch {
				continue;
			}
			if (info.isDirectory()) {
				await walk(full);
			} else if (entry.endsWith(".md")) {
				results.push(full);
			}
		}
	}
	await walk(outDir);
	return results;
}

/**
 * Build a BM25 index from all markdown files currently on disk in `outDir`.
 * Writes the result to `<outDir>/.webaio-index.json`.
 *
 * This does a full rebuild — safe to call after any pull (incremental or fresh).
 */
export async function buildIndex(outDir: string): Promise<void> {
	const allFiles = await collectMarkdownFiles(outDir);
	const chunks: IndexedChunk[] = [];

	for (const fullPath of allFiles) {
		let markdown: string;
		try {
			markdown = await readFile(fullPath, "utf8");
		} catch {
			continue;
		}

		const url = extractFrontmatterUrl(markdown);
		const rel = relative(outDir, fullPath).replace(/\\/g, "/");

		const fileChunks = chunkMarkdown(markdown, {
			maxTokens: 512,
			overlapTokens: 50,
		});

		for (const chunk of fileChunks) {
			chunks.push({
				file: rel,
				url,
				heading: extractHeading(chunk.text),
				text: chunk.text,
			});
		}
	}

	const index: WebpullIndex = {
		version: INDEX_VERSION,
		builtAt: new Date().toISOString(),
		outDir,
		chunks,
	};

	await writeFile(
		join(outDir, INDEX_FILENAME),
		JSON.stringify(index),
		"utf8",
	);
}

// ─── Index loading ─────────────────────────────────────────────────────

export type LoadIndexResult =
	| { ok: true; index: WebpullIndex }
	| { ok: false; reason: "missing" | "version_mismatch" | "corrupt"; message: string };

/**
 * Load and validate the index from `outDir`.
 */
export async function loadIndex(outDir: string): Promise<LoadIndexResult> {
	const indexPath = join(outDir, INDEX_FILENAME);
	let raw: string;
	try {
		raw = await readFile(indexPath, "utf8");
	} catch {
		return {
			ok: false,
			reason: "missing",
			message: `No index found at ${indexPath}. Run aio-webpull on this directory first to build the index.`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			reason: "corrupt",
			message: `Index file at ${indexPath} is corrupt (invalid JSON). Re-run aio-webpull to rebuild it.`,
		};
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed)
	) {
		return {
			ok: false,
			reason: "corrupt",
			message: `Index file at ${indexPath} is missing required fields. Re-run aio-webpull to rebuild it.`,
		};
	}

	const obj = parsed as Record<string, unknown>;
	if (obj["version"] !== INDEX_VERSION) {
		return {
			ok: false,
			reason: "version_mismatch",
			message: `Index version mismatch (found ${obj["version"]}, expected ${INDEX_VERSION}). Re-run aio-webpull to rebuild the index.`,
		};
	}

	return { ok: true, index: parsed as WebpullIndex };
}
