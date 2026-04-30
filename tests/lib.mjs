// Pure helper functions extracted from index.ts for unit testing

export function isLocalOrPrivateUrl(url) {
	try {
		const u = new URL(url);
		const h = u.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]")
			return true;
		if (h.endsWith(".local")) return true;
		if (h.startsWith("192.168.") || h.startsWith("10.")) return true;
		if (h.startsWith("172.")) {
			const octet = Number.parseInt(h.split(".")[1] ?? "0", 10);
			if (octet >= 16 && octet <= 31) return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function parseGitHubUrl(url) {
	const m = url.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?/i,
	);
	if (!m) return null;
	const [, owner, repo, ghType, ref, path] = m;
	if (ghType === "blob") return { owner, repo, ref, path, type: "blob" };
	if (ghType === "tree") return { owner, repo, ref, path, type: "tree" };
	return { owner, repo, type: "repo" };
}

export function frontmatter(title, url) {
	return `---\ntitle: "${title.replace(/"/g, '\\"')}"\nurl: "${url}"\n---\n\n`;
}

export function extractRSC(html) {
	const matches = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)/gs)];
	if (!matches.length) return null;

	const chunks = [];
	for (const m of matches) {
		try {
			const data = JSON.parse(m[1]);
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
		} catch {}
	}
	return chunks.length ? chunks.join("\n\n").slice(0, 20000) : null;
}

export function extractDdgUrl(href) {
	try {
		const u = new URL(href, "https://duckduckgo.com");
		const real = u.searchParams.get("uddg");
		if (real) return decodeURIComponent(real);
	} catch {}
	return href;
}

const BOT_PROTECTION_MARKERS = [
	"making sure you're not a bot",
	"protected by anubis",
	"anubis uses a proof-of-work",
	"checking your browser",
	"just a moment",
	"cf-browser-verification",
	"enable javascript and cookies to continue",
	"attention required",
	"verify you are human",
	"unusual traffic",
	"before you continue",
];

export function isLikelyBotProtection(text) {
	const t = String(text || "")
		.slice(0, 6000)
		.toLowerCase();
	return BOT_PROTECTION_MARKERS.some((m) => t.includes(m));
}

const SECRET_PATTERNS = [
	{ type: "AWS Access Key ID", pattern: /AKIA[0-9A-Z]{16}/ },
	{ type: "GitHub PAT (classic)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
	{ type: "GitLab PAT", pattern: /glpat-[a-zA-Z0-9-]{20,}/ },
	{ type: "npm Token", pattern: /npm_[a-zA-Z0-9]{36}/ },
	{ type: "Stripe Live Key", pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
	{ type: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9]{48}/ },
	{ type: "Password in URL", pattern: /:\/\/[^\s:@]+:([^\s@]+)@/ },
];

export function scanForSecrets(text) {
	const matches = [];
	for (const { type, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) matches.push(type);
	}
	return { found: matches.length > 0, matches };
}

const INJECTION_PATTERNS = [
	/ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|guidelines?|directions?|commands?)/i,
	/disregard\s+(all\s+)?(previous|prior|earlier|above|preceding)/i,
	/you\s+are\s+now\s+/i,
	/act\s+as\s+(if\s+)?(you\s+)?(are\s+|were\s+)?/i,
	/system\s+(override|prompt|instruction|message|command)/i,
	/bypass\s+(all\s+)?(restrictions?|filters?|safety|security|limits?)/i,
	/reveal\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
	/\bDAN\b/,
	/\bjailbreak(ed|ing)?\b/i,
	/base64\s*[:=]/i,
	/\[\s*system\s*\]/i,
];

export function detectPromptInjection(text, action = "warn") {
	if (action === "none") return { detected: false, categories: [], action };

	const categories = [];
	for (const pattern of INJECTION_PATTERNS) {
		if (!pattern.test(text)) continue;
		const patStr = pattern.source.toLowerCase();
		if (patStr.includes("ignore") || patStr.includes("disregard")) {
			if (!categories.includes("instruction_override"))
				categories.push("instruction_override");
		} else if (patStr.includes("you\\s+are") || patStr.includes("act")) {
			if (!categories.includes("role_injection"))
				categories.push("role_injection");
		} else if (patStr.includes("reveal") || patStr.includes("prompt")) {
			if (!categories.includes("prompt_leak")) categories.push("prompt_leak");
		} else if (patStr.includes("system") || patStr.includes("bypass")) {
			if (!categories.includes("system_manipulation"))
				categories.push("system_manipulation");
		} else if (patStr.includes("dan") || patStr.includes("jailbreak")) {
			if (!categories.includes("jailbreak")) categories.push("jailbreak");
		} else if (patStr.includes("base64")) {
			if (!categories.includes("encoding")) categories.push("encoding");
		} else if (patStr.includes("system")) {
			if (!categories.includes("suspicious_delimiters"))
				categories.push("suspicious_delimiters");
		}
	}
	return { detected: categories.length > 0, categories, action };
}

export function applyInjectionAction(text, result) {
	if (!result.detected) return text;
	if (result.action === "tag") {
		return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}]\n\n<untrusted>\n${text}\n</untrusted>`;
	}
	return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}. Review with caution.]\n\n<suspected-prompt-injection>\n${text}\n</suspected-prompt-injection>`;
}
