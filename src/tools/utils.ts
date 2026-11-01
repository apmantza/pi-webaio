import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "../types.ts";
import type { RequestQueue } from "../request-queue.ts";
import { BASE_TEMP } from "../session-store.ts";
import { estimateTokens } from "../token-count.ts";

/**
 * The content budget that leaves a COMPOSED answer inside `totalTokens`.
 *
 * `budgetTokens` is documented as a hard output-size ceiling on what the agent
 * sees, but every tool adds framing around the pruned body — a fetch header, a
 * stored-content header, a truncation pointer, a local-knowledge note. Charging the
 * budget to the body alone put that framing OUTSIDE the ceiling it claimed to bound:
 * measured on aio-webfetch at `budgetTokens: 100`, the body came back at 91 tokens and
 * the composed answer at 147 (independent review dlg-c3e2aa89).
 *
 * Floors at 1 rather than 0: a non-positive budget reads as "no budget", so an
 * impossible budget would otherwise fail open into returning the whole document.
 * Framing that is itself larger than the budget still overflows on purpose — the
 * floor bounds the framing, it cannot shrink the caller's header.
 */
export function contentBudgetForFraming(
	totalTokens: number,
	framing: string,
): number {
	return Math.max(1, totalTokens - estimateTokens(framing));
}

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
 * Decide the scheme of a user-supplied fetch target. Extracted from the inline
 * `if (!/^https?:\/\//i.test(x)) x = "https://" + x` that webfetch/webpull each
 * carried, plus the shared normalizeInputUrl (issue #165 F4). That pattern only
 * recognised the two-slash form, so `file:///etc/passwd` became
 * `https://file:///etc/passwd` — a DNS lookup for a host spelled `file`, reported
 * as a retryable `dns_error` — and `https:/x` became a lookup for host `https`.
 */
export type FetchTarget =
	| { ok: true; url: string; hostname: string; parsed: URL }
	| {
			ok: false;
			code: "unsupported_protocol" | "invalid_url";
			scheme?: string;
			url: string;
	  };

/** Matches a leading `scheme:` so an explicit scheme is never mistaken for a host. */
const LEADING_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * A port, optionally followed by the start of a path/query/fragment.
 * `host:443`, `host:8443/x`, `host:3000?cb=1`.
 */
const PORT_LIKE = /^\d{1,5}([/?#]|$)/;

/**
 * Decide whether a leading `token:` is an explicit scheme or a bare `host:port`.
 *
 * RFC 3986 allows `.` in a scheme name, so `example.com:8443/path` matches
 * `LEADING_SCHEME` with scheme `example.com`. `new URL()` cannot arbitrate
 * either — it parses `localhost:3000` as protocol `localhost:` — so the rule has
 * to be stated here. Rejecting the host:port shape was a real regression: the
 * inline regexes this helper replaced prefixed `https://` onto it and it worked,
 * and `host:port` is the ordinary way to name a local dev server.
 *
 * A dot in the token means host (`schemes` never contain one in practice, and no
 * dangerous scheme does). A dotless token is a scheme unless what follows the
 * colon is a port number — the one case that makes `localhost:3000` a host.
 * The residual risk is a scheme whose payload happens to look like a port
 * (`javascript:123`), which then becomes `https://javascript:123`: a DNS failure
 * for a host spelled `javascript`, never a `javascript:` URL. Degradation is
 * toward a harmless lookup, not toward execution.
 */
function isExplicitScheme(token: string, rest: string): boolean {
	if (token.includes(".")) return false;
	return !PORT_LIKE.test(rest);
}


export function normalizeFetchTarget(rawInput: string): FetchTarget {
	const raw = String(rawInput ?? "").trim();
	if (!raw) return { ok: false, code: "invalid_url", url: rawInput };

	// Parse-first would be tempting, but a bare "example.com" throws in the URL
	// parser while "file:///x" parses fine, so the two cases cannot be told apart
	// by a failed parse. Detect the scheme explicitly instead.
	const schemeMatch = LEADING_SCHEME.exec(raw);
	// No scheme at all (bare host, or protocol-relative `//host/path`) and a bare
	// `host:port` both take the default scheme, as the tools always assumed.
	let candidate = `https://${raw}`;
	if (schemeMatch) {
		const scheme = schemeMatch[1]!.toLowerCase();
		const rest = raw.slice(schemeMatch[1]!.length + 1);
		if (scheme !== "http" && scheme !== "https" && isExplicitScheme(scheme, rest)) {
			// The defect this exists for: prefixing `https://` onto a `file:` URL
			// produced a DNS lookup for a host spelled `file` and a retryable
			// network error instead of a validation refusal.
			return {
				ok: false,
				code: "unsupported_protocol",
				scheme: `${schemeMatch[1]}:`,
				url: raw,
			};
		}
		// Explicit http(s) is used as written — including the single-slash `https:/x`
		// form the old two-slash regex missed (URL parses it as host `x`).
		if (scheme === "http" || scheme === "https") candidate = raw;
	}
	try {
		const u = new URL(candidate);
		if (!u.hostname) return { ok: false, code: "invalid_url", url: rawInput };
		return { ok: true, url: u.toString(), hostname: u.hostname, parsed: u };
	} catch {
		return { ok: false, code: "invalid_url", url: rawInput };
	}
}

/**
 * Normalize a user-supplied URL (add https:// when the scheme is missing)
 * and validate it parses. Shared by webpull/webmap/webquery-style tools
 * (dedup, jscpd). Throws Error("Bad URL: <original>") on malformed input.
 */
export function normalizeInputUrl(rawInput: string): URL {
	const t = normalizeFetchTarget(rawInput);
	if (!t.ok) throw new Error(`Bad URL: ${rawInput}`);
	return t.parsed;
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
