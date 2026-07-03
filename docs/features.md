<!-- markdownlint-disable MD013 MD024 MD060 -->

# Features

Detailed feature reference for pi-webaio.

## Overview

**pi-webaio** is a pi extension that gives your agent eyes on the web. It registers six tools that let pi search, fetch, discover, and archive web content — all without API keys or paid services.

When you search, pi-webaio queries 5 engines in parallel (DuckDuckGo, Brave, Yahoo, Bing, and Google via headless Chrome). Results that show up across multiple engines rank higher — consensus is a signal of quality. When you fetch a page, it tries 14 different extraction backends in order, stripping cookie banners and anti-bot noise along the way, so you get clean markdown instead of raw HTML soup. Paywalled news sites (NYT, WaPo, FT, WSJ, etc.) can be bypassed on opt-in with a strategy chain that tries archive.org, bot-UA impersonation, and Playwright with paywall-script blocking.

Long pages are automatically **AI-summarized** via Google AI Mode (headless Chrome) — you get a concise overview instantly, while the full content is always saved to disk for later inspection. For sites with API-first extractors (GitHub, YouTube, npm, PyPI, crates.io, RubyGems, Packagist, pub.dev, Go, NuGet, Reddit, Hacker News, arXiv, Stack Exchange, Wikipedia, Open Library, DEV.to, SonarCloud, docs sites), pi-webaio bypasses HTML scraping entirely and pulls structured data directly.

For RAG pipelines, fetches can be returned as **paragraph-bounded chunks with overlap** (CJK-aware token estimation). All 6 tools ship with polished **TUI rendering** (real-time progress, elapsed time, phase/category badges, retry hints) and a **phase-aware error system** (25 failure codes × 10 fetch phases × 7 categories) that includes smart retry-timeout suggestions based on partial download progress.

It's built for agents that need to:

- **Research** — find current information, documentation, or references
- **Read** — pull articles, docs, GitHub repos, PDFs, or YouTube transcripts into markdown
- **Explore** — map out a website's pages before pulling them all
- **Remember** — cached results survive restarts and can be retrieved by URL or ID
- **Bypass** — opt-in paywall bypass for news sites that block non-subscribers
- **Chunk for RAG** — split fetched markdown into pre-sized chunks with optional overlap

No API keys. No subscriptions. No brittle scraping scripts. Just `pi install npm:pi-webaio` and go.

## How AI summarization works

When you fetch a single URL with `aio-webfetch`, long pages are automatically summarized using Google AI Mode (via headless Chrome CDP). Here's the logic:

1. **Short pages** (under ~1800 chars) — displayed in full, no summarization needed.
2. **Long pages** — if Google Chrome is available, pi-webaio launches a headless Chrome instance, navigates to the URL, and captures the AI Mode summary.
3. **Fallback** — if Chrome is unavailable or AI Mode fails, the first ~1800 chars are shown with a note that the full file was saved to disk.

**Summarization is automatically skipped** for content that already comes from a structured pipeline:

| Source                                                     | Why skipped                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **GitHub** (repos, blobs, issues, PRs, raw files)          | Clean structured data from git clone / REST API — no HTML noise to summarize |
| **YouTube**                                                | Transcript + metadata via Innertube API — the transcript IS the content      |
| **SonarCloud**                                             | Quality metrics fetched via API — structured data in table form              |
| **npm / PyPI / crates.io / RubyGems / Packagist / pub.dev / Go / NuGet / Reddit / Hacker News / arXiv / Wikipedia / Stack Exchange / Open Library / DEV.to / SonarCloud / docs sites** | API-first extractors return clean markdown directly                          |

Skipping is enforced by both a **content marker** (`> via <source>`) and a **URL hostname check** (covers `github.com`, `raw.githubusercontent.com`, `gist.github.com`), so even if an extractor fails and falls through to the HTML pipeline, GitHub URLs never get AI-summarized.

## Special pipelines: GitHub, YouTube, and more

Instead of scraping HTML, pi-webaio routes known sites through purpose-built extractors that fetch structured data directly. This means faster results, cleaner markdown, and no AI summarization of already-clean content.

### GitHub

GitHub URLs are intercepted **before any HTTP request** and handled by a dedicated pipeline:

| URL pattern                                        | Method                                               | What you get                                          |
| -------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `github.com/owner/repo`                            | `git clone` (or `gh repo clone`) + README extraction | File tree, architecture hints, full README            |
| `github.com/owner/repo/blob/branch/path`           | `raw.githubusercontent.com` fetch                    | Raw file content                                      |
| `github.com/owner/repo/tree/branch/path`           | GitHub REST API                                      | Directory listing                                     |
| `github.com/owner/repo/issues`                     | GitHub REST API                                      | Issue list with states                                |
| `github.com/owner/repo/pull/123`                   | GitHub REST API                                      | Single PR details                                     |
| `github.com/owner/repo/commit/sha`                 | GitHub REST API                                      | Commit details                                        |
| `github.com/owner/repo/actions/runs/123`           | GitHub REST API + logs                               | Run status, jobs, step results, error log excerpts    |
| `github.com/owner/repo/commit/sha/checks/{id}/logs/{step?}` | GitHub REST API + `gh run view --log`        | Check status, conclusion, annotations, log excerpt (Actions jobs); the `{step}` index resolves to a step name via the job's `steps[]` API field, then the tab-separated log is sliced to that step's section; metadata-only for external CI |
| `api.github.com/repos/{owner}/{repo}/actions/runs/{runId}/logs` | `gh run view --log` (via gh CLI auth)        | Plain-text workflow logs. Previously returned HTTP 403 because the endpoint requires auth + redirects to a zip archive; now uses your existing `gh auth login` session for plain-text output with 302-redirect handling. |
| `github.com/owner/repo/security/*`                 | GitHub REST API                                      | Security advisories, code scanning, Dependabot alerts |
| `raw.githubusercontent.com/owner/repo/branch/path` | Direct fetch + fallback to pipeline                  | Raw file content with source marker                   |

All GitHub results are tagged with `> via GitHub` and AI summarization is skipped. Non-existent repos now return a clear "Repository not found or inaccessible" error instead of an empty directory listing.

### YouTube

YouTube video URLs are matched by a [vertical extractor](../src/verticals/youtube.ts) that uses `youtube-transcript-plus` (Innertube API — no API key required):

- Extracts **metadata**: title, channel, duration, views, language, tags (first 10), description
- Extracts the **full transcript** (up to ~40K chars, truncated beyond that)
- Supports `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/embed/` formats
- Playlist URLs are detected but not yet supported (fetch individual videos instead)

### SonarCloud

SonarCloud URLs (`sonarcloud.io/project/...`) are fetched via the SonarCloud REST API:

- **Security hotspots** — grouped by category with severity breakdown
- **Issues** — severity, type, file, line number, message
- **Overview** — quality gate metrics in table form
- **Activity** — chronological analysis events

### API-first extractors (vertical registry)

These 19 sites are handled by [dedicated extractors](../src/verticals/) that use their public APIs:

| Site               | Extractor                        | API                                              |
| ------------------ | -------------------------------- | ------------------------------------------------ |
| **npm**            | `src/verticals/npm.ts`           | npm registry JSON API                            |
| **PyPI**           | `src/verticals/pypi.ts`          | PyPI JSON API                                    |
| **Hacker News**    | `src/verticals/hackernews.ts`    | Firebase API                                     |
| **Reddit**         | `src/verticals/reddit.ts`        | `.json` endpoint                                 |
| **arXiv**          | `src/verticals/arxiv.ts`         | Atom export API                                  |
| **Wikipedia**      | `src/verticals/wikipedia.ts`     | MediaWiki REST API (all editions)                |
| **Stack Exchange** | `src/verticals/stackexchange.ts` | Stack Exchange API v2.3                          |
| **Open Library**   | `src/verticals/openlibrary.ts`   | Open Library REST API                            |
| **DEV.to**         | `src/verticals/devto.ts`         | DEV.to public REST API                           |
| **crates.io**      | `src/verticals/cratesio.ts`      | crates.io registry JSON API                      |
| **RubyGems**       | `src/verticals/rubygems.ts`      | RubyGems.org JSON API                            |
| **Packagist**      | `src/verticals/packagist.ts`     | Packagist JSON API (PHP)                         |
| **pub.dev**        | `src/verticals/pubdev.ts`        | pub.dev API (Dart/Flutter)                       |
| **Go packages**    | `src/verticals/gopackages.ts`    | Go module proxy (proxy.golang.org)               |
| **NuGet**          | `src/verticals/nuget.ts`         | NuGet Search API v3                              |
| **GitLab**         | `src/verticals/gitlab.ts`        | GitLab REST API v4 (gitlab.com + self-hosted)    |
| **Docs sites**     | `src/verticals/docs-site.ts`     | Docusaurus, GitBook, MDN, VitePress extraction   |

All vertical extractors tag their output with `> via <name>`, which automatically skips AI summarization.

### Auto-escalation: when scraping gets blocked

When the normal fetch pipeline hits a bot wall (Cloudflare, Anubis, DataDome, PerimeterX, etc.), pi-webaio escalates automatically:

1. **Fingerprint rotation** — retries with alternate browser profiles (`firefox_147`, `safari_26`, `edge_145`)
2. **Browser mode** — last resort: renders the page with Playwright (headless Chromium)

This is all transparent — the `mode` parameter controls escalation: `auto` (default, escalates on detection), `fast` (no escalation), `fingerprint` (alternate browsers only), or `browser` (Playwright always).

### Paywall bypass: when the content itself is gated

For paywalled news sites (NYT, WSJ, FT, WaPo, The Economist, Le Monde, etc.), the `bypass: true` flag runs a strategy chain after the normal fetch detects a paywall. The chain tries each step in order and returns the first response that no longer contains paywall markers:

| Step | Mechanism | Cost | Effectiveness |
|------|-----------|------|---------------|
| `archive` | Wayback Machine (`web.archive.org/web/2/{url}`) then `archive.ph` | ~1-2s, free | ~80% of articles have at least one snapshot |
| `ua:googlebot` | Fetch with `Googlebot/2.1` UA + no `Sec-Ch-Ua` | ~500ms, free | ~40% (Google News partners + soft paywalls) |
| `ua:bingbot` | Fetch with `Bingbot/2.0` UA | ~500ms, free | Similar to Googlebot, useful for sites that whitelist both |
| `ua:facebookbot` | Fetch with `facebookexternalhit/1.1` UA | ~500ms, free | Small share, useful for sites that whitelist FB |
| `referer:google` | Fetch with `Referer: https://www.google.com/` | ~500ms, free | ~5% of sites that check referer only |
| `block_js` | Playwright with `route.abort()` for 21 known paywall vendors (Piano, Tinypass, Poool, Zephr, Sophi) + DOM override | ~3-5s, needs Playwright | ~60% of vendor-paywalled sites |
| `cookies` | Fetch with cookies dropped (rejects `cf_clearance` etc.) | ~500ms, free | ~10% of sites that track returning readers |

Top-50 news sites have curated strategies in `src/paywall-sites.ts` (NYT = `block_js` → `archive`; WSJ = `block_js` → `archive`; FT = `block_js` → `archive`; unknown domain = `archive` → `ua:googlebot` → `block_js`). The same flags work on `aio-webpull` to apply bypass to every page in a pull.

The bypass engine also triggers on **HTTP 403/401 from known paywall sites** (NYT, WSJ, FT, etc. that block before any content is served) — not just on content-marker detection. So even when the server returns a bare 403 with no body for `detectPaywall` to analyze, the strategy chain still runs and the archive.org snapshot is returned.

Set `PI_WEBAIO_DEBUG=1` to log every bypass attempt and confidence score — useful when triaging sites that still block.

**Note:** The bypass flag is opt-in. A normal `aio-webfetch(url)` gets the regular auto-escalation pipeline. You must explicitly pass `bypass: true` to trigger the strategy chain — this is intentional, since paywall circumvention is a deliberate user action.

## Output formats

`aio-webfetch` accepts a `format` parameter that controls what the tool returns:

| Format     | Behavior                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `markdown` | (default) Save to disk under `os.tmpdir()/pi-webaio/<host>/<path>.md`. Return body inline.        |
| `html`     | Return raw HTML body inline. No disk write.                                                       |
| `text`     | Return plain-text rendering of the markdown (strips headers, bold, links, code fences, HTML tags). |
| `json`     | Return a structured JSON object with `url`, `title`, `author`, `published`, `site`, `language`, `wordCount`, `mimeType`, `content`, `rawHtml`. |
| `raw`      | Return the original raw HTML body. No markdown conversion.                                          |

Non-markdown formats stay in-memory and never touch disk — useful for piping into other tools or for JSON consumers that need structured data. The `compile` parameter auto-skips when any result is non-markdown.

## RAG chunking

`aio-webfetch` accepts a `chunks` parameter that splits the fetched markdown into paragraph-bounded chunks for RAG pipelines:

```
aio-webfetch url: https://en.wikipedia.org/wiki/Node.js
            chunks: true
            maxTokens: 512
            overlapTokens: 50
```

- `chunks: true` enables chunking (default: `false`)
- `maxTokens` is the soft target size per chunk in tokens (default: 512)
- `overlapTokens` is the tail-overlap from the previous chunk (default: 50)
- Only applies to `format: "markdown"` (other formats stay in-memory; the caller can chunk them)
- Token estimation is CJK-aware (counts CJK chars at 1.5x Latin weight)
- The tool result includes both the original markdown and a `chunks` array with metadata (index, total, token count, content)

The chunks are also formatted as a readable numbered text section in the tool output for direct inspection.

## Error handling

`aio-webfetch` uses a **phase-aware FetchError system** with 25 failure codes × 10 fetch phases × 7 categories. Each error carries:

- `code` (e.g. `http_error`, `tls_error`, `timeout`, `blocked`, `paywall`, `security_blocked`)
- `phase` (e.g. `connecting`, `loading`, `headers`, `downloading`, `processing`)
- `category` (e.g. `network`, `server`, `security`, `client`)
- `retryable` (boolean — whether the agent should try again)
- `statusCode`, `downloadedBytes`, `contentLength`, `elapsedMs` (for smart retry-timeout suggestions)

When a partial download is interrupted by a timeout, the suggested retry timeout is extrapolated from the download rate. Security blocks (secrets in URL, private IPs) are flagged with a clear `security_blocked` code instead of a generic "Could not reach server" error.

The TUI error view shows the phase + category badge and the suggested retry hint when the error is retryable.

## How search ranking works

When you search, pi-webaio queries 5 engines in parallel: DuckDuckGo, Brave, Yahoo, Bing, and Google (via headless Chrome). Results are scored by two signals:

- **Engine authority** — Google (5), Bing (3), DDG (2), Brave (2), Yahoo (1)
- **Cross-engine consensus** — +2 for each additional engine that agrees on the same URL

A result returned by all 5 engines outranks a Google-only result. Metadata (title/snippet) comes from the highest-weight engine for each URL.
