# pi-webaio — Agent Context

## What is this?

pi-webaio is an **all-in-one web tools extension** for [pi](https://pi.dev) (the coding agent) that provides search, fetch, crawl, extraction, discovery, storage, compilation, RAG chunking, phase-aware error handling, TUI rendering, and (v0.4.1+) opt-in paywall bypass capabilities via 6 tools: `aio-websearch`, `aio-webfetch`, `aio-webcontent`, `aio-webpull`, `aio-webmap`, and `aio-webresult`. It's published as `npm:pi-webaio` and installable via `pi install npm:pi-webaio`.

**Current version: 0.6.0** — GitHub repo mapping for `aio-webmap`, GitHub security alert handler (Dependabot / code-scanning / secret-scanning via REST API), Reddit network-block detection, vertical `ok:false` propagation, Node 24 `--experimental-strip-types` test runner (36× faster), `@earendil-works/pi-coding-agent ^0.79.0` (closes 6 of 9 Dependabot alerts).

## Architecture

```
pi-webaio/
├── index.ts                  ← Main extension entry point. Registers 6 pi tools.
├── src/
│   ├── google-ai.ts          ← TypeScript wrapper — spawns CDP child processes
│   ├── bot-detection.ts      ← Structured bot-block detection (Cloudflare, Anubis, etc.)
│   ├── data-islands.ts       ← SPA hydration data recovery from <script> JSON
│   ├── storage.ts            ← Persistent result storage with response IDs (JSON + blobs)
│   ├── context-package.ts    ← Compile multiple pages into a single Markdown package
│   ├── request-queue.ts      ← Persistent disk-backed queue with checkpoint/resume
│   ├── browser-pool.ts       ← Reusable Playwright browser instance pool
│   ├── session-router.ts     ← Multi-fetcher URL routing (pattern → mode/extractor)
│   ├── adaptive-selector.ts  ← Structural DOM fingerprinting for element relocation
│   ├── paywall.ts            ← Paywall bypass engine — detection, strategy chain, bot UA fetch, archive.org fetch, Playwright block_js (v0.4.1)
│   ├── paywall-sites.ts      ← Top-50+ paywall site strategy catalog (v0.4.1)
│   ├── chunker.ts            ← RAG chunking — paragraph-bounded markdown chunks with optional overlap (v0.5.0)
│   ├── github-map.ts         ← GitHub-native discovery for aio-webmap (recursive tree API + feature URLs + README + architecture) (v0.5.1)
│   ├── fetch-jina.ts         ← Jina AI Reader proxy fallback
│   ├── html-compress.ts      ← HTML noise attribute stripping
│   ├── injection.ts          ← Prompt injection detection + action (warn/redact/block)
│   ├── interactive-elements.ts ← Extract buttons/links/forms as numbered refs
│   ├── prune-markdown.ts     ← Score-based markdown pruning to token budget
│   ├── security.ts           ← SSRF guard (isDangerousUrl) + secret scanner
│   ├── session-store.ts      ← Content cache + search context store (disk-backed)
│   ├── token-count.ts        ← CJK-aware token estimation
│   ├── content.ts            ← Extraction pipeline (vertical → GitHub → binary → JSON → RSC → defuddle → fallback)
│   ├── github-pipeline.ts    ← Full GitHub URL handling (repo/tree/blob/issue/PR/actions run/actions logs/check log)
│   ├── github-api.ts         ← REST + gh CLI fallback (ghFetch, ghRunLogs, ghApiCall, ghFetchWithFallback)
│   ├── fetch.ts              ← smartFetch, fetchBuffer, fetchWithPlaywright, withTimeout, rate limiter
│   ├── types.ts              ← Shared types (PullResult, FetchOpts, FetchErrorInfo, ScrapeMode)
│   ├── verticals/            ← 19 API-first extractors for known sites
│   │   ├── registry.ts       ← Pattern-matching registry (19 extractors)
│   │   ├── types.ts          ← Shared types
│   │   ├── npm.ts            ← npm registry API
│   │   ├── pypi.ts           ← PyPI JSON API
│   │   ├── hackernews.ts     ← Hacker News Firebase API
│   │   ├── reddit.ts         ← Reddit .json endpoint
│   │   ├── arxiv.ts          ← arXiv Atom export API
│   │   ├── youtube.ts        ← YouTube transcript + metadata
│   │   ├── docs-site.ts      ← Docusaurus, GitBook, MDN, VitePress extraction
│   │   ├── wikipedia.ts      ← Wikipedia REST API
│   │   ├── stackexchange.ts  ← Stack Exchange API v2.3
│   │   ├── openlibrary.ts    ← Open Library covers API
│   │   ├── devto.ts          ← DEV.to API
│   │   ├── sonarcloud.ts     ← SonarCloud API
│   │   ├── cratesio.ts       ← crates.io API
│   │   ├── rubygems.ts       ← RubyGems API
│   │   ├── packagist.ts      ← Packagist API
│   │   ├── pubdev.ts         ← pub.dev API
│   │   ├── gopackages.ts     ← Go module proxy
│   │   ├── nuget.ts          ← NuGet Search API v3
│   │   └── gitlab.ts         ← GitLab REST API v4
│   ├── search/               ← CDP infrastructure (used by bin/extractors)
│   │   ├── constants.mjs
│   │   ├── chrome.mjs
│   │   └── engines.mjs
│   └── tools/                ← Tool handlers
│       ├── render-result.ts  ← TUI components (call/progress/result), markdownToText, applyFormat (v0.5.0)
│       ├── fetch-error.ts    ← Phase-aware FetchError (25 codes × 10 phases × 7 categories) (v0.5.0)
│       ├── utils.ts          ← Shared helpers: frontmatter, runInBatches, safeResolveInBaseTemp
│       ├── webfetch.ts       ← aio-webfetch registration + execute
│       ├── webcontent.ts     ← aio-webcontent registration
│       ├── webresult.ts      ← aio-webresult registration
│       ├── websearch.ts      ← aio-websearch registration
│       ├── webmap.ts         ← aio-webmap registration
│       └── webpull.ts        ← aio-webpull registration
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
├── scripts/
│   └── check-lockfile-sync.mjs ← Fails CI if package-lock.json drifts from package.json
├── types/
│   ├── pi-coding-agent.d.ts  ← Minimal ExtensionAPI type declaration
│   └── playwright.d.ts       ← Playwright type stub (optional dep)
├── tests/
│   ├── unit.test.mjs         ← 145 unit tests (parsers, sitemap, discovery, caching)
│   ├── new-features.test.mjs ← 31 unit tests (queue, router, adaptive selector, pool)
│   ├── paywall.test.mjs      ← 65 unit tests (paywall detection, strategy chain, text stripping, site DB, DOM override)
│   ├── github-check.test.mjs ← 26 unit tests (check log URL parsing, step filter, gh CLI helpers, Actions run logs)
│   ├── render-result.test.mjs ← 39 unit tests (TUI components, progress, result, call)
│   ├── fetch-error.test.mjs  ← 50 unit tests (FetchError system, classifyError, user-facing summaries)
│   ├── fetch-progress.test.mjs ← 6 unit tests (streaming body byte counting, size cap)
│   ├── hardening.test.mjs    ← 16 unit tests (path traversal guard, withTimeout, secret patterns)
│   ├── format.test.mjs       ← 18 unit tests (markdownToText, applyFormat, format param)
│   ├── webfetch-summary.test.mjs ← 10 unit tests (buildDeterministicSummary)
│   ├── chunker.test.mjs      ← 31 unit tests (RAG chunking)
│   ├── github-map.test.mjs   ← 50 unit tests (URL parsing, tree rendering, architecture detection, path filtering, repo map) (v0.5.1)
│   ├── webfetch-format-bug.test.mjs ← regression test for non-markdown readFile bug
│   ├── integration.test.mjs  ← Integration tests
│   └── lib.mjs               ← Test helpers and fixtures
├── tsconfig.json             ← Lint config (noEmit, strict, ES2022)
├── tsconfig.dist.json        ← Build config (emits to dist/, includes types/**/*.d.ts)
├── package.json              ← type: "module", pi extension manifest, v0.5.0
└── README.md
```

## The 6 Tools

### 1. `aio-websearch`

- Searches DuckDuckGo, Brave, Yahoo, Bing, and Google in parallel (5 engines)
- Google uses headless Chrome via CDP (auto-launched)
- 7-second cap — returns whatever is ready
- 10-minute cache (persisted to disk)
- Parameters: `query` (string), `max` (number, default 15), `google` (boolean, default true)
- Returns deduplicated results with title, URL, snippet, domain, sources
- TUI: polished call/progress/result rendering with engine counts and per-result expand
- Google can be skipped with `google: false`

### 2. `aio-webfetch`

- Fetches single URL or batch of URLs, converts to markdown
- Anti-bot TLS fingerprinting via `wreq-js` (chrome_145, firefox_147, safari_26, edge_145)
- **`format` parameter** (v0.5.0): `markdown` (default, saves to disk) | `html` | `text` | `json` | `raw` (all in-memory)
- **`chunks` parameter** (v0.5.0): RAG chunking. Splits markdown into paragraph-bounded chunks with `maxTokens` (default 512) and `overlapTokens` (default 50). Only applies to `format: "markdown"`.
- **TUI rendering** (v0.5.0): custom `renderCall` / `renderResult` components with progress, elapsed time, phase/category badges, retry hints
- **Phase-aware FetchError** (v0.5.0): 25 codes × 10 phases × 7 categories with downloadedBytes, elapsedMs, contentLength for smart retry timeout suggestions
- **Pre-flight secret scan** (v0.5.0): blocks URLs with API keys/tokens before any fetch — returns clear "Request blocked: potential secret(s) detected in URL (GitHub PAT (classic), ...)" instead of generic "Could not reach server"
- **Extraction pipeline** (tries in order, falls through):
  1. Vertical extractors (19 patterns: npm, PyPI, etc.)
  2. GitHub special-case (clone or API for repos/trees/blobs/issues/PRs/actions runs/actions logs/check logs)
  3. `api.github.com/repos/{owner}/{repo}/actions/runs/{runId}/logs` (v0.5.0 — via gh CLI)
  4. Binary download detection (PDF by URL, null-byte/ASCII heuristic)
  5. PDF text extraction
  6. JSON detection → pretty-printed code block
  7. Plain text → code block (unless already markdown)
  8. Client-side `<meta http-equiv="refresh">` redirects
  9. Jina AI Reader proxy (`r.jina.ai`)
  10. Mozilla Readability
  11. Next.js RSC (React Server Components) extraction
  12. Defuddle HTML-to-markdown (extractor comments stripped)
  13. Fallback: bare-minimum title + text extraction
- **AI summarization** via Google AI Mode (udm=50) using headless Chrome
- Long content auto-summarized by Google AI; full content always saved to file
- Search context bridging: recent websearch query injected into summarization prompt
- Bot protection fallback cycles through alternate browser profiles
- Secret scanning blocks URLs with API keys/tokens
- Prompt injection detection (warn/redact/tag)
- **Opt-in paywall bypass** (v0.4.1) — `bypass: true` runs a strategy chain (`archive` → bot UAs → `block_js` → `cookies`) after `detectPaywall()` finds paywall markers (confidence ≥ 0.45). `bypassStrategies: [...]` lets you override the chain order. Set `PI_WEBAIO_DEBUG=1` to log every attempt.

### 3. `aio-webcontent`

- Retrieves previously fetched content from session storage by URL
- Returns **full untruncated content** — no data loss
- Survives restarts (disk cache, lazy-loaded)
- Parameters: `url` (string)

### 4. `aio-webpull`

- Pulls entire websites into local markdown files
- Discovers pages via sitemap, navigation links, or crawling
- Writes files preserving URL structure with YAML frontmatter
- Concurrent workers (4 × CPU cores)
- Parameters: `url`, `out`, `max` (default 100), `mode`, `browser`, `os`, `proxy`, `compile`, `bypass`
- **Request queue**: persistent checkpoint/resume via `resume` param (default: auto-detect). Survives crashes and resumes mid-pull from last checkpoint.
- **Session router**: route different URL patterns to different fetcher modes/extractors via `routes` param. Supports substring, glob (`*/docs/*`), and regex (`/^\/api\//`) patterns. First match wins.
- **Browser pool**: when mode is `browser` or `auto`, Playwright instances are pooled and reused across pages (saves ~2-3s overhead per page). Auto-recycles after 50 navigations.
- **Adaptive selectors**: `adaptive` flag enables structural fingerprinting — remembers element position to survive site redesigns.
- **Opt-in paywall bypass** (v0.4.1) — `bypass: true` runs the per-domain strategy chain on every page in the pull. Curated top-50 sites (NYT, WSJ, FT, etc.) get tuned strategies; unknown sites use the generic chain (`archive` → `ua:googlebot` → `block_js`).
- Parameters: `resume`, `routes`, `adaptive` (v0.4.0+), `bypass` (v0.4.1+)

### 5. `aio-webmap`

- Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, llms.txt
- Returns structured URLs grouped by source without fetching content
- **GitHub-native (v0.5.1)**: when given a GitHub URL, returns a proper repo map — file tree, architecture signals, feature URLs (issues, PRs, releases, tags, branches), and a README excerpt. Uses the recursive Git Trees API (`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`) for the file tree, with `gh repo clone` / `git clone` as fallback for truncated trees. Inspired by [ahmedkhaleel2004/gitdiagram](https://github.com/ahmedkhaleel2004/gitdiagram).
- **URL shapes handled**:
  - Repo URL (`https://github.com/owner/repo`) → full repo map
  - Tree URL (`https://github.com/owner/repo/tree/branch/path`) → directory contents
  - Feature URL (`/issues`, `/pulls`, `/releases`, `/tags`, `/actions`, `/branches`) → numbered list of items
  - Blob URL (`/blob/branch/path`) → single file URL
  - Non-GitHub URL → sitemap/nav/crawl as before
- Parameters: `url`, `max` (default 100), `browser`, `os`
- Returns `details.sources` (grouped URLs), `details.repo` (metadata), `details.treeMarkdown`, `details.architecture`

### 6. `aio-webresult`

- Retrieves previously fetched results by response ID
- Durable storage with 24h TTL (JSON index + content blobs in os.tmpdir())
- Parameters: `id` (string) — response ID from a previous webfetch call
- Shows recent results if the requested ID is not found

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
| TUI components      | `@earendil-works/pi-tui`      | Markdown + text rendering (peer of pi)                |

### Build & Distribution (v0.5.0)

- **Precompiled `dist/`**: `tsconfig.dist.json` emits `index.ts` + `src/**/*.ts` to `dist/`. `package.json` `main` and `pi.extensions` point to `./dist/index.js`. `files` ships `dist/` instead of `src/`.
- **`prepare` hook**: runs `npm run build:dist` on `npm install`, so users get a prebuilt extension without needing to compile.
- **No more jiti transpile**: the previous setup loaded `.ts` source through jiti on every startup. Now pi loads the compiled `dist/index.js` directly. ~100-300ms faster cold start.
- **Scripts**: `build`, `build:dist`, `prepare`, `lint` (`tsc --noEmit`), `watch`, `check:lockfile`.

### New Modules (v0.5.0)

| Module                          | Role                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/chunker.ts`                | RAG chunking. `chunkMarkdown(md, { maxTokens, overlapTokens })` returns `Chunk[]`. `formatChunksText()` renders numbered chunks. CJK-aware token estimation. 31 unit tests. |
| `src/tools/render-result.ts`   | TUI components. `createCallComponent()`, `createProgressComponent()` (real-time spinner + elapsed time + per-item status), `createResultComponent()` (expanded preview with responseId, format, browser/os, package path, chunk count, error details). `applyFormat()` handles markdown/html/text/json/raw output. `markdownToText()` for TUI display. 411 LOC, 39 unit tests. |
| `src/tools/fetch-error.ts`     | Phase-aware FetchError system. 25 failure codes × 10 fetch phases × 7 categories. `createFetchError()` produces frozen rich error objects. `classifyError()` maps Node errors. `buildUserFacingFetchErrorSummary()` produces agent-friendly messages. `suggestRetryTimeoutMs()` extrapolates from partial download. `toFetchErrorInfo()` / `fetchErrorInfoFromUnknown()` bridge to legacy FetchErrorInfo. 564 LOC, 50 unit tests. |
| `src/tools/utils.ts`           | Shared helpers: `frontmatter()`, `runInBatches()`, `safeResolveInBaseTemp()` (path-traversal guard). |
| `scripts/check-lockfile-sync.mjs` | Fails CI if `package-lock.json`'s root entry drifts from `package.json`'s declared dependency specs. Catches the class of bug where someone edits `package.json` without regenerating the lock, which would make `npm ci` wipe `node_modules` and hard-fail for downstream users. |

### New Modules (v0.4.0)

| Module                    | Role                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/request-queue.ts`    | Persistent disk-backed URL queue with checkpoint/resume. Tracks queued/in_progress/completed/failed states. Auto-saves every 5s. Max 3 retries per URL. |
| `src/browser-pool.ts`     | Reusable Playwright browser pool. Acquire/release lifecycle, auto-recycle after N navigations, crash recovery, configurable max browsers. |
| `src/session-router.ts`   | URL pattern → fetcher mode routing. Supports substring, glob, and regex patterns. Per-route overrides for mode, extractor, browser, OS. |
| `src/adaptive-selector.ts` | Structural DOM fingerprinting (tag path, text density, child signatures, attributes, sibling position). Weighted similarity scoring (0-1) with 0.45 threshold. Survives class/ID changes. |

### New Modules (v0.4.1 — paywall bypass, gh CLI fallback, check log handler)

| Module                  | Role                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/paywall.ts`        | Paywall bypass engine. `detectPaywall()` (vendor + text marker detection, confidence-scored), `findStrategy()` (curated → group → generic), `bypassUrl()` (orchestrates strategy chain), `stripPaywallText()` (removes residual tails). 1014 LOC. |
| `src/paywall-sites.ts`  | Top-50+ paywall site strategy catalog (`PAYWALL_SITES`, `PAYWALL_GROUPS`, `GENERIC_STRATEGY`). Covers NYT, WSJ, FT, WaPo, The Economist, Le Monde, FAZ, SMH, etc. + group entries for Hearst, Gannett, Advance Local, DPG Media, Condé Nast. 235 LOC. |
| `src/github-api.ts` | Added `ghRunLogs()`, `ghApiCall()`, `ghFetchWithFallback()` for gh CLI invocation. `ghRunLogs()` is critical for Actions logs (handles 302→S3 zip redirect + auth internally). `ghApiCall()` is a generic `gh api <path>` wrapper. `ghFetchWithFallback()` wraps `ghFetch()` with a gh CLI fallback for 4xx/5xx errors. Set `PI_WEBAIO_GH_FALLBACK=0` to disable child-process spawning. |
| `src/github-pipeline.ts` (v0.4.1 + v0.5.0) | Added `parseGitHubCheckLogUrl()` and `pullGitHubCheckLog()` for `/commit/{sha}/checks/{check_id}/logs/{step?}` URLs. Added `parseGitHubActionsLogsApiUrl()` and `pullGitHubActionsLogs()` (v0.5.0) for `api.github.com/repos/{owner}/{repo}/actions/runs/{runId}/logs` URLs — routes through `ghRunLogs()` so auth + 302→S3 redirects are handled. Fixed `fetchGitHubRepo()` to return `ok:false` with clear "Repository not found or inaccessible" for non-existent repos (was returning empty directory listing). |

### Paywall Bypass — Strategy Chain (v0.4.1)

When `bypass: true` is passed to `aio-webfetch` or `aio-webpull`, and `detectPaywall()` returns `paywalled: true` (confidence ≥ 0.45), `bypassUrl()` runs each step in order and returns the first response that no longer contains paywall markers:

| Step | Mechanism | Cost | Bypasses ~ |
|------|-----------|------|-----------|
| `archive` | Wayback Machine (`web.archive.org/web/2/{url}`) then `archive.ph/newest/{url}` | ~1-2s, free | 80% (most articles have at least one snapshot) |
| `ua:googlebot` | Fetch with `Googlebot/2.1` UA + no `Sec-Ch-Ua` | ~500ms, free | 40% (Google News partners + soft paywalls) |
| `ua:bingbot` | Fetch with `Bingbot/2.0` UA | ~500ms, free | ~20% (sites that whitelist both) |
| `ua:facebookbot` | Fetch with `facebookexternalhit/1.1` UA | ~500ms, free | ~5% (sites that whitelist FB crawler) |
| `referer:google` | Fetch with `Referer: https://www.google.com/` | ~500ms, free | ~5% (sites that check referer only) |
| `block_js` | Playwright + `route.abort()` for 21 known paywall vendors (Piano, Tinypass, Poool, Zephr, Sophi, Pelcro, etc.) + DOM override script (hides `[class*="paywall"]`, restores `body.overflow = auto`, unlocks article containers) | ~3-5s, needs Playwright | 60% (any vendor-paywalled site) |
| `cookies` | Fetch with cookies dropped | ~500ms, free | 10% (sites that track returning readers) |

The first response that passes `detectPaywall()` is re-rendered through the same HTML → markdown pipeline (defuddle, Readability, etc.) so output is uniform. Final markdown is run through `stripPaywallText` to remove residual "Subscribe to continue reading" tails.

The bypass flag is **opt-in** — a normal `aio-webfetch(url)` still gets the regular auto-escalation pipeline. Users must explicitly pass `bypass: true` to trigger the strategy chain. This is intentional, since paywall circumvention is a deliberate user action.

### New Modules (v0.3.0)

| Module                   | Role                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `src/bot-detection.ts`   | Cloudflare, Anubis, DataDome, PerimeterX, Akamai, Incapsula detection with confidence scoring |
| `src/data-islands.ts`    | SPA hydration recovery — JSON from `<script>` tags, 16 framework globals, Next.js RSC chunks  |
| `src/storage.ts`         | Persistent result storage — content-addressed blobs, 500 max, 24h TTL, LRU eviction           |
| `src/context-package.ts` | Compile pulled pages into single Markdown with YAML index                                     |
| `src/verticals/`         | **19** API-first extractors: npm, PyPI, crates.io, RubyGems, Packagist, pub.dev, Go, NuGet, Hacker News, Reddit, arXiv, Stack Exchange, YouTube, Wikipedia, Open Library, DEV.to, SonarCloud, docs sites |

### Caching

- **Session cache**: 30-min TTL, LRU (max 100 entries), normalized keys (http→https, trailing slash)
- **Disk cache**: Persisted to `os.tmpdir()/pi-webaio/` — survives restarts
- **Search cache**: 10-min TTL, persisted to disk
- **Summary cache**: per-URL AI summary cache to avoid re-summarizing within a session
- **Rate limiter**: Token-bucket per domain (5 req/s, burst 10) in `smartFetch`

### Security

- **Secret scanning**: 19 patterns (AWS, GitHub PAT classic/fine-grained/OAuth/App/user, GitLab, npm, PyPI, Slack, Stripe, Google, SendGrid, DigitalOcean, OpenAI including `sk-proj-`/`sk-svcacct-`, Anthropic, Supabase JWT, Vercel, Cloudflare, Private Key, Password in URL). Pre-flight check in `pullPageEnhanced` (v0.5.0) returns clear error before any fetch.
- **SSRF protection**: `isDangerousUrl()` resolves DNS and validates all returned IPs against full RFC 1918/RFC 6598/RFC 3927 ranges, blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal), handles IPv6 tunnel encodings (IPv4-mapped, IPv4-compatible, 6to4, Teredo). Redirect hops are re-validated.
- **Prompt injection**: Categorizes and warns/redacts/tags suspicious content (instruction overrides, role injection, jailbreaks, system manipulation, encoding tricks)
- **Local URL blocking**: Prevents fetching localhost, 127.0.0.1, private IPs
- **HTTP→HTTPS auto-upgrade**
- **`safeResolveInBaseTemp`**: path-traversal guard in `utils.ts` rejects absolute paths and `../` escapes
- **withTimeout**: no longer leaves unhandled rejections when the timeout wins
- **CodeQL scanning**: default GitHub CodeQL scanning active; 6 alerts resolved in v0.5.0 (2 production code, 4 test-file)

### Rate Limiting & Retries

- Token-bucket per domain (5 req/s, burst 10)
- Exponential backoff (1s → 2s) for 429/500/502/503/504
- 400/401/403/404 fail fast
- Jittered retry delays (±40% random variance) to avoid bot-like regularity
- Max 2 retries per request

### Extension API (pi)

- Entry point: `dist/index.js` (compiled from `index.ts`, v0.5.0)
- Package manifest: `package.json` → `pi.extensions: ["./dist/index.js"]`
- Uses `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`
- Tools registered via `pi.registerTool()` with typebox parameter schemas
- Custom `renderCall` / `renderResult` for TUI rendering
- Type augmentations in `types/pi-coding-agent.d.ts`

## Recent Changes

### v0.5.0 — TUI renderer, phase-aware FetchError, format param, hardening, precompiled dist, CI

**TUI result rendering** (411 LOC in `src/tools/render-result.ts`) — All 6 tools now have polished `renderCall` / `renderResult` TUI components. Call view shows tool name + URL(s). Progress view shows per-item status, spinner, elapsed time, and download progress. Result view shows expanded preview with responseId, format, browser/os profile, package path, chunk count, and error details. Phase + category badge for errors. Real-time progress bar wired to `smartFetch` via `readResponseTextWithProgress`.

**Phase-aware FetchError** (564 LOC in `src/tools/fetch-error.ts`) — 25 failure codes × 10 fetch phases × 7 categories. `createFetchError()` produces frozen, rich error objects with `code`, `phase`, `category`, `retryable`, `statusCode`, `downloadedBytes`, `contentLength`, `elapsedMs`, `mimeType`. `classifyError()` maps Node errors. `buildUserFacingFetchErrorSummary()` produces agent-friendly messages. `suggestRetryTimeoutMs()` extrapolates from partial download.

**`format` parameter** on `aio-webfetch` — New `format: "markdown" | "html" | "text" | "json" | "raw"` parameter. Default `markdown` saves to disk. Other formats return body inline for piping into other tools. JSON produces a structured object with all metadata.

**RAG chunking** (`src/chunker.ts`) — New `chunks`, `maxTokens`, `overlapTokens` parameters on `aio-webfetch`. `chunkMarkdown()` splits markdown into paragraph-bounded chunks with optional overlap. CJK-aware token estimation. Only applies to `format: "markdown"`.

**GitHub Actions run logs** — `aio-webfetch` now handles `api.github.com/repos/{owner}/{repo}/actions/runs/{runId}/logs` URLs. Routes through `ghRunLogs()` (the `gh run view --log` CLI path) which uses the user's existing `gh auth login` session to get plain-text logs.

**Precompiled `dist/`** — `tsconfig.dist.json` emits to `dist/`. `package.json` `main` and `pi.extensions` point to `./dist/index.js`. `files` ships `dist/` instead of `src/`. `prepare` hook builds on `npm install`. Eliminates jiti transpile-on-startup cost.

**CI workflow** (`.github/workflows/ci.yml`) — 4 jobs modeled on apmantza/pi-lens: lint-and-typecheck (npm audit + tsc lint + lockfile check), test (all 11 suites), prod-install-build (simulates `npm install --omit=dev`), install-test (3 OS: tarball verification + entry-point loading).

**Release workflow** (`.github/workflows/release.yml`) — Auto-release on version tag detection. 3 jobs: prepare (metadata + CHANGELOG check + dry-run + smoke-load), release (create tag + GitHub release), publish-npm (if NPM_TOKEN set).

**Secret scanner surface** — `pullPageEnhanced` now runs `scanForSecrets()` before any fetch. Returns clear "Request blocked: potential secret(s) detected in URL (GitHub PAT (classic), ...)" instead of generic "Could not reach server".

**Relaxed secret patterns** — Anthropic: now matches shorter `sk-ant-api03-` keys. OpenAI: now matches `sk-proj-` and `sk-svcacct-`. Added: GitHub user tokens (`ghu_`), Supabase JWT, Vercel, Cloudflare.

**Non-existent GitHub repo returns clear error** — `fetchGitHubRepo()` returns `ok:false` with "Repository not found or inaccessible" for 404s.

**`buildDeterministicSummary()` hoisted to module scope** — Fixed 3 latent bugs: heading regex matched H1-H6 (was H1-H3), first-sentence minimum lowered from 20 to 5 chars, added 50KB input cap.

**HTML tag stripping hardened** — Changed regex to `/<[^<>]*>/g` (no crossing nested `<` boundaries) and repeated until stable. Fixes CodeQL `incomplete-multi-character-sanitization`.

**CodeQL alerts resolved** (6) — 2 production: multi-character sanitization in `markdownToText`, string escaping in GitHub pipeline annotations. 4 test-file: URL substring sanitization patterns replaced with regex tests.

**Test count**: 235 → 484 (11 suites, all green locally and in CI).

### v0.4.1 — Anti-bot hardening, headless control, paywall bypass, and GitHub check log handler

**New: GitHub check run log handler** (replaces silent fallthrough to commit metadata) — `pullGitHubCheckLog()` fetches check-runs metadata via REST API, then for Actions jobs calls `gh run view <id> --job <id> --log` via gh CLI. Renders status, conclusion, full annotations table, log excerpt, saves full log to `os.tmpdir()/pi-webaio/github-logs/`. The step index in the URL is honored (job's `steps[]` array resolves index to step name, then tab-separated log is sliced to that step's section).

**New: gh CLI fallback infrastructure** (3 new helpers in `src/github-api.ts`) — `ghRunLogs()`, `ghApiCall()`, `ghFetchWithFallback()`. Uses pre-authenticated `gh` session (5000 req/hr vs 60/hr unauth) and follows 302 redirects with credentials. Set `PI_WEBAIO_GH_FALLBACK=0` to disable.

**Hard paywall bypass on HTTP 403/401** — Triggers on 403/401 from sites in catalogs, not just content-marker detection. `isKnownPaywallSite()` distinguishes curated sites from generic fallback.

**New: opt-in paywall bypass (`bypass: true`)** — Strategy chain: `archive` → bot UAs → `referer:google` → `block_js` → `cookies`. 54 unit tests.

**Issue #33 — Non-headless Chrome support** — `GREEDY_SEARCH_VISIBLE=1` env var, `DISPLAY` env var auto-detected, `shouldUseHeadless()` helper.

**Anti-bot hardening (4 critical fixes)** — Profile-aware `Sec-Ch-Ua` headers, wreq-js session reuse, jittered retry delays, Playwright stealth injection.

**Cookie bridge** — Playwright → wreq-js cookie injection after successful Playwright fallback fetch.

**Session warming** — `aio-webpull` warms session by fetching root URL before deep links.

**Auto-fallback** — `aio-webfetch` with `mode: "auto"` auto-retries once with `mode: "browser"` on retryable errors.

### pi Scope Migration (v0.3.5+)

- Pi moved from `@mariozechner/pi-*` to `@earendil-works/pi-*` package scope (pi 0.73.1+)
- Extension imports updated accordingly
- Pi 0.73.1 also changed to upstream `jiti` 2.7 (internal — transparent to extensions)
- v0.5.0: extension now ships precompiled `dist/`, no longer needs jiti transpile

### v0.2.0 Changes

- Smart content-type auto-detection (JSON, plain text, binary, meta redirects)
- Alternate link fallback (`<link rel="alternate" type="application/json">`)
- Persistent disk cache for session store
- Token-bucket rate limiter per domain
- Proxy support (HTTP, HTTPS, SOCKS5)
- Search context bridging for focused AI summaries
- Fixed Brave search (regex-based parsing, no Svelte-scoped CSS)
- Fixed `gh` CLI ESM import bug

## Testing

- `npm test` → runs unit tests (145 tests)
- `npm run test:new` → runs new feature tests (31 tests)
- `npm run test:paywall` → runs paywall bypass tests (65 tests)
- `npm run test:check` → runs GitHub check log tests (26 tests)
- `npm run test:render` → runs TUI renderer tests (39 tests)
- `npm run test:fetcherror` → runs FetchError system tests (50 tests)
- `npm run test:fetchprogress` → runs streaming body tests (6 tests)
- `npm run test:hardening` → runs security hardening tests (16 tests)
- `npm run test:format` → runs format parameter tests (18 tests)
- `npm run test:webfetch-summary` → runs summary builder tests (10 tests)
- `npm run test:chunker` → runs RAG chunking tests (31 tests)
- `npm run test:integration` → runs integration tests
- `npm run test:all` → runs all 11 suites (~480 tests total)
- `npm run check:lockfile` → fails if package-lock.json drifts from package.json
- `npm run build` → compiles TypeScript to `dist/`
- `npm run lint` → runs `tsc --noEmit` as type-check
- Tests use `node:test` directly (no test runner dependency)
- Tests import TypeScript modules directly (Node 24 native strip-types)
- Playwright tests gracefully handle both installed/uninstalled

## Dependencies

- **Runtime**: `@earendil-works/pi-tui`, `@mozilla/readability`, `defuddle`, `linkedom`, `mathml-to-latex`, `pdf-parse`, `sharp`, `temml`, `turndown`, `wreq-js`, `youtube-transcript-plus`
- **Peer**: `@earendil-works/pi-coding-agent`, `typebox`
- **Optional**: `playwright`
- **Dev**: `@types/node`, `typebox`, `typescript`

## CI/CD

- **GitHub Actions** (`.github/workflows/ci.yml`):
  - `lint-and-typecheck` — `npm audit --omit=dev --audit-level=high` + `npm run check:lockfile` + `npm run lint` (tsc --noEmit)
  - `test` — builds + runs all test suites
  - `prod-install-build` — simulates the actual pi install path (`npm install --omit=dev` → `prepare` → `build:dist` from source). Catches TS2688-style breakage when `@types/node` is absent.
  - `install-test` (ubuntu/windows/macos) — packs tarball, verifies `dist/` is present and no `.ts` leaked, installs from tarball (simulates `pi install npm:pi-webaio`), checks the compiled entry loads without missing-module errors.
- **GitHub Releases** for version tags (`.github/workflows/release.yml`):
  - Auto-creates `v{version}` tag on push to master
  - Auto-creates GitHub release with auto-generated notes
  - `npm publish` if `NPM_TOKEN` secret is configured
  - Verifies CHANGELOG entry exists for the new version
- **Default GitHub CodeQL** scanning for security alerts
- **NPM_TOKEN** secret optional — without it, releases still create GitHub releases but skip npm publish
