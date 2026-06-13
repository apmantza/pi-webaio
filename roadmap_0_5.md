# pi-webaio 0.5.0 Roadmap

**Theme:** Polish the agent experience — better TUI, smarter errors, more output formats.

Inspired by [Thinkscape/agent-smart-fetch](https://github.com/Thinkscape/agent-smart-fetch) and [brandonkramer/pi-scraper](https://github.com/brandonkramer/pi-scraper) — both address similar UX gaps in the 6-tool scraping surface from different angles.

**Status:** in progress
**Target:** v0.5.0

---

## Priority 1 — TUI `renderResult` for `aio-webfetch` *(✅ done in 0.5.0)*

**Why:** Our 6 tools dump raw markdown to the TUI. pi has rich TUI widgets (`Container`/`Markdown`/`Text`/`Spacer` from `@earendil-works/pi-tui`) we don't use at all. The collapsed-preview pattern (7-line preview + "N more lines, Ctrl+O to expand") is a huge UX win.

**Scope:**
- Add `renderCall` and `renderResult` to the `aio-webfetch` tool
- Width-aware progress bar with spinner during in-flight fetch
- Status glyphs (✓/✗/⠋) using pi's theme colors
- Collapsed preview: title + URL + first 7 content lines + "N more lines" hint
- Expanded view: full content with `Markdown` widget for syntax highlighting
- Error result: red summary line using `buildUserFacingFetchErrorSummary`
- Spinner tick via `setInterval(100ms)` so the animation actually moves

**Files added:**
- `src/tools/render-result.ts` — `createProgressComponent`, `createResultComponent`, `createCallComponent`, `truncateMiddle`, `getOptimisticProgress`
- `tests/render-result.test.mjs` — 32 unit tests

**Files modified:**
- `src/tools/webfetch.ts` — added `renderCall` / `renderResult` to the tool def, wired `onUpdate` to push progress, set up `setInterval(100ms)` for the spinner tick, populated `details.content` / `format` / `status` / `progress` / `spinnerTick` / `userErrorSummary` / `items`, wrapped the execute body in try/finally for spinner cleanup, improved `promptSnippet` with the full parameter list and added 3 new `promptGuidelines`

**Reference:** `pi-smart-fetch/src/index.ts:64-230, 530-620`

---

## Priority 2 — Phase-aware `FetchError` *(✅ done in 0.5.0)*

**Why:** Our error reporting was a flat `{ error: string }`. The agent got no hint about whether the failure was a timeout vs DNS vs 5xx, no `retryable` flag, no suggested retry timeout.

**Scope:**
- Replaced with `FetchError` discriminated union: **25 codes × 10 phases × 7 categories**
- Codes: `invalid_url | private_ip | blocked_secret | redirect_loop | dns_error | connect_error | tls_error | aborted | timeout | rate_limited | http_error | not_found | auth_required | download_error | empty_body | binary_content | checksum_mismatch | parse_error | encoding_error | out_of_memory | blocked | paywall | bot_detected | no_content | unknown`
- Phases: `validation | connecting | tls | waiting | headers | downloading | processing | rendering | writing | finished`
- `buildUserFacingFetchErrorSummary(err)` — 1-line TUI-friendly message ("We couldn't resolve the hostname.", "The server rate-limited this request. (HTTP 429)")
- `suggestRetryTimeoutMs(err)` — extrapolates from `downloadedBytes`/`contentLength`/`elapsedMs` (min 5s, max 180s, +20% buffer)
- `classifyError(err, ctx)` — auto-derive code/phase from Node error (`ENOTFOUND`, `ETIMEDOUT`, `CERT_HAS_EXPIRED`, `ECONNRESET`, etc.)
- `createFetchError(code, message, ctx, { retryable? })` factory — frozen object, auto-derives `retryable` from code+statusCode
- `isFetchError(value)` type guard, `toFetchErrorInfo(err)` backwards-compat
- Worker wrapped in IIFE: any thrown error → `classifyError` → structured `PullResult` with `fetchError`, `userErrorSummary`, `suggestedTimeoutMs`
- TUI shows suggested timeout on the next line: `↻ Retry with timeout ≈ 24.0s`

**Files added:**
- `src/tools/fetch-error.ts` — 461 LOC (+ ~30 LOC for `ERR_RESPONSE_TOO_LARGE` handling)
- `tests/fetch-error.test.mjs` — 50 unit tests (added integration tests: enriched progress from `readResponseTextWithProgress`, every FetchErrorContext field, HTTP 503 path)

**Files modified:**
- `src/tools/webfetch.ts` — imports new helpers, worker wrapped in IIFE with catch, error path now returns `{ fetchError, userErrorSummary, suggestedTimeoutMs }` alongside the legacy `errorInfo`, `userErrorSummaryFor` now delegates to `buildUserFacingFetchErrorSummary`, agent-facing text now includes `[phase=… code=… category=… retryable=… http=…]` for richer LLM context, `singleStartedAt` threaded into the single-URL `updateItem` calls
- `src/tools/render-result.ts` — `WebfetchDetails` gained `errorPhase` / `errorCategory` / `errorRetryable` (badge + retry-hint gating), error view shows `phase: … · category: …` line, retry hint only shown when `errorRetryable !== false`, `FetchItemProgress.elapsedMs` shows wall time on per-item rows
- `src/fetch.ts` — added `readResponseTextWithProgress()` (returns `{ text, bytesRead, contentLength }`); new `SmartFetchResult` type adds `downloadedBytes` / `contentLength` / `elapsedMs`; `smartFetch()` now tracks wall time + bytes read for the primary fetch AND the bot-block fallback browsers; errors are enriched with `bytesRead` / `contentLength` / `elapsedMs` before being re-thrown so the caller's `classifyError` produces a rich `FetchError`
- `src/content.ts` — 3 error sites (network, http_error) now attach a `fetchError` to the `PullResult` with real `downloadedBytes` / `contentLength` / `elapsedMs` from `smartFetch`
- `src/types.ts` — `PullResult.fetchError` field added; `FetchOpts.__attempt` added (internal, set by the webfetch worker)
- `package.json` — `test:fetcherror` script + wired into `test:all`

**Reference:** `smart-fetch/packages/core/src/extract.ts`, `format.ts`

---

## Security & robustness hardening *(✅ done in 0.5.0)*

**Why:** A DRYKISS review of the P1+P2 polish identified three pre-existing security/robustness issues that, while not regressions from the polish work, are worth fixing before any further feature work.

**Scope:**

### Fix #1 — Path traversal in `params.out` *(pre-existing)*
- The `params.out` parameter to `aio-webfetch` and `aio-webpull` was resolved against `BASE_TEMP` with no verification that the result stayed inside the temp directory
- Added `safeResolveInBaseTemp(userInput)` helper in `src/tools/utils.ts`:
  - Resolves `userInput` against `BASE_TEMP` via `path.resolve`
  - Verifies the resolved path equals `BASE_TEMP` or starts with `BASE_TEMP + sep`
  - Throws an `Error` if the path would escape the temp directory
- Wired into both `webfetch.ts` (per-item worker) and `webpull.ts` (top-level handler)
- Rejects: absolute paths, `..` traversal, empty string, non-string input

### Fix #2 — SSRF in `fetchWithPlaywright` *(pre-existing)*
- `fetchWithPlaywright` did not call `isDangerousUrl` (unlike `fetchWithRetry`)
- An attacker URL could pivot through the headless browser to private networks / cloud metadata endpoints
- Added `if (await isDangerousUrl(url)) throw new Error("Blocked unsafe URL: …")` at the start of `fetchWithPlaywright`
- This closes the SSRF gap for both the pool-based and the per-request browser launch paths

### Fix #3 — Unhandled promise rejection in `withTimeout` *(pre-existing)*
- The old `withTimeout` used `Promise.race([promise, timeout])`; if the timeout won, the original promise kept running and any later rejection became an unhandled rejection in Node 15+
- Rewrote to use a `new Promise((resolve, reject) => { const timer = setTimeout(...); promise.then(resolve, reject).finally(() => clearTimeout(timer)); })` pattern
- The losing promise no longer dangles; the timer is always cleared in both winner paths
- This eliminates the entire class of `UnhandledPromiseRejection` warnings

**Files added:**
- `tests/hardening.test.mjs` — 8 unit tests:
  - 5 for `safeResolveInBaseTemp` (relative allowed, absolute rejected, parent traversal rejected, empty input rejected, returns joined path)
  - 3 for `withTimeout` behavior (timeout wins, promise wins, promise wins + late timeout)

**Files modified:**
- `src/tools/utils.ts` — added `safeResolveInBaseTemp` + `BASE_TEMP` import
- `src/tools/webfetch.ts` — uses `safeResolveInBaseTemp` for `outFile`
- `src/tools/webpull.ts` — uses `safeResolveInBaseTemp` for `outDir`; removed unused `resolve` import
- `src/fetch.ts` — `fetchWithPlaywright` now guards with `isDangerousUrl`
- `src/content.ts` — `withTimeout` rewritten with the safer `new Promise + .then(resolve, reject).finally(clearTimeout)` pattern
- `package.json` — `test:hardening` script + wired into `test:all`

---

## Priority 3 — Multiple output formats on `aio-webfetch` *(✅ done in 0.5.0)*

**Why:** Power users want `text` (token-efficient) and `raw` (parse the markup themselves). Many sites serve `text/markdown` alternates that defuddle mangles.

**Scope:**
- Add `format` parameter: `markdown | html | text | json | raw`
- `text` = `markdownToText(extracted)` (strip `**`/`[]()` etc.)
- `json` = pretty-print if `Content-Type: application/json`, else follow `<link rel="alternate" type="application/json">`
- `raw` = return body verbatim, skip defuddle, skip truncation unless user passed `maxChars`
- Per-format `Accept` header (json gets `application/json,text/json,application/ld+json;q=0.9,...`, raw gets `text/markdown` to coax `.md` alternates)
- TUI `renderResult` uses `Markdown` widget for md/json/html, plain `Text` for text/raw

**Delivered:**
- `format` parameter added to `aio-webfetch` tool schema (Type.Optional string, default `"markdown"`)
- `applyFormat(result, formatParam, markdown)` helper in `src/tools/render-result.ts` produces `{format, body, savedToDisk, contentLength}`
- `markdownToText(md)` strips: headers, bold/italic/strikethrough, code spans/blocks, links, images, list markers, blockquote markers, horizontal rules, raw HTML tags; collapses excessive newlines; trims trailing whitespace per line
- `FETCH_OUTPUT_FORMATS` `Set` validates the 5 accepted values (`markdown`/`html`/`text`/`json`/`raw`); unknown values fall back to `markdown`
- Per-item worker in `webfetch.ts`:
  - `markdown` (default): writes to disk + stores in cache + returns `outPath` + `responseId` (existing behavior)
  - `html`/`text`/`json`/`raw`: returns body inline (`r.body`), no disk write, no cache store, no `outPath` (so the TUI shows "in-memory only")
- `compile: true` is skipped automatically when any result is non-markdown (the package compiler reads from `outPath` files)
- Batch summary line shows `→ {format} ({length} chars, in-memory)` for non-markdown results instead of `→ {outPath}`
- Tests: 17 new in `tests/format.test.mjs` (covers `markdownToText` 8 cases, `FETCH_OUTPUT_FORMATS` membership, all 5 format paths + defaults)
- TUI `WebfetchDetails.format` already existed; now populated from the per-item result

**Files changed:**
- `src/tools/render-result.ts` — `markdownToText`, `applyFormat`, `FormattedOutput`, `FetchOutputFormat`, `FETCH_OUTPUT_FORMATS`
- `src/tools/webfetch.ts` — schema param, per-item worker branch, batch summary line, compile guard, promptSnippet update
- `tests/format.test.mjs` — new test file (17 tests)
- `package.json` — `test:format` script + `test:all` chain

**Caveats:**
- `raw` format returns `result.rawHtml` (or `result.content` as fallback) as the body. We don't currently preserve the original HTTP response object on `PullResult`, so `raw` is a best-effort approximation. True raw HTTP passthrough (with status/headers) would require threading the response through to the result — deferred to a follow-up.

---

## Priority 4 — `kind: "file"` result type for binaries

**Why:** We currently run `pdf-parse` on every PDF and inline the text. For 50MB binaries that's wasteful. Better to stream to disk and let the agent `read` the file.

**Scope:**
- Add `kind: "content" | "file"` discriminator to fetch result
- `file` branch: stream `Content-Disposition: attachment` or non-textual mime types to `os.tmpdir()/pi-webaio/downloads/{slug}.{ext}`
- Filename from `Content-Disposition: filename*=UTF-8''...` (RFC 5987) or URL path
- Return `{ filePath, fileSize, mimeType }` in TUI + agent response
- TUI shows: `> File size: 2.3 MB` / `> Mime type: application/pdf` / `> File path: /tmp/pi-webaio/...`
- Agent uses built-in `read` tool on the file path

**Reference:** `smart-fetch-core/src/extract.ts:240-360, resolveDownloadTarget`

---

## Priority 5 — Alternate-link fallback

**Why:** Defuddle produces noisy output for HTML pages that have a clean `.md` alternate (GitHub READMEs, Dev.to, Hashnode, many docs sites). Following `<link rel="alternate" type="text/markdown">` is a free 10x quality boost.

**Scope:**
- Parse `<link rel="alternate" type="text/markdown | text/x-markdown | text/plain | application/json">` in `<head>`
- After defuddle, if `wordCount < 30` AND alternate links exist, re-fetch the alternate
- Loop limit: 3 (avoid infinite alternates)
- Per-format accepted types:
  - `markdown` → `text/markdown`, `text/x-markdown`
  - `text` → `text/plain`, `text/markdown`, `text/x-markdown`
  - `html` → `text/html`, `application/xhtml+xml`
  - `json` → `application/json`, `text/json`, `*+json`
  - `raw` → none (raw mode never alternates)

**Reference:** `smart-fetch-core/src/extract.ts:extractQualifiedAlternateLinks`

---

## Priority 6 — Settings file support

**Why:** We hardcode all defaults. Users have no way to configure `webaioDefaultMaxChars`, `webaioDefaultMode`, `webaioTempDir` etc. persistently. The pi agent already supports `~/.pi/agent/settings.json` and `.pi/settings.json` — we just need to read them.

**Scope:**
- Create `src/settings.ts` with typed readers (`readPositiveNumber`, `readOs`, `readBoolean`, …)
- `loadWebaioSettings(cwd, agentDir)` reads global then project, project wins
- Accepted keys (with legacy aliases):
  - `webaioDefaultMaxChars` / `aioDefaultMaxChars`
  - `webaioDefaultTimeoutMs`
  - `webaioDefaultBrowser` / `webaioDefaultOs`
  - `webaioDefaultMode` (`auto` | `fast` | `fingerprint` | `browser`)
  - `webaioDefaultBypass` (bool, paywall bypass default)
  - `webaioTempDir`
  - `webaioCacheTtlSeconds`
- Wire into `webfetch.ts`, `webpull.ts`, `websearch.ts`

**Reference:** `pi-smart-fetch/src/settings.ts`

---

## Priority 7 — DI factory for `content.ts`

**Why:** `content.ts` is 32KB of tightly coupled logic. We can't unit-test it without a real wreq session. A factory pattern makes it mockable.

**Scope:**
- Define `ContentDependencies` interface (`fetch`, `defuddle`, `getProfiles`, `readability`, `jinaFetch`, …)
- `createPullPage(deps)` factory + `pullPage = createPullPage()` default
- `pullPageEnhanced = createEnhancedPullPage(deps)`
- Convert callers to pass `deps` through
- Add unit tests with mocked deps

**Reference:** `smart-fetch-core/src/extract.ts:createDefuddleFetch(deps)`

---

## Priority 8 — Soft-404 detector

**Why:** SPAs (X, LinkedIn, Meta, etc.) return 200 HTML shells for deleted/protected/suspended content. Defuddle extracts the boilerplate as "content", which is useless to the agent.

**Scope:**
- Generalize the `isTwitterJsDisabledPage` pattern
- Detect: empty body, "page not found" + "go back" + nav-only structure
- Suppress `console.error` during defuddle call, capture known error patterns (X oEmbed 404)
- If signal fires AND defuddle returned no meaningful content (`wordCount < 30`), surface a real 404
- Curated list of known SPA shells (X, LinkedIn, Meta, Instagram, Reddit private subs)

**Reference:** `smart-fetch-core/src/extract.ts:isTwitterJsDisabledPage`

---

## Priority 9 — WebFetch provider registration

**Why:** pi's built-in `web_fetch` uses Readability + plain HTTP. If we can register as a fallback provider, the built-in tool automatically upgrades when ours is installed.

**Scope:**
- Check if pi 0.77+ has `api.registerWebFetchProvider` or equivalent
- If yes: register ourselves with `autoDetectOrder: 10` (lower than pi's default)
- If no: file upstream feature request, document in README that `aio-webfetch` should be preferred

**Reference:** `openclaw-smart-fetch/src/web-fetch-provider.ts`

---

## pi-scraper inspirations *(audit completed)*

Source: [brandonkramer/pi-scraper](https://github.com/brandonkramer/pi-scraper) — a 6-tool, scraper-first pi extension by Brandon Kramer, organized around `web_scrape` / `web_crawl` / `web_map` / `web_batch` / `web_extract` / `web_get_result`. Different architecture (TypeScript monorepo, 200+ tests, Vitest, CloakBrowser-backed browser mode) but overlapping problem space with us.

**Status of audit:** complete. Most valuable features have been triaged below. Some already overlap with our existing P1–P9.

### Already covered (or partial overlap)

| pi-scraper feature | Our equivalent | Notes |
|---|---|---|
| `mode: auto/fast/fingerprint/readable/browser` | `mode: auto/fast/fingerprint/browser` (no `readable`) | We could add `readable` as a synonym for our default extraction; not a priority |
| `format: markdown/text/html/json/raw` | `format: markdown/html/text/json/raw` (P3, ✅) | We just shipped this |
| `saveToFile: true \| {dir, filename, maxBytes}` | `params.out: string` (only works for text; no binary) | Validate the API shape when we do P4 — theirs is richer (`{dir, filename, maxBytes}` vs our single string) |
| `sessionId` + `saveSession` + `clearSession` for browser | `wreqSession` (HTTP cookies only) | We persist cookies for wreq; for browser mode we don't persist a disk profile. pi-scraper uses CloakBrowser's `launchPersistentContext()` to write to `~/.pi/browser-sessions/<id>/`. We could do the equivalent with Playwright's `launchPersistentContext` — but only if we add a browser-session tool (P16 below) |
| Resumable crawl with strategy + state | `resume: true` + `request-queue.ts` (P1 in earlier roadmap) | We have checkpoint/resume; they have SQLite-backed jobs; we use JSON blobs |
| Tools provider hook (`web-tools-provider.test.ts`) | (P9 above) | Same idea, different API |
| `followAlternates`, `followMetaRefresh` | (P5 above) | Identical scope |
| Source-grounded LLM extraction | None | See P10 below — high value, deferred to 0.6.0 |
| Crawl strategies (bfs/dfs/best-first) | BFS only | See P11 below — small addition, could fit 0.5.0 |
| `chunks: true` for RAG | None | See P12 below — small addition, could fit 0.5.0 |
| `/scrape-config` slash command | Env vars only | See P13 below — could fit 0.5.0 |
| `respectRobots` config | Implicit (we just go) | See P14 below — small, could fit 0.5.0 |
| Diff snapshots | None | See P15 below — medium, deferred to 0.6.0 |
| YAML vertical manifests (user-extensible at `~/.pi/scraper/verticals/*.yaml`) | TypeScript-only verticals (locked-in) | See P16 below — large refactor, deferred to 0.6.0 |
| Persistent browser sessions (CloakBrowser) | None | See P17 below — requires Playwright persistent context, deferred |

### New priority items

### Priority 10 — RAG `chunks` parameter

**Why:** Right now `aio-webfetch` returns one big markdown blob. RAG workflows want paragraph-bounded chunks with token budgets and overlap. pi-scraper's `chunks: true` returns `chunks: [{text, tokenCount, index}]` alongside the full markdown. Cheap to add (we already have `estimateTokens`).

**Scope:**
- Add `chunks?: boolean`, `maxTokens?: number` (default ~512), `overlapTokens?: number` (default ~50) to `aio-webfetch`
- New `chunkMarkdown(md, {maxTokens, overlapTokens})` in `src/tools/render-result.ts` or a new `src/chunker.ts`
- Output: `chunks: Chunk[]` where `Chunk = {text, tokenCount, index}`
- Only for `format: markdown` (other formats are in-memory; caller can chunk themselves)
- Tests: 6+ in `tests/chunker.test.mjs` (paragraph split, token budget, overlap, empty input, single paragraph, multi-paragraph)

**Reference:** `pi-scraper/src/parse/chunker.ts:chunkMarkdown`, `src/types.ts:Chunk`

### Priority 11 — Crawl strategies: `dfs` and `best-first`

**Why:** Our `aio-webpull` does pure BFS. DFS is useful for nested doc trees (drilling into `docs/v1/api/...`), and best-first prioritizes index pages and short paths (great for docs sites where the landing page points to the categories).

**Scope:**
- Add `strategy: "bfs" | "dfs" | "best-first"` to `aio-webpull` (default `bfs`, backward compatible)
- BFS = current behavior (FIFO)
- DFS = LIFO insert (`queue.splice(head, 0, item)`) — drill one branch before backtracking
- best-first = priority score based on `(maxDepth - depth) * 10` + path-shape bonuses (root +5, short path +3, fragment +1)
- TUI progress row shows the active strategy: `12/50 pages · 3 failed · depth 2 · strategy best-first`
- Tests: 8+ in `tests/crawl-strategy.test.mjs` covering insertion order for each strategy + priority score for `best-first`

**Reference:** `pi-scraper/src/crawl/frontier.ts:42-110`, `src/crawl/runner.ts:74-82`

### Priority 12 — Content line filters: `include` / `exclude` / `linesMatching` / `contextLines`

**Why:** When scraping logs, config dumps, or search results, the user often wants only the lines that match a pattern (e.g. "all `ERROR` lines with 2 lines of context"). pi-scraper has this; we don't.

**Scope:**
- Add 4 new params to `aio-webfetch`:
  - `include?: string[]` — glob patterns; drop content that doesn't match
  - `exclude?: string[]` — glob patterns; drop content that does
  - `linesMatching?: string` — regex; keep only matching lines
  - `contextLines?: number` — N lines of context around each match
- `caseSensitive?: boolean` (default false)
- Applied AFTER extraction, BEFORE `prune` / `max_length`
- Tests: 10+ in `tests/line-filter.test.mjs` covering all 4 filters, case sensitivity, context lines, and combinations

**Reference:** `pi-scraper/src/scrape/line-filter.ts`, `src/commands/scrape-config.ts`

### Priority 13 — `/webaio-config` slash command

**Why:** We have env vars and a few hardcoded defaults. Users want a single place to set their default mode, browser profile, bypass behavior, cache TTL — interactive via the TUI. pi-scraper does this with `/scrape-config`; the same idea transfers cleanly to us.

**Scope:**
- Register a `/webaio-config` command via `pi.registerCommand`
- Sub-actions: `status`, `set mode=auto|fast|fingerprint|browser`, `set browser=<profile>`, `set os=...`, `set bypass=true|false`, `set cacheTtl=<seconds>`, `set tempDir=<path>`, `cache clear`, `cache stats`
- Persist to `~/.pi/webaio-config.json` (settings-file style, see P6)
- `status` shows current effective config (with source: env / file / default)
- Tests: unit-test the parse/validate helpers; the slash command itself is hard to test in isolation

**Reference:** `pi-scraper/src/commands/scrape-config.ts`, `src/commands/scrape-config-*.ts`

### Priority 14 — `respectRobots` config option

**Why:** We're polite enough to read `robots.txt` during `aio-webmap` and `aio-webpull` discovery (we follow sitemap exclusions), but during the actual crawl we just go. A site owner who blocks `/private/` in robots.txt is being ignored. This is a small, defensive change that costs us nothing and might save us a `User-Agent: *` ban.

**Scope:**
- Add `respectRobots?: boolean` to `aio-webfetch` and `aio-webpull` (default `true` for pull, `false` for fetch — fetch is a single URL where robots.txt is less meaningful)
- When `true`, before each fetch:
  - GET `/robots.txt` from the origin (cached for the pull)
  - Check `Disallow` rules against the URL path
  - Check `Crawl-delay` and pace requests accordingly
- Use the cached `robots.txt` we already fetch for sitemap discovery (in `aio-webmap` and `aio-webpull`)
- Tests: 8+ in `tests/respect-robots.test.mjs` covering allow/deny rules, crawl-delay pacing, missing robots (allow), wildcard `*`, multi-User-Agent rules

**Reference:** `pi-scraper/src/http/robots.ts`, `src/crawl/__tests__/respect-robots.test.ts`

### Priority 15 — Diff snapshots *(deferred to 0.6.0)*

**Why:** A user scraping a docs site weekly wants to know what changed. pi-scraper has `web_scrape({snapshotName, snapshotTag, diff, compareTag})` with a `compareSnapshotText` engine that returns `added` / `removed` / `changed` / `unchanged` lines.

**Scope:**
- Add `snapshotName?: string` and `snapshotTag?: string` to `aio-webfetch`
- When set, the result is also saved to `~/.pi/webaio/snapshots/<name>/<tag>.md`
- Add `aio-webdiff` tool: `aio-webdiff({name, oldTag, newTag})` returns the diff
- `compareSnapshotText(previous, current)` in `src/snapshot-compare.ts` with similarity threshold (0.55) and line-by-line alignment
- Return shape: `{added: string[], removed: string[], changed: {previous, current, similarity}[], unchanged: number}`
- TUI: red/green inline diff with 3 lines of context
- Tests: 12+ in `tests/snapshot-compare.test.mjs`

**Reference:** `pi-scraper/src/diff/compare.ts`, `src/diff/snapshots.ts`

### Priority 16 — YAML-based vertical manifests *(deferred to 0.6.0)*

**Why:** Our 18 verticals (`src/verticals/*.ts`) are baked in at compile time. Users can't add their own without forking the extension. pi-scraper solves this with a layered YAML manifest system: built-ins in `verticals/*.yaml`, user overrides at `~/.pi/scraper/verticals/*.yaml`, project overrides at `.pi/scraper/verticals/*.yaml`. The latter wins. A user can drop in a single YAML to teach the extractor a new site.

**Scope:**
- Define manifest v1 schema: `version`, `name`, `kind`, `urlPatterns`, `requirements`, `capabilities`, `request`, `extract`
- `kind` values: `api-json`, `api-xml`, `api-json-aggregate`, `api-json-chain`, `http-workflow`, `html-extract`, `text-extract`, `code-extract`, `selector`, `pattern`, `recipe`
- Migrate 5–10 of our most-used verticals to YAML (npm, PyPI, arXiv, GitHub, HackerNews, Reddit, crates.io, Docker Hub, YouTube oEmbed, OSS Insight) as proof of concept
- Keep TypeScript verticals for the long tail (JSDoc extraction, manifest walking, GitIngest, etc.)
- Layered loader: built-in → user → project, with project winning
- New `aio-webextract` tool with `action: "vertical" | "list" | "reload"`
- Tests: 20+ covering manifest loading order, JSONPath evaluation, http-workflow steps, url-pattern capture groups, recipe primitives

**Reference:** `pi-scraper/verticals/*.yaml`, `src/extract/vertical/manifest-*.ts`, `src/extract/vertical/kinds/`

### Priority 17 — Persistent browser sessions via Playwright `launchPersistentContext` *(deferred)*

**Why:** When a user logs into a site and wants to scrape authenticated pages, they currently have to re-login every session. pi-scraper solves this with CloakBrowser's `launchPersistentContext()` writing to `~/.pi/browser-sessions/<id>/`. We can do the same with Playwright (no CloakBrowser dependency).

**Scope:**
- Add `sessionId?: string` + `saveSession?: boolean` + `clearSession?: boolean` to `aio-webfetch` (only for `mode: "browser"`)
- New `src/browser-session.ts`:
  - `getOrCreateSession(id)` returns a `BrowserContext` from `~/.pi/webaio/sessions/<id>/`
  - `closeSession(id)` releases the context
  - `clearSession(id)` removes the directory
- Cookies / localStorage / IndexedDB persist across calls and Pi restarts
- Replaces our current per-request `chromium.launch()` in `fetchWithPlaywright` when a sessionId is set
- Tests: integration (Playwright is optional dep; skip if not installed)

**Reference:** `pi-scraper/src/browser/session-pool.ts`, `src/browser/session.ts`

### Won't adopt

- **CloakBrowser binary** — adds 200MB+ to install and is a native C++ dep. Our `wreq-js` (static) + `playwright` (browser) + `paywall bypass` (content) cover the same ground with lighter tooling.
- **SQLite index** (`~/.pi/scraper/index.db`) — our JSON-blob store with 24h TTL works fine for the cache scale. Would revisit if we need ACID transactions or cross-device sync.
- **`pi:model-adapter/*` event protocol** — pi 0.77 may not have it; would need to coordinate with the pi core team.
- **YAML vertical manifest for every existing site** — the long tail of TypeScript verticals (JSDoc extraction, manifest walking, GitIngest, etc.) doesn't translate cleanly to YAML's declarative model. Migrate only where it adds value (P16 above).

### What we do that pi-scraper doesn't (our differentiators)

Worth keeping in mind when we feel FOMO:

- **Phase-aware `FetchError`** — 25 codes × 10 phases × 7 categories, with user-facing summaries and `suggestRetryTimeoutMs`. pi-scraper has a simpler `HttpError` model.
- **Paywall bypass** — `bypass: true` with a 7-step strategy chain (`archive` → bot UAs → `block_js` → `cookies`) tuned for top-50+ sites. No equivalent in pi-scraper.
- **Adaptive selectors** — `adaptive: true` fingerprints element structure to survive site redesigns. We have it; they have selector healing (text-anchor fallback), but not full structural fingerprinting.
- **Inline AI summarization** — we summarize via Google AI Mode (headless Chrome) when content exceeds the preview budget. pi-scraper does it via a model adapter that requires the user to have a configured LLM.
- **`wreq-js` for static TLS fingerprinting** — we use the `wreq-js` library for anti-bot TLS, which is much faster than CloakBrowser for static pages. pi-scraper uses `impit`.
- **Search** — `aio-websearch` covers DDG, Brave, and Google (with a 7s cap + 10-min disk cache). pi-scraper doesn't have a search tool.
- **Inline prompt-injection detection** — we scan fetched content for instruction-override, role-injection, jailbreak patterns and warn/redact/tag. pi-scraper doesn't.
- **Secret scanning** — we block URLs with API keys/tokens before outbound request. pi-scraper doesn't.
- **18 vertical extractors** — we have a wider list (npm, PyPI, crates.io, RubyGems, Packagist, pub.dev, Go, NuGet, HN, Reddit, arXiv, Stack Exchange, YouTube, Wikipedia, Open Library, DEV.to, SonarCloud, docs sites). pi-scraper has 25 but most are YAML and overlap.
- **`aio-webmap` discovery** — separate tool for inventorying URLs without fetching. We have it; pi-scraper has it as `web_map` (same idea).

---

## What we are NOT doing in 0.5.0

- Search tool TUI (lower priority — `aio-websearch` already returns concise lists)
- Sitemap/pull TUI (overkill for batch discovery)
- Bun monorepo migration (we're a single-package extension)
- Forking wreq-js (upstream works for our use cases)
- Renaming our tools (`aio-webfetch` is our brand, smart-fetch uses `web_fetch`)
- CloakBrowser binary (200MB+ native dep; we have wreq-js + Playwright + paywall bypass)
- SQLite index (current JSON + blobs work fine at our cache scale)
- Migrating ALL verticals to YAML (P16 only migrates the top 5-10)
- Persistent browser sessions (P17 deferred to 0.6.0; needs Playwright persistent context work)

---

## Release checklist

- [x] Phase-aware `FetchError` (P2) — `src/tools/fetch-error.ts`, 50 tests
- [x] TUI `renderResult` (P1) — `src/tools/render-result.ts`, 39 tests
- [x] Multiple output formats (P3) — `format` parameter, 17 tests
- [x] Security hardening (path traversal, SSRF, withTimeout) — 8 tests
- [x] `readResponseTextWithProgress` + `SmartFetchResult` fields — 6 tests
- [x] pi-scraper audit — 8 new priorities (P10–P17) triaged
- [ ] `kind: "file"` result type (P4)
- [ ] Alternate-link fallback (P5)
- [ ] Settings file support (P6)
- [ ] DI factory for `content.ts` (P7)
- [ ] Soft-404 detector (P8)
- [ ] WebFetch provider registration (P9)
- [ ] RAG `chunks` parameter (P10) — pi-scraper inspiration
- [ ] Crawl strategies `dfs` / `best-first` (P11) — pi-scraper inspiration
- [ ] Content line filters (P12) — pi-scraper inspiration
- [ ] `/webaio-config` slash command (P13) — pi-scraper inspiration
- [ ] `respectRobots` config (P14) — pi-scraper inspiration
- [ ] Diff snapshots (P15) — deferred to 0.6.0
- [ ] YAML vertical manifests (P16) — deferred to 0.6.0
- [ ] Persistent browser sessions (P17) — deferred
- [ ] Update README with new `format` parameter
- [ ] Update README with new `kind: file` result type
- [x] Run all 357 existing tests to confirm no regressions (now 388: 145 unit + 31 new-features + 65 paywall + 22 github-check + 39 render + 50 fetch-error + 6 fetch-progress + 8 hardening + 17 format + 5 integration)
- [ ] Bump version to 0.5.0
- [ ] Update CHANGELOG
