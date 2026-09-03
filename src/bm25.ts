// ─── BM25 relevance scoring for query-aware content pruning ────────
// Implements the BM25 ranking function (Okapi BM25 variant) to score
// markdown sections by relevance to a user query. Designed to slot into
// the existing prune-markdown.ts pipeline as an alternative scorer.
//
// BM25 formula:
//   score(D, Q) = Σ (IDF(q) * TF(q, D) * (k1 + 1) / (TF(q, D) + k1 * (1 - b + b * |D| / avgdl)))
//
// Standard parameters: k1 = 1.5, b = 0.75

/**
 * Options for the BM25 scorer.
 */
export interface BM25Options {
	/** Term frequency saturation parameter (default 1.5). Higher = more TF matters. */
	k1?: number;
	/** Length normalization parameter (default 0.75). 0 = no normalization, 1 = full. */
	b?: number;
	/** Minimum term length to index (default 1). Filters out single chars. */
	minTermLen?: number;
	/** Stop words to skip (default: common English stop words). */
	stopWords?: Set<string>;
}

/** Default English stop words. */
const DEFAULT_STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"by",
	"with",
	"from",
	"as",
	"is",
	"was",
	"are",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"need",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"him",
	"his",
	"she",
	"her",
	"they",
	"them",
	"their",
	"not",
	"no",
	"nor",
	"so",
	"if",
	"then",
	"than",
	"too",
	"very",
	"just",
	"about",
	"above",
	"after",
	"again",
	"all",
	"also",
	"any",
	"because",
	"before",
	"between",
	"both",
	"each",
	"few",
	"more",
	"most",
	"much",
	"neither",
	"now",
	"once",
	"only",
	"other",
	"own",
	"same",
	"some",
	"such",
	"through",
	"thus",
	"under",
	"until",
	"up",
	"while",
	"who",
	"whom",
	"what",
	"which",
	"why",
	"where",
	"when",
	"how",
]);

/**
 * A tokenized document with term frequencies.
 */
interface TokenizedDoc {
	/** Original text. */
	text: string;
	/** Term → frequency map. */
	terms: Map<string, number>;
	/** Total term count (length in tokens). */
	length: number;
}

/**
 * BM25 scorer — created once per query, then used to score multiple documents.
 *
 * Usage:
 *   const scorer = createBM25Scorer("pricing plans");
 *   const scores = documents.map(doc => scorer.score(doc));
 */
export interface BM25Scorer {
	/**
	 * Score a single document text against the query.
	 * Returns a relevance score (higher = more relevant).
	 */
	score(text: string): number;

	/**
	 * Score multiple documents at once.
	 * More efficient than calling score() repeatedly because IDF is
	 * computed from the full collection.
	 */
	scoreAll(texts: string[]): number[];

	/**
	 * Get the query terms (useful for debugging).
	 */
	readonly queryTerms: string[];
}

/**
 * Tokenize text into lowercase terms, filtering stop words and short terms.
 */
function tokenize(
	text: string,
	minTermLen: number,
	stopWords: Set<string>,
): string[] {
	// Normalize: lowercase, strip markdown syntax, split on non-alphanumeric
	const cleaned = text
		.toLowerCase()
		// Remove code blocks
		.replace(/```[\s\S]*?```/g, " ")
		// Remove inline code
		.replace(/`[^`]+`/g, " ")
		// Remove markdown links (keep link text)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		// Remove markdown images
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, " ")
		// Remove HTML tags
		.replace(/<[^>]+>/g, " ")
		// Remove punctuation (keep alphanumeric, hyphens, underscores)
		.replace(/[^a-z0-9\-_\s]/g, " ")
		// Collapse whitespace
		.replace(/\s+/g, " ")
		.trim();

	if (!cleaned) return [];

	return cleaned
		.split(/\s+/)
		.filter((t) => t.length >= minTermLen && !stopWords.has(t));
}

/**
 * Build a term frequency map from a token list.
 */
function buildTermFreq(tokens: string[]): Map<string, number> {
	const freq = new Map<string, number>();
	for (const t of tokens) {
		freq.set(t, (freq.get(t) ?? 0) + 1);
	}
	return freq;
}

const _queryTermsCache = new Map<string, string[]>();
const _QUERY_CACHE_MAX = 128;

/**
 * Create a BM25 scorer for a given query.
 *
 * The scorer is lazy: it tokenizes the query immediately but defers
 * IDF computation until the first call to score() or scoreAll().
 */
export function createBM25Scorer(
	query: string,
	options: BM25Options = {},
): BM25Scorer {
	const {
		k1 = 1.5,
		b = 0.75,
		minTermLen = 2,
		stopWords = DEFAULT_STOP_WORDS,
	} = options;

	const cacheKey = `${query}\x00${minTermLen}`;
	const cachedTerms = _queryTermsCache.get(cacheKey);
	let queryTerms: string[];
	if (cachedTerms !== undefined) {
		queryTerms = cachedTerms;
	} else {
		queryTerms = tokenize(query, minTermLen, stopWords);
		if (_queryTermsCache.size >= _QUERY_CACHE_MAX) {
			const oldest = _queryTermsCache.keys().next().value as string | undefined;
			if (oldest !== undefined) _queryTermsCache.delete(oldest);
		}
		_queryTermsCache.set(cacheKey, queryTerms);
	}

	// If query is empty or has no meaningful terms, return a no-op scorer
	if (queryTerms.length === 0) {
		return {
			queryTerms: [],
			score: () => 0,
			scoreAll: (texts: string[]) => texts.map(() => 0),
		};
	}

	// Cache for tokenized documents (avoids re-tokenizing in scoreAll)
	const docCache = new Map<string, TokenizedDoc>();

	// IDF cache — computed lazily from the document collection
	let idfCache: Map<string, number> | null = null;
	let cachedDocs: string[] | null = null;

	/**
	 * Tokenize and cache a document.
	 */
	function getDoc(text: string): TokenizedDoc {
		let doc = docCache.get(text);
		if (!doc) {
			const tokens = tokenize(text, minTermLen, stopWords);
			doc = {
				text,
				terms: buildTermFreq(tokens),
				length: tokens.length,
			};
			docCache.set(text, doc);
		}
		return doc;
	}

	/**
	 * Compute IDF for each query term from a set of documents.
	 * IDF(q) = ln(1 + (N - n(q) + 0.5) / (n(q) + 0.5))
	 * where N = total documents, n(q) = documents containing q.
	 */
	function computeIDF(docs: TokenizedDoc[]): Map<string, number> {
		const idf = new Map<string, number>();
		const N = docs.length;

		for (const term of queryTerms) {
			let containingDocs = 0;
			for (const doc of docs) {
				if (doc.terms.has(term)) containingDocs++;
			}
			// Smooth IDF to avoid division by zero
			const idfValue = Math.log(
				1 + (N - containingDocs + 0.5) / (containingDocs + 0.5),
			);
			idf.set(term, idfValue);
		}

		return idf;
	}

	/**
	 * Compute BM25 score for a single document against the query.
	 */
	function scoreDoc(
		doc: TokenizedDoc,
		idf: Map<string, number>,
		avgDocLen: number,
	): number {
		if (doc.length === 0) return 0;

		let score = 0;
		for (const term of queryTerms) {
			const tf = doc.terms.get(term) ?? 0;
			if (tf === 0) continue;

			const idfVal = idf.get(term) ?? 0;
			if (idfVal <= 0) continue;

			// BM25 term score
			const numerator = tf * (k1 + 1);
			const denominator = tf + k1 * (1 - b + b * (doc.length / avgDocLen));
			score += idfVal * (numerator / denominator);
		}

		return score;
	}

	/**
	 * Ensure IDF is computed for the given document texts.
	 */
	function ensureIDF(texts: string[]): {
		docs: TokenizedDoc[];
		idf: Map<string, number>;
		avgDocLen: number;
	} {
		// Reuse cached IDF if the same document set is being scored
		if (idfCache && cachedDocs && arraysEqual(cachedDocs, texts)) {
			const docs = texts.map((t) => getDoc(t));
			const avgDocLen =
				docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length);
			return { docs, idf: idfCache, avgDocLen };
		}

		const docs = texts.map((t) => getDoc(t));
		const avgDocLen =
			docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length);
		const idf = computeIDF(docs);

		// Cache for reuse
		idfCache = idf;
		cachedDocs = texts;

		return { docs, idf, avgDocLen };
	}

	return {
		queryTerms,

		score(text: string): number {
			const { docs, idf, avgDocLen } = ensureIDF([text]);
			return scoreDoc(docs[0], idf, avgDocLen);
		},

		scoreAll(texts: string[]): number[] {
			if (texts.length === 0) return [];
			const { docs, idf, avgDocLen } = ensureIDF(texts);
			return docs.map((doc) => scoreDoc(doc, idf, avgDocLen));
		},
	};
}

/**
 * Check if two string arrays are equal (by reference or value).
 */
function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Convenience: score a single document against a query in one call.
 */
export function scoreRelevance(
	document: string,
	query: string,
	options: BM25Options = {},
): number {
	const scorer = createBM25Scorer(query, options);
	return scorer.score(document);
}

/**
 * Convenience: score multiple documents against a query in one call.
 */
export function scoreAllRelevance(
	documents: string[],
	query: string,
	options: BM25Options = {},
): number[] {
	const scorer = createBM25Scorer(query, options);
	return scorer.scoreAll(documents);
}
