# pi-webaio 0.5.0 Roadmap

**Theme:** Polish the agent experience — better TUI, smarter errors, more output formats.

Inspired by [Thinkscape/agent-smart-fetch](https://github.com/Thinkscape/agent-smart-fetch) and the gaps between their tight `web_fetch` core and our broader 6-tool surface.

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

## What we are NOT doing in 0.5.0

- Search tool TUI (lower priority — `aio-websearch` already returns concise lists)
- Sitemap/pull TUI (overkill for batch discovery)
- Bun monorepo migration (we're a single-package extension)
- Forking wreq-js (upstream works for our use cases)
- Renaming our tools (`aio-webfetch` is our brand, smart-fetch uses `web_fetch`)

---

## Release checklist

- [x] Phase-aware `FetchError` (P2) — `src/tools/fetch-error.ts`, 50 tests
- [x] TUI `renderResult` (P1) — `src/tools/render-result.ts`, 39 tests
- [x] Multiple output formats (P3) — `format` parameter, 17 tests
- [x] Security hardening (path traversal, SSRF, withTimeout) — 8 tests
- [x] `readResponseTextWithProgress` + `SmartFetchResult` fields — 6 tests
- [ ] `kind: "file"` result type (P4)
- [ ] Alternate-link fallback (P5)
- [ ] Settings file support (P6)
- [ ] DI factory for `content.ts` (P7)
- [ ] Soft-404 detector (P8)
- [ ] WebFetch provider registration (P9)
- [ ] Update README with new `format` parameter
- [ ] Update README with new `kind: file` result type
- [x] Run all 357 existing tests to confirm no regressions (now 388: 145 unit + 31 new-features + 65 paywall + 22 github-check + 39 render + 50 fetch-error + 6 fetch-progress + 8 hardening + 17 format + 5 integration)
- [ ] Bump version to 0.5.0
- [ ] Update CHANGELOG
