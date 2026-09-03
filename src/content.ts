// ─── Content extraction pipeline ───────────────────────────────────
// Extracted from index.ts. HTML cleaning, Readability, Defuddle, PDF,
// JSON, RSC extraction, alternate links, and bot protection fallback.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { detectBotBlock } from "./bot-detection.ts";
import { extractDataIslands } from "./data-islands.ts";
import { smartFetch, fetchWithPlaywright, fetchBuffer } from "./fetch.ts";
import { captureResponseValidators } from "./http-validators.ts";
import {
	runVerticalExtractor,
	findVerticalExtractor,
} from "./verticals/registry.ts";
import { runAfterFetchHooks, runAfterExtractHooks } from "./hooks.ts";
import {
	detectPaywall,
	bypassUrl,
	stripPaywallText,
	findStrategy,
	isKnownPaywallSite,
} from "./paywall.ts";
import { detectPromptInjection, applyInjectionAction } from "./injection.ts";
import { compressHtml } from "./html-compress.ts";
import { isDangerousUrl, scanForSecrets } from "./security.ts";
import { BASE_TEMP } from "./session-store.ts";
import { loadPdfParseCtor } from "./types.ts";
import type { PullResult, FetchOpts, FetchErrorInfo } from "./types.ts";
import { formatErrorInfo } from "./types.ts";
import { createFetchError } from "./tools/fetch-error.ts";

// ─── Constants ─────────────────────────────────────────────────────

const MARKDOWN_SIGNAL =
	/^(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s|\[[^\]]+\]\([^)]+\))/m;
// Defuddle is CPU-bound and ~14x slower than Readability on large docs
// (measured 2605ms vs 182ms on 625KB). It only runs when Readability
// fails, so bound its worst-case worker stall tightly rather than the
// previous generous 8s.
export const DEFUDDLE_TIMEOUT = 3000; // life-depends: 4000→3000 — Readability already covers 95%, Defuddle is fallback only
export const MAX_PREVIEW_CHARS = 1800;

const MAX_CLIENT_REDIRECTS = 5;
const MIN_ALTERNATE_FALLBACK_WORDS = 30;

// Local extraction (Readability/Defuddle) is considered to have produced
// enough content when it yields at least this many words. Below this, the
// page is likely JS-heavy and we fall back to the Jina proxy reader.
export const MIN_LOCAL_WORDS = 50;

// Readability is accepted unless its output is a suspiciously tiny
// fraction of a large HTML document (a sign it latched onto boilerplate
// rather than the article). Lowered from 1% to 0.5% so more pages resolve
// via the much-cheaper Readability path instead of falling through to
// Defuddle.
export const READABILITY_MIN_RATIO = 0.005;

/**
 * Heuristic: did Readability "fail" by extracting far too little of a
 * large document? Only applied to large HTML (>10KB) where a real article
 * should dwarf the boilerplate. Exported for offline testing.
 */
/**
 * Pre-flight secret-scan result: builds the FetchErrorInfo + FetchError for
 * a URL that carried a credential. Shared by the pull paths (dedup, jscpd).
 */
function blockedSecretResult(url: string, matches: string[]): PullResult {
	const info: FetchErrorInfo = {
		message: `Request blocked: potential secret(s) detected in URL (${matches.join(", ")})`,
		code: "blocked",
		phase: "validation",
		retryable: false,
	};
	const fetchError = createFetchError("blocked_secret", info.message, {
		url,
		phase: "validation",
	});
	return {
		ok: false,
		url,
		error: formatErrorInfo(info),
		errorInfo: info,
		fetchError,
	};
}

export function readabilityRatioFailed(
	contentLength: number,
	htmlLength: number,
): boolean {
	return (
		htmlLength > 10000 && contentLength < READABILITY_MIN_RATIO * htmlLength
	);
}

// ─── Noise selectors ───────────────────────────────────────────────

const NOISE_SELECTORS = [
	"nav",
	"footer",
	"header",
	"svg",
	"canvas",
	"iframe",
	"form",
	"[aria-hidden='true']",
	"[hidden]",
	"[role='navigation']",
	"[role='banner']",
	"[role='contentinfo']",
].join(",");

const CONSENT_SELECTORS = [
	"#onetrust-banner-sdk",
	"#onetrust-consent-sdk",
	".onetrust-pc-dark-filter",
	".onetrust-banner-container",
	"#CybotCookiebotDialog",
	".CybotCookiebotDialog",
	"#CybotCookiebotDialogBackground",
	"#didomi-host",
	"#didomi-notice",
	".didomi-notice",
	".qc-cmp2-ui-root",
	".qc-cmp2-container",
	".qc-cmp2-panel-container",
	"#usercentrics-root",
	".uc-ui-container",
	"#truste-consent-modal",
	"#truste-consent-track",
	".trustarc-banner",
	"#truste-consent-heading",
	".klaro",
	"#sp-root",
	"#sp-frame-root",
	".sp-root",
	"#cookie-law-info-bar",
	".cky-consent-container",
	"#cookie-law-info",
	"#osano-cm-dialog",
	".osano-cm-dialog",
	"#osano-cm-window",
	".osano-cm-window",
	"#cookie-first",
	"#adobe-font-manager",
	"#adobe-privacy-message-center",
	"#smartconsent-modal",
	"#smartconsent-root",
	"#chv-banner",
	"#chv-module",
	"#tc-warning",
	"#cookie-preferences",
	"#cookie-policy",
	"[class*='cookie-banner']",
	"[class*='cookie-consent']",
	"[class*='cookie-notice']",
	"[class*='cookieBar']",
	"[class*='cookieConsent']",
	"[class*='CookieBanner']",
	"[class*='CookieConsent']",
	"[class*='CookieNotice']",
	"[class*='cookie-bar']",
	"[class*='CookieBar']",
	"[class*='gdpr-banner']",
	"[class*='gdpr-consent']",
	"[class*='GdprBanner']",
	"[class*='consent-banner']",
	"[class*='consent-modal']",
	"[class*='consent-dialog']",
	"[class*='consentBar']",
	"[class*='ConsentBanner']",
	"[class*='ConsentModal']",
	"[class*='privacy-banner']",
	"[class*='privacy-notice']",
	"[class*='PrivacyBanner']",
	"[id*='cookie-banner']",
	"[id*='cookie-consent']",
	"[id*='cookie-notice']",
	"[id*='cookieBar']",
	"[id*='CookieBanner']",
	"[id*='CookieConsent']",
	"[id*='gdpr-banner']",
	"[id*='consent-banner']",
	"[id*='consent-dialog']",
	"[id*='consent-modal']",
	"[role='dialog']",
	"[data-cookieconsent]",
	"[data-cmp]",
].join(",");

const ALL_NOISE_SELECTORS = `${NOISE_SELECTORS},${CONSENT_SELECTORS}`;

// ─── HTML cleaning ─────────────────────────────────────────────────

export function preCleanHtml(html: string): string {
	const res = preCleanHtmlWithDocument(html);
	return res ? res.html : html;
}

/** Single-parse variant: returns both cleaned HTML and its Document to avoid double parseHTML. */
function preCleanHtmlWithDocument(
	html: string,
): { html: string; document: Document } | null {
	try {
		const { document } = parseHTML(html);
		document
			.querySelectorAll(ALL_NOISE_SELECTORS)
			.forEach((el: Element) => el.remove());
		return {
			html: document.documentElement.outerHTML,
			// SAFETY: linkedom's Document implements the DOM Document surface required by Readability
			document: document as unknown as Document,
		};
	} catch {
		return null;
	}
}

function cleanText(value: string): string {
	let s = value.replace(/\r/g, "");
	s = s.replace(/[^\S\n]+/g, " ");
	const lines = s.split("\n");
	s = lines
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.join("\n");
	return s;
}

function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1]!.replace(/\*+/g, "").trim();
	return cleaned || null;
}

export function stripDefuddleComments(content: string): string {
	return content.replace(/\n---\n+## Comments[\s\S]*$/i, "").trimEnd();
}

/**
 * Safe hostname extraction for log messages: new URL throws on malformed
 * input, and hostnames here can originate from user-supplied URLs. Returns
 * "<invalid-url>" rather than throwing (unchecked-throwing-call hardening).
 */
function safeHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "<invalid-url>";
	}
}

// ─── CSS / style cruft stripping (Fix 2) ────────────────────────
// Wikipedia-style pages leak `<style>` blocks and standalone CSS rules
// (`.mw-parser-output …{…}`, `#id{…}`) into the extracted markdown. This
// pollutes word counts, the outline, the frugal preview, and the cached
// content. Strip that leaked CSS — but NEVER legitimate fenced code blocks:
// a ```css / ```scss / ```less fence is preserved verbatim. Conservative by
// design: when a line is not clearly leaked CSS, it is left alone.

/** A fenced-code delimiter (``` or ~~~), up to 3 leading spaces. */
const CSS_FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Does this (trimmed, outside-any-fence) line look like a standalone CSS
 * rule that leaked into prose — `selector { declarations }` on one line?
 * Requires a `{…}` pair whose selector carries a CSS signal char
 * (`. # [ : > ~ + @`) and whose body holds a `prop:value` declaration, so
 * prose or code like `if (x) { y }` is never touched.
 */
function isCssRuleLine(trimmed: string): boolean {
	if (!trimmed) return false;
	const m = trimmed.match(/^([^{}]+)\{([^{}]*)\}$/);
	if (!m) return false;
	const selector = m[1]!.trim();
	const decls = m[2]!;
	// Selector must carry a CSS signal char (catches .class, #id, a:hover,
	// @media, [attr], child combinators) — avoids `if (…) {…}` false positives.
	if (!/[.#:[>@~+]/.test(selector)) return false;
	// Declarations must contain a CSS `prop:value`.
	if (!/[a-z-]+\s*:/i.test(decls)) return false;
	return true;
}

/** CSS at-rules that can wrap nested rule blocks (`@media (…) { .x { … } }`). */
const CSS_AT_RULE_RE =
	/^@(media|supports|keyframes|import|font-face|page|charset|namespace|layer|container|scope|property|document)\b/i;

/**
 * Classify a (trimmed, outside-any-fence) line for CSS at-rule cruft that the
 * simple `isCssRuleLine` regex can't catch because at-rules nest braces
 * (`@media (…) { .sel { prop:val } }`). Returns:
 *  - `0`  — not an at-rule line;
 *  - `-1` — a complete single-line at-rule (balanced braces) → strip this line;
 *  - `>0` — opens a multi-line at-rule with this many unclosed `{` → skip lines
 *           until the braces balance.
 * Requires a CSS signal inside so prose that merely starts with an `@media`-like
 * token is never touched.
 */
function cssAtRuleState(trimmed: string): number {
	if (!CSS_AT_RULE_RE.test(trimmed) || !trimmed.includes("{")) return 0;
	if (!/[.#:[>@~+]/.test(trimmed) && !/[a-z-]+\s*:/i.test(trimmed)) return 0;
	const opens = (trimmed.match(/\{/g) || []).length;
	const closes = (trimmed.match(/\}/g) || []).length;
	if (opens === 0) return 0;
	const delta = opens - closes;
	return delta === 0 ? -1 : delta;
}

/**
 * Remove CSS/style cruft that leaked into extracted markdown: `<style>…</style>`
 * blocks, standalone single-line CSS rules, and CSS at-rules (`@media` /
 * `@supports` / …, single- or multi-line). Fence-aware — anything inside a
 * ``` / ~~~ code fence (including ```css) is preserved verbatim. Idempotent.
 */
export function stripCssCruft(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let inStyle = false;
	let atRuleDepth = 0;

	for (const line of lines) {
		// Fence tracking takes priority — code blocks are sacred.
		const fence = line.match(CSS_FENCE_RE);
		if (fence) {
			const ch = fence[1]![0];
			if (!inFence) {
				inFence = true;
				fenceChar = ch;
			} else if (ch === fenceChar) {
				inFence = false;
				fenceChar = "";
			}
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		// `<style>…</style>` block removal (may span multiple lines).
		if (inStyle) {
			if (/<\/style\s*>/i.test(line)) inStyle = false;
			continue;
		}
		if (/<style\b[^>]*>/i.test(line)) {
			// A style block that opens AND closes on one line.
			if (!/<\/style\s*>/i.test(line)) inStyle = true;
			continue;
		}

		// CSS at-rule cruft (`@media` / `@supports` / …), possibly multi-line.
		if (atRuleDepth > 0) {
			const opens = (line.match(/\{/g) || []).length;
			const closes = (line.match(/\}/g) || []).length;
			atRuleDepth = Math.max(0, atRuleDepth + opens - closes);
			continue;
		}
		const atState = cssAtRuleState(line.trim());
		if (atState === -1) continue; // complete single-line at-rule
		if (atState > 0) {
			atRuleDepth = atState; // multi-line at-rule begins
			continue;
		}

		// Standalone leaked CSS rule line.
		if (isCssRuleLine(line.trim())) continue;

		out.push(line);
	}

	return out.join("\n");
}

// ─── Readability extraction ────────────────────────────────────────

export function extractReadability(
	html: string,
	_url: string,
): { title: string; content: string } | null {
	try {
		const { document } = parseHTML(html);
		// SAFETY: linkedom's Document implements the DOM Document surface required by Readability
		return extractReadabilityFromDocument(document as unknown as Document);
	} catch {
		return null;
	}
}

function extractReadabilityFromDocument(
	document: Document,
): { title: string; content: string } | null {
	try {
		// SAFETY: caller guarantees Document is a linkedom Document compatible with Readability
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();
		if (!article || (article.textContent?.length ?? 0) < 200) return null;
		return {
			title: article.title || extractHeadingTitle(article.textContent || "") || "",
			content: article.textContent || "",
		};
	} catch {
		return null;
	}
}

// ─── RSC (React Server Components) extraction ──────────────────────

export function extractRSC(html: string): string | null {
	const matches = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)/gs)];
	if (!matches.length) return null;

	const chunks: string[] = [];
	for (const m of matches) {
		try {
			const data = JSON.parse(m[1]!);
			if (Array.isArray(data) && data.length >= 2) {
				const payload =
					typeof data[1] === "string" ? data[1] : JSON.stringify(data[1]);
				const readable = payload
					.split(/["\n]/)
					.filter(
						(s) =>
							s.length > 30 &&
							/[a-z]{3,}/.test(s) &&
							!s.startsWith("$") &&
							!s.startsWith("@"),
					)
					.join("\n\n");
				if (readable) chunks.push(readable);
			}
		} catch {
			/* ignore */
		}
	}
	return chunks.length ? chunks.join("\n\n").slice(0, 20000) : null;
}

// ─── PDF extraction ────────────────────────────────────────────────

async function extractPDF(
	buffer: Buffer,
	url: string,
): Promise<PullResult | null> {
	try {
		const PDFParseCtor = await loadPdfParseCtor();
		const parser = new PDFParseCtor({ data: new Uint8Array(buffer) });
		await parser.load();
		const data = await parser.getText();
		if (!data.text?.trim()) return null;
		return {
			ok: true,
			url,
			title: new URL(url).pathname.split("/").pop() || "Document",
			content: `## PDF Content (${data.total} pages)\n\n${data.text}`,
		};
	} catch {
		return null;
	}
}

// ─── Timeout helper ────────────────────────────────────────────────

/**
 * Race a promise against a timeout, without leaving the loser promise
 * dangling (which would cause an unhandled rejection in Node 15+ when
 * the timeout wins and the original promise later rejects).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("timeout"));
		}, ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

// ─── Smart content-type detection ──────────────────────────────────

export function isJsonContentType(ct: string): boolean {
	const norm = ct.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		norm === "application/json" || norm === "text/json" || norm.endsWith("+json")
	);
}

export function isLikelyJsonBody(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function formatJsonContent(text: string, url: string): PullResult {
	try {
		const parsed = JSON.parse(text);
		const formatted = JSON.stringify(parsed, null, 2);
		const truncated =
			formatted.length > 50000
				? formatted.slice(0, 50000) + "\n\n[... truncated]"
				: formatted;
		return {
			ok: true,
			url,
			title: new URL(url).pathname.split("/").pop() || "response.json",
			content: `\`\`\`json\n${truncated}\n\`\`\``,
		};
	} catch {
		return {
			ok: true,
			url,
			title: "response.json",
			content: `\`\`\`\n${text.slice(0, 50000)}\n\`\`\``,
		};
	}
}

// ─── Client-side redirect extraction ───────────────────────────────

export function extractClientSideRedirect(
	html: string,
	baseUrl: string,
): string | null {
	const snippet = html.slice(0, 4096);
	const resolveTarget = (rawTarget: string): string | null => {
		const target = rawTarget.trim().replace(/^['"]|['"]$/g, "");
		if (!target || /[\u0000-\u001f\u007f]/.test(target)) return null;
		try {
			const resolvedUrl = new URL(target, baseUrl);
			if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:")
				return null;
			const resolved = resolvedUrl.toString();
			return resolved === baseUrl ? null : resolved;
		} catch {
			return null;
		}
	};

	const meta = snippet.match(
		/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?([^"'>]*)/i,
	);
	if (meta) {
		const parts = meta[1]!.split(";");
		const delay = Number.parseFloat(parts[0]!.trim());
		if (Number.isFinite(delay) && delay >= 0 && delay < 30) {
			const urlMatch = parts
				.slice(1)
				.join(";")
				.match(/url\s*=\s*(.+)/i);
			if (urlMatch) {
				const resolved = resolveTarget(urlMatch[1]!);
				if (resolved) return resolved;
			}
		}
	}

	// Some static sites emit a tiny HTML shell that redirects with JavaScript
	// instead of a meta tag (for example, `/release-notes/overview` on the
	// TypeScript docs site). Inspect script bodies only and accept literal
	// location assignments/calls; do not evaluate arbitrary page JavaScript.
	for (const match of snippet.matchAll(
		/<script\b[^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		const script = match[1] ?? "";
		const assignment = script.match(
			/^\s*(?:window\.|document\.)?location(?:\.href)?\s*=\s*(["'])(.*?)\1\s*;?\s*$/i,
		);
		const call = script.match(
			/^\s*(?:window\.|document\.)?location\.(?:replace|assign)\(\s*(["'])(.*?)\1\s*\)\s*;?\s*$/i,
		);
		const resolved = resolveTarget(assignment?.[2] ?? call?.[2] ?? "");
		if (resolved) return resolved;
	}
	return null;
}

// ─── Alternate link extraction ─────────────────────────────────────

export function extractAlternateLinks(html: string, baseUrl: string): string[] {
	const accepted = [
		"application/json",
		"text/json",
		"text/markdown",
		"text/plain",
	];
	const snippet = html.length > 10000 ? html.slice(0, 10000) : html;
	const links: string[] = [];
	const pattern =
		/<link[^>]+rel=["']alternate["'][^>]*type=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
	const pattern2 =
		/<link[^>]+type=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
	for (const re of [pattern, pattern2]) {
		let match: RegExpExecArray | null;
		while ((match = re.exec(snippet)) !== null) {
			const type = match[1]!.toLowerCase();
			if (accepted.some((a) => type === a || type.endsWith("+json"))) {
				const href = match[2]!;
				try {
					const target = new URL(href, baseUrl).toString();
					if (target !== baseUrl && !links.includes(target)) {
						links.push(target);
					}
				} catch {
					/* ignore */
				}
			}
		}
	}
	return links;
}

// ─── Fallback extraction ───────────────────────────────────────────

function fallbackExtract(html: string): {
	title: string;
	content: string;
} {
	const { document } = parseHTML(html);
	const t = document.querySelector("title")?.textContent || "";
	const el =
		document.querySelector("main") ??
		document.querySelector("article") ??
		document.querySelector("body");
	return {
		title: t,
		content: cleanText(el?.textContent ?? ""),
	};
}

// ─── Title resolution ──────────────────────────────────────────────

/**
 * Resolve a human-readable title from raw HTML, trying og:title, then
 * <title>, then the first <h1>, before falling back to the hostname.
 * Hostname is the true last resort — used only when every real signal
 * is empty.
 */
export function resolveHtmlTitle(html: string, finalUrl: string): string {
	try {
		const { document } = parseHTML(html);
		const og = document
			.querySelector('meta[property="og:title"]')
			?.getAttribute("content")
			?.trim();
		if (og) return og;
		const title = document.querySelector("title")?.textContent?.trim();
		if (title) return title;
		const h1 = document.querySelector("h1")?.textContent?.trim();
		if (h1) return h1;
	} catch {
		// fall through to hostname fallback
	}
	try {
		return new URL(finalUrl).hostname;
	} catch {
		return "";
	}
}

// ─── Inject detection & trust boundaries ─────────────────────────

export function finalizePullResult(
	result: PullResult,
	redirectNotice?: string,
): PullResult {
	if (!result.ok || !result.content) return result;

	let content = result.content;

	// Fix 2: strip leaked CSS / `<style>` cruft before anything else so the
	// cached content, word counts, outline, and preview are all clean.
	// Fence-aware — legitimate ```css code blocks are preserved verbatim.
	content = stripCssCruft(content);

	// Always strip trailing paywall text from extracted markdown,
	// even when bypass wasn't requested. Sites like Medium embed
	// "Subscribe to read more" inline; this cleans them up.
	if (!content.startsWith("> via ") && !content.startsWith("> Data islands")) {
		content = stripPaywallText(content);
	}

	if (redirectNotice) {
		content = redirectNotice + "\n\n" + content;
	}

	content = `[UNTRUSTED WEB CONTENT START]\n${content}\n[UNTRUSTED WEB CONTENT END]`;

	const injection = detectPromptInjection(content);
	return {
		...result,
		content: applyInjectionAction(content, injection),
	};
}

// ─── Alternate link fallback ──────────────────────────────────────

async function tryAlternateLinks(
	rawHtml: string,
	baseUrl: string,
	opts: FetchOpts | undefined,
): Promise<PullResult | null> {
	const altLinks = extractAlternateLinks(rawHtml, baseUrl);
	for (const altUrl of altLinks.slice(0, 3)) {
		const altRes = await smartFetch(altUrl, {
			...opts,
			headers: {
				Accept: "application/json,text/plain,*/*;q=0.8",
				...opts?.headers,
			},
		});
		if (altRes && altRes.status < 400) {
			const altText = altRes.text;
			const altCt = altRes.headers.get("content-type") ?? "";
			if (isJsonContentType(altCt) || isLikelyJsonBody(altText)) {
				return formatJsonContent(altText, baseUrl);
			}
			return {
				ok: true,
				url: baseUrl,
				title: "",
				content: altText,
			};
		}
	}
	return null;
}

// ─── Binary download ────────────────────────────────────────────────

async function downloadToTemp(
	buffer: Buffer,
	contentType: string,
	contentDisposition: string,
	url: string,
): Promise<PullResult> {
	let filename = "";
	const cdMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?([^;]+)/i);
	if (cdMatch) {
		try {
			filename = decodeURIComponent(cdMatch[1]!.trim().replace(/^"|"$/g, ""));
		} catch {
			filename = cdMatch[1]!.trim().replace(/^"|"$/g, "");
		}
	}
	if (!filename) {
		// new URL throws on malformed input; fall back to the raw URL stem.
		try {
			filename =
				new URL(url).pathname.split("/").filter(Boolean).pop() || "download";
		} catch {
			filename = "download";
		}
	}
	filename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

	const dir = join(BASE_TEMP, "downloads");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, filename);
	await writeFile(filePath, buffer);

	const ext = filename.split(".").pop() || "";
	const typeLabel = ext.toUpperCase() || contentType.split("/").pop() || "file";

	return {
		ok: true,
		url,
		title: `📦 ${filename} (${typeLabel}, ${buffer.length} bytes)`,
		content: `Downloaded to \`${filePath}\` (${buffer.length} bytes, ${typeLabel})`,
		filePath,
	};
}

// ─── Word count helper ──────────────────────────────────────────────

const _wordCountCache = new Map<string, number>();
const _WORD_COUNT_CACHE_MAX = 256;

export function wordCount(text: string): number {
	const cached = _wordCountCache.get(text);
	if (cached !== undefined) return cached;
	const count = text.trim().split(/\s+/).filter(Boolean).length;
	if (_wordCountCache.size >= _WORD_COUNT_CACHE_MAX) {
		const oldest = _wordCountCache.keys().next().value as string | undefined;
		if (oldest !== undefined) _wordCountCache.delete(oldest);
	}
	_wordCountCache.set(text, count);
	return count;
}

// ─── HTML content pipeline (shared by normal + browser-mode paths) ─

/**
 * Follow a client-side (<meta http-equiv="refresh">) redirect if present,
 * bounded by MAX_CLIENT_REDIRECTS. Returns the recursive pull result, or
 * null when there is no redirect to follow (dedup, jscpd — shared by the
 * HTML override and regular HTML paths).
 */
async function maybeFollowClientRedirect(
	text: string,
	finalUrl: string,
	opts: FetchOpts | undefined,
	_redirectCount: number,
): Promise<PullResult | null> {
	if (_redirectCount >= MAX_CLIENT_REDIRECTS) return null;
	const redirectTarget = extractClientSideRedirect(text, finalUrl);
	if (!redirectTarget) return null;
	return pullPage(redirectTarget, opts, _redirectCount + 1);
}

/**
 * Reprocess a bypassed page through the HTML pipeline (htmlOverride path),
 * prefixing the result with a note about the bypass strategy. Shared by the
 * hard-paywall and marker-based bypass paths (dedup, jscpd).
 */
async function reprocessViaBypass(
	url: string,
	opts: FetchOpts | undefined,
	_redirectCount: number,
	bypassed: {
		ok?: boolean;
		text?: string;
		strategy?: string;
		paywall?: { paywalled?: boolean; confidence?: number };
	} | null,
	note: string,
): Promise<PullResult | null> {
	if (!bypassed?.ok || !bypassed.text || bypassed.paywall?.paywalled)
		return null;
	const bypassedResult = await pullPage(
		url,
		opts,
		_redirectCount,
		bypassed.text,
	);
	if (!bypassedResult.ok) return null;
	return finalizePullResult({
		...bypassedResult,
		content: bypassedResult.content
			? note + "\n\n" + bypassedResult.content
			: bypassedResult.content,
	});
}

export async function runHtmlPipeline(
	text: string,
	finalUrl: string,
	url: string,
	_opts: FetchOpts | undefined,
	redirectNotice: string | undefined,
): Promise<PullResult> {
	const redirectTarget = extractClientSideRedirect(text, finalUrl);
	if (redirectTarget) {
		return pullPage(redirectTarget, _opts, 1);
	}

	const hookedText = await runAfterFetchHooks(url, {
		status: 200,
		headers: {},
		html: text,
	});
	// Single-parse optimisation: preClean once and reuse its Document for
	// Readability, avoiding a second parseHTML. Falls back to string path
	// if cleaning fails.
	const preCleaned = preCleanHtmlWithDocument(hookedText);
	let cleaned: string;
	let preCleanDoc: Document | null = null;
	if (preCleaned) {
		cleaned = compressHtml(preCleaned.html);
		preCleanDoc = preCleaned.document;
	} else {
		cleaned = compressHtml(preCleanHtml(hookedText));
	}
	const rawHtml = hookedText;

	// Local extraction first (Readability → RSC → Defuddle → fallback) on
	// the HTML we already downloaded. The Jina proxy reader re-fetches the
	// same page server-side, so it is a *fallback* for genuinely JS-heavy
	// pages that yield too few words locally — not the first step.
	const local = await runLocalExtraction(
		cleaned,
		hookedText,
		finalUrl,
		rawHtml,
		preCleanDoc,
	);

	let chosen = local;
	const localWords = wordCount(local.content || "");
	if (localWords < MIN_LOCAL_WORDS && !(await isDangerousUrl(url))) {
		const { fetchJina } = await import("./fetch-jina.ts");
		const jina = await fetchJina(url);
		// Prefer Jina only when it actually recovered more content than the
		// local pass — never downgrade a thin Jina body over a usable local
		// extraction.
		if (jina && wordCount(jina.content || "") > localWords) {
			chosen = jina;
		}
	}

	if (wordCount(chosen.content || "") < MIN_ALTERNATE_FALLBACK_WORDS) {
		const alt = await tryAlternateLinks(hookedText, finalUrl, _opts);
		if (alt) return finalizePullResult(alt, redirectNotice);
	}
	return finalizePullResult(chosen, redirectNotice);
}

/**
 * Run the purely-local extraction chain (no network) over HTML we already
 * have: Readability, then Next.js RSC payloads, then Defuddle (bounded by
 * DEFUDDLE_TIMEOUT), then a last-resort text fallback. Returns an
 * unfinalized PullResult; the caller decides whether to fall back to Jina
 * and applies finalization / alternate-link handling.
 */
async function runLocalExtraction(
	cleaned: string,
	hookedText: string,
	finalUrl: string,
	rawHtml: string,
	preCleanDoc?: Document | null,
): Promise<PullResult> {
	// Reuse the Document from the single preClean parse when available
	const readability = preCleanDoc
		? extractReadabilityFromDocument(preCleanDoc)
		: extractReadability(cleaned, finalUrl);
	if (readability) {
		// Accept Readability whenever it produced a usable article, or when
		// the ratio heuristic did not flag it as boilerplate. This resolves
		// more pages via the cheap Readability path instead of Defuddle.
		if (
			wordCount(readability.content) >= MIN_LOCAL_WORDS ||
			!readabilityRatioFailed(readability.content.length, hookedText.length)
		) {
			return {
				ok: true,
				url: finalUrl,
				title: readability.title,
				content: readability.content,
				rawHtml,
			};
		}
	}

	const rscContent = extractRSC(hookedText);
	if (rscContent) {
		return {
			ok: true,
			url: finalUrl,
			// Derive a real title from the HTML (og:title → <title> →
			// <h1>) instead of hardcoding the hostname for Next.js SPAs.
			title: resolveHtmlTitle(hookedText, finalUrl),
			content: rscContent,
		};
	}

	try {
		const result = await withTimeout(
			Defuddle(cleaned, finalUrl, { markdown: true }),
			DEFUDDLE_TIMEOUT,
		);
		let defContent = result.content || "";
		defContent = stripDefuddleComments(defContent);
		defContent = cleanText(defContent);
		return {
			ok: true,
			url: finalUrl,
			title: result.title || "",
			content: defContent,
			author: result.author || undefined,
			published: result.published || undefined,
			site: result.site || undefined,
			language: result.language || undefined,
			wordCount: result.wordCount || undefined,
		};
	} catch {
		const { title, content } = fallbackExtract(cleaned);
		return { ok: true, url: finalUrl, title, content, rawHtml };
	}
}

// ─── Pull page (full fetch + pipeline) ─────────────────────────────

async function pullPage(
	url: string,
	opts?: FetchOpts,
	_redirectCount = 0,
	htmlOverride?: string,
): Promise<PullResult> {
	let redirectNotice: string | undefined;

	if (htmlOverride !== undefined) {
		const text = htmlOverride;
		const finalUrl = url;

		const redirected = await maybeFollowClientRedirect(
			text,
			finalUrl,
			opts,
			_redirectCount,
		);
		if (redirected) return redirected;

		return runHtmlPipeline(text, finalUrl, url, opts, redirectNotice);
	}

	// Pre-flight secret scan — surface a clear security error instead of
	// the generic "Could not reach server" the inner fetch returns when it
	// silently nulls out on a secret match.
	const secretScan = scanForSecrets(url);
	if (secretScan.found) return blockedSecretResult(url, secretScan.matches);

	// GitHub pipeline — extractor handles github.com URLs via API/smartFetch.
	// Try the compiled .js first (production runtime), fall back to the .ts
	// source (Node 24 native strip-types for the test runner). Either way,
	// the dynamic import resolves to the same pullGitHub function.
	let ghPipeline: ((u: string) => Promise<PullResult | null>) | null = null;
	try {
		const mod = await import("./github-pipeline.js");
		ghPipeline = mod.pullGitHub;
	} catch {
		try {
			const mod = await import("./github-pipeline.ts");
			ghPipeline = mod.pullGitHub;
		} catch {
			ghPipeline = null;
		}
	}
	if (ghPipeline) {
		const gh = await ghPipeline(url);
		if (gh) return finalizePullResult(gh, redirectNotice);
	}

	const binPeek = await fetchBuffer(url, opts);
	if (binPeek && binPeek.status < 400) {
		if (url.toLowerCase().endsWith(".pdf")) {
			const pdf = await extractPDF(binPeek.buffer, url);
			if (pdf) return finalizePullResult(pdf, redirectNotice);
			const dl = await downloadToTemp(binPeek.buffer, "application/pdf", "", url);
			return finalizePullResult(dl, redirectNotice);
		}

		const headBytes = binPeek.buffer.subarray(0, 1024);
		const isBinary =
			headBytes.includes(0) ||
			headBytes.toString("utf8").replace(/[\x20-\x7E\n\r\t]/g, "").length >
				headBytes.length * 0.3;
		if (isBinary && !url.toLowerCase().endsWith(".pdf")) {
			const dl = await downloadToTemp(binPeek.buffer, "", "", url);
			return finalizePullResult(dl, redirectNotice);
		}
	} else if (!binPeek) {
		const info: FetchErrorInfo = {
			message: "Could not reach server",
			code: "network_error",
			phase: "connecting",
			retryable: true,
		};
		const fetchError = createFetchError("connect_error", info.message, {
			url,
			phase: "connecting",
			mode: opts?.mode,
		});
		return {
			ok: false,
			url,
			error: formatErrorInfo(info),
			errorInfo: info,
			fetchError,
		};
	}

	let res = await smartFetch(url, {
		...opts,
		headers: {
			Accept:
				"text/html,application/xhtml+xml,application/json;q=0.9,text/markdown;q=0.8,*/*;q=0.7",
			...opts?.headers,
		},
	});
	// Capture ETag / Last-Modified for HTTP revalidation (issue #46).
	// Uses a module-level side channel so the validators are available to
	// webfetch.ts without threading them through every return path below.
	if (res && res.status < 400) {
		captureResponseValidators(res.url, res.headers);
	}
	if (!res) {
		const info: FetchErrorInfo = {
			message: "Server unreachable or request failed after retries",
			code: "network_error",
			phase: "loading",
			retryable: true,
		};
		const fetchError = createFetchError("connect_error", info.message, {
			url,
			phase: "downloading",
			mode: opts?.mode,
		});
		return {
			ok: false,
			url,
			error: formatErrorInfo(info),
			errorInfo: info,
			fetchError,
		};
	}
	if (res.status >= 400) {
		const snippet4096 = res.text.slice(0, 4096).toLowerCase();
		const isCf403 =
			res.status === 403 &&
			(res.headers.get("cf-mitigated") === "challenge" ||
				snippet4096.includes("just a moment") ||
				snippet4096.includes("cf-chl-bypass"));
		if (isCf403) {
			const cfRes = await smartFetch(url, {
				...opts,
				headers: {
					Accept:
						"text/html,application/xhtml+xml,application/json;q=0.9,text/markdown;q=0.8,*/*;q=0.7",
					"User-Agent":
						"Mozilla/5.0 (compatible; OpenCode/1.0; +https://opencode.ai)",
					...opts?.headers,
				},
			});
			if (cfRes && cfRes.status < 400) {
				res = cfRes;
			}
		}
		const httpInfo: FetchErrorInfo = {
			message: `Server responded with HTTP ${res.status}`,
			code: "http_error",
			phase: "loading",
			retryable: res.status >= 500 || res.status === 429,
			statusCode: res.status,
		};
		const fetchError = createFetchError("http_error", httpInfo.message, {
			url,
			finalUrl: res.url,
			phase: "headers",
			statusCode: res.status,
			mimeType: res.headers.get("content-type") ?? undefined,
			downloadedBytes: res.downloadedBytes,
			contentLength: res.contentLength ?? undefined,
			elapsedMs: res.elapsedMs,
			mode: opts?.mode,
		});
		return {
			ok: false,
			url,
			error: formatErrorInfo(httpInfo),
			errorInfo: httpInfo,
			fetchError,
		};
	}

	const text = res.text;
	const finalUrl = res.url;
	const ct = res.headers.get("content-type") ?? "";

	try {
		const origHost = new URL(url).hostname;
		const finalHost = new URL(finalUrl).hostname;
		if (origHost !== finalHost) {
			redirectNotice = `> ⚠️ Cross-host redirect detected: \`${url}\` → \`${finalUrl}\``;
		}
	} catch {
		/* ignore */
	}

	if (ct.includes("application/pdf")) {
		const bin = await fetchBuffer(url, opts);
		if (bin) {
			const pdf = await extractPDF(bin.buffer, url);
			if (pdf) return finalizePullResult(pdf);
			const dl = await downloadToTemp(
				bin.buffer,
				ct,
				res.headers.get("content-disposition") ?? "",
				url,
			);
			return finalizePullResult(dl, redirectNotice);
		}
	}

	if (isJsonContentType(ct) || isLikelyJsonBody(text)) {
		return finalizePullResult(formatJsonContent(text, finalUrl), redirectNotice);
	}

	if (ct.includes("text/plain") || ct.includes("text/markdown")) {
		let titleFromUrl = "";
		try {
			titleFromUrl = new URL(finalUrl).pathname.split("/").pop() || finalUrl;
		} catch {
			titleFromUrl = finalUrl;
		}
		const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || titleFromUrl;
		if (MARKDOWN_SIGNAL.test(text) || ct.includes("text/markdown")) {
			return finalizePullResult(
				{ ok: true, url: finalUrl, title, content: text },
				redirectNotice,
			);
		}
		const truncated =
			text.length > 50000 ? text.slice(0, 50000) + "\n\n[... truncated]" : text;
		return finalizePullResult(
			{
				ok: true,
				url: finalUrl,
				title,
				content: "```\n" + truncated + "\n```",
			},
			redirectNotice,
		);
	}

	if (ct.includes("text/html")) {
		const redirected = await maybeFollowClientRedirect(
			text,
			finalUrl,
			opts,
			_redirectCount,
		);
		if (redirected) return redirected;
	}

	return runHtmlPipeline(text, finalUrl, url, opts, redirectNotice);
}

// ─── Enhanced pull page with verticals, bot detection, modes ─------

export async function pullPageEnhanced(
	url: string,
	opts?: FetchOpts,
	_redirectCount = 0,
): Promise<PullResult> {
	// Pre-flight secret scan — surface a clear security error before any
	// fetch path runs (vertical extractors call smartFetch directly).
	const secretScan = scanForSecrets(url);
	if (secretScan.found) return blockedSecretResult(url, secretScan.matches);

	const mode = opts?.mode ?? "auto";

	const vertical = await runVerticalExtractor(
		url,
		async (u) => {
			const r = await smartFetch(u, {
				...opts,
				headers: { Accept: "application/json", ...opts?.headers },
			});
			if (!r || r.status >= 400) return null;
			try {
				return JSON.parse(r.text);
			} catch {
				return null;
			}
		},
		async (u) => {
			const r = await smartFetch(u, opts);
			if (!r || r.status >= 400) return null;
			return r.text;
		},
		async (u) => {
			const r = await smartFetch(u, opts);
			if (!r || r.status >= 400) return null;
			return r.text;
		},
	);
	if (vertical) {
		// Honor vertical.ok — a vertical that returns ok:false (e.g. Reddit's
		// .json endpoint blocked, YouTube transcript unavailable) is signaling
		// a real error, not "this extractor doesn't apply". Fall through to
		// the regular HTML pipeline if the vertical failed and there's an
		// error message to surface.
		if (vertical.ok) {
			return runAfterExtractHooks(
				url,
				finalizePullResult({
					ok: true,
					url,
					title: vertical.title,
					content: `> via ${findVerticalExtractor(url) ?? "vertical extractor"}\n\n${vertical.content}`,
				}),
			);
		}
		// Vertical reported a structured error. Surface it as a result so the
		// user gets a clear explanation (e.g. "Reddit blocked our network")
		// instead of an empty body or a generic 403 from the HTML fallback.
		if (vertical.error) {
			return {
				ok: false,
				url,
				title: vertical.title,
				error: vertical.error,
				errorInfo: {
					message: vertical.error,
					code: "http_error",
					phase: "loading",
					retryable: false,
				},
			};
		}
		// No error message — fall through to the regular HTML pipeline.
	}

	if (mode === "fast" || mode === "auto" || mode === "fingerprint") {
		const result = await pullPage(url, opts, _redirectCount);

		// Paywall bypass — also triggers on 403/401 from known paywall
		// sites, even when the server returned no body for detectPaywall
		// to analyze (hard paywalls like NYT, WSJ, FT block before any
		// content is served). Generic 403s on unknown sites are NOT
		// treated as paywalls — only sites with a known strategy.
		if (opts?.bypass && !result.ok && result.errorInfo?.statusCode) {
			const status = result.errorInfo.statusCode;
			if (status === 403 || status === 401) {
				const knownStrategy = isKnownPaywallSite(url) ? findStrategy(url) : null;
				if (knownStrategy) {
					if (process.env.PI_WEBAIO_DEBUG) {
						console.warn(
							`[paywall] ${safeHostname(url)}: hard ${status} from known paywall site, triggering bypass strategy chain: ${knownStrategy.steps.join(" → ")}`,
						);
					}
					const bypassed = await bypassUrl(url, {
						browser: opts.browser,
						os: opts.os,
						proxy: opts.proxy,
						wreqSession: opts.wreqSession,
						browserPool: opts.browserPool,
						strategies: opts.bypassStrategies,
						onProgress: (msg) => {
							if (process.env.PI_WEBAIO_DEBUG) console.warn(msg);
						},
					});
					const hardReprocessed = await reprocessViaBypass(
						url,
						opts,
						_redirectCount,
						bypassed,
						`> Hard paywall detected (HTTP ${status}) — bypassed via ${bypassed?.strategy ?? "?"}`,
					);
					if (hardReprocessed) return hardReprocessed;
				}
			}
		}

		if (result.ok && result.content) {
			// Paywall bypass — runs before bot-block detection since
			// some paywall pages also trip generic bot markers
			// (e.g. "checking your browser" from Cloudflare's
			// metered paywall challenge).
			if (opts?.bypass) {
				const paywallCheck = detectPaywall(result.content);
				if (paywallCheck.paywalled) {
					if (process.env.PI_WEBAIO_DEBUG) {
						console.warn(
							`[paywall] ${safeHostname(url)}: ${paywallCheck.matchedMarkers.length} markers (${Math.round(paywallCheck.confidence * 100)}% confidence, vendor=${paywallCheck.vendor ?? "?"})`,
						);
					}
					const bypassed = await bypassUrl(url, {
						browser: opts.browser,
						os: opts.os,
						proxy: opts.proxy,
						wreqSession: opts.wreqSession,
						browserPool: opts.browserPool,
						strategies: opts.bypassStrategies,
						onProgress: (msg) => {
							if (process.env.PI_WEBAIO_DEBUG) console.warn(msg);
						},
					});
					const markerReprocessed = await reprocessViaBypass(
						url,
						opts,
						_redirectCount,
						bypassed,
						`> Bypassed via ${bypassed?.strategy ?? "?"} (${Math.round((1 - (bypassed?.paywall?.confidence ?? 0)) * 100)}% clean)`,
					);
					if (markerReprocessed) return markerReprocessed;
					if (process.env.PI_WEBAIO_DEBUG) {
						console.warn(
							`[paywall] ${safeHostname(url)}: bypass via ${bypassed?.strategy ?? "?"} ${bypassed?.paywall?.paywalled ? "still paywalled" : "did not return text"} — strategies exhausted`,
						);
					}
					// Bypass failed — fall through and return the
					// paywalled result with a clear notice
					return finalizePullResult({
						...result,
						content: `> ⚠️ Paywall detected (${paywallCheck.matchedMarkers.slice(0, 3).join(", ")}${paywallCheck.matchedMarkers.length > 3 ? "…" : ""}) — bypass strategies exhausted\n\n${result.content}`,
					});
				}
			}

			const botCheck = detectBotBlock(result.content);
			if (botCheck.blocked) {
				if (mode === "auto" && botCheck.retryable) {
					const fallbackBrowsers = ["firefox_147", "safari_26", "edge_145"];
					for (const fb of fallbackBrowsers) {
						const fbResult = await pullPage(
							url,
							{ ...opts, browser: fb },
							_redirectCount,
						);
						if (fbResult.ok && fbResult.content) {
							const fbBotCheck = detectBotBlock(fbResult.content);
							if (!fbBotCheck.blocked) {
								return fbResult;
							}
						}
					}
					const pwHtml = await fetchWithPlaywright(
						url,
						opts?.browserPool,
						opts?.wreqSession,
						undefined,
						undefined,
						opts?.timeoutMs,
					);
					if (pwHtml) {
						const pwResult = await pullPage(url, opts, _redirectCount, pwHtml);
						if (pwResult.ok && pwResult.content) {
							const pwBotCheck = detectBotBlock(pwResult.content);
							if (!pwBotCheck.blocked) {
								return pwResult;
							}
						}
					}
				}
				return {
					ok: false,
					url,
					error: `Blocked (${botCheck.blockerType}, ${Math.round(botCheck.confidence * 100)}% confidence) — ${botCheck.message}`,
					errorInfo: {
						message: botCheck.message,
						code: "blocked",
						phase: "loading",
						retryable: botCheck.retryable,
					},
				};
			}

			if (result.content.length < 5000) {
				const islands = extractDataIslands(result.content);
				if (islands.found && islands.markdown) {
					return finalizePullResult({
						...result,
						content: `> Data islands recovered from: ${islands.islands.map((i) => i.source).join(", ")}\n\n${islands.markdown}`,
					});
				}
			}
		}

		return runAfterExtractHooks(url, result);
	}

	if (mode === "browser") {
		const pwHtml = await fetchWithPlaywright(
			url,
			opts?.browserPool,
			undefined,
			undefined,
			undefined,
			opts?.timeoutMs,
		);
		if (pwHtml) {
			return runAfterExtractHooks(
				url,
				await pullPage(url, opts, _redirectCount, pwHtml),
			);
		}
		const pwInfo: FetchErrorInfo = {
			message: "Playwright browser rendering failed",
			code: "processing_error",
			phase: "loading",
			retryable: false,
		};
		return {
			ok: false,
			url,
			error: formatErrorInfo(pwInfo),
			errorInfo: pwInfo,
		};
	}

	return runAfterExtractHooks(url, await pullPage(url, opts, _redirectCount));
}
