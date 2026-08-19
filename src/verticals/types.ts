// ─── Vertical extractor shared types ───────────────────────────────

export interface VerticalResult {
	ok: boolean;
	url: string;
	title?: string;
	content: string;
	error?: string;
}

/** Fetch helpers handed to every vertical extractor. */
export type VerticalFetchJson = (url: string) => Promise<unknown | null>;
export type VerticalFetchText = (url: string) => Promise<string | null>;
export type VerticalFetchHtml = (url: string) => Promise<string | null>;

type VerticalExtractor = (url: string) => Promise<VerticalResult | null>;
