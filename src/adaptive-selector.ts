/**
 * Adaptive Selector — structural fingerprinting for element relocation.
 *
 * When a CSS/XPath selector identifies elements, this module captures a
 * structural fingerprint (tag path, depth, text density, attribute patterns,
 * sibling position). On subsequent pages — even after a site redesign —
 * the fingerprint can locate the equivalent elements even if CSS classes
 * or IDs changed.
 *
 * Use cases:
 * - Docs site pulls: locate main content after redesign
 * - Batch scraping: find similar items across paginated pages
 * - Survive A/B tests: structural position is more stable than class names
 */

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Structural fingerprint of a DOM element.
 * Designed to be serializable to JSON for persistent storage.
 */
export interface ElementFingerprint {
	/** Tag path from root to this element, e.g. ["html", "body", "div", "main", "article"] */
	tagPath: string[];
	/** Depth in the DOM tree */
	depth: number;
	/** Ratio of visible text length to total inner HTML length (0-1) */
	textDensity: number;
	/** Ratio of link text length to total text length (0-1) */
	linkDensity: number;
	/** Sorted child tag names as a frequency hash, e.g. "a:2,div:1,p:3" */
	childTagSignature: string;
	/**
	 * Key attribute patterns found on the element.
	 * e.g. {"class": "post-content", "id": "main-content", "role": "main"}
	 */
	attributes: Record<string, string>;
	/** Position among siblings with the same tag */
	siblingIndex: number;
	/** Total siblings with the same tag */
	siblingCount: number;
	/** The explicit selector used to find this element (for reference) */
	sourceSelector?: string;
}

/**
 * Scoring result for a candidate match.
 */
export interface MatchScore {
	element: Element | null;
	score: number; // 0-1, higher is better
	details: Record<string, number>; // per-category scores for debugging
}

// ─── Weights for similarity scoring ──────────────────────────────────

const WEIGHTS = {
	tagPath: 0.3,
	depth: 0.1,
	textDensity: 0.15,
	linkDensity: 0.05,
	childTagSignature: 0.2,
	attributes: 0.1,
	siblingPosition: 0.1,
};

const SIMILARITY_THRESHOLD = 0.45; // minimum score to consider a match

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Capture the structural fingerprint of a DOM element.
 * Call this on the first successful selection to establish the reference.
 */
export function captureFingerprint(
	element: Element,
	sourceSelector?: string,
): ElementFingerprint {
	const tagName = element.tagName?.toLowerCase() ?? "unknown";
	const tagPath = getTagPath(element);
	const depth = tagPath.length;
	const textDensity = computeTextDensity(element);
	const linkDensity = computeLinkDensity(element);
	const childTagSignature = computeChildTagSignature(element);
	const attributes = extractAttributes(element);
	const { index, total } = getSiblingPosition(element, tagName);

	return {
		tagPath,
		depth,
		textDensity,
		linkDensity,
		childTagSignature,
		attributes,
		siblingIndex: index,
		siblingCount: total,
		sourceSelector,
	};
}

/**
 * Given a document and a reference fingerprint, find the best-matching
 * element. Returns the element and its match score (0-1).
 * Returns null if no element scores above the threshold.
 */
export function locateByFingerprint(
	doc: Document,
	fp: ElementFingerprint,
	threshold = SIMILARITY_THRESHOLD,
): MatchScore | null {
	// Strategy 1: Try to match by tagPath first (most reliable for stable structures)
	const pathMatches = findElementsByTagPath(doc, fp.tagPath);
	if (pathMatches.length > 0) {
		const scored = scoreCandidates(pathMatches, fp);
		if (scored && scored.score >= threshold) {
			return scored;
		}
	}

	// Strategy 2: Broader search — find elements by the last tag in the path
	const lastTag = fp.tagPath[fp.tagPath.length - 1];
	if (!lastTag) return null;

	const candidates = doc.querySelectorAll(lastTag);
	const allElements: Element[] = [];
	// Handle both NodeList and array-like
	for (let i = 0; i < candidates.length; i++) {
		const el = candidates[i];
		if (el && typeof el.tagName === "string") {
			allElements.push(el);
		}
	}

	return scoreCandidates(allElements, fp, threshold);
}

/**
 * Score a batch of candidate elements against a fingerprint.
 */
function scoreCandidates(
	elements: Element[],
	fp: ElementFingerprint,
	threshold = SIMILARITY_THRESHOLD,
): MatchScore | null {
	let best: MatchScore | null = null;

	for (const el of elements) {
		const score = scoreElement(el, fp);
		if (score > (best?.score ?? 0)) {
			best = { element: el, score, details: {} };
		}
	}

	if (best && best.score >= threshold) {
		return best;
	}
	return null;
}

// ─── Scoring ─────────────────────────────────────────────────────────

/**
 * Score a single candidate element against a reference fingerprint (0-1).
 */
function scoreElement(element: Element, fp: ElementFingerprint): number {
	let totalScore = 0;

	const tagPath = getTagPath(element);
	const tagName = element.tagName?.toLowerCase() ?? "";

	// 1. Tag path similarity (30%)
	const pathScore = scoreTagPath(tagPath, fp.tagPath);
	totalScore += pathScore * WEIGHTS.tagPath;

	// 2. Depth similarity (10%)
	const depthScore = scoreSimilarity(fp.depth, tagPath.length, 0.8);
	totalScore += depthScore * WEIGHTS.depth;

	// 3. Text density (15%)
	const textDensity = computeTextDensity(element);
	const densityScore = scoreSimilarity(fp.textDensity, textDensity, 0.3);
	totalScore += densityScore * WEIGHTS.textDensity;

	// 4. Link density (5%)
	const linkDensity = computeLinkDensity(element);
	const linkScore = scoreSimilarity(fp.linkDensity, linkDensity, 0.3);
	totalScore += linkScore * WEIGHTS.linkDensity;

	// 5. Child tag signature (20%)
	const childSig = computeChildTagSignature(element);
	const sigScore =
		childSig === fp.childTagSignature
			? 1.0
			: scoreChildTagSimilarity(fp.childTagSignature, childSig);
	totalScore += sigScore * WEIGHTS.childTagSignature;

	// 6. Attribute patterns (10%)
	const attrs = extractAttributes(element);
	const attrScore = scoreAttributes(fp.attributes, attrs);
	totalScore += attrScore * WEIGHTS.attributes;

	// 7. Sibling position (10%)
	const { index, total } = getSiblingPosition(element, tagName);
	if (fp.siblingCount === total) {
		const posScore = fp.siblingIndex === index ? 1.0 : 0.5;
		totalScore += posScore * WEIGHTS.siblingPosition;
	} else {
		// Partial credit if counts differ
		const ratio =
			total > 0
				? Math.min(fp.siblingCount, total) / Math.max(fp.siblingCount, total)
				: 0;
		totalScore += ratio * 0.5 * WEIGHTS.siblingPosition;
	}

	return Math.min(totalScore, 1.0);
}

// ─── Sub-scores ──────────────────────────────────────────────────────

function scoreTagPath(actual: string[], expected: string[]): number {
	const maxLen = Math.max(actual.length, expected.length);
	if (maxLen === 0) return 1.0;

	// Count matching tags from the end (most recent ancestors are most important)
	let matches = 0;
	const minLen = Math.min(actual.length, expected.length);
	for (let i = 0; i < minLen; i++) {
		if (actual[actual.length - 1 - i] === expected[expected.length - 1 - i]) {
			matches++;
		}
	}

	// Weight recent matches more heavily
	const weighted = matches / maxLen;
	return weighted;
}

function scoreSimilarity(
	expected: number,
	actual: number,
	tolerance: number,
): number {
	if (expected === 0 && actual === 0) return 1.0;
	if (expected === 0) return actual < tolerance ? 1.0 : 0.0;
	const ratio = Math.min(expected, actual) / Math.max(expected, actual);
	// Near 1.0 is perfect, but allow tolerance
	return Math.max(0, (ratio - (1 - tolerance)) / tolerance);
}

function scoreChildTagSimilarity(
	expectedSig: string,
	actualSig: string,
): number {
	if (!expectedSig || !actualSig) return 0.5;

	const expected = parseChildTagSig(expectedSig);
	const actual = parseChildTagSig(actualSig);

	// Jaccard-like similarity on child tags
	const allTags = new Set([...Object.keys(expected), ...Object.keys(actual)]);
	if (allTags.size === 0) return 1.0;

	let matches = 0;
	for (const tag of allTags) {
		const expCount = expected[tag] ?? 0;
		const actCount = actual[tag] ?? 0;
		if (expCount === actCount && expCount > 0) {
			matches++;
		}
	}

	return matches / allTags.size;
}

function scoreAttributes(
	expected: Record<string, string>,
	actual: Record<string, string>,
): number {
	const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
	if (keys.size === 0) return 1.0;

	let matches = 0;
	for (const key of keys) {
		const expVal = expected[key];
		const actVal = actual[key];
		if (expVal && actVal && expVal === actVal) {
			matches++;
		}
		// Also check if key exists on both (credit for having the same attribute, even if value differs slightly)
		if (expVal !== undefined && actVal !== undefined && key !== "class") {
			matches += 0.3;
		}
	}

	return Math.min(matches / keys.size, 1.0);
}

// ─── DOM Helpers ─────────────────────────────────────────────────────

/**
 * Get the tag path from root to this element.
 */
function getTagPath(element: Element): string[] {
	const path: string[] = [];
	let current: Element | null = element;
	while (current) {
		const tag = current.tagName?.toLowerCase();
		if (tag) path.unshift(tag);
		if (tag === "html") break;
		current = current.parentElement;
	}
	return path;
}

/**
 * Compute text density: visible text length / inner HTML length.
 */
function computeTextDensity(element: Element): number {
	const html = element.innerHTML ?? "";
	if (html.length === 0) return 0;
	const text = element.textContent ?? "";
	return text.length / html.length;
}

/**
 * Compute link density: length of text inside <a> tags / total text length.
 */
function computeLinkDensity(element: Element): number {
	const totalText = element.textContent ?? "";
	if (totalText.length === 0) return 0;

	let linkTextLength = 0;
	const links = element.querySelectorAll("a");
	for (let i = 0; i < links.length; i++) {
		linkTextLength += (links[i]?.textContent ?? "").length;
	}

	return Math.min(linkTextLength / totalText.length, 1.0);
}

/**
 * Compute a signature string of child tag frequencies.
 */
function computeChildTagSignature(element: Element): string {
	const counts: Record<string, number> = {};
	const children = element.children;
	for (let i = 0; i < children.length; i++) {
		const tag = children[i]?.tagName?.toLowerCase();
		if (tag) {
			counts[tag] = (counts[tag] ?? 0) + 1;
		}
	}

	return Object.entries(counts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([tag, count]) => `${tag}:${count}`)
		.join(",");
}

function parseChildTagSig(sig: string): Record<string, number> {
	const result: Record<string, number> = {};
	for (const part of sig.split(",")) {
		const [tag, countStr] = part.split(":");
		if (tag && countStr) {
			result[tag] = parseInt(countStr, 10);
		}
	}
	return result;
}

/**
 * Extract key attributes from an element (skips empty/null ones).
 */
function extractAttributes(element: Element): Record<string, string> {
	const attrs: Record<string, string> = {};

	// Check common identifying attributes
	const attrNames = [
		"id",
		"class",
		"role",
		"data-*",
		"itemprop",
		"itemtype",
		"name",
		"rel",
	];

	for (const name of attrNames) {
		if (name === "data-*") {
			// Collect all data-* attributes
			// SAFETY: The cast only indexes the same element with keys returned by Object.keys;
			// every value is narrowed to a string before it is stored in the attribute map.
			const el = element as unknown as Record<string, string>;
			for (const key of Object.keys(element)) {
				if (key.startsWith("data-")) {
					const val = el[key];
					if (val && typeof val === "string") {
						attrs[key] = val;
					}
				}
			}
		} else {
			const val = element.getAttribute(name);
			if (val) attrs[name] = val;
		}
	}

	return attrs;
}

/**
 * Get the sibling position (index and total) among siblings with the same tag.
 */
function getSiblingPosition(
	element: Element,
	tagName: string,
): { index: number; total: number } {
	const parent = element.parentElement;
	if (!parent) return { index: 0, total: 1 };

	let index = 0;
	let total = 0;
	const children = parent.children;
	for (let i = 0; i < children.length; i++) {
		if (children[i]?.tagName?.toLowerCase() === tagName) {
			if (children[i] === element) {
				index = total;
			}
			total++;
		}
	}

	return { index, total };
}

/**
 * Find elements matching a tag path by traversing the DOM.
 * e.g. ["html", "body", "div", "main"] finds <main> inside <div> inside <body>
 */
function findElementsByTagPath(doc: Document, tagPath: string[]): Element[] {
	if (tagPath.length === 0) return [];

	// Start from the last tag in the path (most specific)
	const lastTag = tagPath[tagPath.length - 1];
	if (!lastTag) return [];

	const candidates = doc.querySelectorAll(lastTag);
	const results: Element[] = [];

	for (let i = 0; i < candidates.length; i++) {
		const el = candidates[i];
		const elPath = getTagPath(el);
		if (arraysEndMatch(elPath, tagPath)) {
			results.push(el);
		}
	}

	return results;
}

/**
 * Check if two arrays have matching elements from the end.
 * e.g. ["a","b","c","d"] and ["c","d"] → true (ends match)
 */
function arraysEndMatch<T>(a: T[], b: T[]): boolean {
	const minLen = Math.min(a.length, b.length);
	for (let i = 0; i < minLen; i++) {
		if (a[a.length - 1 - i] !== b[b.length - 1 - i]) {
			return false;
		}
	}
	return true;
}
