![pi-webaio](banner.png)

# pi-webaio

All-in-one web access tools for [pi](https://pi.dev) with search, fetch, crawl, extraction, anti-bot TLS fingerprinting, and intelligent resilience.

## Installation

```bash
pi install npm:pi-webaio
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-webaio
```

## Tools

| Tool             | Description                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aio-websearch`  | Search the web using DuckDuckGo, Brave, and Google in parallel (no API keys required). Returns compact results with title, URL, and snippet. 7s cap — returns whatever is ready. Google runs via headless Chrome CDP (auto-launched). 10-minute cache.                  |
| `aio-webfetch`   | Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Long content is **AI-summarized** via Google AI Mode; full file always saved. Detects PDFs, GitHub repos, and Next.js RSC. Supports auto escalation.                    |
| `aio-webcontent` | Retrieve previously fetched content from session storage by URL. Returns **full untruncated content** — no data loss.                                                                                                                                                   |
| `aio-webmap`     | Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, and llms.txt without fetching content. Returns structured URL list.                                                                                                                       |
| `aio-webresult`  | Retrieve a previously fetched result by persistent response ID. Survives restarts. Shows recent results if ID not found.                                                                                                                                                |
| `aio-webpull`    | Pull any public website or docs site into local markdown files with anti-bot TLS fingerprinting. Discovers pages via sitemap, navigation links, or crawling. Rewrites internal links to relative `.md` paths. Supports auto escalation and context package compilation. |

### Tool Parameters

#### `aio-websearch`

| Parameter | Type      | Default | Description                                                                       |
| --------- | --------- | ------- | --------------------------------------------------------------------------------- |
| `query`   | `string`  | —       | Search query (e.g. 'React Server Components RFC')                                 |
| `max`     | `number`  | `10`    | Max results per engine. Up to 25 total after dedup across all engines.            |
| `google`  | `boolean` | `true`  | Also search Google via headless Chrome CDP. Set to `false` to use only DDG/Brave. |

#### `aio-webfetch`

| Parameter         | Type       | Default      | Description                                                                                                                       |
| ----------------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `string`   | —            | Single URL to fetch. Use either `url` or `urls`, not both.                                                                        |
| `urls`            | `string[]` | —            | Multiple URLs to fetch in parallel. Use either `url` or `urls`, not both.                                                         |
| `out`             | `string`   | auto-derived | Output file path under temp (for single url only)                                                                                 |
| `mode`            | `string`   | `auto`       | Scrape mode: `auto` (escalates), `fast`, `fingerprint`, or `browser`                                                              |
| `browser`         | `string`   | latest       | Browser profile for TLS fingerprinting. Auto-selects latest Chrome. Options: `chrome_145`, `firefox_147`, `safari_26`, `edge_145` |
| `os`              | `string`   | `windows`    | OS profile for fingerprinting. Options: `windows`, `macos`, `linux`, `android`, `ios`                                             |
| `proxy`           | `string`   | —            | Proxy URL (`http://user:pass@host:port` or `socks5://host:port`). Supports HTTP, HTTPS, SOCKS5.                                   |
| `cacheTtlSeconds` | `number`   | —            | Opt-in cache TTL in seconds. Omit for fresh fetches.                                                                              |
| `compile`         | `boolean`  | `false`      | Compile batch results into a single context package                                                                               |
| `prune`           | `number`   | —            | Prune markdown to token budget (e.g. 3000)                                                                                        |
| `interactive`     | `boolean`  | `false`      | Extract interactive elements as numbered refs                                                                                     |
| `start_index`     | `number`   | `0`          | Return content starting from this character index (0-based). Use with `max_length` for pagination.                                |
| `max_length`      | `number`   | unlimited    | Maximum characters to return. Use with `start_index` for pagination.                                                              |

#### `aio-webcontent`

| Parameter | Type     | Default | Description                       |
| --------- | -------- | ------- | --------------------------------- |
| `url`     | `string` | —       | URL of previously fetched content |

#### `aio-webmap`

| Parameter | Type     | Default   | Description                            |
| --------- | -------- | --------- | -------------------------------------- |
| `url`     | `string` | —         | URL to discover pages for              |
| `max`     | `number` | `100`     | Max URLs to discover                   |
| `browser` | `string` | latest    | Browser profile for TLS fingerprinting |
| `os`      | `string` | `windows` | OS profile for fingerprinting          |

#### `aio-webresult`

| Parameter | Type     | Default | Description                               |
| --------- | -------- | ------- | ----------------------------------------- |
| `id`      | `string` | —       | Response ID from a previous webfetch call |

#### `aio-webpull`

| Parameter | Type      | Default      | Description                                                                                                                       |
| --------- | --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | `string`  | —            | URL to pull (e.g. https://docs.example.com)                                                                                       |
| `out`     | `string`  | `<hostname>` | Output directory under temp                                                                                                       |
| `max`     | `number`  | `100`        | Max pages to pull                                                                                                                 |
| `mode`    | `string`  | `auto`       | Scrape mode: `auto` (escalates), `fast`, `fingerprint`, or `browser`                                                              |
| `browser` | `string`  | latest       | Browser profile for TLS fingerprinting. Auto-selects latest Chrome. Options: `chrome_145`, `firefox_147`, `safari_26`, `edge_145` |
| `os`      | `string`  | `windows`    | OS profile for fingerprinting. Options: `windows`, `macos`, `linux`, `android`, `ios`                                             |
| `proxy`   | `string`  | —            | Proxy URL (`http://user:pass@host:port` or `socks5://host:port`). Supports HTTP, HTTPS, SOCKS5.                                   |
| `compile` | `boolean` | `false`      | Compile pulled pages into a single context package                                                                                |

## Features

### Fetching & Extraction

- **Anti-bot TLS fingerprinting** — `wreq-js` with dynamic browser profiles (auto-selects latest Chrome, with fallbacks to `firefox_147`, `safari_26`, `edge_145`)
- **Auto escalation pipeline** — `mode: "auto"` escalates from fast fetch → fingerprint rotation → Cloudflare UA bypass → Playwright rendering when bot protection is detected
- **Bot-block detection** — Structured detection of Cloudflare, Anubis, PerimeterX, DataDome, Incapsula, Akamai with confidence scoring and retry advice
- **Cloudflare challenge bypass** — Detects CF challenges via header + body markers, retries with alternate UA before falling through to fingerprint rotation
- **Playwright fallback** — If `wreq-js` fails, dynamically imports Playwright to render JS-heavy pages (zero-config, optional dependency)
- **Smart retry logic** — Exponential backoff (1s → 2s) for `429/500/502/503/504` and transient network errors. Non-retryable (`400/401/403/404`) fail fast.
- **Provider cooldown system** — Search engines (DDG, Brave, Google) track failures with TTL cooldowns (10min quota / 2min network). Skipped engines don't waste time.
- **HTTP→HTTPS auto-upgrade** — Normalizes `http://` requests and responses
- **Cross-host redirect detection** — Surfaces a warning notice when a fetch redirects to a different domain
- **GitHub-aware fetch** — Detects repos, trees, blobs; clones repos or uses API. Special handling for GitHub Actions run URLs — fetches job details, step-by-step status, and failed job log excerpts
- **Architecture detection** — Analyzes cloned repos for Docker, CI/CD platforms, test frameworks, monorepo tooling, package managers, and security signals
- **PDF extraction** — Extracts text from PDFs (`pdf-parse`)
- **RSC extraction** — Extracts Next.js React Server Components flight data
- **JSON auto-detection** — Detects `application/json` content-type or body starting with `{`/`[`, returns pretty-printed
- **Plain text handling** — Detects `text/plain`, wraps in code block (unless already markdown)
- **Binary download detection** — Detects null bytes or >30% non-ASCII, streams to temp with filename from Content-Disposition
- **Vertical extractors** — 6 API-first extractors for npm, PyPI, Hacker News, Reddit, arXiv, and docs sites — hit structured APIs instead of scraping HTML
- **SPA data-island recovery** — Extracts JSON hydration data from `<script>` tags and framework globals for JS-rendered pages
- **Client-side meta redirect** — Follows `<meta http-equiv="refresh">` up to 5 hops recursively
- **Proxy support** — Routes all requests through HTTP, HTTPS, or SOCKS5 proxy
- **Structured error info** — Failed fetches include `errorCode`, `phase`, `retryable` flag, and `statusCode`

### Content Extraction Pipeline

When fetching a page, pi-webaio tries the following backends **in order**, falling through until one returns clean content. HTML is **pre-cleaned** (nav/footer/header/svg/cookie consent banners removed via DOM) before entering the extraction pipeline. At every stage, if extracted content is <30 words or <1% of original HTML, the pipeline falls through to the next backend.

0. **Vertical extractors** — API-first: npm registry, PyPI JSON, Hacker News Firebase, Reddit .json, arXiv Atom, platform docs-sites
1. **GitHub special-case** — Clones repos or fetches via GitHub API
2. **Binary download** — Detects non-text content before attempting text fetch
3. **PDF** — Extracts text from PDF files (by URL or content-type)
4. **JSON** — Detects `application/json` content-type, pretty-prints in code block
5. **Plain text** — Wraps `.txt`, configs, logs in code block (unless already markdown)
6. **Client-side meta redirect** — Follows `<meta http-equiv="refresh">` up to 5 hops
7. **Cloudflare challenge bypass** — Detects CF 403, retries with OpenCode UA
8. **Jina AI Reader** (`r.jina.ai`) — Re-fetches via Jina's proxy
9. **Mozilla Readability** — Local article extraction. If <30 words or <1% of original → skip
10. **Next.js RSC** — Extracts React Server Components flight data
11. **SPA data-island recovery** — Extracts hydration JSON from `<script>` tags
12. **Defuddle** — Local HTML→markdown conversion (extractor comments stripped, whitespace normalized)
13. **Fallback** — Bare-minimum title + text extraction

Alternate link fallback: at every stage, if content is thin, `<link rel="alternate" type="application/json">` is tried.

### Security & Safety

- **DNS-based SSRF protection** — Resolves hostnames and validates all returned IPs against full RFC 1918/RFC 6598/RFC 3927 private ranges, blocks cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`)
- **Redirect-hop SSRF re-validation** — Validates every redirect target (up to 5 hops) — prevents `302 → internal IP` bypass attacks
- **IPv6 tunnel detection** — Blocks tunneled private IPv4 inside IPv6 addresses (::ffff, IPv4-compatible, 6to4, Teredo)
- **Content trust boundaries** — All fetched content wrapped in `[UNTRUSTED WEB CONTENT]` markers
- **Secret scanning** — Blocks requests containing API keys, tokens, or passwords in URLs
- **Prompt injection detection** — Categorizes and warns/redacts/tags suspicious content
- **Provider cooldown system** — Search engines track failures with TTL cooldowns to skip dead providers

### Metadata & Frontmatter

- **Rich YAML frontmatter** — Saved markdown files include `title`, `url`, `author`, `published`, `site`, `language`, and `word_count` in the frontmatter when available from extraction (Defuddle)
- **Stored in session cache** — Metadata is captured alongside content in the session store for retrieval via `aio-webcontent`

### Caching & Performance

- **Session cache** — 30-minute TTL, LRU eviction (max 100 entries). Keys normalized for consistency (`http://` → `https://`, root trailing slashes deduplicated).
- **Persistent disk cache** — On startup, all previously fetched `.md` files under `BASE_TEMP` are scanned and registered in the session store. Content is lazy-loaded from disk on first access — survives restarts.
- **Search cache** — 10-minute TTL, persisted to disk for cross-session reuse
- **Preview truncation** — `aio-webfetch` tool results show ~500 tokens in-context; **full file is always written to disk** for inspection via the `read` tool
- **Rate limiter** — Token-bucket per domain (5 req/s, burst 10) in `smartFetch`. All tools are throttled politely.

### AI-Powered Summarization

- **Google AI Mode (udm=50)** — Long fetched content is auto-summarized by Google AI via headless Chrome CDP (15s timeout). The AI reads the URL directly and returns a concise bullet-point summary.
- **Search context bridging** — When `aio-webfetch` follows a recent `aio-websearch` (within 5 min), the original query is injected into the summarization prompt for more focused summaries.
- **Graceful fallback** — If Google AI is unavailable (Chrome not installed, CDP files missing), falls back to truncation.

### Google CDP Search

- **Parallel search** — `aio-websearch` runs DuckDuckGo, Brave, and Google in parallel. Google uses a headless Chrome instance (auto-launched) with locale-agnostic `textarea[name="q"]` selectors.
- **7-second cap** — Returns whatever results are ready by the deadline. No waiting for slow engines.
- **Result deduplication** — Merges and deduplicates results across all engines by URL.

## Usage Examples

### Search the web

```
Use aio-websearch to find the latest React documentation
```

Google search is on by default (via headless Chrome). To skip it:

```
Use aio-websearch to search for "Rust serde" (google: false)
```

### Fetch a single URL

```
Use aio-webfetch to download https://example.com/article
```

After fetching, use the built-in `read` tool to inspect the full saved file.

### Fetch multiple URLs in batch

```
Use aio-webfetch to download these URLs:
  - https://example.com/page1
  - https://example.com/page2
  - https://example.com/page3
```

### Fetch with a specific browser fingerprint

```
Use aio-webfetch to download https://example.com (browser: "firefox_147", os: "linux")
```

### Retrieve stored content (no re-download)

```
Use aio-webcontent to get the full content from https://example.com/article
```

### Pull an entire site

```
Use aio-webpull to download https://docs.example.com (max: 50 pages)
```

### Pull a site with custom fingerprint

```
Use aio-webpull to download https://docs.example.com (max: 50, browser: "edge_145", os: "macos")
```

## License

MIT
