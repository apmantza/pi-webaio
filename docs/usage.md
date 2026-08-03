<!-- markdownlint-disable MD013 MD024 MD060 -->

# Usage Guide

Common ways to use pi-webaio from inside pi.

## Examples

### Search the web

```
Use aio-websearch to find the latest React documentation
```

Google search is on by default (via headless Chrome CDP). Reddit is also an automatic CDP companion when Chrome is available. To skip Google (without disabling Reddit):

```
Use aio-websearch to search for "Rust serde" (google: false)
```

Scout URLs with minimal tokens — one line per result, no snippet:

```
Use aio-websearch to find the Vite docs (compact: true)
```

### Fetch a single URL

```
Use aio-webfetch to download https://example.com/article
```

After fetching, use the built-in `read` tool to inspect the full saved file.

### See a page's shape before reading it (outline mode)

```
Use aio-webfetch to download https://expressjs.com/en/guide/routing.html (outline: true)
```

Returns only a ~50-token heading outline (total + per-section word counts). The full content is still saved + cached — then fetch just the section you want with `query`, or the whole page with `aio-webcontent`.

### Get a focused answer from one page

```
Use aio-webfetch to download https://example.com/long-article (query: "how does auth work")
```

Returns only the top-k BM25-ranked chunks that answer the query, with heading breadcrumbs. Full content stays cached.

### Get a cited answer from several pages at once

```
Use aio-webfetch to download these URLs (query: "migration safety"):
  - https://example.com/docs/migrations
  - https://example.com/blog/schema-changes
  - https://example.com/guide/rollback
```

Fetches all URLs, ranks chunks across them, and returns the top-k most relevant chunks each cited with its source URL + heading + score — verbatim supporting text, not a generated answer.

### Fetch multiple URLs in batch

```
Use aio-webfetch to download these URLs:
  - https://example.com/page1
  - https://example.com/page2
  - https://example.com/page3
```

### Fetch as JSON for structured downstream processing

```
Use aio-webfetch to download https://api.github.com/repos/apmantza/pi-webaio (format: "json")
```

Returns a structured JSON object with `url`, `title`, `author`, `published`, `site`, `language`, `wordCount`, `content`, `rawHtml`. Useful for piping into other tools.

### Fetch with RAG chunking

```
Use aio-webfetch to download https://en.wikipedia.org/wiki/Node.js (chunks: true, maxTokens: 512)
```

Splits the markdown into paragraph-bounded chunks with 50-token overlap. Result includes both the markdown and a `chunks` array.

### Fetch a GitHub Actions run log

```
Use aio-webfetch to download https://api.github.com/repos/apmantza/pi-drykiss/actions/runs/27479618304/logs
```

Routes through `gh run view --log` (uses your existing `gh auth login` session) to get plain-text logs with auth + 302-redirect handling. No more HTTP 403.

### Fetch with a specific browser fingerprint

```
Use aio-webfetch to download https://example.com (browser: "firefox_147", os: "linux")
```

### Retrieve stored content (no re-download)

```
Use aio-webcontent to get the full content from https://example.com/article
```

See what changed since the last fetch (section-level diff):

```
Use aio-webcontent to diff https://example.com/article (diff: true)
```

### Pull an entire site

```
Use aio-webpull to download https://docs.example.com (max: 50 pages)
```

### Pull with URL pattern routing

```
Use aio-webpull to download https://example.com with routes:
  - { pattern: "*/api/*", mode: "fast" }
  - { pattern: "*/docs/*", mode: "browser" }
```

Routes different URL patterns to different fetcher modes. First match wins.

### Pull with resume from checkpoint

```
Use aio-webpull to download https://docs.example.com (resume: true)
```

Skips pages that were already pulled (checks for existing `.md` files in the output directory).

### Bypass a paywall (single URL)

```
Use aio-webfetch to download https://www.nytimes.com/2024/01/01/some-article (bypass: true)
```

If the normal fetch hits a paywall, pi-webaio tries `archive` → `ua:googlebot` → `ua:bingbot` → `ua:facebookbot` → `referer:google` → `block_js` → `cookies` in order, returning the first response that doesn't contain paywall markers.

### Bypass with a custom strategy chain

```
Use aio-webfetch to download https://example.com/paywalled (bypass: true, bypassStrategies: ["archive", "ua:googlebot"])
```

Only tries Wayback Machine and Googlebot impersonation. Useful when you know a site only responds to specific strategies.

### Bypass on a whole pull (every page)

```
Use aio-webpull to download https://www.ft.com (max: 50, bypass: true)
```

Applies the per-domain strategy chain to every page in the pull. NYT pages use `block_js → archive`; FT pages use `block_js → archive`; unknown sites fall through to the generic chain.
