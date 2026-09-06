// ─── HTTP response text classification ────────────────────────────
//
// Dependency-free leaf (only linkedom, for HTML → text). Shared by the
// full extraction pipeline (content.ts) and the static fetch entrypoint
// (webfetch-api.ts).
//
// The static entrypoint cannot import content.ts — that module pulls in
// the browser, search, Jina, verticals, and storage layers its boundary
// forbids — so these predicates live here instead of being forked. Both
// paths previously carried their own copy of the JSON/content-type/
// whitespace helpers (dedup, jscpd).
//
// Nothing in this module performs I/O.

import { parseHTML } from "linkedom";

/** Characters of a decoded body inspected when sniffing a content type. */
const SNIFF_SAMPLE_CHARS = 100;

/** Bytes of a body inspected when classifying it as binary. */
const BINARY_SNIFF_BYTES = 4096;

/**
 * Collapse runs of horizontal whitespace, strip carriage returns, trim
 * every line, and drop the empty ones. Used to turn raw `textContent`
 * into readable plain text.
 */
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

/**
 * Extract readable plain text from an HTML document without running a
 * full article extractor. Prefers `<body>`, falls back to the document
 * element. This is a last-resort path, not a substitute for Defuddle or
 * Readability.
 */
export function htmlToPlainText(html: string): string {
	const { document } = parseHTML(html);
	return cleanText(
		document.body?.textContent || document.documentElement?.textContent || "",
	);
}

/** Strip parameters and normalize case: `Text/HTML; charset=x` → `text/html`. */
export function normalizeContentType(raw: string | null | undefined): string {
	return raw?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** The `charset=` parameter of a Content-Type header, if present. */
function contentTypeCharset(raw: string | null | undefined): string | undefined {
	return raw?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
}

/** True for `application/json`, `text/json`, and any `+json` suffix. */
export function isJsonContentType(ct: string): boolean {
	const norm = normalizeContentType(ct);
	return norm === "application/json" || norm === "text/json" || norm.endsWith("+json");
}

/** True when a body *looks* like JSON regardless of its declared type. */
export function isLikelyJsonBody(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** True for `text/html` and `application/xhtml+xml`. */
export function isHtmlContentType(ct: string): boolean {
	const norm = normalizeContentType(ct);
	return norm === "text/html" || norm === "application/xhtml+xml";
}

/**
 * True when a content type carries text we can safely decode and return:
 * any `text/*`, anything JSON- or XML-flavoured, or JavaScript source.
 */
export function isTextualContentType(ct: string): boolean {
	const norm = normalizeContentType(ct);
	return (
		norm.startsWith("text/") ||
		norm.includes("json") ||
		norm.includes("xml") ||
		norm === "application/javascript"
	);
}

/**
 * Resolve the effective content type: the declared one when present,
 * otherwise a conservative sniff of the body's leading characters.
 * Never returns an empty string — `text/plain` is the floor.
 */
export function sniffContentType(
	declared: string | null | undefined,
	text: string,
): string {
	const normalized = normalizeContentType(declared);
	if (normalized) return normalized;
	const sample = text.trimStart().slice(0, SNIFF_SAMPLE_CHARS).toLowerCase();
	if (sample.startsWith("<!doctype html") || sample.startsWith("<html"))
		return "text/html";
	if (sample.startsWith("{") || sample.startsWith("[")) return "application/json";
	return "text/plain";
}

/**
 * Decode response bytes using the charset declared in `contentType`,
 * falling back to UTF-8. An unknown or malformed charset name degrades
 * to UTF-8 rather than throwing.
 */
export function decodeResponseBody(
	body: Uint8Array,
	contentType: string | null | undefined,
): string {
	const charset = contentTypeCharset(contentType);
	try {
		return new TextDecoder(charset || "utf-8").decode(body);
	} catch {
		return new TextDecoder().decode(body);
	}
}

/**
 * Recognize a body by its magic bytes: `"pdf"` for `%PDF-`, `"binary"`
 * for the common image/archive/executable signatures, otherwise
 * undefined (which does *not* mean textual — see {@link looksBinary}).
 */
export function binarySignature(body: Uint8Array): "pdf" | "binary" | undefined {
	const startsWith = (signature: number[]): boolean =>
		body.length >= signature.length &&
		signature.every((byte, index) => body[index] === byte);
	if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
	for (const signature of [
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
		[0xff, 0xd8, 0xff], // JPEG
		[0x47, 0x49, 0x46, 0x38], // GIF
		[0x50, 0x4b, 0x03, 0x04], // ZIP / OOXML
		[0x50, 0x4b, 0x05, 0x06], // empty ZIP
		[0x1f, 0x8b], // gzip
		[0x7f, 0x45, 0x4c, 0x46], // ELF
	]) {
		if (startsWith(signature)) return "binary";
	}
	return undefined;
}

/**
 * Heuristic binary check over the first {@link BINARY_SNIFF_BYTES} bytes:
 * a NUL byte, an undecodable charset, or a control-character ratio above
 * 5% all classify the body as binary. An empty body is never binary.
 */
export function looksBinary(
	contentType: string | null | undefined,
	body: Uint8Array,
): boolean {
	if (body.length === 0) return false;
	const sample = body.subarray(0, Math.min(body.length, BINARY_SNIFF_BYTES));
	if (sample.includes(0)) return true;
	const charset = contentTypeCharset(contentType);
	let decoded: string;
	try {
		decoded = new TextDecoder(charset || "utf-8", { fatal: true }).decode(sample);
	} catch {
		return true;
	}
	let controls = 0;
	for (const char of decoded) {
		const code = char.codePointAt(0)!;
		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
			controls += 1;
		}
	}
	return controls / Math.max(1, decoded.length) > 0.05;
}
