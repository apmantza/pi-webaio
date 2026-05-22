# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.7] - 2026-05-22

### Fixed

- **arXiv vertical extractor URL coverage** — `matchesArxiv()` now matches `export.arxiv.org/api/query?...` and `arxiv.org/pdf/...` URLs in addition to the previously-only-matched `arxiv.org/abs/...` pattern. `extractArxiv()` extracts paper IDs from all three URL formats and reuses the original API response when the input is already the query endpoint (avoids a redundant second HTTP request). Previously, `api/query` URLs fell through to generic XML extraction, producing garbled results. Added 7 unit tests for the new patterns.

### Added

- **`Sec-Ch-Ua` client hint headers** — `buildHeaders()` now includes User-Agent Client Hints (`Sec-Ch-Ua`, `Sec-Ch-Ua-Mobile`, `Sec-Ch-Ua-Platform`) alongside existing Fetch Metadata headers. Completes the Chrome 120 browser fingerprint for better anti-bot resistance.
- **`isLikelyJSRendered()` heuristic** — Detects SPA shell pages by checking if body text is <500 chars but has >3 `<script>` tags. Available for future use in fallback prioritization.
- **`extractHeadingTitle()` helper** — Extracts first H1/H2 from markdown text as a title fallback. Wired into the Readability pipeline when `article.title` is empty.
- **`MIN_USEFUL_CONTENT` threshold** — Constant (500 chars) defined for future extraction quality checks.
- **`buildDeterministicSummary()` fallback** — When Google AI summarization fails, extracts headings and lead sentences from markdown content as a structured excerpt (up to `MAX_PREVIEW_CHARS`). Replaces raw truncation with a readable overview.
- **Content-Length pre-check in `readResponseText()`** — Checks `Content-Length` header before streaming. Oversized responses fail instantly instead of allocating a reader and hitting the byte cap mid-stream.

## [Unreleased]

### Fixed

- **CodeQL #52 — incomplete multi-character sanitization in `stripTags`** (`src/verticals/wikipedia.ts`) — Replaced single-pass `.replace(/<[^>]*>/g, "")` with a do-while loop that runs until the string stabilizes, preventing crafted input like `<<script>script>` from re-forming a `<script>` tag after the first pass.

## [0.3.6] - 2026-05-22

### Added

- **`domain` and `sources` on every search result** — `SearchResult` interface expanded with `domain?: string` (URL hostname) and `sources?: string[]` (which engines found this URL). All 5 search parsers (DDG, Yahoo, Bing, Brave, Google CDP) now populate `domain` via `extractDomain()`. `scoreAndRankResults()` threads the `sources` array through to final output instead of dropping it.
- **Domain + consensus tags in result text** — Each result line now renders as `**Title** *(github.com)* — DDG+Bing+Google\n   url\n   snippet`. Domain shown when available; consensus tag shown only when 2+ engines agree, making cross-engine agreement visible to the agent.
- **`onUpdate` progress streaming** — `aio-websearch` `execute()` now accepts `onUpdate` and fires `Searching "query" via DDG, Brave, Yahoo, Bing, Google...` immediately while engines run in parallel. Eliminates the 7-second blank stall.
- **Per-engine result counts in header** — Engine labels changed from binary presence (`DDG + Brave + Bing`) to actual counts (`DDG:8 + Brave:12 + Bing:10 + Google:5`). Makes silent failures visible and gives the agent a volume signal per source.
- **Custom TUI `renderCall` / `renderResult`** — `aio-websearch` now has polished TUI rendering:
  - *Call view:* `aio-websearch "query"` in `toolTitle` + `accent` colors.
  - *Collapsed result:* `12 results via DDG:8+Brave:12+Bing:10+Google:5 in 2.3s` in `success` + `muted`.
  - *Expanded result* (Ctrl+O): shows up to 8 results with title (`accent`), domain/consensus (`dim`), URL (`dim`), snippet (`muted`), and `… N more` truncation.
  - *Partial state:* yellow `Searching "query"...` while in flight.
- **Type augmentation updated** (`types/pi-coding-agent.d.ts`) — Added `renderCall` and `renderResult` fields to the `registerTool` signature, plus `export {}` to ensure TypeScript treats it as a module augmentation (not a script). Previously these renderer hooks were absent, which would have shadowed the real package's richer `ToolDefinition` type.

## [0.3.5] - 2026-05-22

### Fixed

- **CodeQL alerts #44-#47: Incomplete URL substring sanitization in index.ts** — Replaced `url.includes("search.yahoo.com")`, `url.includes("video.search.yahoo.com")`, `url.includes("r.search.yahoo.com")`, and `url.includes("bing.com")` in `parseYahooResults()` and `parseBingResults()` with `new URL(url).hostname` exact/suffix matching. Prevents bypass via path or query string (e.g. `https://evil.com/bing.com`).

### Performance

- **AI summarization gated on content length** — `aio-webfetch` no longer spawns a Google AI subprocess for pages whose markdown already fits within the `MAX_PREVIEW_CHARS` (1800 char) tool-result preview. Short pages are returned verbatim with no extra round-trip.
- **Session-scoped summary cache** — Introduced `summaryCache` (`Map<url, summary>`). Fetching the same URL more than once in a session reuses the existing AI summary instead of re-running the full Google AI extraction pipeline.

### Changed

- **Dependency bumps** — `ws` 8.20.0 → 8.20.1, `protobufjs` 7.5.6 → 7.6.0, `brace-expansion` 5.0.5 → 5.0.6.
- **CDP extractor sync** — Synced `extractors/` from GreedySearch-Pi @ 18abe97.

## [0.3.4] - 2026-05-18

### Fixed

- **CodeQL alerts #44-#47: Incomplete URL substring sanitization** — Replaced 7 `url.includes(hostname)` calls with proper hostname-based checks across 4 files, preventing false matches on attacker-controlled URLs (e.g. `evil.github.com` or `github.com.evil.com`):
  - `extractors/consent.mjs` — Microsoft/Cloudflare verification page detection uses `new URL(url).hostname` comparisons
  - `extractors/google-ai.mjs` — Google search page detection uses hostname + pathname parsing
  - `extractors/google-search.mjs` — Google internal link filtering uses hostname + pathname parsing
  - `index.ts` — Yahoo/Bing search result filtering and GitHub URL detection uses `new URL(url).hostname` with exact matching

### Added

- **4-engine search pipeline** (`searchWeb()` in `index.ts`) — Expanded from DDG+Brave to **DDG, Brave, Yahoo, and Bing** running in parallel. Yahoo bypasses EU GDPR consent walls via `region=us&lang=en` query params. Bing adds Microsoft index coverage. All 4 engines fan out simultaneously with a 7-second cap.
- **Cross-engine consensus ranking** (`scoreAndRankResults()`, `buildResultBuckets()`, `ENGINE_WEIGHTS` in `index.ts`) — Results are scored by engine authority + cross-engine agreement. Higher weight = more trusted engine (Google 5, Bing 3, DDG 2, Brave 2, Yahoo 1). Consensus bonus: +2 per additional engine agreeing on a URL. Metadata (title/snippet) is taken from the highest-weight engine for each URL. High-confidence results (returned by multiple engines) bubble to the top.
- **Per-session engine health tracking** (`EngineHealthRecord`, `recordEngineSuccess/Failure`, `isEngineAvailable` in `index.ts`) — Tracks successes, failures, consecutive failures, latency per engine. Auto-cooldown after 2 consecutive failures (10 min). Failed engines are skipped on subsequent searches until cooldown expires. Replaces the simpler `providerCooldowns` map.
- **Login-redirect detection** (`detectLoginRedirect()` in `src/bot-detection.ts`) — Detects auth-wall redirects (accounts.google.com, login.microsoftonline.com, auth0.com, okta.com, etc.) and content pages that redirect to login forms. Returns structured reason string. Integrated into `smartFetch()` — login redirects return `null` instead of passing through the login page as content.
- **Default search results cap raised** — `max` parameter default increased from 10 to 15. Final output cap remains 25 (after HTTP + Google merge and dedup).
- **raw.githubusercontent.com pipeline** (`parseRawGitHubUrl()` in `index.ts`) — GitHub raw file URLs now parsed and routed through `pullGitHub()` with `> via GitHub` marker, preventing AI summarization on raw code content. Previously these fell through to the normal HTML pipeline with no skip marker.
- **URL hostname-based AI summarization skip** — `aio-webfetch` now checks `r.url` against `github.com`, `raw.githubusercontent.com`, and `gist.github.com` hostnames before attempting summarization, catching GitHub URLs that fail pipeline extraction.
- **Catch-all `> via ` summarization skip** — Replaced fragile per-provider marker checks with a single `preview.includes("> via ")` test. All pipeline interceptors (GitHub, SonarCloud, vertical extractors) prepend this prefix, automatically excluding YouTube, npm, PyPI, Reddit, HN, arXiv, and docs-site content from AI summarization.

### Changed

- **Search tool description** — Updated from "DuckDuckGo, Brave, and Google" to "DuckDuckGo, Brave, Yahoo, Bing, and Google" to reflect the 4 HTTP engines + 1 CDP engine architecture.
- **Engine labels in output** — Now dynamic: only shows engines that actually contributed results (e.g. "DDG + Bing" or "DDG + Brave + Bing + Google"), replacing the static "DDG + Brave" label.
- **README restructured** — "What is this?" renamed to "What does pi-webaio do?" with AI summarization mention. Added "How AI summarization works" section with skip rules table. Added "Special pipelines: GitHub, YouTube, and more" section covering all vertical extractors, auto-escalation, and detailed GitHub URL pattern table. Tools section moved to last.

### Fixed

- **SonarCloud security hotspots** — Resolved 6 hotspots across 4 files:
  - `extractors/selectors.mjs:52` — Bounded `citationNameRegex` capture group to `{1,200}` to prevent backtracking on long citation labels
  - `index.ts:266` — Replaced `/ *\n */g` regex in `cleanText()` with split/join/trim pipeline, removing unbounded `*` quantifiers
  - `index.ts:3693` — Replaced `/just a moment|cf-chl-bypass/i` regex alternation with simple `.includes()` calls on a pre-computed lowercase slice
  - `index.ts:3989` — Bounded `cleanText` markdown link regex quantifiers to `{0,5000}` and `{1,5000}` to prevent catastrophic backtracking on malformed input
  - `index.ts:4004` — Changed `new URL(url, "http://x")` to `"https://x"` to avoid plain HTTP in code
  - `src/storage.ts:83` — Replaced `Math.random()` in `makeId()` with `randomUUID()` from `node:crypto`

## [0.3.3] - 2026-05-12

### Added

- **YouTube vertical extractor** (`src/verticals/youtube.ts`) — Fetches YouTube video transcripts + metadata via `youtube-transcript-plus` (Innertube API, no API key required). Supports standard URLs, `youtu.be`, Shorts, and embeds. Returns title, channel, duration, views, tags, description, and full transcript with configurable format (`text`, `vtt`, `segments` with timestamps). Language selection with auto-fallback. Registered in `src/verticals/registry.ts`.
- **Consent banner stripping** (`preCleanHtml()` in `index.ts`) — Cookie consent / CMP banner removal during server-side HTML pre-cleaning. 80+ selectors covering 17+ named CMPs (OneTrust, Cookiebot, Didomi, Quantcast, Usercentrics, TrustArc, Klaro, Sourcepoint, CookieYes, Osano, CookieFirst, Adobe PMC, SmartConsent, CookieHub, TermsFeed, Google, YouTube, BBC, Amazon) plus generic class/id patterns (`[class*="cookie-banner"]`, `[class*="consent-modal"]`, `[class*="gdpr-banner"]`, `[class*="privacy-notice"]`) and ARIA/data-attribute patterns. Merged with existing noise selectors into `ALL_NOISE_SELECTORS` — runs before Readability/Defuddle extraction, so banner noise never reaches content heuristics.
- **Comprehensive cookie consent dismissal** (`extractors/consent.mjs`) — Rewrote CDP-based cookie dismissal with 17+ named CMPs, shadow DOM support (Usercentrics), multi-language accept/reject patterns (EN, DE, FR, IT, ES, PT), text-based fallbacks, and iframe consent dialog handling. Replaced the original 4-handler script (Google, OneTrust, generic) with a production-grade dismissal covering the same CMPs as the server-side stripper.
- **Consent banner stripping tests** (`tests/lib.mjs`, `tests/unit.test.mjs`) — 21 new unit tests: 10 named CMPs (OneTrust through Osano), 4 generic patterns, 5 false-positive protections (cookie recipes, GDPR articles, parental consent content, dialog stripping with sibling preservation, nested banners), 2 edge cases (empty HTML, no banners).

## [0.3.2] - 2026-05-09

### Added

- **HTML compression pipeline** (`src/html-compress.ts`) — Strips noise attributes (class, id, data-\*, style, event handlers, ARIA) before feeding HTML to Readability/Defuddle. Removes empty elements across multiple passes. Runs after `preCleanHtml()` in the extraction pipeline. Reduces token bloat from HTML cruft while preserving semantic attributes (href, src, alt, itemprop, role).
- **Token counting** (`src/token-count.ts`) — Approximate GPT-family token estimation with CJK detection. `estimateTokensFast()` for hot paths, `estimateTokens()` for accuracy-sensitive use.
- **Interactive element extraction** (`src/interactive-elements.ts`) — Extracts buttons, links, forms, selects, inputs, textareas as numbered `[1] button: "Submit" ⌥ B` refs. New `interactive` parameter on `aio-webfetch`.
- **Token-budget pruning** (`src/prune-markdown.ts`) — Score-based markdown section pruning. Splits content by headings, scores sections by importance (headings, first-section bonus, keyword matching, code-block penalty), greedily fills token budget. New `prune` parameter on `aio-webfetch`.
- **Architecture detection** — `detectArchitectureSignals()` analyzes cloned repo file trees for Docker, CI/CD (GitHub Actions, GitLab CI, Jenkins, CircleCI, Travis, Azure Pipelines, Bitbucket Pipelines), test frameworks (Jest, Vitest, Playwright, Cypress, pytest, Mocha, Karma), monorepo tooling (Lerna, Nx, Turborepo, pnpm workspaces, Rush), package managers (from lockfiles), and security signals (SECURITY.md, .env committed, Dependabot). Integrated into `buildRepoMarkdown()` for GitHub repo fetches.
- **Link rewriting** — `rewriteLinks()` converts absolute URLs between pulled pages to relative `.md` paths during `aio-webpull`. Fragment preservation. Only activates when ≥2 page links match.
- **CI run handler** — `pullGitHubFeature()` now fetches job details and step-by-step status tables for individual GitHub Actions run URLs (`/actions/runs/{id}`). Supports `/actions/runs/{id}/job/{jid}` sub-paths — highlights the specific job and fetches failed-job log excerpts (last 15 error lines or 50 tail lines). Shows PR references when available (e.g. dependabot PRs).

### Fixed

- **Browser mode discarded Playwright HTML** — Both the explicit `mode: "browser"` path and the auto-escalation Playwright fallback in `pullPageEnhanced()` called `fetchWithPlaywright()` to get JS-rendered HTML, then immediately discarded it and called `pullPage()` which did a fresh `wreq-js` fetch. Browser mode was effectively a no-op. Fixed by adding an optional `htmlOverride` parameter to `pullPage()` and extracting the 100+ line HTML extraction pipeline into a shared `runHtmlPipeline()` helper. Both the browser mode path and auto-escalation fallback now pass Playwright HTML through via `htmlOverride`.
- **DNS failures not retried in main fetch** — `isRetryableNetworkError()` in `index.ts` was missing `ENOTFOUND` and `getaddrinfo` detection (already present in `src/github-api.ts`). DNS resolution failures during `smartFetch` were not retried. Added both markers.
- **Unused imports and variables** — Removed unused `readdir`/`stat` imports from `src/storage.ts`, removed unused `running` variable and `profileDir` from `src/google-ai.ts`, renamed unused `total` parameter to `_total` in `src/prune-markdown.ts:scoreSection()`.
- **Implicit `any` and deprecated API** — Added explicit `string` type annotation to `l` parameter in sitemap parser (`index.ts:1301`). Replaced deprecated `Buffer.slice()` with `Buffer.subarray()` in binary detection (`index.ts:3254`).

### Changed

- **GitHub CLI dependency removed** — Replaced all `gh api` and `gh subcommand` calls with direct REST API via new `src/github-api.ts`. The `gh` binary is no longer required for reading GitHub repos, trees, blobs, or feature pages (issues, PRs, actions, releases, commits, security alerts, etc.). Feature-page URL parsing still works unauthenticated for public repos at 60 req/hr.
- **`ghFetch<T>()` helper** — 3-tier auth fallback: `GITHUB_TOKEN` env → `GH_TOKEN` env → `gh auth token` (from logged-in CLI) → unauthenticated. Exponential backoff on 429/5xx/network errors with `Retry-After` header support. Exported `isRetryableNetworkError` for testing.
- **`cloneGitHubRepo()` private repo support** — Injects `GITHUB_TOKEN` into clone URL (`x-access-token:TOKEN@github.com/...`) when `gh` CLI is unavailable but a token is set. Enables cloning private repos without the `gh` binary.
- **`fetchGitHubRaw()` smarter branch fallback** — Queries `GET /repos/{owner}/{repo}` for the default branch when the ref looks like a commit SHA (40 hex chars), instead of guessing main→master→fail.
- **Streaming response reader** — New `readResponseText()` function replaces `res.text()` in `smartFetch()`. Streams via `ReadableStream` with 10MB byte cap (`MAX_RESPONSE_BYTES`) to prevent memory exhaustion from unexpectedly large responses.
- **Pagination on `aio-webfetch`** — New `start_index` and `max_length` params. Applied after interactive extraction, before token pruning. Returns `_(chars X–Y of Z total)_` footer so the agent knows where it is. Out-of-bounds `start_index` returns a clear error.

### Removed

- **`ghCommand()`, `ghApi()`, `ghAvailable()`, `GH_NATIVE_COMMANDS`** (~90 lines) — Replaced by `ghFetch()` in `src/github-api.ts`.

## [0.3.1] - 2026-05-08

### Changed

- **Banner redesign** — Updated from 4-tool single-row layout to 6-tool 2×3 grid (560px). New cards for `aio-webmap` and `aio-webresult` with cyan/green color accents. Tagline updated. SVG and PNG regenerated.

### Fixed

- **CodeQL alerts #41 and #42** — Removed stale JSDoc comment from removed `stripHtmlTags()` function that contained `<script` and `<style` substrings in documentation text, triggering false-positive "incomplete multi-character sanitization" alerts.
- **CodeQL alert #43** — Fixed `url.includes("developer.mozilla.org")` in `src/verticals/docs-site.ts` which could match attacker-controlled subdomains (e.g. `developer.mozilla.org.evil.com`). Replaced with proper hostname parsing via new `isHostMatch()` helper. Also hardened `matchesDocsSite()` with the same pattern.

## [0.3.0] - 2026-05-08

### Added

- **2 new tools: `aio-webmap` and `aio-webresult`** — bringing the total to 6 tools
  - `aio-webmap` — Discovery-only tool that finds pages via robots.txt, sitemaps, navigation links, and llms.txt without fetching content. Returns structured URL list grouped by source.
  - `aio-webresult` — Retrieves previously fetched results by persistent response ID (survives restarts). Falls back to showing recent results when ID not found.
- **Vertical extractors** — 6 API-first extractors for known sites that hit structured APIs instead of scraping HTML: npm (registry.npmjs.org), PyPI (pypi.org/pypi), Hacker News (Firebase API), Reddit (.json endpoint), arXiv (Atom export), and platform-aware docs-site extractors (Docusaurus, GitBook, MDN, VitePress, ReadTheDocs). Run before the HTML content pipeline for matching URLs.
- **Auto escalation pipeline** — New `mode` parameter on `aio-webfetch` and `aio-webpull` with four modes: `auto` (default), `fast`, `fingerprint`, `browser`. Auto mode escalates from fast fetch → fingerprint rotation → Playwright rendering when bot protection is detected.
- **Cloudflare challenge bypass** — Detects CF challenges via `cf-mitigated` header and body markers (`just a moment`, `cf-chl-bypass`) in the first 4KB of 403 responses. Retries with OpenCode UA — cheaper than full fingerprint rotation or Playwright.
- **Bot-block detection module** (`src/bot-detection.ts`) — Structured detection of Cloudflare, Anubis, PerimeterX, DataDome, Incapsula, and Akamai bot protection. Returns typed `BotBlockResult` with blocker type, confidence score, retry advice, and human-readable messages.
- **SPA data-island recovery** (`src/data-islands.ts`) — Extracts JSON hydration data from `<script>` tags, 16 framework globals (`__NEXT_DATA__`, `__NUXT__`, etc.), and Next.js RSC chunks. Recovers content from JS-rendered pages where traditional extraction produces empty results.
- **Persistent result storage** (`src/storage.ts`) — Content-addressed blob storage with JSON metadata index, 500 max results, 24h TTL, LRU eviction. Each `aio-webfetch` call returns a `responseId` for later retrieval via `aio-webresult`.
- **Context packages** (`src/context-package.ts`) — `compile` parameter on `aio-webfetch` (batch mode) and `aio-webpull` compiles multiple pages into a single Markdown file with YAML index and configurable size bounds.
- **Content trust boundaries** — All fetched content wrapped in `[UNTRUSTED WEB CONTENT START] / [UNTRUSTED WEB CONTENT END]` markers. Applied in `finalizePullResult()` — the single choke point for all pull output. Zero-trust safety pattern adopted from pi-search.
- **DNS-based SSRF protection** — Replaced weak string-based localhost check with `isDangerousUrl()` which resolves DNS and validates all returned IPs against full RFC 1918/RFC 6598/RFC 3927 ranges, blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal), handles IPv6 tunnel encodings (IPv4-mapped, IPv4-compatible, 6to4, Teredo), and includes fast-path prefix checks for obvious private ranges.
- **Redirect-hop SSRF re-validation** — `smartFetch` now uses manual redirect following (`redirect: "manual"`) and re-validates every redirect target against `isDangerousUrl()`. Max 5 hops. Prevents `302 → http://169.254.169.254/` bypass attacks.
- **Provider cooldown system** — Search providers (DDG, Brave, Google) now track failures with TTL-based cooldowns: 10 minutes for quota/rate-limit errors (429, 402, 403), 2 minutes for connection failures (ECONNREFUSED, ENOTFOUND). Skipped engines don't waste request time.
- **`preCleanHtml()` — DOM-based noise removal** before extraction. Removes nav, footer, header, svg, canvas, iframe, form, `[aria-hidden]`, `[hidden]`, and role-based navigation/banner/contentinfo elements via linkedom BEFORE feeding to Readability/Defuddle. Significantly improves extraction quality on chrome-heavy pages.
- **`cleanText()` — improved whitespace normalization** adopted from strip-search. Collapses whitespace runs while preserving newlines, strips carriage returns, normalizes 3+ newlines to 2. Applied after Defuddle and in fallback extraction.
- **`<1% fallback heuristic`** — If Readability output is <1% of original HTML size (and original >10KB), assume wrong container → skip Readability and fall through to Defuddle.
- **Teredo and 6to4 IPv6 tunnel detection** — `isPrivateIPv6()` now extracts and validates embedded IPv4 addresses from Teredo (RFC 4380) and 6to4 tunnel addresses.

### Changed

- `aio-webfetch` new parameters: `mode` (scrape mode), `cacheTtlSeconds` (opt-in cache TTL), `compile` (compile batch into context package)
- `aio-webpull` new parameters: `mode` (scrape mode), `compile` (compile pulled pages into package)
- `aio-webfetch` now uses `pullPageEnhanced()` which runs vertical extractors, data-island recovery, and auto escalation before falling through to the standard HTML pipeline
- `aio-webpull` now uses `pullPageEnhanced()` per page, enabling auto escalation and vertical extractors for discovered pages
- Extraction pipeline now starts with `preCleanHtml()` (DOM-based) instead of `stripHtmlTags()` (regex-based), preserving structural HTML for Readability/Defuddle

### Removed

- `stripHtmlTags()` — replaced by `preCleanHtml()` which surgically removes noise elements via DOM while preserving structural HTML tags needed by Readability and Defuddle

### Changed

- **Pi scope migration** — Updated imports from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` to match pi 0.74.0 package scope. Peer dependency updated, lockfile regenerated.
- **Streaming webpull** — `aio-webpull` now streams each page via `onUpdate` as it completes (file path, title, URL, word count). Agent can inspect pages while the pull continues instead of waiting for the entire crawl.
- **Clearer Chrome CDP errors** — Replaced cryptic "CDP launcher not found" and "google-ai.mjs not found" messages with actionable descriptions explaining which features are affected.
- **Persistent search context** — Search→fetch context bridging now uses the session store instead of a global variable. Survives compaction, branching, and session restarts.
- **Improved TypeScript types** — Expanded `types/pi-coding-agent.d.ts` from a bare `registerTool` stub to include `registerCommand`, `registerShortcut`, and `on()` — more accurately reflecting the real `@earendil-works/pi-coding-agent` API.

### Added

- **Playwright runtime warning** — One-time `console.warn` when Playwright is not installed, with install instructions. No more silent fail for JS-rendered page fallback.
- **`AGENTS.md`** — Full project context document covering architecture, tool descriptions, extraction pipeline, security features, caching, rate limiting, and test setup for future agents.

### Fixed

- **SonarCloud security hotspots** — Resolved 13 hotspots across 5 files: command injection (HIGH, 4) in `bin/launch.mjs` and `src/search/chrome.mjs` via `spawnSync` + port/pid validation; regex DoS (MEDIUM, 5) by bounding capture groups in `extractors/common.mjs`, `extractors/selectors.mjs`, and `index.ts`; weak cryptography and PATH injection left untouched per user request.
- **GitHub marker for AI summarization** — Added `>` marker to `pullGitHubRef` to prevent AI summarization on GitHub raw/tree/repo pages (3 previously uncovered code paths).

## [0.2.0] - 2026-05-05

### Fixed

- **Session startup blocked by sync cache scan** — `loadContentCacheFromDisk()` was declared `async` but used only sync FS calls (`readdirSync`, `statSync`, `openSync`, `readSync`) with zero `await`s. JS runs async functions synchronously until the first `await`, so the entire recursive tree scan blocked extension init inline. Fixed by deferring the scan via `setImmediate` and removing the no-op `async`/`Promise<void>` return type. Startup log removed — cache loading is now silent and seamless.
- **Double `max` slice discarded Google search results** — `aio-websearch` applied `max` twice: once per engine (each returned ≤10) and again after merge+dedup (`slice(0, max)`). DDG/Brave results come first in the merge array, so Google's unique results were almost always chopped off. Fixed by decoupling the final cap (fixed 25) from the per-engine request cap (`max`, default 10). Parameter description updated accordingly.
- **Critical: `gh` CLI completely broken** — `ghAvailable()` used `require("node:child_process")` which fails in ESM (`require is not defined`). Silently cached `false` forever, disabling all GitHub CLI features (clone, api, issue/pr listing). Fixed by importing `execSync` directly.
- **`require("node:os")` in `src/google-ai.ts`** — 3 calls replaced with proper ESM `import { tmpdir }`.
- **`require("pdf-parse")` in `index.ts`** — replaced with `createRequire(import.meta.url)` for CJS interop.
- Webfetch summarization label corrected from "Gemini" to "Google AI".
- **Brave search results broken** — `parseBraveResults()` used linkedom DOM queries against Svelte-scoped CSS classes (`.snippet`, `.title`, `.description`) that never matched. Rewrote with regex-based chunking on `data-type="web"` divs, extracting URL/title/snippet from raw HTML.
- **SonarCloud: all 20 security hotspots resolved** — S5852 regex DoS (safeRegexTest with 10K input truncation; `/^http:/i` → string ops); S5332 HTTP in test fixtures (nosonar); S7637 short SHA (already full 40-char); S4036 PATH trust comment.
- **SonarCloud: all 18 MAJOR issues resolved** — S5843 regex complexity (split/simplified patterns); S5869+S6397 char class cleanup; S6582 optional chaining (`foo?.bar`); S7721+S4144 duplicate function (removed `_normalizeCacheKey`); S4624 nested template literals (extracted variables); S8233 workflow permissions (moved to job level, then hardened with explicit `contents: read` at workflow level).

### Changed

- **Package description** — Updated to "All-in-one web tools for pi with search (Google, Brave, DDG) and fetch with headless browser AI summarization".
- **AI summarization is now the default for ALL responses** — not just long content (>1800 chars). Short content also gets summarized when CDP is available. Falls back to raw display (short) or truncation (long) when summarization fails.
- **Summarization timeout: 10s → 15s** — empirically tested at 3.5–5s for real pages.
- **Brave search runs in parallel with DDG** — `searchWeb()` now fans out DDG + Brave via `Promise.all` (previously sequential: DDG first, Brave as fallback). Both must complete within the 7s cap.
- **Three-way result deduplication** — DDG, Brave, and Google results are all merged and deduplicated by URL (DDG/Brave take priority over Google on conflict).
- **Search header now shows all engines** — output header changed from `"DDG"` (or `"DDG + Google"`) to `"DDG + Brave"` (or `"DDG + Brave + Google"`) to reflect Brave is always attempted.
- **Search details now include per-engine counts** — `ddgCount`, `braveCount`, and `googleCount` are all tracked separately in the tool result (previously Brave was invisible).

### Added

- **Smart content-type auto-detection** — `pullPage` now automatically detects and handles JSON APIs (pretty-printed in code block), plain text files (wrapped in codeblock), binary downloads (streamed to temp file with filename from Content-Disposition), and client-side `<meta>` refresh redirects (followed up to 5 hops). No format switch needed — just fetch any URL and it works.
- **Alternate link fallback** — when Readability extraction produces <30 words (thin HTML shell pages), the HTML `<head>` is scanned for `<link rel="alternate" type="application/json">` entries and the JSON API is fetched automatically. Catches SPAs, docs sites with JSON backends, and API-driven pages.
- **Persistent content cache** — `aio-webcontent` now survives restarts. On startup, `BASE_TEMP` is scanned for `.md` files and their frontmatter URLs are registered in the session store. Content is lazy-loaded from disk on first access — zero memory waste.
- **Token-bucket rate limiter** — per-domain rate limiting (5 req/s, burst 10) in `smartFetch`. All tools (webfetch, webpull, websearch, GitHub API) are throttled politely. The limiter waits (sleeps) when the bucket is empty — no dropped requests.
- **Proxy support** — `proxy` parameter added to `aio-webfetch` and `aio-webpull`. Supports HTTP, HTTPS, and SOCKS5 proxies (`http://user:pass@host:port` or `socks5://host:port`). Routed through to `wreq-js` for all fetches including discovery, bot protection fallback, and alternate link fallback.
- **Search context bridging** — when `aio-webfetch` follows a recent `aio-websearch` (within 5 min), the original search query is injected into the summarization prompt: `"The user searched for: X. Give a concise summary of this page focusing on the user's search topic"` → summaries become context-aware and more focused.

## [0.1.8] - 2026-05-02

### Fixed

- fetchWithPlaywright test now handles both environments (Playwright installed or not) — CI stays green everywhere

## [0.1.7] - 2026-05-02

### Changed

- Expanded npm keywords: pi, pi-extension, web-scraping, web-fetch, crawler, markdown, anti-bot, tls-fingerprinting, pdf-extraction, duckduckgo, brave, llm

## [0.1.6] - 2026-05-02

### Changed

- README.md expanded with full tool parameter tables, extraction pipeline documentation, batch/Playwright/Jina usage examples
- Banner converted from SVG to PNG for broader compatibility
- CI tarball verification now checks for banner.png
- package.json `files` includes banner.png

### Removed

- SonarQube Cloud CI job and stale sonar-project.properties

## [0.1.5] - 2026-05-02

### Added

- Playwright fallback for JS-rendered pages (zero-config — uses system Chrome if installed)
- Playwright graceful degradation test
- Comprehensive README: tool parameter tables, extraction pipeline docs, batch/Playwright/Jina examples

### Changed

- `smartFetch` fallback chain: wreq-js → bot protection → Playwright Chromium
- `playwright` added to `optionalDependencies`
- `README.md` expanded from 3.7KB to 6.3KB with full parameter docs and pipeline details

## [0.1.4] - 2026-05-02

### Added

- 21 new unit tests covering search result parsers, sitemap parsing, and URL discovery (76 total)
- SonarQube Cloud integration with `sonar-project.properties`

### Changed

- Banner: removed version tag and bottom accent line

### Fixed

- GitHub Actions pinned to full commit SHAs
- SonarQube scan action bumped to v8.0.0

## [0.1.3] - 2026-05-02

### Changed

- Banner height reduced from 640px to 500px

### Fixed

- CodeQL: Closing tag regex uses `[^>]*` for robust whitespace/attribute handling
- All 11 CodeQL alerts resolved (6 fixed, 3 second-pass fixes, 2 dismissed as false positives)

## [0.1.2] - 2026-05-02

### Added

- Banner SVG for GitHub and npm package page
- `license` and `repository` fields to `package.json`

### Changed

- CI and release workflows: actions bumped to `checkout@v6` / `setup-node@v6`
- Tarball verification now checks for `banner.svg`
- README updated with banner image

### Fixed

- CodeQL: Added `data:` and `vbscript:` to URL scheme checks
- CodeQL: HTML regex now handles whitespace in closing script/style tags
- CodeQL: `frontmatter()` now escapes backslashes in titles and URLs

## [0.1.1] - 2026-04-30

### Added

- TTL cache support
- Retry logic for web requests
- Redirect detection
- HTTPS upgrade handling
- Preview truncation improvements
- Expanded test coverage
- Pi manifest, tsconfig, and type declarations

### Fixed

- `webpull` `promptSnippet` handling
- Regenerated `package-lock.json` to sync with `package.json`

### Changed

- Bump patch version to 0.1.1

## [0.1.0] - 2026-04-30

### Added

- Initial release of pi-webaio
- `aio-websearch` tool - Search the web using DuckDuckGo or Brave
- `aio-webfetch` tool - Fetch single/batch URLs and convert to markdown
- `aio-webcontent` tool - Retrieve cached content from session storage
- `aio-webpull` tool - Pull entire sites via sitemap/crawling
- Anti-bot TLS fingerprinting (chrome_145, firefox_147, safari_26, edge_145)
- GitHub-aware fetch (clones repos, uses API for trees/blobs)
- PDF extraction support
- RSC (Next.js) extraction
- Secret scanning in URLs
- Prompt injection detection
- Session storage for cached content
