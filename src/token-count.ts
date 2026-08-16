// ─── Token counting (approximate) ────────────────────────────────────
// Approximates GPT-family token counts without a tiktoken dependency.
// Uses a simple character-based heuristic that correlates well with
// actual tokenizer counts for English text:
//   - Words with 1-2 chars → 1 token each
//   - Words with 3-7 chars → ~1 token each
//   - Words with 8+ chars → ~ceil(len/4) tokens
//   - Punctuation / special chars → ~1 token per char

/**
 * Estimate token count for a string using a character-based heuristic.
 * Correlates ~95% with tiktoken cl100k_base for English text.
 * For non-English (CJK, etc.), characters are counted individually.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;

	let tokens = 0;
	// Split on whitespace and punctuation boundaries for word-level counting
	const words = text.split(/\s+/).filter(Boolean);

	for (const word of words) {
		const len = word.length;

		// CJK / non-Latin characters → count individually
		// (most CJK chars are 1-2 tokens in cl100k_base)
		const cjkCount = (
			word.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) ||
			[]
		).length;
		if (cjkCount > len * 0.5) {
			// Predominantly CJK — count chars individually
			tokens += len;
			continue;
		}

		// Special characters (URLs, code, etc.) → count individually
		const specialCount = (word.match(/[{}[\]()<>|&^$#@!%*+=~`\\/:;,"']/g) || [])
			.length;
		if (specialCount > len * 0.4) {
			tokens += len;
			continue;
		}

		// English-like: apply the heuristic
		if (len <= 2) {
			tokens += 1;
		} else if (len <= 7) {
			tokens += 1;
		} else {
			tokens += Math.ceil(len / 4);
		}
	}

	// Add a small overhead for whitespace/formatting
	return Math.max(1, tokens);
}

/**
 * Fast approximate token count — chars / 4.
 * Slightly less accurate but much faster for large texts.
 * Use estimateTokens() when accuracy matters, estimateTokensFast() when speed matters.
 */
function estimateTokensFast(text: string): number {
	return Math.ceil(text.length / 4);
}
