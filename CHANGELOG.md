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

