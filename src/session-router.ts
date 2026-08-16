/**
 * Session Router — multi-fetcher URL routing.
 *
 * Maps URL patterns to fetcher modes (fast / fingerprint / browser) and
 * optionally to vertical extractors. Allows a single webpull to use
 * different strategies for different page types.
 *
 * Routes are evaluated in order; the first match wins.
 * An implicit default route always exists (uses the global mode).
 */

// ─── Types ───────────────────────────────────────────────────────────

/** Fetcher mode matching the values used in the main fetch pipeline. */
export type RouteScrapeMode = "fast" | "fingerprint" | "browser" | "auto";

/** A single route entry mapping URL patterns to fetcher behavior. */
export interface Route {
	pattern: string;
	mode?: RouteScrapeMode;
	extractor?: string;
	browser?: string;
	os?: string;
}

/** Resolved route match result. */
export interface RouteMatch {
	mode?: RouteScrapeMode;
	extractor?: string;
	browser?: string;
	os?: string;
	matchedRoute: Route | null;
}

// ─── Router ─────────────────────────────────────────────────────────

export class SessionRouter {
	private routes: Route[];

	constructor(routes: Route[] = []) {
		this.routes = routes;
	}

	add(route: Route): void {
		this.routes.push(route);
	}

	match(url: string): RouteMatch | null {
		for (const route of this.routes) {
			if (this.matchesPattern(url, route.pattern)) {
				return {
					mode: route.mode,
					extractor: route.extractor,
					browser: route.browser,
					os: route.os,
					matchedRoute: route,
				};
			}
		}
		return null;
	}

	getRoutes(): Route[] {
		return [...this.routes];
	}

	clear(): void {
		this.routes = [];
	}

	// ── Pattern Matching ────────────────────────────────────────────

	private matchesPattern(url: string, pattern: string): boolean {
		const urlPath = this.extractPath(url);

		// Regex pattern: starts and ends with /
		if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
			try {
				const regexBody = pattern.slice(1, -1);
				const re = new RegExp(regexBody);
				return re.test(urlPath);
			} catch {
				return false;
			}
		}

		// Glob-like pattern with wildcards
		if (pattern.includes("*")) {
			return this.matchGlob(urlPath, pattern);
		}

		// Simple substring match
		return urlPath.includes(pattern);
	}

	private extractPath(url: string): string {
		try {
			return new URL(url).pathname;
		} catch {
			return url;
		}
	}

	private matchGlob(path: string, pattern: string): boolean {
		// Bound the pattern so a pathological route cannot build a
		// pathological regex (opengrep ReDoS hardening); route patterns are
		// config inputs but the guard is cheap.
		if (pattern.length > 4096) return false;
		const regexStr =
			"^" +
			pattern
				.split(/\*+/)
				.map((part) => escapeRegex(part))
				.join(".*") +
			"$";
		try {
			return new RegExp(regexStr).test(path);
		} catch {
			return false;
		}
	}
}

// ─── Route Parser ────────────────────────────────────────────────────

/**
 * Parse route definitions from various formats.
 */
export function parseRoutes(input: unknown): Route[] {
	if (!input) return [];
	if (Array.isArray(input)) {
		return input.map(parseRouteEntry).filter(Boolean) as Route[];
	}
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input);
			return parseRoutes(parsed);
		} catch {
			return input
				.split("\n")
				.map((l) => parseRouteEntry(l.trim()))
				.filter(Boolean) as Route[];
		}
	}
	return [];
}

function parseRouteEntry(entry: unknown): Route | null {
	if (!entry) return null;

	if (typeof entry === "object" && entry !== null && "pattern" in entry) {
		const e = entry as Record<string, unknown>;
		return {
			pattern: String(e.pattern),
			mode: e.mode as RouteScrapeMode | undefined,
			extractor: e.extractor as string | undefined,
			browser: e.browser as string | undefined,
			os: e.os as string | undefined,
		};
	}

	if (typeof entry === "string") {
		const trimmed = entry.trim();
		const arrowMatch = trimmed.match(/^(.+?)\s*->\s*(\w+)$/);
		if (arrowMatch) {
			return {
				pattern: arrowMatch[1]!.trim(),
				mode: arrowMatch[2] as RouteScrapeMode,
			};
		}
		const spaceMatch = trimmed.match(/^(\S+)\s+(\w+)$/);
		if (spaceMatch) {
			return {
				pattern: spaceMatch[1]!,
				mode: spaceMatch[2] as RouteScrapeMode,
			};
		}
	}

	return null;
}

// ─── Helper ──────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
