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
import {
	runVerticalExtractor,
	findVerticalExtractor,
} from "./verticals/registry.ts";
import { detectPromptInjection, applyInjectionAction } from "./injection.ts";
import { compressHtml } from "./html-compress.ts";
import { isDangerousUrl } from "./security.ts";
import { BASE_TEMP } from "./session-store.ts";
import { loadPdfParseCtor } from "./types.ts";
import type { PullResult, FetchOpts, FetchErrorInfo } from "./types.ts";
import { formatErrorInfo } from "./types.ts";

// ─── Constants ─────────────────────────────────────────────────────

export const MARKDOWN_SIGNAL =
	/^(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s|\[.+\]\(.+\))/m;
export const DEFUDDLE_TIMEOUT = 8000;
export const MAX_PREVIEW_CHARS = 1800;
export const MIN_USEFUL_CONTENT = 500;

const MAX_CLIENT_REDIRECTS = 5;
const MIN_ALTERNATE_FALLBACK_WORDS = 30;

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
	try {
		const { document } = parseHTML(html);
		document
			.querySelectorAll(ALL_NOISE_SELECTORS)
			.forEach((el: Element) => el.remove());
		return document.documentElement.outerHTML;
	} catch {
		return html;
	}
}

export function cleanText(value: string): string {
	let s = value.replace(/\r/g, "");
	s = s.replace(/[^\S\n]+/g, " ");
	const lines = s.split("\n");
	s = lines
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.join("\n");
	return s;
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1]!.replace(/\*+/g, "").trim();
	return cleaned || null;
}

export function stripDefuddleComments(content: string): string {
	return content.replace(/\n---\n+## Comments[\s\S]*$/i, "").trimEnd();
}

// ─── JS rendering detection ───────────────────────────────────────

export function isLikelyJSRendered(html: string): boolean {
	try {
		const { document } = parseHTML(html);
		const body = document.querySelector("body");
		if (!body) return false;
		body
			.querySelectorAll("script, style")
			.forEach((el: Element) => el.remove());
		const textContent = (body.textContent || "").replace(/\s+/g, " ").trim();
		const scriptCount = document.querySelectorAll("script").length;
		return textContent.length < 500 && scriptCount > 3;
	} catch {
		return false;
	}
}

// ─── Readability extraction ────────────────────────────────────────

export function extractReadability(
	html: string,
	_url: string,
): { title: string; content: string } | null {
	try {
		const { document } = parseHTML(html);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();
		if (!article || (article.textContent?.length ?? 0) < 200) return null;
		return {
			title:
				article.title || extractHeadingTitle(article.textContent || "") || "",
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

export async function extractPDF(
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("timeout")), ms),
		),
	]);
}

// ─── Smart content-type detection ──────────────────────────────────

export function isJsonContentType(ct: string): boolean {
	const norm = ct.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		norm === "application/json" ||
		norm === "text/json" ||
		norm.endsWith("+json")
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
	const m = snippet.match(
		/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?([^"'>]*)/i,
	);
	if (!m) return null;
	const parts = m[1]!.split(";");
	const delay = Number.parseFloat(parts[0]!.trim());
	if (!Number.isFinite(delay) || delay < 0 || delay >= 30) return null;
	const urlMatch = parts
		.slice(1)
		.join(";")
		.match(/url\s*=\s*(.+)/i);
	if (!urlMatch) return null;
	const target = urlMatch[1]!.trim().replace(/^['"]|['"]$/g, "");
	try {
		const resolved = new URL(target, baseUrl).toString();
		return resolved === baseUrl ? null : resolved;
	} catch {
		return null;
	}
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

export function fallbackExtract(html: string): {
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

// ─── Inject detection & trust boundaries ─────────────────────────

export function finalizePullResult(
	result: PullResult,
	redirectNotice?: string,
): PullResult {
	if (!result.ok || !result.content) return result;

	let content = result.content;
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

export async function downloadToTemp(
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
		const urlPath = new URL(url).pathname;
		filename = urlPath.split("/").filter(Boolean).pop() || "download";
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

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── HTML content pipeline (shared by normal + browser-mode paths) ─

export async function runHtmlPipeline(
	text: string,
	finalUrl: string,
	url: string,
	_opts: FetchOpts | undefined,
	redirectNotice: string | undefined,
): Promise<PullResult> {
	if (text.includes("http-equiv")) {
		const redirectTarget = extractClientSideRedirect(text, finalUrl);
		if (redirectTarget) {
			return pullPage(redirectTarget, _opts, 1, undefined);
		}
	}

	let cleaned = preCleanHtml(text);
	cleaned = compressHtml(cleaned);
	const rawHtml = text;

	if (!(await isDangerousUrl(url))) {
		const { fetchJina } = await import("./fetch-jina.js");
		const jina = await fetchJina(url);
		if (jina) {
			if (wordCount(jina.content || "") < MIN_ALTERNATE_FALLBACK_WORDS) {
				const alt = await tryAlternateLinks(text, finalUrl, _opts);
				if (alt) return finalizePullResult(alt, redirectNotice);
			}
			return finalizePullResult(jina, redirectNotice);
		}
	}

	const readability = extractReadability(cleaned, finalUrl);
	if (readability) {
		if (
			text.length > 10000 &&
			readability.content.length < 0.01 * text.length
		) {
			// skip — readability failed
		} else {
			if (wordCount(readability.content) < MIN_ALTERNATE_FALLBACK_WORDS) {
				const alt = await tryAlternateLinks(text, finalUrl, _opts);
				if (alt) return finalizePullResult(alt, redirectNotice);
			}
			return finalizePullResult(
				{
					ok: true,
					url: finalUrl,
					title: readability.title,
					content: readability.content,
					rawHtml,
				},
				redirectNotice,
			);
		}
	}

	const rscContent = extractRSC(text);
	if (rscContent) {
		return finalizePullResult(
			{
				ok: true,
				url: finalUrl,
				title: new URL(finalUrl).hostname,
				content: rscContent,
			},
			redirectNotice,
		);
	}

	try {
		const result = await withTimeout(
			Defuddle(cleaned, finalUrl, { markdown: true }),
			DEFUDDLE_TIMEOUT,
		);
		let defContent = result.content || "";
		defContent = stripDefuddleComments(defContent);
		defContent = cleanText(defContent);
		if (wordCount(defContent) < MIN_ALTERNATE_FALLBACK_WORDS) {
			const alt = await tryAlternateLinks(text, finalUrl, _opts);
			if (alt) return finalizePullResult(alt, redirectNotice);
		}
		return finalizePullResult(
			{
				ok: true,
				url: finalUrl,
				title: result.title || "",
				content: defContent,
				author: result.author || undefined,
				published: result.published || undefined,
				site: result.site || undefined,
				language: result.language || undefined,
				wordCount: result.wordCount || undefined,
			},
			redirectNotice,
		);
	} catch {
		const { title, content } = fallbackExtract(cleaned);
		if (wordCount(content) < MIN_ALTERNATE_FALLBACK_WORDS) {
			const alt = await tryAlternateLinks(text, finalUrl, _opts);
			if (alt) return finalizePullResult(alt, redirectNotice);
		}
		return finalizePullResult(
			{ ok: true, url: finalUrl, title, content, rawHtml },
			redirectNotice,
		);
	}
}

// ─── Pull page (full fetch + pipeline) ─────────────────────────────

export async function pullPage(
	url: string,
	opts?: FetchOpts,
	_redirectCount = 0,
	htmlOverride?: string,
): Promise<PullResult> {
	let redirectNotice: string | undefined;

	if (htmlOverride !== undefined) {
		const text = htmlOverride;
		const finalUrl = url;

		if (_redirectCount < MAX_CLIENT_REDIRECTS) {
			const redirectTarget = extractClientSideRedirect(text, finalUrl);
			if (redirectTarget) {
				return pullPage(redirectTarget, opts, _redirectCount + 1, undefined);
			}
		}

		return runHtmlPipeline(text, finalUrl, url, opts, redirectNotice);
	}

	// GitHub pipeline — extractor handles github.com URLs via API/smartFetch
	// Note: in a future phase, pullGitHub will be imported from ./github-pipeline.js
	const { pullGitHub: ghPipeline } = await import("./github-pipeline.js").catch(
		() => ({
			pullGitHub: null as ((u: string) => Promise<PullResult | null>) | null,
		}),
	);
	if (ghPipeline) {
		const gh = await ghPipeline(url);
		if (gh) return finalizePullResult(gh, redirectNotice);
	}

	const binPeek = await fetchBuffer(url, opts);
	if (binPeek && binPeek.status < 400) {
		if (url.toLowerCase().endsWith(".pdf")) {
			const pdf = await extractPDF(binPeek.buffer, url);
			if (pdf) return finalizePullResult(pdf, redirectNotice);
			const dl = await downloadToTemp(
				binPeek.buffer,
				"application/pdf",
				"",
				url,
			);
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
		return {
			ok: false,
			url,
			error: formatErrorInfo(info),
			errorInfo: info,
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
	if (!res) {
		const info: FetchErrorInfo = {
			message: "Server unreachable or request failed after retries",
			code: "network_error",
			phase: "loading",
			retryable: true,
		};
		return {
			ok: false,
			url,
			error: formatErrorInfo(info),
			errorInfo: info,
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
		return {
			ok: false,
			url,
			error: formatErrorInfo(httpInfo),
			errorInfo: httpInfo,
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
		return finalizePullResult(
			formatJsonContent(text, finalUrl),
			redirectNotice,
		);
	}

	if (ct.includes("text/plain") || ct.includes("text/markdown")) {
		const title =
			text.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
			new URL(finalUrl).pathname.split("/").pop() ||
			finalUrl;
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

	if (_redirectCount < MAX_CLIENT_REDIRECTS && ct.includes("text/html")) {
		const redirectTarget = extractClientSideRedirect(text, finalUrl);
		if (redirectTarget) {
			return pullPage(redirectTarget, opts, _redirectCount + 1);
		}
	}

	return runHtmlPipeline(text, finalUrl, url, opts, redirectNotice);
}

// ─── Enhanced pull page with verticals, bot detection, modes ─------

export async function pullPageEnhanced(
	url: string,
	opts?: FetchOpts,
	_redirectCount = 0,
): Promise<PullResult> {
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
		return finalizePullResult({
			ok: true,
			url,
			title: vertical.title,
			content: `> via ${findVerticalExtractor(url) ?? "vertical extractor"}\n\n${vertical.content}`,
		});
	}

	if (mode === "fast" || mode === "auto" || mode === "fingerprint") {
		const result = await pullPage(url, opts, _redirectCount);

		if (result.ok && result.content) {
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

		return result;
	}

	if (mode === "browser") {
		const pwHtml = await fetchWithPlaywright(url, opts?.browserPool);
		if (pwHtml) {
			return pullPage(url, opts, _redirectCount, pwHtml);
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

	return pullPage(url, opts, _redirectCount);
}
