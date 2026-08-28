/**
 * tinyfish.ts — TinyFish Search & Fetch API client
 *
 * TinyFish provides free Search (GET) and Fetch (POST) APIs authenticated via
 * the X-API-Key header. The API key is resolved from:
 *   1. The `apiKey` parameter (explicit override)
 *   2. The `TINYFISH_API_KEY` environment variable
 *
 * Search API:  GET  https://api.search.tinyfish.ai?query=...
 * Fetch API:   POST https://api.fetch.tinyfish.ai  body: { urls, format, ... }
 *
 * https://docs.tinyfish.ai/
 */

import { debug } from "./debug.ts";
import { resolveTinyfishConfigKey } from "./config.ts";

// ─── API key resolution ────────────────────────────────────────────

/**
 * Resolve the TinyFish API key, checked in order:
 *   1. Explicit `apiKey` parameter
 *   2. `~/.piwebaio/config` file (JSON, key: `tinyfish.apiKey`)
 *   3. `TINYFISH_API_KEY` environment variable
 */
export function resolveTinyfishApiKey(override?: string): string | null {
  return override ?? resolveTinyfishConfigKey();
}

/** True when a TinyFish API key is available. */
export function tinyfishAvailable(apiKey?: string): boolean {
  return resolveTinyfishApiKey(apiKey) !== null;
}

// ─── Search API ─────────────────────────────────────────────────────

export interface TinyfishSearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

interface TinyfishRawSearchResult {
  position?: number;
  site_name?: string;
  title?: string;
  snippet?: string;
  url?: string;
  date?: string;
}

interface TinyfishSearchResponseBody {
  query: string;
  results: TinyfishRawSearchResult[];
}

/**
 * Search via TinyFish Search API.
 * Returns parsed search results, or null on failure/empty.
 */
export async function searchTinyfish(
  query: string,
  options: { maxResults?: number; apiKey?: string } = {},
): Promise<{ results: TinyfishSearchResult[]; latencyMs: number } | null> {
  const apiKey = resolveTinyfishApiKey(options.apiKey);
  if (!apiKey) {
    debug("tinyfish", "skipped: no API key");
    return null;
  }

  const start = Date.now();
  const params = new URLSearchParams({ query: query });
  if (
    options.maxResults &&
    options.maxResults > 0 &&
    options.maxResults <= 25
  ) {
    params.set("max", String(options.maxResults));
  }

  const url = `https://api.search.tinyfish.ai?${params}`;
  try {
    const res = await fetch(url, {
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      debug("tinyfish", `search HTTP ${res.status}`);
      return { results: [], latencyMs };
    }
    const body = (await res.json()) as TinyfishSearchResponseBody;
    const results = (body.results ?? [])
      .map((r) => ({
        title: (r.title ?? "").trim(),
        url: (r.url ?? "").trim(),
        snippet: (r.snippet ?? "").trim(),
        domain: extractDomain(r.url ?? ""),
      }))
      .filter((r) => r.title && r.url);
    debug(
      "tinyfish",
      `search returned ${results.length} results in ${latencyMs}ms`,
    );
    return { results, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    debug(
      "tinyfish",
      `search error: ${String(err instanceof Error ? err.message : err)}`,
    );
    return { results: [], latencyMs };
  }
}

// ─── Fetch API ─────────────────────────────────────────────────────

export interface TinyfishFetchResult {
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string | null;
  language?: string;
  text: string;
  format: string;
  latencyMs?: number;
  notModified?: boolean;
}

export interface TinyfishFetchResponseBody {
  results: TinyfishFetchResult[];
  errors?: Array<{ url: string; error: string }>;
}

export type TinyfishOutputFormat = "markdown" | "html" | "json";

/**
 * Fetch one or more URLs via the TinyFish Fetch API.
 * Returns clean extracted content in the requested format.
 * Errors per-URL appear in the errors array rather than rejecting the whole
 * request — each URL is processed independently.
 */
export async function fetchTinyfish(
  urls: string[],
  options: {
    format?: TinyfishOutputFormat;
    ttl?: number;
    includeSelectors?: string[];
    excludeSelectors?: string[];
    purpose?: string;
    apiKey?: string;
  } = {},
): Promise<{
  results: TinyfishFetchResult[];
  errors: Array<{ url: string; error: string }>;
} | null> {
  const apiKey = resolveTinyfishApiKey(options.apiKey);
  if (!apiKey) {
    debug("tinyfish", "fetch skipped: no API key");
    return null;
  }

  const body: Record<string, unknown> = {
    urls,
    format: options.format ?? "markdown",
  };
  if (options.ttl !== undefined) body.ttl = options.ttl;
  if (options.includeSelectors?.length)
    body.include_selectors = options.includeSelectors;
  if (options.excludeSelectors?.length)
    body.exclude_selectors = options.excludeSelectors;
  if (options.purpose) body.purpose = options.purpose;

  try {
    const res = await fetch("https://api.fetch.tinyfish.ai", {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      debug("tinyfish", `fetch HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as TinyfishFetchResponseBody;
    debug(
      "tinyfish",
      `fetch returned ${data.results?.length ?? 0} results, ${data.errors?.length ?? 0} errors`,
    );
    return {
      results: data.results ?? [],
      errors: data.errors ?? [],
    };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    debug("tinyfish", `fetch error: ${msg}`);
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
