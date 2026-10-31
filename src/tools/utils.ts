import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "../types.ts";
import type { RequestQueue } from "../request-queue.ts";
import { BASE_TEMP } from "../session-store.ts";

// ─── Safe path resolution under BASE_TEMP ────────────────────────────
// Resolves `userInput` against `BASE_TEMP` and verifies the result
// stays within the temp directory. Rejects absolute paths, ".."
// traversal, and any path that escapes via symlink-free checks.
//
// Throws an Error if the resolved path would escape BASE_TEMP.
export function safeResolveInBaseTemp(userInput: string): string {
	if (typeof userInput !== "string" || !userInput) {
		throw new Error("Path must be a non-empty string");
	}
	const baseTempWithSep = BASE_TEMP.endsWith(sep) ? BASE_TEMP : BASE_TEMP + sep;
	const resolved = resolve(BASE_TEMP, userInput);
	// Use strict prefix check: the resolved path must start with
	// BASE_TEMP + sep (or be exactly BASE_TEMP, which we also accept).
	if (resolved !== BASE_TEMP && !resolved.startsWith(baseTempWithSep)) {
		throw new Error(
			`Refusing to write outside temp dir: ${userInput} → ${resolved}`,
		);
	}
	return resolved;
}

// ─── Resolve CLI binary helper (used by cloneGitHubRepo) ────────────
const _resolvedBinaries = new Map<string, string | null>();
export function resolveBinary(name: string): string | null {
	const cached = _resolvedBinaries.get(name);
	if (cached !== undefined) return cached;
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const out = spawnSync(cmd, [name], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (out.error || out.status !== 0) {
			_resolvedBinaries.set(name, null);
			return null;
		}
		const resolved = out.stdout.trim().split("\n")[0] || null;
		_resolvedBinaries.set(name, resolved);
		return resolved;
	} catch {
		_resolvedBinaries.set(name, null);
		return null;
	}
}

// ─── Frontmatter ────────────────────────────────────────────────────
/**
 * Normalize a user-supplied URL (add https:// when the scheme is missing)
 * and validate it parses. Shared by webpull/webmap/webquery-style tools
 * (dedup, jscpd). Throws Error("Bad URL: <original>") on malformed input.
 */
export function normalizeInputUrl(rawInput: string): URL {
	let raw = rawInput;
	if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
	try {
		return new URL(raw);
	} catch {
		throw new Error(`Bad URL: ${rawInput}`);
	}
}

export function frontmatter(
	title: string,
	url: string,
	metadata?: {
		author?: string;
		published?: string;
		site?: string;
		language?: string;
		wordCount?: number;
	},
): string {
	let fm = `---\ntitle: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nurl: "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	if (metadata?.author)
		fm += `\nauthor: "${metadata.author.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	if (metadata?.published) fm += `\npublished: "${metadata.published}"`;
	if (metadata?.site)
		fm += `\nsite: "${metadata.site.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	if (metadata?.language) fm += `\nlanguage: "${metadata.language}"`;
	if (metadata?.wordCount) fm += `\nword_count: ${metadata.wordCount}`;
	fm += "\n---\n\n";
	return fm;
}

// ─── Page path helpers ──────────────────────────────────────────────
/**
 * The canonical output path for a URL. This is the pull's page IDENTITY:
 * `/learn/`, `/learn/index.html` and `/learn#x` all write `learn/index.md`, so
 * they are one page.
 *
 * There used to be two canonicalizers of different strength (issue #165 F22):
 * `search.ts` `canonicalizeUrl()` (host case, trailing slash, tracking params)
 * and `request-queue.ts` `canonicalQueueUrl()` (hash/search only). The pull path
 * used the weak one while completion was decided by the file, which is how two
 * queue entries came to write one file. The queue now takes this function as its
 * `pathFor` rule, so enqueue dedupe and completion answer to the same rule that
 * actually writes the file.
 */
export function urlToPagePath(url: string): string {
	// new URL throws on malformed URLs; fall back to the root stem.
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		pathname = "/";
	}
	let p = pathname;
	if (p.endsWith("/")) p += "index";
	p = p.replace(/\.html?$/, "").replace(/^\//, "");
	if (!p.endsWith(".md")) p += ".md";
	return p;
}

function pageToPath(page: Page): string {
	return urlToPagePath(page.url);
}

/** Normalize a URL to the same stem used by pageToPath for matching. */
function urlStem(url: string): string {
	try {
		const u = new URL(url);
		let p = u.origin + u.pathname;
		if (p.endsWith("/")) p += "index";
		p = p.replace(/\.html?$/, "");
		return p;
	} catch {
		return url;
	}
}

/** Rewrite absolute links between pulled pages to relative .md paths. */
export function rewriteLinks(
	markdown: string,
	pageUrlToPath: Map<string, string>,
	currentPath: string,
): string {
	const stemToPath = new Map<string, string>();
	for (const [url, path] of pageUrlToPath) {
		stemToPath.set(urlStem(url), path);
	}

	return markdown.replace(
		/\[([^\]]{0,5000})\]\(([^)\s]{1,5000})\)/g,
		(match, text, url) => {
			if (/^(#|mailto:|javascript:|data:)/.test(url)) return match;

			const key = urlStem(url);
			const target = stemToPath.get(key);

			if (target && target !== currentPath) {
				const fromDir = dirname(currentPath);
				let relPath = relative(fromDir, target).replace(/\\/g, "/");
				if (!relPath.startsWith(".")) relPath = "./" + relPath;

				try {
					const hash = new URL(url, "https://x").hash;
					if (hash) relPath += hash;
				} catch {
					/* ignore */
				}

				return `[${text}](${relPath})`;
			}

			return match;
		},
	);
}

export async function writePage(page: Page, outDir: string): Promise<string> {
	const rel = pageToPath(page);
	const full = join(outDir, rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, page.markdown, "utf8");
	return rel;
}

// ─── Concurrency helpers ────────────────────────────────────────────
export async function runInBatches<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let index = 0;

	async function worker(): Promise<void> {
		while (index < items.length) {
			const i = index++;
			results[i] = await fn(items[i]!, i);
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results;
}

/**
 * Run concurrent workers that pull URLs from a RequestQueue until done.
 */
export async function runPullFromQueue(
	queue: RequestQueue,
	concurrency: number,
	fn: (url: string) => Promise<void>,
): Promise<void> {
	async function worker(): Promise<void> {
		while (!queue.isDone()) {
			const url = await queue.next();
			if (!url) break;
			try {
				await fn(url);
			} catch {
				// If fn throws, mark as failed so the URL is retried
				// rather than stuck in-progress forever
				await queue.fail(url, "Worker threw unhandled error").catch(() => {});
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
