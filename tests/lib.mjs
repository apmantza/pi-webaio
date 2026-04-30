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
