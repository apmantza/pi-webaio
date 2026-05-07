# pi-webaio — Agent Context

## What is this?

pi-webaio is an **all-in-one web tools extension** for [pi](https://pi.dev) (the coding agent) that provides search, fetch, crawl, and extraction capabilities via 4 tools: `aio-websearch`, `aio-webfetch`, `aio-webcontent`, and `aio-webpull`. It's published as `npm:pi-webaio` and installable via `pi install npm:pi-webaio`.

## Architecture

```
pi-webaio/
├── index.ts                  ← Main extension entry point. Registers 4 pi tools.
├── src/
│   ├── google-ai.ts          ← TypeScript wrapper — spawns CDP child processes
│   └── search/               ← CDP infrastructure (used by bin/extractors)
│       ├── constants.mjs
│       ├── chrome.mjs
│       └── engines.mjs
├── bin/
│   ├── cdp.mjs               ← Chrome DevTools Protocol bridge
│   └── launch.mjs            ← Chrome process lifecycle manager
├── extractors/
│   ├── common.mjs            ← Shared CDP helpers
│   ├── consent.mjs           ← Google consent dialog handler
│   ├── google-ai.mjs         ← Google AI Mode (udm=50) search
│   ├── google-search.mjs     ← Standard Google search via CDP
│   ├── selectors.mjs         ← DOM selectors for Google's UI
│   └── gemini.mjs            ← (legacy) Gemini AI extractor
├── types/
│   ├── pi-coding-agent.d.ts  ← Minimal ExtensionAPI type declaration
│   └── playwright.d.ts       ← Playwright type stub (optional dep)
├── tests/
│   ├── unit.test.mjs         ← 76+ unit tests (parsers, sitemap, discovery)
│   ├── integration.test.mjs  ← Integration tests
│   └── lib.mjs               ← Test helpers and fixtures
├── tsconfig.json
├── package.json              ← type: "module", pi extension manifest
└── README.md
```

## The 4 Tools

### 1. `aio-websearch`

- Searches DuckDuckGo, Brave, and Google in parallel
- Google uses headless Chrome via CDP (auto-launched)
- 7-second cap — returns whatever is ready
- 10-minute cache (persisted to disk)
- Parameters: `query` (string), `max` (number, default 10), `google` (boolean, default true)
- Returns deduplicated results with title, URL, snippet
- Google can be skipped with `google: false`

### 2. `aio-webfetch`

- Fetches single URL or batch of URLs, converts to markdown
- Anti-bot TLS fingerprinting via `wreq-js` (chrome_145, firefox_147, safari_26, edge_145)
- **Extraction pipeline** (tries in order, falls through):
  1. GitHub special-case (clone or API for repos/trees/blobs)
  2. Binary download detection (PDF by URL, null-byte/ASCII heuristic)
  3. PDF text extraction
  4. JSON detection → pretty-printed code block
  5. Plain text → code block (unless already markdown)
  6. Client-side `<meta http-equiv="refresh">` redirects
  7. Jina AI Reader proxy (`r.jina.ai`)
  8. Mozilla Readability
  9. Next.js RSC (React Server Components) extraction
  10. Defuddle HTML-to-markdown (extractor comments stripped)
  11. Fallback: bare-minimum title + text extraction
- **AI summarization** via Google AI Mode (udm=50) using headless Chrome
- Long content auto-summarized by Google AI; full content always saved to file
- Search context bridging: recent websearch query injected into summarization prompt
- Bot protection fallback cycles through alternate browser profiles
- Secret scanning blocks URLs with API keys/tokens
- Prompt injection detection (warn/redact/tag)

### 3. `aio-webcontent`

- Retrieves previously fetched content from session storage by URL
- Returns **full untruncated content** — no data loss
- Survives restarts (disk cache, lazy-loaded)
- Parameters: `url` (string)

### 4. `aio-webpull`

- Pulls entire websites into local markdown files
- Discovers pages via sitemap, navigation links, or crawling
- Writes files preserving URL structure with YAML frontmatter
- Parameters: `url`, `out` (optional output dir), `max` (default 100), `browser`, `os`, `proxy`
- Concurrent workers (4 × CPU cores)

## Key Technical Details

### Fetch Stack

| Layer               | Package                       | Role                                                  |
| ------------------- | ----------------------------- | ----------------------------------------------------- |
| Primary fetch       | `wreq-js` ^2.3.0              | Anti-bot TLS fingerprinting, dynamic browser profiles |
| JS rendering        | `playwright` (optional)       | Fallback when wreq fails                              |
| DOM parsing         | `linkedom` ^0.18.12           | Lightweight HTML parser (no jsdom)                    |
| Article extraction  | `@mozilla/readability` ^0.6.0 | Local article → text                                  |
| Markdown conversion | `defuddle` ^0.18.1            | HTML → markdown (extractor comments stripped)         |
| PDF                 | `pdf-parse` ^2.4.5            | Text extraction from PDFs                             |
| Image processing    | `sharp` ^0.34.5               | Image ops (resize, format conversion)                 |

### Caching

- **Session cache**: 30-min TTL, LRU (max 100 entries), normalized keys (http→https, trailing slash)
- **Disk cache**: Persisted to `os.tmpdir()/pi-webaio/` — survives restarts
- **Search cache**: 10-min TTL, persisted to disk
- **Rate limiter**: Token-bucket per domain (5 req/s, burst 10) in `smartFetch`

### Security

- **Secret scanning**: Blocks URLs containing API keys, tokens, passwords before outbound request
- **Prompt injection**: Categorizes and warns/redacts/tags suspicious content (instruction overrides, role injection, jailbreaks, system manipulation, encoding tricks)
- **Local URL blocking**: Prevents fetching localhost, 127.0.0.1, private IPs
- **HTTP→HTTPS auto-upgrade**

### Rate Limiting & Retries

- Token-bucket per domain (5 req/s, burst 10)
- Exponential backoff (1s → 2s) for 429/500/502/503/504
- 400/401/403/404 fail fast
- Max 2 retries per request

### Extension API (pi)

- Entry point: `index.ts` (TypeScript, loaded by pi via jiti)
- Package manifest: `package.json` → `pi.extensions: ["./index.ts"]`
- Uses `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`
- Tools registered via `pi.registerTool()` with typebox parameter schemas
- Type augmentations in `types/pi-coding-agent.d.ts`

## Recent Changes

### pi Scope Migration (v0.2.0)

- Pi moved from `@mariozechner/pi-*` to `@earendil-works/pi-*` package scope (pi 0.73.1+)
- Extension imports updated accordingly
- Pi 0.73.1 also changed to upstream `jiti` 2.7 (internal — transparent to extensions)

### v0.2.0 Changes

- Smart content-type auto-detection (JSON, plain text, binary, meta redirects)
- Alternate link fallback (<link rel="alternate" type="application/json">)
- Persistent disk cache for session store
- Token-bucket rate limiter per domain
- Proxy support (HTTP, HTTPS, SOCKS5)
- Search context bridging for focused AI summaries
- Fixed Brave search (regex-based parsing, no Svelte-scoped CSS)
- Fixed `gh` CLI ESM import bug

## Testing

- `npm test` → runs unit tests
- `npm run test:integration` → runs integration tests
- `npm run test:all` → runs both
- Tests use `node` directly (no test runner dependency)
- Playwright tests gracefully handle both installed/uninstalled

## Dependencies

- **Runtime**: `@mozilla/readability`, `defuddle`, `linkedom`, `pdf-parse`, `sharp`, `wreq-js`
- **Peer**: `@earendil-works/pi-coding-agent`, `typebox`
- **Optional**: `playwright`
- **Dev**: `typescript`, `@types/node`

## CI/CD

- GitHub Actions: lint, test, tarball verification
- GitHub Releases for npm publishing
