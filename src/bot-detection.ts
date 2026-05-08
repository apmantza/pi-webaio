// ─── Structured bot-block detection ────────────────────────────────
// Categorized detection for known anti-bot systems. Returns structured
// metadata so callers can decide whether to retry, escalate, or give up.

export interface BotBlockResult {
	blocked: boolean;
	/** Known blocker type, or "generic" for heuristic-only matches. */
	blockerType?:
		| "cloudflare"
		| "anubis"
		| "perimeterx"
		| "datadome"
		| "incapsula"
		| "akamai"
		| "generic";
	/** Human-readable explanation. */
	message: string;
	/** Whether retrying with a different profile/browser may help. */
	retryable: boolean;
	/** The phase of the page that triggered detection. */
	phase:
		| "javascript_challenge"
		| "captcha"
		| "rate_limit"
		| "proof_of_work"
		| "generic_block";
	/** Raw confidence score 0–1 based on signal strength. */
	confidence: number;
}

type KnownBlocker = Exclude<BotBlockResult["blockerType"], undefined>;

interface BlockerSignature {
	type: KnownBlocker;
	phase: BotBlockResult["phase"];
	retryable: boolean;
	/** Required string(s) that must ALL be present. */
	required: string[];
	/** Optional string(s); at least one must be present if provided. */
	optional?: string[];
	/** Weight for confidence scoring. */
	weight: number;
}

const BLOCKER_SIGNATURES: BlockerSignature[] = [
	{
		type: "cloudflare",
		phase: "javascript_challenge",
		retryable: true,
		required: ["cf-browser-verification", "checking your browser"],
		weight: 0.95,
	},
	{
		type: "cloudflare",
		phase: "captcha",
		retryable: false,
		required: ["attention required"],
		optional: ["cloudflare", "captcha", "verify you are human"],
		weight: 0.95,
	},
	{
		type: "cloudflare",
		phase: "rate_limit",
		retryable: true,
		required: ["rate limited"],
		optional: ["cloudflare", "too many requests", "ray id"],
		weight: 0.9,
	},
	{
		type: "anubis",
		phase: "proof_of_work",
		retryable: true,
		required: ["protected by anubis"],
		optional: ["proof-of-work", "making sure you're not a bot"],
		weight: 0.98,
	},
	{
		type: "perimeterx",
		phase: "javascript_challenge",
		retryable: true,
		required: ["perimeterx"],
		optional: ["px-captcha", "please verify"],
		weight: 0.95,
	},
	{
		type: "datadome",
		phase: "javascript_challenge",
		retryable: true,
		required: ["datadome"],
		optional: ["please verify", "captcha", "checking your browser"],
		weight: 0.95,
	},
	{
		type: "incapsula",
		phase: "javascript_challenge",
		retryable: true,
		required: ["incap_ses"],
		optional: ["incapsula", " Javascript is required"],
		weight: 0.9,
	},
	{
		type: "akamai",
		phase: "javascript_challenge",
		retryable: true,
		required: ["akamai"],
		optional: ["checking your browser", "please verify"],
		weight: 0.9,
	},
];

// Generic heuristic markers (used when no specific signature matches)
const GENERIC_BOT_MARKERS = [
	"making sure you're not a bot",
	"checking your browser",
	"just a moment",
	"enable javascript and cookies to continue",
	"attention required",
	"verify you are human",
	"unusual traffic",
	"before you continue",
	"please enable javascript",
	"browser check",
	"security check",
	"captcha",
	"ddos protection",
	"bot detection",
];

/**
 * Analyze HTML/text content for known anti-bot / blocking pages.
 * Returns structured metadata instead of a simple boolean so callers
 * can make intelligent retry/escalation decisions.
 */
export function detectBotBlock(
	text: string,
	statusCode?: number,
): BotBlockResult {
	const sample = String(text || "")
		.slice(0, 8000)
		.toLowerCase();

	// Check specific blocker signatures
	for (const sig of BLOCKER_SIGNATURES) {
		const hasRequired = sig.required.every((r) => sample.includes(r));
		if (!hasRequired) continue;
		const hasOptional =
			!sig.optional || sig.optional.some((o) => sample.includes(o));
		if (sig.optional && !hasOptional) continue;

		const messages: Record<string, string> = {
			cloudflare: "Cloudflare bot protection detected",
			anubis: "Anubis proof-of-work challenge detected",
			perimeterx: "PerimeterX bot protection detected",
			datadome: "DataDome bot protection detected",
			incapsula: "Incapsula bot protection detected",
			akamai: "Akamai bot protection detected",
			generic: "Bot protection likely detected",
		};

		return {
			blocked: true,
			blockerType: sig.type,
			message: messages[sig.type] ?? messages.generic,
			retryable: sig.retryable,
			phase: sig.phase,
			confidence: sig.weight,
		};
	}

	// Generic heuristic fallback
	const matches = GENERIC_BOT_MARKERS.filter((m) => sample.includes(m));
	if (
		matches.length >= 2 ||
		(matches.length >= 1 && statusCode && statusCode >= 400)
	) {
		return {
			blocked: true,
			blockerType: "generic",
			message: `Bot protection likely detected (${matches.join(", ")})`,
			retryable: true,
			phase: "generic_block",
			confidence: Math.min(0.5 + matches.length * 0.15, 0.85),
		};
	}

	return {
		blocked: false,
		message: "No bot protection detected",
		retryable: false,
		phase: "generic_block",
		confidence: 0,
	};
}

/**
 * Backward-compatible boolean check. Use detectBotBlock() for full metadata.
 */
export function isLikelyBotProtection(text: string): boolean {
	return detectBotBlock(text).blocked;
}
