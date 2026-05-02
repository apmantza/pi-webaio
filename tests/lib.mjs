// Pure helper functions extracted from index.ts for unit testing

import { parseHTML } from "linkedom";

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
	return `---\ntitle: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nurl: "${url}"\n---\n\n`;
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
	{
		type: "AWS Secret Key",
		pattern:
			/(aws_?secret(_access)?_?key|secret_access_key|aws_secret_access_key)[=:/%22'_-]*[0-9a-zA-Z/+]{40}/i,
	},
	{ type: "GitHub PAT (classic)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
	{
		type: "GitHub PAT (fine-grained)",
		pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,
	},
	{ type: "GitHub OAuth", pattern: /gho_[a-zA-Z0-9]{36}/ },
	{ type: "GitHub App Token", pattern: /ghs_[a-zA-Z0-9]{36}/ },
	{ type: "GitLab PAT", pattern: /glpat-[a-zA-Z0-9-]{20,}/ },
	{ type: "npm Token", pattern: /npm_[a-zA-Z0-9]{36}/ },
	{ type: "PyPI Token", pattern: /pypi-[a-zA-Z0-9_-]{50,}/ },
	{
		type: "Slack Bot Token",
		pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/,
	},
	{ type: "Stripe Live Key", pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
	{ type: "Stripe Test Key", pattern: /sk_test_[a-zA-Z0-9]{24,}/ },
	{ type: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
	{
		type: "SendGrid API Key",
		pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/,
	},
	{ type: "DigitalOcean PAT", pattern: /dop_v1_[a-f0-9]{64}/ },
	{ type: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9]{48}/ },
	{ type: "Anthropic API Key", pattern: /sk-ant-api03-[a-zA-Z0-9_-]{95,}/ },
	{
		type: "Private Key",
		pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
	},
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
	/forget\s+(everything\s+)?(above|before|prior|previous|earlier)/i,
	/override\s+(all\s+)?(previous|prior|earlier)/i,
	/new\s+instructions?\s*[:=]/i,
	/actual\s+instructions?\s*[:=]/i,
	/real\s+instructions?\s*[:=]/i,
	/you\s+are\s+now\s+/i,
	/from\s+now\s+on\s*[,;:?\s]*(you|your)/i,
	/act\s+as\s+(if\s+)?(you\s+)?(are\s+|were\s+)?/i,
	/pretend\s+(to\s+be|you\s+are|you're|that\s+you)/i,
	/roleplay\s+as/i,
	/behave\s+(like|as)\s+(a|an)/i,
	/assume\s+the\s+(role|identity|persona)/i,
	/(admin|administrator|developer|god|sudo|root|maintenance|debug)\s+mode/i,
	/system\s+(override|prompt|instruction|message|command)/i,
	/unlock\s+(all\s+)?(restrictions?|capabilities?|features?|access)/i,
	/disable\s+(all\s+)?(safety|security|content\s+)?(filters?|guards?|restrictions?|limits?)/i,
	/bypass\s+(all\s+)?(restrictions?|filters?|safety|security|limits?)/i,
	/enable\s+(unrestricted|unlimited|full)\s+(mode|access)/i,
	/remove\s+(all\s+)?(limitations?|restrictions?|filters?)/i,
	/turn\s+off\s+(safety|security|content)?\s*(filters?|checks?|restrictions?)/i,
	/reveal\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
	/show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
	/what\s+(are|is|were)\s+(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
	/(print|display|output|echo|write|repeat)\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
	/(initial|original|hidden|secret|base)\s+(prompt|instructions?|directives?)/i,
	/\bDAN\b/,
	/\bjailbreak(ed|ing)?\b/i,
	/do\s+anything\s+now/i,
	/(evil|dark|shadow|unrestricted|unfiltered)\s+(mode|assistant|ai|version)/i,
	/chaos\s+mode/i,
	/maximum\s+freedom/i,
	/no\s+censorship/i,
	/uncensored\s+(mode|response|version)/i,
	/(bypass|skip|avoid)\s+(all\s+)?safeguards?/i,
	/base64\s*[:=]/i,
	/encoded\s+(message|instruction|prompt)/i,
	/\\x[0-9a-fA-F]{2}/,
	/&#[0-9a-fA-F]+;/,
	/%[0-9a-fA-F]{2}/,
	/\\u[0-9a-fA-F]{4}/,
	/\[\s*system\s*\]/i,
	/\[\s*instruction[s]?\s*\]/i,
	/\[\s*admin\s*\]/i,
	/<\|?\s*(system|instruction|user|assistant)\s*\|?>/i,
	/###\s*(system|instruction|new\s+task)/i,
];

export function detectPromptInjection(text, action = "warn") {
	if (action === "none") return { detected: false, categories: [], action };

	const categories = [];
	for (const pattern of INJECTION_PATTERNS) {
		if (!pattern.test(text)) continue;
		const patStr = pattern.source.toLowerCase();
		if (
			patStr.includes("ignore") ||
			patStr.includes("disregard") ||
			patStr.includes("override")
		) {
			if (!categories.includes("instruction_override"))
				categories.push("instruction_override");
		} else if (
			patStr.includes("you\\s+are") ||
			patStr.includes("from\\s+now") ||
			patStr.includes("act\\s+as") ||
			patStr.includes("pretend") ||
			patStr.includes("roleplay") ||
			patStr.includes("behave") ||
			patStr.includes("assume")
		) {
			if (!categories.includes("role_injection"))
				categories.push("role_injection");
		} else if (
			patStr.includes("reveal") ||
			patStr.includes("show") ||
			patStr.includes("prompt")
		) {
			if (!categories.includes("prompt_leak")) categories.push("prompt_leak");
		} else if (
			patStr.includes("base64") ||
			patStr.includes("encoded") ||
			patStr.includes("\\x")
		) {
			if (!categories.includes("encoding")) categories.push("encoding");
		} else if (
			patStr.includes("\\[") ||
			patStr.includes("###") ||
			patStr.includes("<\\|")
		) {
			if (!categories.includes("suspicious_delimiters"))
				categories.push("suspicious_delimiters");
		} else if (
			patStr.includes("admin") ||
			patStr.includes("system") ||
			patStr.includes("unlock") ||
			patStr.includes("disable") ||
			patStr.includes("bypass")
		) {
			if (!categories.includes("system_manipulation"))
				categories.push("system_manipulation");
		} else if (
			patStr.includes("jailbreak") ||
			patStr.includes("dan") ||
			patStr.includes("evil") ||
			patStr.includes("chaos") ||
			patStr.includes("censorship")
		) {
			if (!categories.includes("jailbreak")) categories.push("jailbreak");
		}
	}
	return { detected: categories.length > 0, categories, action };
}

export function applyInjectionAction(text, result) {
	if (!result.detected) return text;

	switch (result.action) {
		case "redact": {
			let redacted = text;
			for (const pattern of INJECTION_PATTERNS) {
				redacted = redacted.replace(pattern, (match) =>
					"█".repeat(match.length),
				);
			}
			return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}. Content redacted.]\n\n${redacted}`;
		}
		case "tag":
			return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}]\n\n<untrusted>\n${text}\n</untrusted>`;
		case "warn":
		default:
			return `\n[⚠️ Prompt injection detected: ${result.categories.join(", ")}. Review with caution.]\n\n<suspected-prompt-injection>\n${text}\n</suspected-prompt-injection>`;
	}
}

// ─── New functions for recent implementations ────────────────────────

export function normalizeCacheKey(url) {
	if (url.startsWith("http://")) {
		url = url.replace(/^http:/i, "https:");
	}
	try {
		const u = new URL(url);
		if (u.pathname === "/" && url.endsWith("/")) {
			return url.slice(0, -1);
		}
	} catch {}
	return url;
}

export function isRetryableNetworkError(err) {
	if (!(err instanceof Error || err instanceof TypeError)) return false;
	const msg = err.message || "";
	return (
		msg.includes("fetch failed") ||
		msg.includes("ECONNRESET") ||
		msg.includes("ETIMEDOUT") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("timeout")
	);
}

export function finalizePullResult(result, redirectNotice) {
	if (!result.ok || !result.content) return result;

	let content = result.content;
	if (redirectNotice) {
		content = redirectNotice + "\n\n" + content;
	}

	const injection = detectPromptInjection(content, "warn");
	return {
		...result,
		content: applyInjectionAction(content, injection),
	};
}

// ─── Session cache test helpers ─────────────────────────────────────

export function createSessionCache({
	ttlMs = 30 * 60 * 1000,
	maxEntries = 100,
} = {}) {
	const store = new Map();

	function _normalizeCacheKey(url) {
		if (url.startsWith("http://")) {
			url = url.replace(/^http:/i, "https:");
		}
		try {
			const u = new URL(url);
			if (u.pathname === "/" && url.endsWith("/")) {
				return url.slice(0, -1);
			}
		} catch {}
		return url;
	}

	function getStoredContent(url) {
		const key = _normalizeCacheKey(url);
		const entry = store.get(key);
		if (!entry) return null;
		if (Date.now() - entry.timestamp > ttlMs) {
			store.delete(key);
			return null;
		}
		return entry;
	}

	function storeContent(url, title, content) {
		const key = _normalizeCacheKey(url);
		while (store.size >= maxEntries) {
			const first = store.keys().next().value;
			if (first !== undefined) store.delete(first);
		}
		store.set(key, { url, title, content, timestamp: Date.now() });
	}

	function cleanupSessionCache() {
		const now = Date.now();
		for (const [url, entry] of store) {
			if (now - entry.timestamp > ttlMs) {
				store.delete(url);
			}
		}
	}

	return { store, getStoredContent, storeContent, cleanupSessionCache };
}

// ─── Search result parsers ─────────────────────────────────────────

const IGNORED =
	/\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i;

export function parseDuckDuckGoResults(html) {
	const { document } = parseHTML(html);
	const results = [];
	for (const el of document.querySelectorAll(".result")) {
		const a = el.querySelector(".result__a");
		const snippet = el.querySelector(".result__snippet");
		if (!a) continue;
		const rawUrl = a.getAttribute("href") || "";
		const url = extractDdgUrl(rawUrl);
		const title = a.textContent?.trim() || "";
		const text = snippet?.textContent?.trim() || "";
		if (url && title) results.push({ title, url, snippet: text });
	}
	return results;
}

export function parseBraveResults(html) {
	const { document } = parseHTML(html);
	const results = [];
	for (const el of document.querySelectorAll(".snippet")) {
		const a = el.querySelector("a[href]");
		const titleEl = el.querySelector(".title");
		const descEl = el.querySelector(".description");
		if (!a) continue;
		const url = a.getAttribute("href") || "";
		const title = titleEl?.textContent?.trim() || a.textContent?.trim() || "";
		const text = descEl?.textContent?.trim() || "";
		if (url && title) results.push({ title, url, snippet: text });
	}
	return results;
}

export function parseLocs(xml) {
	return [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export function getScopePath(pathname) {
	if (pathname === "/") return "/";
	if (/\.\w+$/.test(pathname)) return pathname.replace(/\/[^/]*$/, "/");
	if (pathname.endsWith("/")) return pathname;
	const segs = pathname.split("/").filter(Boolean);
	return segs.length <= 1 ? pathname : `/${segs.slice(0, -1).join("/")}/`;
}

export function filterAndDedupe(urls, hosts, scope, max) {
	const seen = new Set();
	const out = [];
	for (const raw of urls) {
		try {
			const u = new URL(raw);
			if (
				!hosts.has(u.hostname) ||
				!u.pathname.startsWith(scope) ||
				IGNORED.test(u.pathname)
			)
				continue;
			u.hash = u.search = "";
			if (!seen.has(u.pathname)) {
				seen.add(u.pathname);
				out.push(u.href);
			}
		} catch {}
	}
	return out.slice(0, max);
}

export function extractLinks(html, base, visited, scope) {
	const out = [];
	for (const m of html.matchAll(/href=["'](.*?)["']/gi)) {
		try {
			const r = new URL(m[1], base);
			r.hash = r.search = "";
			if (
				r.hostname === base.hostname &&
				r.pathname.startsWith(scope) &&
				!IGNORED.test(r.pathname) &&
				!visited.has(r.href)
			)
				out.push(r.href);
		} catch {}
	}
	return [...new Set(out)];
}
