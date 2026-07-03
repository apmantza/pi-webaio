<!-- markdownlint-disable MD013 MD024 MD060 -->

# Architecture and Implementation Notes

## How it's built

- **Precompiled `dist/`** — TypeScript source compiles to `dist/index.js` via `tsc` on `npm install` (the `prepare` hook). pi loads the compiled JS directly, no jiti transpile on every startup.
- **TUI rendering** — All 6 tools ship custom `renderCall` / `renderResult` components. Progress view shows per-item status, spinner, elapsed time, and download progress in real time. Result view shows expanded preview with responseId, format, browser/os profile, package path, chunk count, and error details. Phase + category badge for errors.
- **Phase-aware FetchError** — 25 failure codes × 10 fetch phases × 7 categories. `createFetchError()` produces frozen rich error objects. `classifyError()` maps Node errors. `buildUserFacingFetchErrorSummary()` produces agent-friendly messages. `suggestRetryTimeoutMs()` extrapolates from partial download progress.
- **CI** — 4 GitHub Actions jobs: lint+typecheck (with `npm audit` and lockfile check), test (all 11 suites), prod-install-build (simulates the real `npm install --omit=dev` path), install-test (ubuntu/windows/macos — tarball verification + entry-point loading). Auto-release on version tag with GitHub Release notes.
- **Security** — 19 secret patterns (AWS, GitHub, GitLab, npm, PyPI, Slack, Stripe, Google, SendGrid, DigitalOcean, OpenAI including `sk-proj-`/`sk-svcacct-`, Anthropic, Supabase, Vercel, Cloudflare, private keys, passwords in URLs). SSRF protection via DNS resolution + RFC 1918/RFC 6598/RFC 3927 range validation. Path-traversal guard in `utils.ts`. Prompt injection detection. Default GitHub CodeQL scanning.
