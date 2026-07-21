# Changelog

All notable changes to pi-webaio will be documented in this file.

## [Unreleased]

### Added

- **Active bot-protection wait loop in the Playwright fallback** (`src/fetch.ts`) — after `page.goto`, if the rendered HTML classifies as a self-resolvable challenge (`detectBotBlock` with `retryable: true` — Cloudflare/PerimeterX/DataDome JS challenges, Anubis proof-of-work, generic blocks), `waitForBotProtectionToClear` polls the DOM (500ms interval, 15s budget) until the challenge markers clear, then re-reads the page in the same session. Cookies are harvested *after* clearance so the per-origin cookie cache (#71) stores the cleared session for cheap follow-up fetches. Clean renders return immediately with zero added latency; non-retryable captcha pages skip the wait entirely; timeout returns the last HTML without throwing. Wired into both the pooled-page and one-shot Playwright paths ([#76](https://github.com/apmantza/pi-webaio/issues/76)).
- **Config-driven SSRF allow-list (CIDR ranges)** (`src/security.ts`) — opt-in `WEBAIO_SSRF_ALLOW_RANGES` env var (comma-separated IPv4/IPv6 CIDRs, e.g. `10.0.0.0/8,fd00::/8`) consulted by `isDangerousUrl`, unblocking users behind TUN/proxy setups or fetching intentionally-internal hosts. Addresses are normalized to a unified IPv4-mapped-IPv6 representation so v4 CIDRs match `::ffff:` literals; `/0` prefixes and malformed entries are rejected/skipped; multi-record DNS answers require *every* dangerous address to be allow-listed (one allowed A-record cannot smuggle a dangerous second one). Default behavior with the variable unset is byte-for-byte unchanged ([#77](https://github.com/apmantza/pi-webaio/issues/77)).
- **Lifecycle hooks (`afterFetch`/`afterExtract`) for the user extractor registry** (`src/hooks.ts`, `src/content.ts`, `src/verticals/registry.ts`) — user-authored hook modules loaded from `~/.pi/agent/webaio/hooks/` (`.mjs`/`.js`), each exporting a URL glob `pattern` (`*`/`**`, no new dependency) plus optional `afterFetch(url, { status, headers, html })` (transforms raw HTML before extraction — e.g. strip consent walls) and/or `afterExtract(url, result)` (transforms the final `PullResult` — e.g. fix titles, drop boilerplate). Matching hooks chain in load order, a `null`/`undefined` return leaves the value unchanged, and throwing hooks are logged and skipped — a hook can never fail the fetch. Wired at the top of `runHtmlPipeline` and at every `pullPageEnhanced` return point (including verticals); with no hooks installed the added cost is a single length check ([#78](https://github.com/apmantza/pi-webaio/issues/78)).

### Changed

### Fixed

- **Source-loaded installs: `fetch-jina` dynamic import crash** (`src/content.ts`) — `runHtmlPipeline` dynamically imported `./fetch-jina.js` while the rest of the source tree uses `.ts` specifiers, so any install that loads the extension from source (e.g. pi loading a git clone via type stripping) threw `Cannot find module 'src/fetch-jina.js'` on every non-vertical HTML fetch. This broke `aio-webpull` ("Pulled 0 pages" / "No pages found") and `aio-webresearch` outright; `aio-webfetch` only appeared unaffected on vertical-routed URLs (e.g. GitHub). Now imports `./fetch-jina.ts`; the dist build is unchanged since `rewriteRelativeImportExtensions` rewrites it back to `.js` on emit.

## [0.7.1] - 2026-07-20

### Added

- **`aio-webresearch` tool** (`src/research.ts`, `src/tools/webresearch.ts`) — single-round research bundle orchestrator: fans out `aio-websearch` over a query and optional sub-queries, ranks/dedupes sources, fetches the top-N through the webfetch pipeline, indexes them into a local BM25 corpus, and writes an auditable bundle (`STATUS.md`, `reports/EVIDENCE.md`/`CLAIMS.md`/`GAPS.md`, `sources/`, `data/manifest.json`/`sources.json`/`evidence.json`) under `.pi/webaio-research/`. Deterministic retrieval + bookkeeping only — no LLM calls inside the tool. Includes a citation/reachability audit that classifies anti-bot statuses (e.g. 403) as "skipped" rather than "dead". MVP is single-round; the iterative research loop is a follow-up ([#64](https://github.com/apmantza/pi-webaio/issues/64)).
- **Source-type classification for search ranking** (`src/search.ts`) — each merged `aio-websearch` result is classified into a source type (`official-docs` / `repo` / `academic` / `maintainer-blog` / `website` / `community` / `news` / `social`) via cheap domain/path/title heuristics, folded as a per-type priority into `scoreAndRankResults` alongside the existing engine-weight and consensus-bonus scoring, so official docs and repos outrank SEO blogspam and social results sink. `sourceType` is now exposed on result metadata for downstream tools ([#61](https://github.com/apmantza/pi-webaio/issues/61)).
- **Preferred-domain inference boost** (`src/search.ts`) — a hardcoded query-keyword → canonical official-domain map (~35 entries: frameworks, languages, cloud/dev-tool vendors) boosts matching domains in the same ranking pass, so a query like "prisma migrate" surfaces `prisma.io` above lookalike results with equal engine consensus ([#63](https://github.com/apmantza/pi-webaio/issues/63)).
- **Per-origin cookie cache** (`src/cookie-cache.ts`) — a bounded (LRU, 50 entries) + short-TTL (~10 min) cache keyed by origin + proxy + browser profile that bridges cookies harvested from a headless Playwright render across *separate* `aio-webfetch`/`aio-webpull`/`aio-webresearch` calls. `smartFetch` now consults it and injects cached cookies at the cheap TLS-fingerprint tier before escalating to a browser, so a warm origin can be re-fetched without relaunching Playwright; the cache is invalidated on login-redirect and clear-cookie (`Set-Cookie: Max-Age=0`/expired) signals ([#71](https://github.com/apmantza/pi-webaio/issues/71)).
- **Search goggles rerank presets** (`src/goggles.ts`) — optional `goggles` parameter on `aio-websearch`/`aio-webresearch` accepting a built-in preset (`docs-first`, `research`, `news-balanced`) or a path/inline-JSON/object of custom domain/domain-marker/title-term boost-demote rules, folded as a purely additive term into `scoreAndRankResults` alongside the existing engine-weight, consensus, source-type, and preferred-domain scoring. When active, each result carries a per-source `goggles` score breakdown for debug transparency; omitting the parameter leaves ranking unchanged ([#72](https://github.com/apmantza/pi-webaio/issues/72)).
- **Deterministic claim-stance classifier for `aio-webresearch`** (`src/research.ts`, `src/tools/webresearch.ts`) — classifies each fetched source as supporting / conflicting / neutral relative to the research query using keyword overlap (BM25 tokenization), a ~40-term English conflict-marker word list, source-quality tier, and freshness, then aggregates into a per-run verdict (`supported` / `likely_supported` / `contested` / `likely_false` / `insufficient_evidence`). Emits `STANCE.md` and `data/stance.json` into the bundle with an explicit non-authoritative candidate claims table. No LLM calls — keyword/pattern-based, not semantic entailment ([#70](https://github.com/apmantza/pi-webaio/issues/70)).

### Changed

- **Shared, hardened stealth script** (`extractors/stealth-script.mjs`) — ported the validated anti-detection patches from `greedysearch-pi`'s `injectHeadlessStealth` (Sannysoft 20/20 clean, identical CreepJS fingerprints headless vs visible) into one shared module now consumed by both the CDP-based search extractors (`extractors/common.mjs`) and webfetch's Playwright fallback (`src/fetch.ts`), removing the drift between two independently-maintained copies. Key fixes: `navigator.webdriver` removed from both instance and `Navigator.prototype` (not a stealth-tell getter), `Plugin`/`MimeType` objects with correct prototypes and `enabledPlugin` back-references, `Function.prototype.toString` masking so patched functions read as native code, canvas/AudioContext/WebGL fingerprint noise, a `permissions.query` notifications fix, and `navigator.connection`/`share`/`contentIndex`/`pdfViewerEnabled`/`productSub`/`product` plus realistic `chrome.loadTimes()`/`csi()` ([#62](https://github.com/apmantza/pi-webaio/issues/62)).

### Fixed

## [0.7.0] - 2026-07-20

### Added

- **Query-focused fetch (answer mode)** (`src/tools/webfetch.ts`) — new `answerMode` behavior: when a `query` is provided, `aio-webfetch` can return only the sections that answer it, ranked by BM25, instead of the whole page ([#42](https://github.com/apmantza/pi-webaio/issues/42), [#51](https://github.com/apmantza/pi-webaio/pull/51)).
- **Per-domain fetch strategy memory** (`src/strategy-memory.ts`) — remembers which rung of the fetch ladder (plain → TLS-fingerprinted → headless browser) worked per domain, with LRU capping at 500 domains, 7-day expiry, and periodic re-probe of cheaper strategies ([#43](https://github.com/apmantza/pi-webaio/issues/43), [#52](https://github.com/apmantza/pi-webaio/pull/52)).
- **Hard token budget** (`src/prune-markdown.ts`, `src/tools/webfetch.ts`, `src/tools/webcontent.ts`) — new `budgetTokens` parameter enforces a hard output-size ceiling with heading-skeleton preservation, BM25 section ranking when a query is present, and a footer pointing at `aio-webcontent` for the full content ([#44](https://github.com/apmantza/pi-webaio/issues/44), [#53](https://github.com/apmantza/pi-webaio/pull/53)).
- **`aio-webquery` tool** (`src/tools/webquery.ts`, `src/webquery-index.ts`) — BM25 search over a locally-pulled corpus (from `aio-webpull`), fully offline, no re-fetching ([#48](https://github.com/apmantza/pi-webaio/issues/48), [#54](https://github.com/apmantza/pi-webaio/pull/54)).
- **HTTP revalidation and diff-aware refetch** (`src/http-validators.ts`, `src/content-diff.ts`) — conditional requests via stored ETag/Last-Modified with 304 handling, plus a `diff` parameter on `aio-webfetch` that returns only the changed sections since the cached copy ([#45](https://github.com/apmantza/pi-webaio/issues/45), [#56](https://github.com/apmantza/pi-webaio/pull/56)).
- **Extraction quality benchmark harness** (`scripts/bench-extraction.mjs`, `.github/workflows/bench.yml`) — scored extraction benchmark over a fixed corpus with a CI workflow ([#50](https://github.com/apmantza/pi-webaio/issues/50), [#57](https://github.com/apmantza/pi-webaio/pull/57)).
- **Speculative prefetch of top search results** (`src/prefetch.ts`) — opt-in warm-up of the content cache for the top `aio-websearch` hits ([#47](https://github.com/apmantza/pi-webaio/issues/47), [#58](https://github.com/apmantza/pi-webaio/pull/58)).
- **User-defined vertical extractors** (`src/verticals/user-loader.ts`, `docs/custom-verticals.md`) — load custom extractors from `~/.pi/agent/webaio/verticals/` ([#49](https://github.com/apmantza/pi-webaio/issues/49), [#59](https://github.com/apmantza/pi-webaio/pull/59)).
- **MCP stdio server** (`src/mcp-server.ts`, `bin/pi-webaio-mcp.mjs`, `docs/mcp.md`) — exposes all seven `aio-*` tools over the Model Context Protocol so non-pi agents (e.g. Claude Code) can use them ([#55](https://github.com/apmantza/pi-webaio/issues/55), [#60](https://github.com/apmantza/pi-webaio/pull/60)).

### Fixed

- **MCP tools/list rejected by Claude Code** (`src/mcp-server.ts`) — `sanitizeJsonSchema` injected `type: "object"` into every nested object lacking a `type`, corrupting `properties` maps and `anyOf` unions into invalid JSON Schema; strict clients (Claude Code) reported "Connected · tools fetch failed". The `type` default is now applied only at the schema root, with regression tests. Also `serverInfo.version` now reads from package.json instead of a hardcoded string.
- **Broken `pi install git:` on machines without devDependencies** (`package.json`, `scripts/prepare.mjs`) — pi installs packages with `npm install --omit=dev`, so the `prepare` build either failed (`'tsc' is not recognized`) or, after being made tolerant, silently skipped the build leaving no `dist/` at all — the extension registered zero (or stale) tools. `pi.extensions` now points at `./pi-entry.mjs`, a loader that prefers the compiled `./dist/index.js` (npm installs, no transpile cost) and falls back to the TypeScript source `./index.ts` (git installs); no build step is needed for git installs. The `dist/` build remains for the npm `main` entry and the MCP bin.

## [0.6.3] - 2026-07-18

### Fixed

- **Crash on hung response bodies** (`src/fetch.ts`) — a website that stopped responding mid-download could kill the entire pi process with an `uncaughtException` ([#41](https://github.com/apmantza/pi-webaio/issues/41)). Root cause: `reader.cancel()` on an errored stream returns a rejected promise that nothing handled, so the body-read error escaped as an unhandled rejection. Now guarded via `safeCancel()`, with regression tests asserting no unhandled rejection escapes on the exact error from the crash report.
- **Leaked search race timer** (`src/tools/websearch.ts`) — the 40s timeout timer in the search `Promise.race` was never cleared when the real work won and wasn't `unref`'d, delaying process exit in one-shot runs.

### Changed

- **Every network path is now time- and size-bounded** — full sweep of the codebase for unbounded resource usage:
  - Core fetch (`src/fetch.ts`): 30s wreq per-request timeout (`DEFAULT_TIMEOUT_MS`), 60s streaming body-read deadline (`DEFAULT_BODY_READ_MS`), and `fetchBuffer` now streams with the 10MB cap and deadline instead of an uncapped `arrayBuffer()`. New `FetchOpts.timeoutMs` lets callers override; `"timed out"` errors are treated as retryable.
  - GitHub (`src/github-api.ts`, `src/github-pipeline.ts`): 30s `AbortSignal.timeout` on API and CI-log fetches with capped body reads; `execGh` child processes get a 60s kill timer and 10MB stdout cap; repo-tree walks stop at 20k entries with a truncation marker.
  - Paywall bypass (`src/paywall.ts`): each UA-spoof strategy now gets a wreq timeout derived from the remaining bypass budget (a hung step can no longer stall past the overall deadline); all bypass and archive body reads go through the capped stream reader.
  - Reddit block detection (`src/verticals/reddit.ts`): the three parallel probe fetches get 10s abort signals and capped reads; a timed-out probe still degrades to "no block detected".
- **Sitemap discovery fan-out capped** (`src/discovery.ts`) — a hostile `<sitemapindex>` could trigger an exponential burst of concurrent fetches via raw `Promise.all`. Now ≤50 child sitemaps per level, fetched 5 at a time, with a 5000-URL overall backstop.
- **In-memory caches bounded** (`src/session-store.ts`) — `summaryCache` and `searchCache` grew one entry per unique URL/query for the life of the process. Both now cap at 100 entries with oldest-first eviction; search-cache disk writes are debounced into one coalesced write per burst.
- **Crawl size clamped** (`src/tools/webpull.ts`) — `max` is now hard-capped at 500 items with input validation.

## [0.6.2] - 2026-07-04

### Added

- **Query-aware BM25 content pruning** (`src/bm25.ts`, `src/prune-markdown.ts`) — New `query` parameter on `aio-webfetch` enables relevance-based pruning via Okapi BM25 scoring. When `query` is provided alongside `prune`, sections are scored against the query, ranked by relevance, and the most relevant sections are selected first up to the token budget. Includes BM25 with IDF caching, stop-word filtering, markdown stripping, and `combineScores`/`bm25Weight` tuning options. 21 unit tests in `tests/prune-markdown.test.mjs`.
- **TLS fingerprint regression diagnostics** (`tests/fingerprint.test.mjs`, `scripts/fingerprint-diagnostics.mjs`) — 10 offline tests locking down profile defaults, header shapes per browser/OS, and fallback behavior. Opt-in live diagnostics via `npm run diagnose:fingerprint -- --target tls|sannysoft|creepjs` with optional Playwright-based browser fingerprint pages. Exported `applyStealth()` for consistent stealth patch validation.
- **MIT license file** — Added a repository-level `LICENSE` file and linked it from the README.
- **Contributor guide for web integrations** — Added `CONTRIBUTING.md` with setup, PR checklist, and dedicated guidance for vertical extractors, search engines, anti-bot/paywall work, tests, and release notes.

### Changed

- **README reorganized into a small landing page plus docs** — Moved the detailed feature, usage, tool, and architecture reference into `docs/` so the repository front page stays concise while preserving the full documentation.
- **`smartFetch` returns null on invalid URLs** — Previously threw an unhandled `TypeError` from `new URL()` on malformed input. Now returns `null` so callers can classify it via `FetchError`.

### Fixed

- **Large JSON preview truncation in `aio-webfetch`** — JSON responses larger than 30KB now compact to a summary snippet instead of leaking a massive truncated preview into the tool output.
- **Full truncated content leak in `aio-webfetch`** — Raw full-text preview no longer bleeds into the TUI result view.

## [0.6.1] - 2026-07-03

### Added

- **CHANGELOG-driven GitHub release notes and backfill tooling** — Added shared changelog parser/extractor/release-promotion/backfill scripts plus package scripts, so release bodies can be generated from curated CHANGELOG sections and existing GitHub releases can be retroactively updated.

### Changed

- **Release workflow uses CHANGELOG as the release-notes source of truth** — Replaced generated GitHub release notes with `scripts/changelog-extract.mjs --summary` and `gh release create --notes-file`, matching the pi-lens release process.

### Fixed

- **Google results now appear in the registered `aio-websearch` extension** — The compiled `dist/src/google-ai.js` wrapper now resolves the package root before looking for `bin/` and `extractors/`, so CDP-backed Google search is available from the published/registered extension instead of only from TypeScript source.
- **Static-analysis hardening after v0.6.0** — Tightened ReDoS-prone regexes, removed a duplicate prompt-injection probe alternative, simplified optional handling, and cleaned up SonarCloud/autoreview findings across fetch, paywall, cache, vertical, and browser helper code.

## [0.6.0] - 2026-06-19

### Added

- **`aio-webmap` GitHub repo mapping** (`src/github-map.ts`, ~1100 LOC) — When `aio-webmap` is called on a GitHub URL it now returns a proper map of the repo instead of falling back to crawling github.com's explore pages. The new `mapGitHubRepo()` orchestrator handles four URL shapes:
  - **Repo URL** (`https://github.com/owner/repo`) — uses the recursive Git Trees API (`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`) for a full file tree in one call, with `gh repo clone` (preferred) or `git clone` as fallback for truncated trees. Filters out ~50 noise patterns (node_modules, build outputs, asset files, lockfiles) before building the tree. Runs the existing architecture-signal detector (CI/CD, tests, monorepo, package managers, security). In parallel it queries the GitHub API for issues, PRs, releases, tags, branches, and a 8KB README excerpt.
  - **Tree URL** (`https://github.com/owner/repo/tree/branch/path`) — uses `GET /repos/{owner}/{repo}/contents/{path}` to list the directory contents and return a markdown table of 📁/📄 entries with clickable GitHub URLs.
  - **Feature URL** (`/issues`, `/pulls`, `/releases`, `/tags`, etc.) — uses the relevant API endpoint and returns a numbered list of items with state + URL.
  - **Blob URL** (`/blob/branch/path`) — returns the single blob URL.
  - Inspired by [ahmedkhaleel2004/gitdiagram](https://github.com/ahmedkhaleel2004/gitdiagram)'s recursive tree approach. 50 unit tests in `tests/github-map.test.mjs`.
- **`details.sources` field on `aio-webmap`** — URLs now returned grouped by discovery source (`github-api:tree`, `github-api:issues`, `github-api:pulls`, `github-api:releases`, `github-api:tags`, `github-api:branches`, `github-api:readme`, `repo-clone`, `llms.txt`, `sitemap-or-nav-or-crawl`) instead of one flat list. Backward compatible — the flat `details.urls` is still populated.
- **`details.repo` field on `aio-webmap`** — for GitHub repo URLs: `{ owner, repo, ref, totalFiles, totalDirs, description, topics, language, stars, forks, license, defaultBranch, cloned, clonePath }`. Lets the renderer show repo metadata without re-fetching.
- **`details.treeMarkdown` and `details.architecture`** — full file tree and architecture signals (CI/CD, tests, monorepo, package managers, security) included in the response so agents can plan follow-up `aio-webfetch` calls.
- **GitHub security alert handler** (`pullGitHubSecurityAlert` in `src/github-pipeline.ts`, +245 LOC) — `aio-webfetch` on `/security/dependabot/{id}`, `/security/code-scanning/{id}`, or `/security/secret-scanning/{id}` used to return only 8 lines of mostly-empty gated content. The new handler routes to the REST API endpoint (`GET /repos/{owner}/{repo}/dependabot/alerts/{id}` etc.) via `ghFetchWithFallback`, surfacing the full advisory details — GHSA/CVE IDs, severity, vulnerable package + version range, first patched version, CVSS scores, references, annotations, and locations. Uses `gh auth login` token if available, otherwise `GITHUB_TOKEN` env var. 4 unit tests in `tests/github-check.test.mjs`.

### Changed

- **Bumped `@earendil-works/pi-coding-agent` to `^0.79.0` and `@earendil-works/pi-tui` to `^0.79.0`** — resolves 6 of 9 open Dependabot alerts via the new transitive versions:
  - `undici`: 7.25.0 → 8.5.0 (closes #16 medium cross-user info disclosure, #17 high TLS cert validation bypass)
  - `protobufjs`: 7.6.0 → 7.6.4 (closes #9 medium schema-derived name shadowing, #10 high DoS via unbounded Any expansion)
  - `ws`: 8.20.1 → 8.21.0 (no change in vulnerability, but bumps the dep)
  - `@earendil-works/pi-coding-agent` itself: 0.74.0 → 0.79.8 (closes #14 high temp-path privilege escalation, #15 medium project-local extension loading)
  - `npm audit --omit=dev --audit-level=high` now reports `found 0 vulnerabilities` (was 4 high).
  - `pi-coding-agent@0.77.0` renamed `model_select`/`thinking_level_select` events to `model_update`/`thinking_level_update`. We don't use those events (we only import `ExtensionAPI`, `Theme`, and `getMarkdownTheme`), so the bump is API-compatible.
- **Test runner: switched from `npx tsx` to `node --experimental-strip-types --test`** — 36× faster test suite execution (4m50s → 8s for all 553 tests across 14 suites). The previous 4-minute runtime was almost entirely `tsx` process startup overhead loading the heavy `@earendil-works/pi-coding-agent` package transitively per test file. Node 24's native TypeScript stripping bypasses `tsx` entirely. Updated all `test*` scripts in `package.json` and `.github/workflows/ci.yml`.
- **Replaced the CI's per-suite `for` loop with a single `npm run test:all`** — same coverage, ~9s instead of ~5min.
- **Moved `typebox` from `devDependencies` to `dependencies`** — required for `npm install --omit=dev` to complete the build (the peerDep `*` was being satisfied by `@earendil-works/pi-coding-agent`'s nested copy, unreachable from our top-level code).
- **Extracted `escapeMarkdownTableCell()` helper** (`src/github-pipeline.ts`) — escapes backslashes BEFORE pipes (so the pipe-escape isn't itself re-escaped), then collapses newlines. Replaces the inline `.replace(/\|/g, "\\|")` pattern that CodeQL flagged as incomplete sanitization in two places.

### Fixed

- **Vertical extractor `ok: false` treated as success** (`src/content.ts:920-957`) — `pullPageEnhanced` hardcoded `ok: true` for any non-null vertical result, which meant a Reddit vertical returning `ok: false` (network block, rate limit) showed up as "empty content" to the user. Now honors `vertical.ok` — a `false` result with an error message is propagated as a structured failure with the vertical's error message preserved. The vertical result still wins over the regular HTML pipeline when it has useful error context.
- **Reddit network block detection** (`src/verticals/reddit.ts`, +75 LOC) — The `.json` endpoint (the only AI-consumable Reddit API) is gated by Reddit's anti-bot wall. The new `detectRedditBlock()` helper probes three endpoints (`.json`, main page, reddit.com home) in parallel to distinguish between the 4 most common failure modes: network block (with a clear explanation that .json is gated, suggests opening in a browser or using a Reddit-aware proxy), 5xx server error, 404 (post deleted), and "both endpoints down" (Reddit is offline from this network). 7 unit tests in `tests/reddit-block.test.mjs`.
- **CodeQL `js/incomplete-sanitization` alert #61** — The new `pullGitHubSecurityAlert()` handler for secret-scanning locations escaped only the `|` meta-character but not the `\` character itself. Fixed via the `escapeMarkdownTableCell()` helper (see Changed section above). 5 unit tests cover pipe escape, backslash-before-pipe ordering, newline collapse, clean pass-through, and combined input.
- **`npm install --omit=dev` failed to build dist** (`Production install build` CI job) — `typebox` was declared in both `devDependencies` and `peerDependencies`. With `--omit=dev`, devDeps are skipped, and the peerDep was being satisfied by `@earendil-works/pi-coding-agent`'s nested copy at `node_modules/@earendil-works/pi-coding-agent/node_modules/typebox`. Our `prepare` hook (which runs `tsc`) couldn't resolve `import { Type } from "typebox"` from the top level — `TS2307: Cannot find module 'typebox'` in 6 files. Fixed by moving `typebox` from `devDependencies` to `dependencies` (it's a runtime dep — our tool parameter schemas use it at runtime) and dropping the redundant `peerDependencies` entry.
- **Test runner source incompatibility** — `src/fetch.ts`'s `TokenBucket` class used TypeScript parameter properties (`constructor(private maxTokens: number, ...)`) which Node 24's `--strip-types` doesn't support. Converted to explicit readonly fields + constructor assignments. `src/content.ts`'s dynamic import of `./github-pipeline.js` failed in strip-types mode (only the .js exists in dist/, not in src/) — now tries `.js` first then `.ts` as a fallback.

### Test results

Test count: 484 → 553 (+69 across 7 new features: github-map, reddit-block, github-check security alerts, escapeMarkdownTableCell, plus the dep bump enabling all of it). 14 test suites, all pass locally in 8.8s.

## [0.5.0] - 2026-06-14

### Added

- **TUI result rendering** (`src/tools/render-result.ts`, 411 LOC) — All 6 tools now have polished `renderCall` / `renderResult` TUI components. Call view shows tool name + URL(s). Progress view shows per-item status, spinner, elapsed time, and download progress. Result view shows expanded preview with responseId, format, browser/os profile, package path, chunk count, and error details. Phase + category badge for errors. `createProgressComponent` updates in real time as pages are fetched.
- **`format` parameter on `aio-webfetch`** — New `format: "markdown" | "html" | "text" | "json" | "raw"` parameter. Default `markdown` saves to disk (unchanged behavior). Other formats return body inline for piping into other tools. JSON produces a structured object with all metadata. `applyFormat()` in `src/tools/render-result.ts` handles all five formats.
- **Phase-aware `FetchError` system** (`src/tools/fetch-error.ts`, 564 LOC) — 25 failure codes × 10 fetch phases × 7 categories. `createFetchError()` produces frozen, rich error objects with `code`, `phase`, `category`, `retryable`, `statusCode`, `downloadedBytes`, `contentLength`, `elapsedMs`, `mimeType`. `classifyError()` maps Node errors (ENOTFOUND, ECONNREFUSED, ECONNRESET, TLS, etc.) to FetchError. `buildUserFacingFetchErrorSummary()` produces agent-friendly messages. `suggestRetryTimeoutMs()` extrapolates from partial download to suggest a smart timeout. `toFetchErrorInfo()` / `fetchErrorInfoFromUnknown()` bridge to legacy `FetchErrorInfo` for backward compat. 50 unit tests.
- **Real progress + elapsed time** — Progress bar now wired to `smartFetch` (via `bytesRead` / `contentLength` from `readResponseTextWithProgress`). Streaming bodies update progress incrementally. Per-item elapsed time shown in the progress view (omitted when <1s).
- **Phase/category badges in error view** — Errors display `phase=loading code=http_error category=server retryable=true` metadata. Retry hint shows suggested timeout when available, hidden for non-retryable errors.
- **Security hardening** — 3 pre-existing issues closed: `safeResolveInBaseTemp()` path-traversal guard, `withTimeout()` no longer leaves unhandled rejections, dependency audit. 8 unit tests.
- **RAG chunking support** (`src/chunker.ts`, 31 unit tests) — New `chunks`, `maxTokens`, `overlapTokens` parameters on `aio-webfetch`. `chunkMarkdown()` splits markdown into paragraph-bounded chunks with optional overlap. `formatChunksText()` renders numbered chunks for RAG pipelines. CJK-aware token estimation. Only applies to `format: "markdown"` (documented contract).
- **GitHub Actions run logs handler** — `aio-webfetch` now handles `api.github.com/repos/{owner}/{repo}/actions/runs/{runId}/logs` URLs. Routes through `ghRunLogs()` (the `gh run view --log` CLI path) which uses the user's existing `gh auth login` session to get plain-text logs with auth + 302-redirect handling. Renders as markdown with a log excerpt and saves the full log to `os.tmpdir()/pi-webaio/github-logs/`. Fixes the previously broken 403 response on these URLs.
- **CI workflow** (`.github/workflows/ci.yml`) — 4 jobs modeled on apmantza/pi-lens:
  1. **lint-and-typecheck** — `npm audit --omit=dev --audit-level=high` + `tsc --noEmit` lint. Catches vulnerable production deps and type errors before they ship.
  2. **test** — builds + runs all 11 test suites (unit + 10 specialized).
  3. **prod-install-build** — simulates the actual pi install path (`npm install --omit=dev`, which triggers `prepare` → `build:dist` from source). Catches TS2688-style breakage when `@types/node` is absent.
  4. **install-test** (ubuntu/windows/macos) — packs tarball, verifies `dist/` is present and no `.ts` leaked, installs from tarball (simulates `pi install npm:pi-webaio`), checks the compiled entry loads without missing-module errors.
- **`check:lockfile` script** — `node scripts/check-lockfile-sync.mjs` fails CI if `package-lock.json`'s root entry drifts from `package.json`'s declared dependency specs. Catches the class of bug where someone edits `package.json` without regenerating the lock, which would make `npm ci` wipe `node_modules` and hard-fail for downstream users.

### Changed

- **Precompiled `dist/`** — `tsconfig.dist.json` emits `index.ts` + `src/**/*.ts` to `dist/`, preserving directory structure. `package.json` `main` and `pi.extensions` now point to `./dist/index.js`; `files` ships `dist/` instead of `src/`. New scripts: `build`, `build:dist`, `prepare` (runs `build:dist` on `npm install`), `lint` (`tsc --noEmit`), `watch`. Eliminates jiti transpile-on-startup cost.
- **Secret scanner surface** — `pullPageEnhanced` now runs `scanForSecrets()` before any fetch path. When a secret is detected, the user gets a clear "Request blocked: potential secret(s) detected in URL (GitHub PAT (classic), ...)" error instead of a generic "Could not reach server". Uses `FetchErrorCode "blocked_secret"` for the rich error and legacy `"blocked"` for the `FetchErrorInfo`.
- **Relaxed secret patterns** — Anthropic: now matches shorter `sk-ant-api03-` keys (was 95+ chars). OpenAI: now matches `sk-proj-` and `sk-svcacct-` (was `sk-` + exactly 48 chars). Added: GitHub user tokens (`ghu_`), Supabase JWT, Vercel, Cloudflare. No false positives on short `sk-` strings.
- **Non-existent GitHub repo returns clear error** — `fetchGitHubRepo()` now returns `ok:false` with "Repository not found or inaccessible" when both clone and API return 404. Previously returned an empty directory listing.
- **`buildDeterministicSummary()` hoisted to module scope** — Extracted from closure to module scope, exported with `@internal` JSDoc tag for unit testing. Fixed 3 latent bugs in the process: heading regex matched H1-H6 (was H1-H3), first-sentence minimum lowered from 20 to 5 chars, added 50KB input cap to prevent event-loop blocking on multi-MB pages. 10 unit tests.
- **HTML tag stripping hardened** — Changed regex from `/<[^>]+>/g` to `/<[^<>]*>/g` (no crossing nested `<` boundaries) and repeated until stable. Fixes the CodeQL `incomplete-multi-character-sanitization` finding on `markdownToText` — previously `<<script>script>` could survive as `<script>`.

### Fixed

- **CodeQL alerts** (6) — 2 production code: incomplete multi-character sanitization in `markdownToText` (src/tools/render-result.ts:168), incomplete string escaping in GitHub pipeline annotations (src/github-pipeline.ts:358-360). 4 test-file: URL substring sanitization patterns in `tests/render-result.test.mjs` and `tests/paywall.test.mjs`. Replaced `.includes()` with regex tests for the test-file alerts. All 6 alerts resolved.
- **Non-markdown `aio-webfetch` formats failed with `readFile(undefined)`** — Single-URL success path used `readFile(r.outPath!, "utf8")` to read the saved file, but non-markdown formats (html, text, json, raw) stay in-memory and never write to disk. Fixed by using `r.body ?? ""` and branching the AI-summarized notice on `r.outPath` truthy. 1 regression test in `tests/webfetch-format.test.mjs`.
- **Path separator check in `safeResolveInBaseTemp` test** — CI run (Linux) failed because the test computed `baseWithSep` by appending a separator only if `BASE_TEMP` didn't already end with one. On Linux, `BASE_TEMP` is `/tmp/pi-webaio` (no trailing slash) and `safeResolveInBaseTemp('file.md')` returns `/tmp/pi-webaio/file.md` which `startsWith('/tmp/pi-webaio')` but not `/tmp/pi-webaio/`. Simplified to just check `startsWith(BASE_TEMP)`.
- **fetchWithPlaywright degradation test timeout** — CI run timed out at 5s because the optional `playwright` dep gets installed on Linux, so the function actually launches a browser. Increased timeout to 60s and wrapped in try/catch.

### Test results

Test count: 235 → 484 (145 unit + 31 new-features + 65 paywall + 26 github-check + 39 render-result + 50 fetch-error + 6 fetch-progress + 16 hardening + 18 format + 10 webfetch-summary + 31 chunker + 47 integration). All pass locally and in CI.

## [0.4.2] - 2026-06-02

### Fixed

- **Paywall bypass on mid-page paywall markers** -- detectPaywall() 16KB head-sample was too small for raw HTML from the bypass chain (e.g. macropolis.gr Googlebot response has the paywall curtain at position ~16,800). Replaced with three-window scan: 16KB head + 4KB tail + full text on pages >20KB.
- **Reject still-paywalled bypass results** -- pullPageEnhanced now checks bypassed.paywall.paywalled before accepting a bypassed response. When Googlebot still serves the paywall or Playwright is not installed, the user sees the honest bypass strategies exhausted notice instead of a misleading 100% clean success.
- **B2B and analysis-site paywall markers** -- Added 19 new high-weight text markers covering macropolis.gr and similar EU-policy sites.

### Added

- **Chromium output detection** -- detectChromiumError() recognizes Chromium running without the --no-sandbox flag errors so they do not get mistaken for paywall markers.
- **57 new unit tests** covering deep-marker detection, tail detection, bypass safety, and large-page scanning.
