// ─── Open Library extractor ────────────────────────────────────────
// Uses the Open Library REST API (openlibrary.org).
// Free, no API key required. Provides structured book metadata.

import type { VerticalResult } from "./types.ts";

/**
 * Match Open Library book/works URLs.
 */
export function matchesOpenLibrary(url: string): boolean {
	return /^https?:\/\/openlibrary\.org\/(books|works|authors)\/[\w]+/i.test(
		url,
	);
}

/**
 * Extract an Open Library ID from the URL.
 */
function extractId(url: string): { type: string; id: string } | null {
	const m = url.match(
		/openlibrary\.org\/(books|works|authors)\/([\w]+)/i,
	);
	if (!m) return null;
	return { type: m[1]!.toLowerCase(), id: m[2]! };
}

export async function extractOpenLibrary(
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const extracted = extractId(url);
	if (!extracted) return null;
	const { type, id } = extracted;

	// ── Fetch entity data ────────────────────────────────────────────
	const entityUrl = `https://openlibrary.org/${type}/${encodeURIComponent(id)}.json`;
	const data = await fetchJson(entityUrl);
	if (!data || typeof data !== "object") return null;

	const d = data as Record<string, unknown>;

	if (type === "authors") {
		return formatAuthor(d, id, url);
	}

	return formatBookOrWork(d, type, id, url, fetchJson);
}

function formatAuthor(
	d: Record<string, unknown>,
	id: string,
	url: string,
): VerticalResult | null {
	const name = String(d.name || id);
	const bio = typeof d.bio === "string" ? d.bio : String(d.bio || "");
	const birthDate = String(d.birth_date || "");
	const deathDate = String(d.death_date || "");
	const wikipedia = String(d.wikipedia || "");
	const photos = Array.isArray(d.photos) ? (d.photos as number[]) : [];

	let md = `# ${name}\n\n`;
	if (birthDate) md += `- **Born:** ${birthDate}\n`;
	if (deathDate) md += `- **Died:** ${deathDate}\n`;
	if (wikipedia) md += `- **Wikipedia:** ${wikipedia}\n`;

	if (bio) {
		const cleanBio =
			typeof bio === "string" && bio.startsWith("{")
				? extractBioValue(bio)
				: bio;
		md += `\n## Biography\n\n${cleanBio}\n`;
	}

	if (photos.length > 0) {
		md += `\n## Photos\n\n`;
		for (const photoId of photos.slice(0, 3)) {
			const photoUrl = `https://covers.openlibrary.org/a/id/${photoId}-L.jpg`;
			md += `![Photo](${photoUrl})\n`;
		}
	}

	return { ok: true, url, title: name, content: md };
}

function extractBioValue(raw: string): string {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && parsed.value) {
			return String(parsed.value);
		}
	} catch {
		// not JSON, return as-is
	}
	return raw;
}

async function formatBookOrWork(
	d: Record<string, unknown>,
	type: string,
	id: string,
	url: string,
	fetchJson: (url: string) => Promise<unknown | null>,
): Promise<VerticalResult | null> {
	const title = String(d.title || "");
	const description =
		typeof d.description === "string"
			? d.description
			: typeof d.description === "object" && d.description !== null
				? (d.description as Record<string, unknown>).value || ""
				: "";
	const coverId =
		d.covers && Array.isArray(d.covers) ? (d.covers as number[])[0] : null;

	// Subjects
	const subjects = Array.isArray(d.subjects) ? (d.subjects as string[]) : [];

	// Authors
	const authorRefs = extractAuthorRefs(d);

	// Publish date
	const publishDate = String(d.publish_date || d.first_publish_date || "");

	// Number of pages
	const pages = d.number_of_pages ? Number(d.number_of_pages) : 0;

	// Languages
	const languages = extractLanguages(d);

	// ── Resolve author names ─────────────────────────────────────────
	const authorNames: string[] = [];
	for (const ref of authorRefs) {
		if (ref.name) {
			authorNames.push(ref.name);
		} else if (ref.key) {
			const authorUrl = `https://openlibrary.org${ref.key}.json`;
			const authorData = await fetchJson(authorUrl);
			if (authorData && typeof authorData === "object") {
				const ad = authorData as Record<string, unknown>;
				authorNames.push(String(ad.name || ad.personal_name || ref.key));
			}
		}
	}

	// ── Build markdown ───────────────────────────────────────────────
	let md = `# ${title}\n\n`;

	if (coverId) {
		const coverUrl = `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
		md += `![Cover](${coverUrl})\n\n`;
	}

	if (authorNames.length) md += `- **Author(s):** ${authorNames.join(", ")}\n`;
	if (publishDate) md += `- **Published:** ${publishDate}\n`;
	if (pages) md += `- **Pages:** ${pages}\n`;
	if (languages.length) md += `- **Languages:** ${languages.join(", ")}\n`;
	if (subjects.length)
		md += `- **Subjects:** ${subjects.slice(0, 15).join(", ")}\n`;

	if (typeof description === "string" && description) {
		md += `\n## Description\n\n${description}\n`;
	}

	// Edition count for works
	if (type === "works") {
		const editionUrl = `https://openlibrary.org/works/${encodeURIComponent(id)}/editions.json?limit=1`;
		const editionsData = await fetchJson(editionUrl);
		if (
			editionsData &&
			typeof editionsData === "object" &&
			(editionsData as Record<string, unknown>).size
		) {
			md += `\n- **Editions:** ${(editionsData as Record<string, unknown>).size}\n`;
		}
	}

	// Links
	md += `\n- **Open Library:** https://openlibrary.org/${type}/${id}\n`;

	return { ok: true, url, title, content: md };
}

// ─── Helpers ────────────────────────────────────────────────────────

interface AuthorRef {
	key?: string;
	name?: string;
}

function extractAuthorRefs(d: Record<string, unknown>): AuthorRef[] {
	const refs: AuthorRef[] = [];

	// authors array (works)
	if (Array.isArray(d.authors)) {
		for (const a of d.authors as Record<string, unknown>[]) {
			refs.push({
				key: typeof a.key === "string" ? a.key : undefined,
				name: typeof a.author === "string" ? a.author : undefined,
			});
		}
	}

	// author key string (some books)
	if (typeof d.author === "string") {
		refs.push({ key: d.author });
	}

	return refs;
}

function extractLanguages(d: Record<string, unknown>): string[] {
	const langs: Set<string> = new Set();

	if (Array.isArray(d.languages)) {
		for (const l of d.languages as Record<string, unknown>[]) {
			if (typeof l.key === "string") {
				const code = l.key.replace(/^\/languages\//, "");
				langs.add(code);
			}
		}
	}

	return [...langs];
}
