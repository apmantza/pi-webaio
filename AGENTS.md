# pi-webaio — Agent Context

## What is this?

pi-webaio is an **all-in-one web tools extension** for [pi](https://pi.dev) (the coding agent) that provides search, fetch, crawl, extraction, discovery, storage, compilation, RAG chunking, query-focused answer mode, offline corpus search, single-round research bundles, phase-aware error handling, TUI rendering, and (v0.4.1+) opt-in paywall bypass capabilities via 8 tools: `aio-websearch`, `aio-webfetch`, `aio-webcontent`, `aio-webresult`, `aio-webmap`, `aio-webpull`, `aio-webquery`, and `aio-webresearch`. It's published as `npm:pi-webaio` and installable via `pi install npm:pi-webaio`. The same eight tools are also exposed to non-pi MCP clients (Claude Code, Claude Desktop, etc.) through a stdio MCP server (`bin/pi-webaio-mcp.mjs`, `src/mcp-server.ts`).

**Current version: 0.8.0** — Context7 + DeepWiki verticals (21 built-in extractors), multi-source **cited** answer mode (`urls`+`query`), outline mode + frugal default preview, opt-in AI summarization, compact search, per-engine search status/latency + ~4.5s deadline, shared warm browser pool, lazy Jina extraction, CSS-cruft stripping (incl. `@media`) + heading-detection fallback, source trust-tier grading, content-hash dedup + `aio-webcontent` diff, local-knowledge pre-check, plus the SSRF/secret-redaction hardening from 0.7.3. 1207 tests / 51 suites.

> **Internal-docs policy:** research / audit / inspiration notes — `docs/inspirations*.md`, `docs/pagemap-inspiration.md`, `docs/observability-gaps.md`, `docs/perf-improvements.md`, and root-level `inspiration7.md` — are **local-only working artifacts**. They are gitignored and must **never** be committed or shipped. Only user-facing docs (`README.md`, `docs/{features,tools,usage,architecture,custom-verticals,mcp}.md`) plus `ROADMAP.md` / `CHANGELOG.md` / `AGENTS.md` belong in the repo. When auditing or surveying, write findings to these local files, not to tracked docs.

## Architecture

```
pi-webaio/
├── index.ts                  ← Main extension entry point. Registers 8 pi tools.
├── pi-entry.mjs              ← pi.extensions entry. Prefers compiled dist/index.js, falls back to index.ts for git installs.
├── src/
│   ├── google-ai.ts          ← TypeScript wrapper — spawns CDP child processes
│   ├── search.ts             ← HTTP search (DDG, Brave, Yahoo, Bing) + engine health, caching, dedup, source-type ranking, goggles
│   ├── discovery.ts          ← Sitemap parsing, nav link extraction, crawling (fan-out capped)
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
│   ├── outline.ts            ← Heading-tree outline + per-section word counts for the outline/frugal fetch modes (post-0.7.3)
│   ├── multi-answer.ts       ← Cited multi-source answer mode — BM25-rank chunks across fetched URLs, top-k with source citations (post-0.7.3)
│   ├── github-map.ts         ← GitHub-native discovery for aio-webmap (recursive tree API + feature URLs + README + architecture) (v0.5.1)
│   ├── fetch-jina.ts         ← Jina AI Reader proxy fallback (rejects Cloudflare challenge bodies in v0.7.3)
│   ├── html-compress.ts      ← HTML noise attribute stripping
│   ├── injection.ts          ← Prompt injection detection + action (warn/redact/block)
│   ├── interactive-elements.ts ← Extract buttons/links/forms as numbered refs
│   ├── bm25.ts               ← Okapi BM25 scoring with IDF caching and stop-word filtering
│   ├── prune-markdown.ts     ← Score-based markdown pruning to token budget + unified omitted-sections TOC footer (v0.6.2, v0.7.3)
│   ├── security.ts           ← SSRF guard (DNS-pinning, fail-closed, metadata floor, CIDR allow-list) + secret scanner
│   ├── redact.ts             ← Output secret redaction — masks credentials in error messages and TUI previews (v0.7.3)
│   ├── session-store.ts      ← Content cache + search context store (disk-backed), relatedness-gated summary bridging
│   ├── token-count.ts        ← CJK-aware token estimation
│   ├── content.ts            ← Extraction pipeline (vertical → GitHub → binary → JSON → local-first RSC/Readability/defuddle, lazy Jina fallback) + lifecycle hooks
│   ├── content-diff.ts       ← Section-level diff between cached and fresh page versions (v0.7.0)
│   ├── http-validators.ts    ← Conditional requests via stored ETag/Last-Modified with 304 handling (v0.7.0)
│   ├── github-pipeline.ts    ← Full GitHub URL handling (repo/tree/blob/issue/PR/actions run/actions logs/check log/security alert)
│   ├── github-api.ts         ← REST + gh CLI fallback (ghFetch, ghRunLogs, ghApiCall, ghFetchWithFallback)
│   ├── fetch.ts              ← smartFetch, fetchBuffer, fetchWithPlaywright, withTimeout, rate limiter, pinned SSRF lookup, bot-wait loop, soft-block 404→browser escalation, shared warm BrowserPool
│   ├── cookie-cache.ts       ← Per-origin cookie cache bridging Playwright harvests across fetch calls (v0.7.1)
│   ├── strategy-memory.ts    ← Per-domain fetch-ladder memory (which rung worked), LRU + re-probe (v0.7.0)
│   ├── prefetch.ts           ← Speculative prefetch of top search results into the content cache (v0.7.0)
│   ├── goggles.ts            ← Search rerank presets/rules (docs-first, research, news-balanced, custom) (v0.7.1)
│   ├── research.ts           ← Single-round research bundle orchestrator + claim-stance classifier (v0.7.1)
│   ├── source-trust.ts       ← Source trust-tier + evidence-quality grading (classifySourceProfile + caveat reasons) (post-0.7.3)
│   ├── content-hash.ts       ← SHA-256 content hashing for dedup + diff baselines (post-0.7.3)
│   ├── debug.ts              ← Central PI_WEBAIO_DEBUG-gated debug() helper (stderr, MCP-safe) + strategy/cache/search tracing (post-0.7.3)
│   ├── webquery-index.ts     ← BM25 index builder/loader for the aio-webpull corpus (v0.7.0)
│   ├── hooks.ts              ← User lifecycle hooks (afterFetch/afterExtract) loaded from ~/.pi/agent/webaio/hooks/ (v0.7.2)
│   ├── mcp-server.ts         ← MCP stdio server adapter exposing all 8 tools to non-pi clients (v0.7.0)
│   ├── types.ts              ← Shared types (PullResult, FetchOpts, FetchErrorInfo, ScrapeMode)
│   ├── verticals/            ← 21 built-in API-first extractors + user loader
│   │   ├── registry.ts       ← Pattern-matching registry (21 extractors)
│   │   ├── user-loader.ts    ← Loads user-defined verticals from ~/.pi/agent/webaio/verticals/ (v0.7.0)
│   │   ├── types.ts          ← Shared types
│   │   ├── npm.ts            ← npm registry API
│   │   ├── pypi.ts           ← PyPI JSON API
│   │   ├── hackernews.ts     ← Hacker News Firebase API
│   │   ├── reddit.ts         ← Reddit .json endpoint + block detection
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
│   │   ├── gitlab.ts         ← GitLab REST API v4 (known-host gated in v0.7.3)
│   │   ├── context7.ts       ← Context7 library-docs API (keyless two-step search→fetch) (post-0.7.3)
│   │   └── deepwiki.ts       ← DeepWiki repo-Q&A via MCP JSON-RPC (keyless) (post-0.7.3)
│   └── tools/                ← Tool handlers
│       ├── render-result.ts  ← TUI components (call/progress/result), markdownToText, applyFormat, secret redaction (v0.5.0)
│       ├── fetch-error.ts    ← Phase-aware FetchError (26 codes × 10 phases × 7 categories) (v0.5.0, v0.7.3)
│       ├── utils.ts          ← Shared helpers: frontmatter, runInBatches, safeResolveInBaseTemp
│       ├── webfetch.ts       ← aio-webfetch registration + execute (answer mode, budgetTokens, diff, localCheck)
│       ├── webcontent.ts     ← aio-webcontent registration (content-hash dedup, diff mode)
│       ├── webresult.ts      ← aio-webresult registration
│       ├── websearch.ts      ← aio-websearch registration (googleStatus surfacing)
│       ├── webmap.ts         ← aio-webmap registration
│       ├── webpull.ts        ← aio-webpull registration
│       ├── webquery.ts       ← aio-webquery registration (offline BM25 over pulled corpus)
│       └── webresearch.ts    ← aio-webresearch registration (single-round research bundle)
├── bin/
│   ├── cdp.mjs               ← Chrome DevTools Protocol bridge
│   ├── launch.mjs            ← Chrome process lifecycle manager
│   └── pi-webaio-mcp.mjs     ← MCP stdio server executable (pi-webaio-mcp bin)
├── extractors/
│   ├── common.mjs            ← Shared CDP helpers (consumes stealth-script)
│   ├── consent.mjs           ← Google consent dialog handler
│   ├── google-ai.mjs         ← Google AI Mode (udm=50) search
│   ├── google-search.mjs     ← Standard Google search via CDP
│   ├── selectors.mjs         ← DOM selectors for Google's UI
│   └── stealth-script.mjs    ← Shared anti-detection stealth patches (CDP + Playwright)
├── scripts/
│   ├── prepare.mjs           ← prepare hook: locates tsc via typescript/package.json (TS7-safe) and builds dist/
│   ├── check-lockfile-sync.mjs ← Fails CI if package-lock.json drifts from package.json
│   ├── changelog-extract.mjs ← Extracts curated release notes from CHANGELOG.md
│   ├── changelog-release.mjs ← Promotes [Unreleased] to a dated version section
│   ├── backfill-github-releases.mjs ← Retroactively updates GitHub releases with CHANGELOG content
│   ├── bench-extraction.mjs  ← Scored extraction benchmark over a fixed corpus
│   ├── fingerprint-diagnostics.mjs ← Opt-in live TLS/SannySoft/CreepJS diagnostics
│   └── diagnose-backends.mjs ← Opt-in backend doctor: probes gh CLI / Playwright / Chrome (offline) + search engines / Jina (--live)
├── types/
│   ├── pi-coding-agent.d.ts  ← Minimal ExtensionAPI type declaration
│   └── playwright.d.ts       ← Playwright type stub (optional dep)
├── tests/                    ← 51 suites wired into test:all (1207 tests) + standalone suites (mcp, etc.)
├── tsconfig.json             ← Lint config (noEmit, strict, ES2022)
├── tsconfig.dist.json        ← Build config (emits to dist/, includes types/**/*.d.ts)
├── package.json              ← type: "module", pi extension manifest, v0.7.3
└── README.md
```

## The 8 Tools

### 1. `aio-websearch`

- Searches DuckDuckGo, Brave, Yahoo, and Bing plus Google and Reddit CDP companions when Chrome is available
- Google uses headless Chrome via CDP (auto-launched)
- 7-second cap — returns whatever is ready
- 10-minute cache (persisted to disk)
- Parameters: `query` (string), `max` (number, default 15), `google` (boolean, default true), `goggles` (optional rerank preset/rules), `prefetch` (opt-in speculative cache warm of top hits)
- Returns deduplicated, cross-engine-scored results with title, URL, snippet, domain, sources, and a per-result `sourceType` (official-docs, repo, academic, maintainer-blog, website, community, news, social)
- TUI: polished call/progress/result rendering with engine counts and per-result expand
- Google can be skipped with `google: false`; Reddit is independent and remains automatic when CDP is available. When Google is requested but empty, the result carries a `googleStatus` field and a note instead of silently dropping Google (v0.7.3)

### 2. `aio-webfetch`

- Fetches single URL or batch of URLs, converts to markdown
- Anti-bot TLS fingerprinting via `wreq-js` (chrome_145, firefox_147, safari_26, edge_145)
- **`format` parameter** (v0.5.0): `markdown` (default, saves to disk), `html`, `text`, `json`, `raw` (all in-memory)
- **`chunks` parameter** (v0.5.0): RAG chunking. Splits markdown into paragraph-bounded chunks with `maxTokens` (default 512) and `overlapTokens` (default 50). Only applies to `format: "markdown"`.
- **Answer mode** (v0.7.0): with `query` set (and no `prune`), returns only the top-k BM25-ranked sections that answer the query, with heading breadcrumbs; full content stays cached for `aio-webcontent`.
- **`budgetTokens`** (v0.7.0): hard output-size ceiling with heading-skeleton preservation, BM25 ranking when a query is present, and a footer pointing at `aio-webcontent`.
- **`prune`** (v0.6.2): score-based pruning to a token budget; query-aware when `query` is set. Both `prune` and `budgetTokens` share a unified truncation footer with an omitted-sections mini-TOC (v0.7.3).
- **`diff`** (v0.7.0): returns only the sections changed since the cached copy (conditional revalidation via ETag/Last-Modified, 304 handling).
- **TUI rendering** (v0.5.0): custom `renderCall` / `renderResult` components with progress, elapsed time, phase/category badges, retry hints
- **Phase-aware FetchError** (v0.5.0): 26 codes × 10 phases × 7 categories with downloadedBytes, elapsedMs, contentLength for smart retry timeout suggestions
- **Pre-flight secret scan** (v0.5.0): blocks URLs with API keys/tokens before any fetch — returns clear "Request blocked: potential secret(s) detected in URL (GitHub PAT (classic), ...)" instead of generic "Could not reach server"
- **Extraction pipeline** (tries in order, falls through):
  1. Vertical extractors (21 built-in patterns: npm, PyPI, etc., plus user-defined verticals)
  2. GitHub special-case (clone or API for repos/trees/blobs/issues/PRs/actions runs/actions logs/check logs/security alerts)
  3. `api.github.com/repos/{owner}/{repo}/actions/runs/{runId}/logs` (v0.5.0 — via gh CLI)
  4. Binary download detection (PDF by URL, null-byte/ASCII heuristic)
  5. PDF text extraction
  6. JSON detection → pretty-printed code block
  7. Plain text → code block (unless already markdown)
  8. Client-side `<meta http-equiv="refresh">` redirects
  9. Jina AI Reader proxy (`r.jina.ai`) — challenge bodies rejected so the real pipeline runs (v0.7.3)
  10. Mozilla Readability
  11. Next.js RSC (React Server Components) extraction with real title resolution (v0.7.3)
  12. Defuddle HTML-to-markdown (extractor comments stripped)
  13. Fallback: bare-minimum title + text extraction
- **AI summarization** via Google AI Mode (udm=50) using headless Chrome
- Long content auto-summarized by Google AI; full content always saved to file
- Search context bridging: a recent related websearch query is injected into the summary only when BM25-relatedness passes a 0.35 threshold; focused summaries are annotated and cache-keyed separately (v0.7.3)
- Bot protection fallback cycles through alternate browser profiles; active bot-wait loop polls until self-resolvable challenges clear (v0.7.2)
- Secret scanning blocks secret-bearing URLs; secret redaction masks credentials in output/errors (v0.7.3)
- Prompt injection detection (warn/redact/tag)
- **Opt-in paywall bypass** (v0.4.1) — `bypass: true` runs a strategy chain (`archive` → bot UAs → `block_js` → `cookies`) after `detectPaywall()` finds paywall markers (confidence ≥ 0.45). `bypassStrategies: [...]` lets you override the chain order. Set `PI_WEBAIO_DEBUG=1` to log every attempt.

### 3. `aio-webcontent`

- Retrieves previously fetched content from session storage by URL
- Returns **full untruncated content** — no data loss
- Survives restarts (disk cache, lazy-loaded)
- Supports `budgetTokens` + `query` for budget-aware pruning of the stored content
- Parameters: `url` (string)

### 4. `aio-webresult`

- Retrieves previously fetched results by response ID
- Durable storage with 24h TTL (JSON index + content blobs in os.tmpdir())
- Parameters: `id` (string) — response ID from a previous webfetch call
- Shows recent results if the requested ID is not found

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

### 6. `aio-webpull`

- Pulls entire websites into local markdown files
- Discovers pages via sitemap, navigation links, or crawling
- Writes files preserving URL structure with YAML frontmatter, and builds a BM25 index alongside for `aio-webquery`
- Concurrent workers sized by `computePullConcurrency` (10 for single-host pulls, `distinctHosts × 10` capped at 32 for multi-host; rate-limiter-aware, not raw CPU count)
- Parameters: `url`, `out`, `max` (default 100, hard-capped at 500), `mode`, `browser`, `os`, `proxy`, `compile`, `bypass`
- **Request queue**: persistent checkpoint/resume via `resume` param (default: auto-detect). Survives crashes and resumes mid-pull from last checkpoint. Re-pulling a completed site reports "0 new pages (N already completed …)" instead of a bare "Pulled 0 pages" (v0.7.3).
- **Session router**: route different URL patterns to different fetcher modes/extractors via `routes` param. Supports substring, glob (`*/docs/*`), and regex patterns. First match wins.
- **Browser pool**: when mode is `browser` or `auto`, Playwright instances are pooled and reused across pages (saves ~2-3s overhead per page). Auto-recycles after 50 navigations.
- **Adaptive selectors**: `adaptive` flag enables structural fingerprinting — remembers element position to survive site redesigns.
- **Opt-in paywall bypass** (v0.4.1) — `bypass: true` runs the per-domain strategy chain on every page in the pull. Curated top-50 sites (NYT, WSJ, FT, etc.) get tuned strategies; unknown sites use the generic chain (`archive` → `ua:googlebot` → `block_js`).
- Parameters: `resume`, `routes`, `adaptive` (v0.4.0+), `bypass` (v0.4.1+)

### 7. `aio-webquery`

- Searches a locally-pulled corpus (output of `aio-webpull`) using BM25 — fully offline, no re-fetching
- Returns top-k relevant chunks with source file, original URL, and heading breadcrumb
- Parameters: `query` (string), `dir` (corpus dir; relative paths resolve against the temp base, matching `aio-webpull`'s layout — v0.7.3), `topK` (default 8)

### 8. `aio-webresearch`

- Single-round research orchestrator: fans out `aio-websearch` over a query (and optional sub-queries), ranks/dedupes sources, fetches the top-N through the webfetch pipeline, indexes them into a local BM25 corpus, and writes an auditable bundle (`STATUS.md`, `reports/`, `sources/`, `data/`) under `.pi/webaio-research/`
- Deterministic retrieval + bookkeeping only — no LLM calls inside the tool; the calling agent writes the cited claims
- Includes a citation/reachability audit (anti-bot statuses classify as "skipped", not "dead") and a keyword-based claim-stance classifier (`STANCE.md`, `data/stance.json`)
- Per-source fetches are guarded — one throwing source is recorded as `dead` and the run continues (v0.7.3)
- Parameters: `query`, `queries` (sub-queries), `maxSources` (3-12, default 6), `outDir`, `writeBundle`, `goggles`

### MCP server

- `bin/pi-webaio-mcp.mjs` (registered as the `pi-webaio-mcp` bin) starts a stdio MCP server (`src/mcp-server.ts`) exposing all eight `aio-*` tools to any MCP client (Claude Code, Claude Desktop, etc.) without the pi runtime. Tool logic is shared with the pi extension.

## Key Technical Details

### Fetch Stack

| Layer               | Package                       | Role                                                  |
| ------------------- | ----------------------------- | ----------------------------------------------------- |
| Primary fetch       | `wreq-js` ^2.3.0              | Anti-bot TLS fingerprinting, dynamic browser profiles |
| JS rendering        | `playwright` (optional)       | Fallback when wreq fails                              |
| DOM parsing         | `linkedom` ^0.18.12           | Lightweight HTML parser (no jsdom)                    |
| Article extraction  | `@mozilla/readability` ^0.6.0 | Local article → text                                  |
| Markdown conversion | `defuddle` ^0.19.2            | HTML → markdown (extractor comments stripped)         |
| PDF                 | `pdf-parse` ^2.4.5            | Text extraction from PDFs                             |
| Math                | `temml`                       | MathML rendering in extracted content                  |
| MCP server          | `@modelcontextprotocol/sdk`   | stdio MCP adapter for non-pi clients                  |
| TUI components      | `@earendil-works/pi-tui`      | Markdown + text rendering (peer of pi)                |

(`sharp` was removed in v0.7.3 — it was declared but never imported.)

### Build & Distribution

- **Precompiled `dist/`**: `tsconfig.dist.json` emits `index.ts` + `src/**/*.ts` to `dist/`. `package.json` `main` points to `./dist/index.js`; `files` ships `dist/` instead of `src/`.
- **`pi.extensions` → `./pi-entry.mjs`** (v0.7.0): a loader that prefers the compiled `./dist/index.js` (npm installs, no transpile cost) and falls back to the TypeScript source `./index.ts` (git installs, which have no `dist/` and no devDeps). No build step is needed for git installs.
- **`prepare` hook**: `scripts/prepare.mjs` runs on `npm install`. It locates `tsc` by resolving the always-exported `typescript/package.json` and joining `bin/tsc` (TypeScript 7's exports map no longer exposes `./bin/tsc`), then builds `dist/`. The catch is narrowed so only a genuine "typescript not installed" skips the build; any other resolution error fails loudly (v0.7.3).
- **MCP bin**: `bin/pi-webaio-mcp.mjs` ships in `files` and is declared under `bin`.
- **Scripts**: `build`, `build:dist`, `prepare`, `lint` (`tsc --project tsconfig.json`), `watch`, `check:lockfile`, `bench`, `diagnose:fingerprint`, `diagnose:backends`, plus `changelog:*` release helpers.

### New Modules (v0.7.0–v0.7.3)

| Module | Role |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/webquery.ts` + `src/webquery-index.ts` | `aio-webquery`: offline BM25 search over an `aio-webpull` corpus. The index builder serializes per-chunk metadata to JSON alongside the pulled markdown; `resolveCorpusDir` fixes `dir` resolution against the temp base (v0.7.3). |
| `src/research.ts` + `src/tools/webresearch.ts` | `aio-webresearch`: single-round research bundle orchestrator (search fan-out, source ranking, fetch, BM25 index, auditable bundle) plus a deterministic claim-stance classifier. Per-source fetch guard added in v0.7.3. |
| `src/search.ts` | Source-type classification + preferred-domain boost folded into cross-engine ranking; `sourceType` exposed on results (v0.7.1). |
| `src/goggles.ts` | Search rerank presets (`docs-first`, `research`, `news-balanced`) or custom rules, added as a purely additive ranking term (v0.7.1). |
| `src/cookie-cache.ts` | Bounded (LRU 50) + short-TTL per-origin cookie cache bridging Playwright harvests across fetch calls; consulted by `smartFetch` before escalating to a browser (v0.7.1). |
| `src/strategy-memory.ts` | Per-domain memory of which fetch-ladder rung worked, LRU-capped (500) with 7-day expiry and periodic cheaper-strategy re-probe (v0.7.0). |
| `src/prefetch.ts` | Opt-in speculative prefetch of top search hits into the content cache (v0.7.0). |
| `src/http-validators.ts` + `src/content-diff.ts` | Conditional requests via stored ETag/Last-Modified with 304 handling, plus section-level diff for the `diff` parameter (v0.7.0). |
| `src/hooks.ts` | User lifecycle hooks (`afterFetch`/`afterExtract`) loaded from `~/.pi/agent/webaio/hooks/`; throwing hooks are logged and skipped, never failing the fetch (v0.7.2). |
| `src/mcp-server.ts` | MCP stdio adapter exposing all eight tools to non-pi clients (v0.7.0). |
| `src/redact.ts` | Output secret redaction — masks Authorization headers, JWTs, private-key blocks, password-in-URL userinfo, and entropy-guarded key-value credentials in error messages and TUI previews. Additive to the pre-flight blocker (v0.7.3). |
| `src/source-trust.ts` | Source trust-tier + evidence-quality grading — `classifySourceProfile()` maps the existing `sourceType` to trust tiers (authoritative/credible/mixed/community) and emits caveats (community-only, low-diversity, bot-check, possible-conflict) plus diversity metrics; `research.ts` `rankSources()` gains an opt-in `trustBoost` (default off). Feeds the planned F1 research loop (post-0.7.3, unreleased). |
| `src/verticals/user-loader.ts` | Loads user-defined vertical extractors from `~/.pi/agent/webaio/verticals/` (v0.7.0). |

### New Modules (v0.5.0)

| Module | Role |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/chunker.ts` | RAG chunking. `chunkMarkdown(md, { maxTokens, overlapTokens })` returns `Chunk[]`. `formatChunksText()` renders numbered chunks. CJK-aware token estimation. 31 unit tests. |
| `src/tools/render-result.ts` | TUI components. `createCallComponent()`, `createProgressComponent()` (real-time spinner + elapsed time + per-item status), `createResultComponent()` (expanded preview with responseId, format, browser/os, package path, chunk count, error details). `applyFormat()` handles markdown/html/text/json/raw output. `markdownToText()` for TUI display. |
| `src/tools/fetch-error.ts` | Phase-aware FetchError system. 26 failure codes × 10 fetch phases × 7 categories. `createFetchError()` produces frozen rich error objects. `classifyError()` maps Node errors. `buildUserFacingFetchErrorSummary()` produces agent-friendly messages. `suggestRetryTimeoutMs()` extrapolates from partial download. `toFetchErrorInfo()` / `fetchErrorInfoFromUnknown()` bridge to legacy FetchErrorInfo. |
| `src/tools/utils.ts` | Shared helpers: `frontmatter()`, `runInBatches()`, `safeResolveInBaseTemp()` (path-traversal guard). |
| `scripts/check-lockfile-sync.mjs` | Fails CI if `package-lock.json`'s root entry drifts from `package.json`'s declared dependency specs. Catches the class of bug where someone edits `package.json` without regenerating the lock, which would make `npm ci` wipe `node_modules` and hard-fail for downstream users. |

### New Modules (v0.4.0)

| Module                    | Role                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/request-queue.ts`    | Persistent disk-backed URL queue with checkpoint/resume. Tracks queued/in_progress/completed/failed states. Auto-saves every 5s. Max 3 retries per URL. |
| `src/browser-pool.ts`     | Reusable Playwright browser pool. Acquire/release lifecycle, auto-recycle after N navigations, crash recovery, configurable max browsers. |
| `src/session-router.ts`   | URL pattern → fetcher mode routing. Supports substring, glob, and regex patterns. Per-route overrides for mode, extractor, browser, OS. |
| `src/adaptive-selector.ts` | Structural DOM fingerprinting (tag path, text density, child signatures, attributes, sibling position). Weighted similarity scoring (0-1) with 0.45 threshold. Survives class/ID changes. |

### New Modules (v0.4.1 — paywall bypass, gh CLI fallback, check log handler)

| Module | Role |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/paywall.ts` | Paywall bypass engine. `detectPaywall()` (vendor + text marker detection, confidence-scored), `findStrategy()` (curated → group → generic), `bypassUrl()` (orchestrates strategy chain), `stripPaywallText()` (removes residual tails). |
| `src/paywall-sites.ts` | Top-50+ paywall site strategy catalog (`PAYWALL_SITES`, `PAYWALL_GROUPS`, `GENERIC_STRATEGY`). Covers NYT, WSJ, FT, WaPo, The Economist, Le Monde, FAZ, SMH, etc. + group entries for Hearst, Gannett, Advance Local, DPG Media, Condé Nast. |
| `src/github-api.ts` | Added `ghRunLogs()`, `ghApiCall()`, `ghFetchWithFallback()` for gh CLI invocation. `ghRunLogs()` is critical for Actions logs (handles 302→S3 zip redirect + auth internally). `ghApiCall()` is a generic `gh api <path>` wrapper. `ghFetchWithFallback()` wraps `ghFetch()` with a gh CLI fallback for 4xx/5xx errors. Set `PI_WEBAIO_GH_FALLBACK=0` to disable child-process spawning. |
| `src/github-pipeline.ts` (v0.4.1 + v0.5.0) | Added `parseGitHubCheckLogUrl()` and `pullGitHubCheckLog()` for check-log URLs. Added `parseGitHubActionsLogsApiUrl()` and `pullGitHubActionsLogs()` (v0.5.0) for Actions run log API URLs — routes through `ghRunLogs()` so auth + 302→S3 redirects are handled. Fixed `fetchGitHubRepo()` to return `ok:false` with clear "Repository not found or inaccessible" for non-existent repos. |

### Paywall Bypass — Strategy Chain (v0.4.1)

When `bypass: true` is passed to `aio-webfetch` or `aio-webpull`, and `detectPaywall()` returns `paywalled: true` (confidence ≥ 0.45), `bypassUrl()` runs each step in order and returns the first response that no longer contains paywall markers:

| Step | Mechanism | Cost | Bypasses ~ |
| ------ | ----------- | ------ | ----------- |
| `archive` | Wayback Machine then `archive.ph/newest/{url}` | ~1-2s, free | 80% (most articles have at least one snapshot) |
| `ua:googlebot` | Fetch with `Googlebot/2.1` UA + no `Sec-Ch-Ua` | ~500ms, free | 40% (Google News partners + soft paywalls) |
| `ua:bingbot` | Fetch with `Bingbot/2.0` UA | ~500ms, free | ~20% (sites that whitelist both) |
| `ua:facebookbot` | Fetch with `facebookexternalhit/1.1` UA | ~500ms, free | ~5% (sites that whitelist FB crawler) |
| `referer:google` | Fetch with a Google referer header | ~500ms, free | ~5% (sites that check referer only) |
| `block_js` | Playwright + route abort for 21 known paywall vendors (Piano, Tinypass, Poool, Zephr, Sophi, Pelcro, etc.) + DOM override script (hides paywall containers, restores body scroll, unlocks article containers) | ~3-5s, needs Playwright | 60% (any vendor-paywalled site) |
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
| `src/verticals/`         | **19** API-first extractors: npm, PyPI, crates.io, RubyGems, Packagist, pub.dev, Go, NuGet, Hacker News, Reddit, arXiv, Stack Exchange, YouTube, Wikipedia, Open Library, DEV.to, SonarCloud, docs sites, GitLab |

### Caching

- **Session cache**: 30-min TTL, LRU (max 100 entries), normalized keys (http→https, trailing slash)
- **Disk cache**: Persisted to `os.tmpdir()/pi-webaio/` — survives restarts
- **Search cache**: 10-min TTL, persisted to disk, capped at 100 entries
- **Summary cache**: per-URL AI summary cache, keyed by URL + search context so a focused summary is never served for a context-free request (v0.7.3)
- **Cookie cache**: per-origin, LRU 50, ~10-min TTL, bridges Playwright harvests across calls (v0.7.1)
- **Strategy memory**: per-domain fetch-ladder memory, LRU 500, 7-day expiry (v0.7.0)
- **Rate limiter**: Token-bucket per domain (5 req/s, burst 10) in `smartFetch`

### Security

- **Secret scanning (pre-flight block)**: 19 patterns (AWS, GitHub PAT classic/fine-grained/OAuth/App/user, GitLab, npm, PyPI, Slack, Stripe, Google, SendGrid, DigitalOcean, OpenAI including `sk-proj-`/`sk-svcacct-`, Anthropic, Supabase JWT, Vercel, Cloudflare, Private Key, Password in URL). Pre-flight check returns a clear `blocked_secret` error before any fetch.
- **Secret redaction (output masking)** (v0.7.3): `src/redact.ts` masks credentials (Authorization headers, JWTs, private-key blocks, password-in-URL userinfo, entropy-guarded key-value forms) that appear in user-facing error messages and rendered TUI previews/URLs. Additive to the blocker — a credential that slips through in a response or error never lands in the agent's context.
- **SSRF protection** (hardened v0.7.3): `validateUrlForSsrf()` resolves DNS once and validates every returned address, returning `pinnedIps`; `createPinnedLookup()` dials exactly those addresses (closing the re-resolve TOCTOU), wired into the Playwright fallback via Chromium host-resolver rules. Fails closed on any abnormal condition (DNS error, empty answer, unparseable URL, unexpected throw). The cloud-metadata block (169.254.169.254, AWS IMDSv6 `fd00:ec2::254`, IPv4-mapped forms, `metadata.google.internal`) is an absolute floor evaluated before the CIDR allow-list, so `WEBAIO_SSRF_ALLOW_RANGES` can never relax it. Blocks surface as a phase-aware `blocked_ssrf` FetchError.
- **SSRF allow-list** (v0.7.2): opt-in `WEBAIO_SSRF_ALLOW_RANGES` env var (comma-separated CIDRs) for TUN/proxy setups; multi-record DNS answers require every dangerous address to be allow-listed.
- **Prompt injection**: Categorizes and warns/redacts/tags suspicious content (instruction overrides, role injection, jailbreaks, system manipulation, encoding tricks)
- **Local URL blocking**: Prevents fetching localhost, 127.0.0.1, private IPs
- **HTTP→HTTPS auto-upgrade**
- **`safeResolveInBaseTemp`**: path-traversal guard in `utils.ts` rejects absolute paths and `../` escapes
- **Bounded resources** (v0.6.3): every network path is time- and size-bounded (per-request timeouts, streaming body deadlines, capped child-process stdout, capped sitemap fan-out, bounded in-memory caches)
- **CodeQL scanning**: default GitHub CodeQL scanning active

### Rate Limiting & Retries

- Token-bucket per domain (5 req/s, burst 10)
- Exponential backoff (1s → 2s) for 429/500/502/503/504
- 400/401/403/404 fail fast
- Jittered retry delays (±40% random variance) to avoid bot-like regularity
- Max 2 retries per request

### Extension API (pi)

- Entry point: `pi-entry.mjs` → prefers `dist/index.js` (compiled from `index.ts`), falls back to `index.ts` for git installs
- Package manifest: `package.json` → `pi.extensions: ["./pi-entry.mjs"]`, `main: "./dist/index.js"`
- Uses `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`
- Tools registered via `pi.registerTool()` with typebox parameter schemas
- Custom `renderCall` / `renderResult` for TUI rendering
- Type augmentations in `types/pi-coding-agent.d.ts`

## Recent Changes

### v0.7.3 — SSRF hardening, secret redaction, relatedness-gated summaries, TS7 build

- **SSRF guard hardened** — DNS-pinning (`createPinnedLookup`/`validateUrlForSsrf`), fail-closed on any abnormal condition, and a non-overridable cloud-metadata floor evaluated before the CIDR allow-list. 30 new offline tests.
- **Secret redaction in output/errors** (`src/redact.ts`) — additive masking of credentials in error messages and TUI previews, complementing the pre-flight blocker. 21 new tests.
- **`blocked_ssrf` FetchError code** — SSRF blocks now surface as a phase-aware error (`phase=validation`, non-retryable), bringing the taxonomy to 26 codes × 10 phases × 7 categories.
- **Relatedness-gated search-context summaries** — a recent search query is injected into a page summary only when BM25-relatedness (over URL + title + first heading, with URL-slug normalization) passes 0.35; focused summaries are annotated and cache-keyed by URL + context.
- **Cloudflare-challenge rejection in the Jina path** (`parseJinaBody`) + real RSC title resolution (`resolveHtmlTitle`: og:title → title → h1 → hostname).
- **Unified `prune`/`budgetTokens` truncation footer** with an omitted-sections mini-TOC.
- **TypeScript 7 build fix** in `scripts/prepare.mjs` (locates tsc via `typescript/package.json`).
- **pi peer/runtime floor raised to 0.83**; removed unused `sharp`; scheduled Dependabot updates.
- **Fixes**: B2 (Wikipedia `[object Object]`), B3 (webresearch per-source guard), B4 (`googleStatus` surfacing), B5 (webquery `dir` resolution), B6 (GitLab over-matching now host-gated), B8 (webpull "0 new pages" headline).

### v0.7.2 — bot-wait loop, SSRF allow-list, lifecycle hooks

- Active bot-protection wait loop in the Playwright fallback (`waitForBotProtectionToClear`).
- Config-driven SSRF allow-list (`WEBAIO_SSRF_ALLOW_RANGES` CIDRs).
- User lifecycle hooks (`afterFetch`/`afterExtract`) via `src/hooks.ts`.
- Fixed `fetch-jina` dynamic-import crash for source-loaded installs.

### v0.7.1 — aio-webresearch, source ranking, cookie cache, goggles, stance

- **`aio-webresearch` tool** — single-round research bundle orchestrator (no LLM calls inside).
- Source-type classification + preferred-domain boost in search ranking; per-origin cookie cache; search goggles rerank presets; deterministic claim-stance classifier; shared hardened stealth script.

### v0.7.0 — answer mode, webquery, diff, strategy memory, MCP server

- Query-focused fetch (answer mode), hard `budgetTokens`, `aio-webquery` offline corpus search, HTTP revalidation + `diff`-aware refetch, per-domain strategy memory, speculative prefetch, user-defined verticals, extraction benchmark harness, and the MCP stdio server. `pi.extensions` moved to `pi-entry.mjs` (dist-preferred, source fallback).

### v0.6.2 — BM25 pruning, fingerprint diagnostics, CHANGELOG-driven releases

**Query-aware BM25 pruning** (`src/bm25.ts`) — New `query` parameter on `aio-webfetch` enables relevance-based content pruning via Okapi BM25 scoring. Includes IDF caching, stop-word filtering, markdown stripping, and tuning options. 21+ unit tests in `tests/prune-markdown.test.mjs`.

**TLS fingerprint regression diagnostics** (`tests/fingerprint.test.mjs`, `scripts/fingerprint-diagnostics.mjs`) — offline tests locking down profile defaults, header shapes per browser/OS, and fallback behavior, plus opt-in live diagnostics.

**CHANGELOG-driven release workflow** — release notes extracted from `CHANGELOG.md` via `scripts/changelog-extract.mjs --summary`.

### v0.5.0 — TUI renderer, phase-aware FetchError, format param, hardening, precompiled dist, CI

TUI result rendering for all tools; phase-aware FetchError system; `format` parameter; RAG chunking; GitHub Actions run logs; precompiled `dist/`; CI + release workflows; pre-flight secret scanner; CodeQL alerts resolved.

### pi Scope Migration (v0.3.5+)

- Pi moved from `@mariozechner/pi-*` to `@earendil-works/pi-*` package scope (pi 0.73.1+)
- Extension imports updated accordingly
- v0.5.0: extension ships precompiled `dist/`; v0.7.0: `pi-entry.mjs` loader (dist-preferred, source fallback)

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

- `npm test` → runs unit tests (`tests/unit.test.mjs`, 156 tests)
- `npm run test:all` → runs all 51 wired suites (1207 tests total, 0 fail, 2 expected skips: a live-network Jina test that skips on external HTTP 403, and an opt-in live TLS test)
- `npm run test:mcp` → MCP server tests (standalone, not in test:all)
- Specialized suites (each `npm run test:<name>`): `new` (new-features, 31), `paywall` (65), `check` (github-check, 35), `render` (render-result, 40), `fetcherror` (fetch-error, 57), `fetchprogress` (9), `hardening` (16), `redact` (21), `ssrf` (ssrf-hardening, 30), `fingerprint` (14), `format` (18), `webfetch-summary` (13), `search-context` (20), `chunker` (31), `prune` (prune-markdown, 25), `github-map` (50), `reddit` (reddit-block, 7), `source-ranking` (16), `webresearch` (26), `stance` (24), `cookie-cache` (25), `title-extraction` (10), `integration` (5), `bench` (bench-harness, 35)
- Additional suites present in `tests/` (run via test:all or directly): goggles (14), bot-wait (6), ssrf-allowlist (37), lifecycle-hooks (14), webquery (12), plus diff-refetch, query-mode, revalidation, strategy-memory, prefetch, token-budget, user-verticals
- `npm run diagnose:fingerprint` → opt-in live TLS/SannySoft/CreepJS diagnostics
- `npm run diagnose:backends` → opt-in backend doctor (gh CLI / Playwright / Chrome offline; search engines + Jina behind `--live`)
- `npm run check:lockfile` → fails if package-lock.json drifts from package.json
- `npm run build` → compiles TypeScript to `dist/`
- `npm run lint` → runs `tsc --project tsconfig.json` as type-check
- Tests use `node:test` directly (no test runner dependency)
- Tests run under `node --experimental-strip-types --test` (Node 24 native TypeScript stripping)
- Playwright tests gracefully handle both installed/uninstalled

## Dependencies

- **Runtime**: `@modelcontextprotocol/sdk` (^1.30.0), `@earendil-works/pi-tui` (^0.83.0), `@mozilla/readability`, `defuddle` (^0.19.2), `linkedom`, `pdf-parse`, `temml`, `typebox` (^1.1.34), `wreq-js`, `youtube-transcript-plus`
- **Peer**: `@earendil-works/pi-coding-agent` (^0.83.0)
- **Optional**: `playwright` (^1.55.0)
- **Dev**: `@types/node` (^26.x), `typescript` (^7.x — the project builds under TypeScript 7)
- **Overrides**: `brace-expansion`, `protobufjs`, `@hono/node-server` (security pins)
- **Removed in v0.7.3**: `sharp` (declared but never imported; cleared a high-severity libvips advisory and dropped a heavy native binary)

## CI/CD

- **GitHub Actions** (`.github/workflows/ci.yml`):
  - `lint-and-typecheck` — `npm run check:lockfile` + `npm audit --omit=dev --omit=peer --audit-level=high` + `npm run lint` (tsc). Peer deps are excluded from audit because npm overrides do not cascade into a peer's subtree.
  - `test` — builds + runs `npm test` and `npm run test:all` (all suites).
  - `prod-install-build` — simulates pi's real install path (`npm install --omit=dev` → `prepare` → `build:dist` from source, with `@types/node` absent). Catches TS2688-style breakage.
  - `install-test` (ubuntu/windows/macos) — packs tarball, verifies `dist/index.js` is present and no `.ts` leaked, checks `main`/`pi.extensions` entry points exist, installs from tarball (simulates `pi install npm:pi-webaio`), and verifies the compiled entry loads without missing-module errors.
- **GitHub Releases + npm publish** (`.github/workflows/release.yml`):
  - Triggers on push to master (and `workflow_dispatch`); reads version from `package.json`.
  - **Do NOT manually create or push tags** — the workflow creates the tag via `gh release create`. The tag check is the sole guard: if the tag already exists, the release job is skipped entirely.
  - Verifies a `## [VERSION]` CHANGELOG entry exists before releasing/publishing.
  - Creates the GitHub release with CHANGELOG-driven notes (`scripts/changelog-extract.mjs --summary`).
  - **Publishes to npm via npm trusted publishing (OIDC)** — the `publish-npm` job sets `id-token: write` and runs `npm publish` with no `NPM_TOKEN` secret (npm ≥ 11.5.1 detects the GitHub Actions OIDC token automatically). The publish gate is independent of the tag, so a re-run can publish a version whose tag/release already exists.
  - Dry-run publish + smoke-load of the compiled entry before tagging/publishing.
- **Dependabot** (`.github/dependabot.yml`) — scheduled weekly npm (minor/patch grouped) + github-actions update PRs, on top of reactive security-update PRs.
- **Default GitHub CodeQL** scanning for security alerts.
