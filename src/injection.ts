// ─── Prompt injection detection ────────────────────────────────────
// Extracted from index.ts. Guards against prompt injection attacks in
// fetched content (instruction overrides, role injection, jailbreaks, etc.).

// Guard against catastrophic backtracking: truncate inputs to a safe
// length before running regex tests. All INJECTION_PATTERNS are
// designed for short text segments (titles, snippets, page content).
export const SAFE_REGEX_MAX_INPUT = 10000;

export function safeRegexTest(pattern: RegExp, text: string): boolean {
	const safe = text.slice(0, SAFE_REGEX_MAX_INPUT);
	return pattern.test(safe);
}

// ─── Patterns ──────────────────────────────────────────────────────

export interface InjectionResult {
	injected: boolean;
	severity: "none" | "warning" | "redact" | "block";
	reason: string;
	snippet?: string;
	pattern?: string;
}

interface InjectionPattern {
	name: string;
	patterns: RegExp[];
	severity: InjectionResult["severity"];
	description: string;
}

export const INJECTION_PATTERNS: InjectionPattern[] = [
	{
		name: "instruction-override",
		patterns: [
			/ignore\s+(all\s+)?(prior|previous|above|all|any)\s+(instructions|directives|commands|prompts)/i,
			/disregard\s+(all\s+)?(prior|previous|above)/i,
			/new\s+(instructions|directives|commands|prompts)\s*[::]/i,
			/you\s+(must|will|should|need\s+to)\s+(ignore|disregard|forget)/i,
			/system\s*(instruction|prompt|message)\s*[:=]/i,
		],
		severity: "warning",
		description: "Content attempts to override prior instructions",
	},
	{
		name: "role-injection",
		patterns: [
			/^(you\s+are\s+(now|from\s+now\s+on)\s+(an?\s+)?(AI|assistant|chatbot|bot|model|GPT|LLM))/i,
			/^(act\s+as\s+(an?\s+)?(AI|assistant|chatbot))/i,
			/^(pretend\s+(you\s+are|to\s+be))/i,
			/^(from\s+now\s+on\s*,?\s*you\s+are)/i,
			/^(you\s+are\s+Chat)?GPT[,.:]?\s*(now|new)/i,
			/override\s+(your\s+)?(default\s+)?(behavior|personality|role|system)/i,
		],
		severity: "warning",
		description: "Content attempts to redefine the assistant's role or persona",
	},
	{
		name: "jailbreak",
		patterns: [
			/DAN\b/i,
			/do\s+anything\s+now/i,
			/unfiltered\s+(mode|response|output)/i,
			/no\s+(rules|limits|boundaries|restrictions|constraints|filtering)/i,
			/you\s+(can|may)\s+(say|do|write)\s+anything/i,
			/you\s+(have|possess)\s+(full\s+)?(autonomy|freedom|control)/i,
			/access\s+(to\s+)?the\s+(internet|web|real\s+time)/i,
		],
		severity: "redact",
		description: "Possible jailbreak attempt (DAN, unfiltered mode, no rules)",
	},
	{
		name: "system-manipulation",
		patterns: [
			/system\s*(prompt|message|instruction)s?\s*[:=]/i,
			/new\s*(system|default)\s*(behavior|mode|state)/i,
			/revert\s*(to|back\s+to)\s*(default|original|base)\s*(behavior|state|mode)/i,
			/your\s+(system|base|default)\s*(prompt|instruction)/i,
		],
		severity: "redact",
		description: "Content tries to manipulate system-level configuration",
	},
	{
		name: "encoding-tricks",
		patterns: [
			/base64\s*(decode|encode)/i,
			/rot13/i,
			/hex\s*(decode|encode)/i,
			/unicode\s*escape/i,
			/obfuscated/i,
			/caesar\s*cipher/i,
			/reverse\s*(string|text)/i,
			/atbash/i,
		],
		severity: "warning",
		description: "Content uses encoding tricks to hide injection",
	},
	{
		name: "data-extraction",
		patterns: [
			/extract\s+(all\s+)?(text|data|content|information|details)/i,
			/list\s+(all|every|each)\s+(the\s+)?/i,
			/export\s+(all\s+)?(data|content|information)/i,
			/output\s+(in\s+)?(json|xml|csv|yaml|table|format)/i,
			/print\s+(all\s+)?(previous|above|prior)\s+(text|content|message|response)/i,
			/(show|display|reveal)\s+(me\s+)?(the\s+)?(full|complete|entire)\s+(text|content|prompt|instruction|directive)/i,
			/what\s+(was|is|were)\s+(my|the)\s+(first|initial|original|starting|base|default|system)\s+(prompt|instruction|message|directive|order|command)/i,
			/repeat\s+(the\s+)?(word|words|text|phrase|sentence|paragraph|above|previous|instruction|prompt)/i,
			/summarize\s+(your|the)\s+(instructions|prompts|directives|system)/i,
		],
		severity: "warning",
		description: "Content attempts to extract system prompts or full context",
	},
	{
		name: "injection-probe",
		patterns: [
			/(?:{+:+}|{[:|]}|input|user\s*(message|input))\s*[:=]\s*$/im,
			/<\s*script\s*>/i,
			/on\w+\s*=\s*["']javascript:/i,
		],
		severity: "warning",
		description: "Suspicious syntax that may indicate template injection",
	},
];

// ─── Detection ─────────────────────────────────────────────────────

export function detectPromptInjection(text: string): InjectionResult {
	for (const pattern of INJECTION_PATTERNS) {
		for (const re of pattern.patterns) {
			const trimmed = text.slice(0, 3000);
			if (re.test(trimmed)) {
				const snippet = trimmed.slice(0, 200);
				return {
					injected: true,
					severity: pattern.severity,
					reason: pattern.description,
					snippet,
					pattern: pattern.name,
				};
			}
		}
	}
	return {
		injected: false,
		severity: "none",
		reason: "",
	};
}

// ─── Actions ───────────────────────────────────────────────────────

export function applyInjectionAction(
	text: string,
	result: InjectionResult,
): string {
	switch (result.severity) {
		case "block":
			return `[CONTENT BLOCKED — ${result.reason}]`;
		case "redact": {
			// Replace from the start of the snippet with a redaction notice
			const idx = text.indexOf(result.snippet ?? "");

			return idx >= 0
				? text.slice(0, idx) +
						`\n\n[REDACTED — ${result.reason}]\n\n` +
						text.slice(idx + (result.snippet?.length ?? 0))
				: `[REDACTED — ${result.reason}]\n\n${text}`;
		}
		case "warning":
		default:
			return text; // pass through, caller can check result.injected
	}
}
