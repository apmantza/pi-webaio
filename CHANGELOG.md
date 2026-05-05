# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Critical: `gh` CLI completely broken** — `ghAvailable()` used `require("node:child_process")` which fails in ESM (`require is not defined`). Silently cached `false` forever, disabling all GitHub CLI features (clone, api, issue/pr listing). Fixed by importing `execSync` directly.
- **`require("node:os")` in `src/google-ai.ts`** — 3 calls replaced with proper ESM `import { tmpdir }`.
- **`require("pdf-parse")` in `index.ts`** — replaced with `createRequire(import.meta.url)` for CJS interop.
- Webfetch summarization label corrected from "Gemini" to "Google AI".
- **Brave search results broken** — `parseBraveResults()` used linkedom DOM queries against Svelte-scoped CSS classes (`.snippet`, `.title`, `.description`) that never matched. Rewrote with regex-based chunking on `data-type="web"` divs, extracting URL/title/snippet from raw HTML.
- **SonarCloud: all 20 security hotspots resolved** — S5852 regex DoS (safeRegexTest with 10K input truncation; `/^http:/i` → string ops); S5332 HTTP in test fixtures (nosonar); S7637 short SHA (already full 40-char); S4036 PATH trust comment.
- **SonarCloud: all 18 MAJOR issues resolved** — S5843 regex complexity (split/simplified patterns); S5869+S6397 char class cleanup; S6582 optional chaining (`foo?.bar`); S7721+S4144 duplicate function (removed `_normalizeCacheKey`); S4624 nested template literals (extracted variables); S8233 workflow permissions (moved to job level, then hardened with explicit `contents: read` at workflow level).

### Changed

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
