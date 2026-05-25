import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "../types.ts";
import type { RequestQueue } from "../request-queue.ts";

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
export function pageToPath(page: Page): string {
	let p = new URL(page.url).pathname;
	if (p.endsWith("/")) p += "index";
	p = p.replace(/\.html?$/, "").replace(/^\//, "");
	if (!p.endsWith(".md")) p += ".md";
	return p;
}

/** Normalize a URL to the same stem used by pageToPath for matching. */
export function urlStem(url: string): string {
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
			await fn(url);
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
