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

| Tool             | Description                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aio-websearch`  | Search the web using DuckDuckGo, Brave, and Google in parallel (no API keys required). Returns compact results with title, URL, and snippet. 7s cap — returns whatever is ready. Google runs via headless Chrome CDP (auto-launched). 10-minute cache. |
| `aio-webfetch`   | Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Long content is **AI-summarized** via Google AI Mode; full file always saved. Detects PDFs, GitHub repos, and Next.js RSC.                             |
| `aio-webcontent` | Retrieve previously fetched content from session storage by URL. Returns **full untruncated content** — no data loss.                                                                                                                                  |
| `aio-webpull`    | Pull any public website or docs site into local markdown files with anti-bot TLS fingerprinting. Discovers pages via sitemap, navigation links, or crawling.                                                                                           |

### Tool Parameters

#### `aio-websearch`

| Parameter | Type      | Default | Description                                                                       |
| --------- | --------- | ------- | --------------------------------------------------------------------------------- |
| `query`   | `string`  | —       | Search query (e.g. 'React Server Components RFC')                                 |
| `max`     | `number`  | `10`    | Max results to return per engine                                                  |
| `google`  | `boolean` | `true`  | Also search Google via headless Chrome CDP. Set to `false` to use only DDG/Brave. |

#### `aio-webfetch`

| Parameter | Type       | Default      | Description                                                                                                                       |
| --------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | `string`   | —            | Single URL to fetch. Use either `url` or `urls`, not both.                                                                        |
| `urls`    | `string[]` | —            | Multiple URLs to fetch in parallel. Use either `url` or `urls`, not both.                                                         |
| `out`     | `string`   | auto-derived | Output file path under temp (for single url only)                                                                                 |
| `browser` | `string`   | latest       | Browser profile for TLS fingerprinting. Auto-selects latest Chrome. Options: `chrome_145`, `firefox_147`, `safari_26`, `edge_145` |
| `os`      | `string`   | `windows`    | OS profile for fingerprinting. Options: `windows`, `macos`, `linux`, `android`, `ios`                                             |
| `proxy`   | `string`   | —            | Proxy URL (`http://user:pass@host:port` or `socks5://host:port`). Supports HTTP, HTTPS, SOCKS5.                                   |

#### `aio-webcontent`

| Parameter | Type     | Default | Description                       |
| --------- | -------- | ------- | --------------------------------- |
| `url`     | `string` | —       | URL of previously fetched content |

#### `aio-webpull`

| Parameter | Type     | Default      | Description                                                                                                                       |
| --------- | -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | `string` | —            | URL to pull (e.g. https://docs.example.com)                                                                                       |
| `out`     | `string` | `<hostname>` | Output directory under temp                                                                                                       |
| `max`     | `number` | `100`        | Max pages to pull                                                                                                                 |
| `browser` | `string` | latest       | Browser profile for TLS fingerprinting. Auto-selects latest Chrome. Options: `chrome_145`, `firefox_147`, `safari_26`, `edge_145` |
| `os`      | `string` | `windows`    | OS profile for fingerprinting. Options: `windows`, `macos`, `linux`, `android`, `ios`                                             |
| `proxy`   | `string` | —            | Proxy URL (`http://user:pass@host:port` or `socks5://host:port`). Supports HTTP, HTTPS, SOCKS5.                                   |

## Features

### Fetching & Extraction

- **Anti-bot TLS fingerprinting** — `wreq-js` with dynamic browser profiles (auto-selects latest Chrome, with fallbacks to `firefox_147`, `safari_26`, `edge_145`)
- **Bot-protection fallback** — Detects Cloudflare/Anubis/etc and cycles through alternate browser profiles
- **Playwright fallback** — If `wreq-js` fails, dynamically imports Playwright to render JS-heavy pages via system Chrome (zero-config, optional dependency)
- **Smart retry logic** — Exponential backoff (1s → 2s) for `429/500/502/503/504` and transient network errors (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`). Non-retryable (`400/401/403/404`) fail fast.
- **HTTP→HTTPS auto-upgrade** — Normalizes `http://` requests and responses
- **Cross-host redirect detection** — Surfaces a warning notice when a fetch redirects to a different domain
- **GitHub-aware fetch** — Detects repos, trees, blobs; clones repos or uses API
- **PDF extraction** — Extracts text from PDFs (`pdf-parse`)
- **RSC extraction** — Extracts Next.js React Server Components flight data
- **JSON auto-detection** — Detects `application/json` content-type or body starting with `{`/`[`, returns pretty-printed in ` ```json `` ` block
- **Plain text handling** — Detects `text/plain`, wraps in code block (unless already markdown)
- **Binary download detection** — Detects null bytes or >30% non-ASCII in first 1KB, streams to `BASE_TEMP/downloads/` with filename from URL or Content-Disposition
- **Client-side meta redirect** — Follows `<meta http-equiv="refresh">` up to 5 hops recursively
- **Proxy support** — Routes all requests through HTTP, HTTPS, or SOCKS5 proxy
- **Structured error info** — Failed fetches include `errorCode`, `phase`, `retryable` flag, and `statusCode` for programmatic handling

### Content Extraction Pipeline

When fetching a page, pi-webaio tries the following backends **in order**, falling through until one returns clean content. At every stage, if the extracted content is <30 words, **alternate link fallback** scans the HTML `<head>` for `<link rel="alternate" type="application/json">` and re-fetches the alternate URL automatically.

1. **GitHub special-case** — Clones repos or fetches via GitHub API
2. **Binary download** — Detects non-text content before attempting text fetch (PDF by URL, then null-byte/ASCII heuristic)
3. **PDF** — Extracts text from PDF files (by URL or content-type)
4. **JSON** — Detects `application/json` content-type or body starting with `{`/`[`, pretty-prints in code block
5. **Plain text** — Wraps `.txt`, configs, logs in code block (unless already markdown)
6. **Client-side meta redirect** — Follows `<meta http-equiv="refresh">` up to 5 hops
7. **Jina AI Reader** (`r.jina.ai`) — Re-fetches via Jina's proxy. If <30 words → try alternate links
8. **Mozilla Readability** — Local article extraction. If <30 words → try alternate links
9. **Next.js RSC** — Extracts React Server Components flight data
10. **Defuddle** — Local HTML-to-markdown conversion (extractor comments stripped). If <30 words → try alternate links
11. **Fallback** — Bare-minimum title + text extraction. If <30 words → try alternate links

### Security & Safety

- **Secret scanning** — Blocks requests containing API keys, tokens, or passwords in URLs before they leave the machine
- **Prompt injection detection** — Categorizes and warns/redacts/tags suspicious content (instruction overrides, role injection, jailbreaks, system manipulation, encoding tricks, suspicious delimiters)

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

