# pi-webaio — Agent Context

## What is this?

pi-webaio is an **all-in-one web tools extension** for [pi](https://pi.dev) (the coding agent) that provides search, fetch, crawl, extraction, discovery, storage, compilation, and (v0.4.1+) opt-in paywall bypass capabilities via 6 tools: `aio-websearch`, `aio-webfetch`, `aio-webcontent`, `aio-webpull`, `aio-webmap`, and `aio-webresult`. It's published as `npm:pi-webaio` and installable via `pi install npm:pi-webaio`.

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
│   ├── verticals/            ← API-first extractors for known sites
│   │   ├── registry.ts       ← Pattern-matching registry
│   │   ├── types.ts          ← Shared types
│   │   ├── npm.ts            ← npm registry API
│   │   ├── pypi.ts           ← PyPI JSON API
│   │   ├── hackernews.ts     ← Hacker News Firebase API
│   │   ├── reddit.ts         ← Reddit .json endpoint
│   │   ├── arxiv.ts          ← arXiv Atom export API
│   │   └── docs-site.ts      ← Docusaurus, GitBook, MDN, VitePress extraction
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
│   ├── unit.test.mjs         ← 145 unit tests (parsers, sitemap, discovery, caching)
│   ├── new-features.test.mjs ← 31 unit tests (queue, router, adaptive selector, pool)
│   ├── paywall.test.mjs      ← 54 unit tests (paywall detection, strategy chain, text stripping, site DB)
│   ├── integration.test.mjs  ← Integration tests
│   └── lib.mjs               ← Test helpers and fixtures
├── tsconfig.json
├── package.json              ← type: "module", pi extension manifest
└── README.md
```

## The 6 Tools

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
- New in v0.4.0: `resume`, `routes`, `adaptive` parameters
- New in v0.4.1: `bypass` parameter

### 5. `aio-webmap`

- Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, llms.txt
- Returns structured URLs grouped by source without fetching content
- Parameters: `url`, `max` (default 100), `browser`, `os`
- Useful for previewing what pages webpull would fetch

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
| `src/github-api.ts` (extended) | Added `ghRunLogs()`, `ghApiCall()`, `ghFetchWithFallback()` for gh CLI invocation. `ghRunLogs()` is critical for Actions logs (handles 302→S3 zip redirect + auth internally). `ghApiCall()` is a generic `gh api <path>` wrapper. `ghFetchWithFallback()` wraps `ghFetch()` with a gh CLI fallback for 4xx/5xx errors. Set `PI_WEBAIO_GH_FALLBACK=0` to disable child-process spawning. |
| `src/github-pipeline.ts` (extended) | Added `parseGitHubCheckLogUrl()` and `pullGitHubCheckLog()`. Handles `/commit/{sha}/checks/{check_id}/logs/{step?}` URLs (the legacy commit-checks view) that previously silently fell through to commit metadata. For Actions jobs, calls `ghRunLogs()` to get plain-text logs. Renders status, conclusion, full annotations table, log excerpt, and saves full log to `os.tmpdir()/pi-webaio/github-logs/`. |

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
| `src/verticals/`         | 18 API-first extractors: npm, PyPI, crates.io, RubyGems, Packagist, pub.dev, Go, NuGet, Hacker News, Reddit, arXiv, Stack Exchange, YouTube, Wikipedia, Open Library, DEV.to, SonarCloud, docs sites |

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

### v0.4.1 — Anti-bot hardening, headless control, paywall bypass, and GitHub check log handler

**New: GitHub check run log handler** (replaces silent fallthrough to commit metadata)

- `aio-webfetch` (and `aio-webpull`) now handles `/commit/{sha}/checks/{check_id}/logs/{step?}` URLs. Previously, these silently returned commit metadata, dropping the check ID and logs entirely. The new `pullGitHubCheckLog()` function in `src/github-pipeline.ts` fetches check-runs metadata via the REST API, then for Actions jobs (`app.slug === "github-actions"`) calls `gh run view <id> --job <id> --log` via the gh CLI to get plain-text logs (handles 302→S3 zip redirect + auth internally). Rendered markdown includes status, conclusion, full annotations table, log excerpt (last 15 error lines or 50 tail lines), and a `<details>` block with the path to the filtered log saved to `os.tmpdir()/pi-webaio/github-logs/`. **The step index in the URL is honored**: the job's `steps[]` array from the API is used to resolve the index to a step name, then the tab-separated log is sliced to that step's section. Two fallback paths handle older log formats: `##[group]` markers and order derived from the log itself. Filtered logs are saved to a separate `check-{id}-step{N}.log` file. External CI apps return check metadata + annotations only with a "View on GitHub" link.

**New: gh CLI fallback infrastructure** (3 new helpers in `src/github-api.ts`)

- `ghRunLogs(owner, repo, runId, jobId?)` — runs `gh run view <id> --log [--job <id>]` to get plain-text workflow logs without needing a zip-extraction library. Returns null on failure.
- `ghApiCall<T>(path, { raw? })` — runs `gh api <path> [--jq .]` and returns parsed JSON or raw bytes. Uses the user's pre-authenticated `gh` session (5000 req/hr vs 60/hr unauth) and follows 302 redirects with credentials.
- `ghFetchWithFallback<T>(path)` — wraps `ghFetch()` with a gh CLI fallback for 4xx/5xx errors. Currently used in the check log handler; available as drop-in replacement for `ghFetch()` anywhere higher rate limits or private-repo access via `gh auth login` would help.
- Set `PI_WEBAIO_GH_FALLBACK=0` to disable gh CLI child-process spawning entirely. Default: ON if `gh` is on `PATH`.

**Hard paywall bypass on HTTP 403/401** — the bypass engine now triggers on 403/401 responses from sites in the `PAYWALL_SITES` or `PAYWALL_GROUPS` catalogs, not just on content-marker detection. Previously, NYT/WSJ/FT (which return 403/401 with no body for `detectPaywall` to analyze) fell through to the raw error response. New helper `isKnownPaywallSite(url)` distinguishes curated sites from the generic fallback (so we don't try to bypass non-paywall 403s from CDNs or geo-restrictions). Also handles mobile subdomains (e.g. `m.washingtonpost.com` matches `washingtonpost.com`).

**New: opt-in paywall bypass (`bypass: true`)**

- `aio-webfetch` and `aio-webpull` now accept `bypass: true`. When the normal fetch returns content with paywall markers (confidence ≥ 0.45), `bypassUrl()` runs a strategy chain: `archive` (Wayback Machine / archive.ph) → bot UAs (`ua:googlebot`, `ua:bingbot`, `ua:facebookbot`) → `referer:google` → `block_js` (Playwright with paywall vendor script blocking + DOM override) → `cookies`. The first response that no longer contains paywall markers wins.
- New `src/paywall.ts` (1014 LOC) with `detectPaywall()`, `findStrategy()`, `bypassUrl()`, `stripPaywallText()`, and the `KNOWN_PAYWALL_VENDORS` block list.
- New `src/paywall-sites.ts` (235 LOC) with the top-50+ paywall site strategy catalog — direct entries for NYT, WSJ, FT, WaPo, The Economist, Le Monde, FAZ, SMH, The Atlantic, Vanity Fair, etc., plus group strategies for newspaper chains (Hearst, Gannett, Advance Local, DPG Media, Condé Nast, Axel Springer, Schibsted, Vox Media).
- 54 unit tests in `tests/paywall.test.mjs` covering detection, strategy resolution, text stripping, bot UA, site DB integrity, and DOM override script.
- New `bypassStrategies` parameter on `aio-webfetch` for custom chain ordering.
- Debug knob `PI_WEBAIO_DEBUG=1` logs every bypass attempt and confidence score.

**Issue #33 — Non-headless Chrome support**

**Issue #33 — Non-headless Chrome support**
- `GREEDY_SEARCH_VISIBLE=1` env var now respected by Google Search & AI summary
- `DISPLAY` env var auto-detected — if X11 is available, defaults to visible mode
- Removed all hardcoded `headless: true` overrides in `src/tools/websearch.ts` and `src/tools/webfetch.ts`
- `ensureChrome()` now uses `shouldUseHeadless()` helper that checks env vars before defaulting

**Anti-bot hardening (4 critical fixes)**
1. **Profile-aware `Sec-Ch-Ua` headers** — `buildHeaders()` derives version from browser profile (e.g. `chrome_145` → `v="145"`). Firefox/Safari omit the header entirely (they don't send it). Edge gets `"Microsoft Edge"` brand.
2. **wreq-js session reuse** — batch fetches (`urls` param) and webpull now create a persistent `wreq-js` session, sharing cookies and TCP/TLS connections across requests. Sessions are closed after work completes.
3. **Jittered retry delays** — replaced deterministic `sleep(1000 * attempt)` with `jitteredDelay()` adding ±40% random variance. Avoids bot-like regularity in retry timing.
4. **Playwright stealth injection** — `fetchWithPlaywright()` now injects an anti-detection script before navigation: `navigator.webdriver`, plugins, mimeTypes, `window.chrome`, WebGL renderer spoofing, window outer dimensions, screen depth. Covers the most common headless detection vectors.

**Cookie bridge — Playwright → wreq-js**
- After a successful Playwright fallback fetch, clearance cookies (`cf_clearance`, datadome tokens, etc.) are extracted from the browser context and injected into the wreq-js session
- Subsequent HTTP fetches to the same domain reuse these cookies, avoiding repeated browser escalation

**Session warming — webpull**
- Before pulling deep links, `aio-webpull` warms the session by fetching the root URL
- Followed by an 800–1500ms jittered dwell to mimic human landing behavior
- Reduces bot scores from anti-bot systems that flag "deep-link first" patterns

**Auto-fallback — webfetch**
- When `aio-webfetch` with `mode: "auto"` fails with a retryable or bot-block error, it automatically retries once with `mode: "browser"`
- Applies to single-URL fetches; avoids requiring the user to make a second manual call

### pi Scope Migration (unreleased)

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

- `npm test` → runs existing unit tests (145 tests)
- `npm run test:new` → runs new feature tests (31 tests)
- `npm run test:paywall` → runs paywall bypass tests (57 tests)
- `npm run test:check` → runs GitHub check log tests (22 tests)
- `npm run test:integration` → runs integration tests (5 tests)
- `npm run test:all` → runs all 5 suites (260 tests total)
- Tests use `node` directly (no test runner dependency)
- New feature + paywall + check log tests import TypeScript modules directly (Node 24 native strip-types)
- Playwright tests gracefully handle both installed/uninstalled

## Dependencies

- **Runtime**: `@mozilla/readability`, `defuddle`, `linkedom`, `pdf-parse`, `sharp`, `wreq-js`
- **Peer**: `@earendil-works/pi-coding-agent`, `typebox`
- **Optional**: `playwright`
- **Dev**: `typescript`, `@types/node`

## CI/CD

- GitHub Actions: lint, test, tarball verification
- GitHub Releases for npm publishing
