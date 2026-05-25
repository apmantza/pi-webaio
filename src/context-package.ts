// ─── Context package compilation ───────────────────────────────────
// Compiles multiple fetched pages into a single bounded artifact with
// an index, suitable for agent consumption or long-context LLM use.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PackagePage {
	url: string;
	title: string;
	content: string;
	/** Relative path within the output directory */
	relPath: string;
}

export interface CompiledPackage {
	/** Absolute path to the compiled package file */
	packagePath: string;
	/** Number of pages included */
	pageCount: number;
	/** Total characters across all pages */
	totalChars: number;
	/** Whether any pages were truncated to fit bounds */
	truncated: boolean;
}

const DEFAULT_MAX_PACKAGE_CHARS = 500_000; // ~125K tokens
const DEFAULT_MAX_PAGE_CHARS = 50_000;

/**
 * Compile a set of pages into a single markdown package with YAML index.
 */
export async function compileContextPackage(
	pages: PackagePage[],
	outDir: string,
	options?: {
		maxTotalChars?: number;
		maxPageChars?: number;
		packageName?: string;
	},
): Promise<CompiledPackage> {
	const maxTotal = options?.maxTotalChars ?? DEFAULT_MAX_PACKAGE_CHARS;
	const maxPage = options?.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS;
	const name = options?.packageName ?? "context-package";

	await mkdir(outDir, { recursive: true });

	let totalChars = 0;
	let truncated = false;
	const included: Array<{
		url: string;
		title: string;
		relPath: string;
		length: number;
	}> = [];

	const chunks: string[] = [];
	chunks.push("---\n");
	chunks.push(`package: ${name}\n`);
	chunks.push(`compiled_at: ${new Date().toISOString()}\n`);
	chunks.push(`pages: ${pages.length}\n`);
	chunks.push("---\n");

	for (const page of pages) {
		const budget = maxTotal - totalChars;
		if (budget <= 200) {
			truncated = true;
			break;
		}

		let pageContent = page.content;
		if (pageContent.length > maxPage) {
			pageContent = pageContent.slice(0, maxPage) + "\n\n[...truncated]";
			truncated = true;
		}
		if (pageContent.length > budget) {
			pageContent = pageContent.slice(0, budget) + "\n\n[...truncated]";
			truncated = true;
		}

		chunks.push(`\n---\n\n# ${page.title}\n\n`);
		chunks.push(`<!-- source: ${page.url} -->\n\n`);
		chunks.push(pageContent);
		chunks.push("\n");

		totalChars += pageContent.length;
		included.push({
			url: page.url,
			title: page.title,
			relPath: page.relPath,
			length: pageContent.length,
		});
	}

	// Append index at the end
	chunks.push("\n---\n\n## Index\n\n");
	for (const item of included) {
		chunks.push(`- [${item.title}](${item.url}) — ${item.length} chars\n`);
	}

	const packagePath = join(outDir, `${name}.md`);
	await mkdir(dirname(packagePath), { recursive: true });
	await writeFile(packagePath, chunks.join(""), "utf8");

	return {
		packagePath,
		pageCount: included.length,
		totalChars,
		truncated,
	};
}
