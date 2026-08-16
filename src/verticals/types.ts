// ─── Vertical extractor shared types ───────────────────────────────

export interface VerticalResult {
	ok: boolean;
	url: string;
	title?: string;
	content: string;
	error?: string;
}

type VerticalExtractor = (url: string) => Promise<VerticalResult | null>;
