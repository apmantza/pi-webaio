<!-- markdownlint-disable MD013 MD024 MD060 -->

# Tools Reference

Registered pi tools and parameters provided by pi-webaio.

## Tools

| Tool             | Description                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aio-websearch`  | Search the web using DuckDuckGo, Brave, Yahoo, Bing, and Google in parallel (no API keys required). Returns compact results with title, URL, and snippet. Results are ranked by cross-engine consensus — URLs returned by multiple engines rank higher. 7s cap. Google runs via headless Chrome CDP (auto-launched). 10-minute cache. |
| `aio-webfetch`   | Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Long content is **AI-summarized** via Google AI Mode; full file always saved. Detects PDFs, GitHub repos, and Next.js RSC. Supports `format: "markdown\|html\|text\|json\|raw"`, `chunks` for RAG, auto escalation, and opt-in paywall bypass.     |
| `aio-webcontent` | Retrieve previously fetched content from session storage by URL. Returns **full untruncated content** — no data loss.                                                                                                                                                                                                                 |
| `aio-webmap`     | Discovery-only tool — finds pages via robots.txt, sitemaps, navigation links, and llms.txt without fetching content. Returns structured URL list.                                                                                                                                                                                     |
| `aio-webresult`  | Retrieve a previously fetched result by persistent response ID. Survives restarts. Shows recent results if ID not found.                                                                                                                                                                                                              |
| `aio-webpull`    | Pull any public website or docs site into local markdown files. Discovers pages via sitemap, navigation links, or crawling. Rewrites internal links to relative `.md` paths. Supports `routes` for per-pattern routing, `resume` for checkpoint resume, `adaptive` selectors, and `bypass` for opt-in paywall bypass on every page. Automatically builds a BM25 index for offline search. |
| `aio-webquery`   | BM25 full-text search over a corpus pulled by `aio-webpull`. No re-fetching — purely local, offline retrieval. Returns top-k chunks with source file, original URL, and heading breadcrumb. Requires running `aio-webpull` first to build the index.                                                                                   |
| `aio-webresearch`| Single-round research orchestrator: fans out `aio-websearch` over a query (and optional sub-queries), ranks/dedupes sources, fetches the top-N through the webfetch pipeline, builds a local BM25 corpus, and writes an auditable bundle (`STATUS.md`, `reports/`, `sources/`, `data/`) under `.pi/webaio-research/`. Deterministic retrieval + bookkeeping only — no LLM calls inside the tool; the calling agent writes `reports/CLAIMS.md`. Single-round MVP; iterative loop is a follow-up. |

### Tool Parameters

#### `aio-websearch`

| Parameter | Type      | Default | Description                                                                       |
| --------- | --------- | ------- | --------------------------------------------------------------------------------- |
| `query`   | `string`  | —       | Search query (e.g. 'React Server Components RFC')                                 |
| `max`     | `number`  | `15`    | Max results per engine. Up to 25 total after dedup across all engines.            |
| `google`  | `boolean` | `true`  | Also search Google via headless Chrome CDP. Set to `false` to use only DDG/Brave. |

#### `aio-webfetch`

| Parameter         | Type       | Default      | Description                                                                                           |
| ----------------- | ---------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `url`             | `string`   | —            | Single URL to fetch. Use either `url` or `urls`, not both.                                            |
| `urls`            | `string[]` | —            | Multiple URLs to fetch in parallel. Use either `url` or `urls`, not both.                             |
| `out`             | `string`   | auto-derived | Output file path under temp (for single url only)                                                     |
| `format`          | `string`   | `markdown`   | Output format: `markdown` (saves to disk) \| `html` \| `text` \| `json` \| `raw` (all in-memory)    |
| `chunks`          | `boolean`  | `false`      | Split markdown into paragraph-bounded chunks for RAG. Only applies to `format: "markdown"`.            |
| `maxTokens`       | `number`   | `512`        | Soft target size per chunk in tokens.                                                                  |
| `overlapTokens`   | `number`   | `50`         | Tail-overlap from the previous chunk prepended to each chunk after the first.                          |
| `mode`            | `string`   | `auto`       | Scrape mode: `auto` (escalates), `fast`, `fingerprint`, or `browser`                                  |
| `browser`         | `string`   | latest       | Browser profile for TLS fingerprinting. Options: `chrome_145`, `firefox_147`, `safari_26`, `edge_145` |
| `os`              | `string`   | `windows`    | OS profile for fingerprinting. Options: `windows`, `macos`, `linux`, `android`, `ios`                 |
| `proxy`           | `string`   | —            | Proxy URL (`http://user:pass@host:port` or `socks5://host:port`). Supports HTTP, HTTPS, SOCKS5.       |
| `cacheTtlSeconds` | `number`   | —            | Opt-in cache TTL in seconds. Omit for fresh fetches.                                                  |
| `compile`         | `boolean`  | `false`      | Compile batch results into a single context package                                                   |
| `prune`           | `number`   | —            | Prune markdown to token budget (e.g. 3000)                                                            |
| `interactive`     | `boolean`  | `false`      | Extract interactive elements as numbered refs                                                         |
| `start_index`     | `number`   | `0`          | Return content starting from this character index (0-based). Use with `max_length` for pagination.    |
| `max_length`      | `number`   | unlimited    | Maximum characters to return. Use with `start_index` for pagination.                                  |
| `bypass`          | `boolean`  | `false`      | If a paywall is detected, run a strategy chain (`archive` → bot UAs → `block_js` → `cookies`) to bypass. Opt-in. |
| `bypassStrategies`| `string[]` | —            | Custom strategy chain order. Options: `archive`, `ua:googlebot`, `ua:bingbot`, `ua:facebookbot`, `referer:google`, `block_js`, `cookies`. |

#### `aio-webcontent`

| Parameter | Type     | Default | Description                       |
| --------- | -------- | ------- | --------------------------------- |
| `url`     | `string` | —       | URL of previously fetched content |

#### `aio-webmap`

| Parameter | Type     | Default   | Description                            |
| --------- | -------- | --------- | -------------------------------------- |
| `url`     | `string` | —         | URL to discover pages for              |
| `max`     | `number` | `100`     | Max URLs to discover                   |
| `browser` | `string` | latest    | Browser profile for TLS fingerprinting |
| `os`      | `string` | `windows` | OS profile for fingerprinting          |

#### `aio-webresult`

| Parameter | Type     | Default | Description                               |
| --------- | -------- | ------- | ----------------------------------------- |
| `id`      | `string` | —       | Response ID from a previous webfetch call |

#### `aio-webpull`

| Parameter | Type      | Default      | Description                                                                                           |
| --------- | --------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `url`     | `string`  | —            | URL to pull (e.g. https://docs.example.com)                                                           |
| `out`     | `string`  | `<hostname>` | Output directory under temp                                                                           |
| `max`     | `number`  | `100`        | Max pages to pull                                                                                     |
| `mode`    | `string`  | `auto`       | Scrape mode: `auto` (escalates), `fast`, `fingerprint`, or `browser`                                  |
| `browser` | `string`  | latest       | Browser profile for TLS fingerprinting. Options: `chrome_145`, `firefox_147`, `safari_26`, `edge_145` |
| `os`      | `string`  | `windows`    | OS profile for fingerprinting. Options: `windows`, `macos`, `linux`, `android`, `ios`                 |
| `proxy`   | `string`  | —            | Proxy URL (`http://user:pass@host:port` or `socks5://host:port`). Supports HTTP, HTTPS, SOCKS5.       |
| `compile` | `boolean` | `false`      | Compile pulled pages into a single context package                                                    |
| `bypass`  | `boolean` | `false`      | If a paywall is detected on any page, run the per-domain strategy chain to bypass. Opt-in.            |
| `resume`  | `boolean` | `true`       | Resume from previous pull (auto-detected from output directory). Set `false` to force a fresh pull.   |
| `routes`  | `object[]`| —            | URL pattern → fetcher mode routing. Each: `{ pattern: string, mode?: string, browser?: string, os?: string, extractor?: string }`. Pattern supports substring, glob (`*/docs/*`), or regex (`/^\/api\//`). First match wins. |
| `adaptive`| `boolean` | `false`      | Enable adaptive content selectors that survive site redesigns via structural DOM fingerprinting.       |

#### `aio-webquery`

| Parameter | Type     | Default              | Description                                                                                         |
| --------- | -------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `query`   | `string` | —                    | Search query to run against the local corpus                                                        |
| `dir`     | `string` | `<os-temp>/pi-webaio`| Directory containing a pulled corpus (output of `aio-webpull`). Defaults to the standard temp base. |
| `topK`    | `number` | `8`                  | Number of top-ranked chunks to return                                                               |

#### `aio-webresearch`

| Parameter     | Type       | Default | Description                                                                                     |
| ------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------- |
| `query`       | `string`   | —       | Primary research question or topic.                                                              |
| `queries`     | `string[]` | —       | Optional agent-supplied sub-queries fanned out alongside `query` (capped at 6 total).             |
| `maxSources`  | `number`   | `6`     | Max ranked sources to fetch and include in the bundle. Clamped to 3-12.                           |
| `outDir`      | `string`   | `.pi/webaio-research/<timestamp>_<slug>/` | Output directory for the bundle, resolved relative to cwd.                  |
| `writeBundle` | `boolean`  | `true`  | Write the bundle to disk. Set `false` to only search/fetch/rank in memory.                        |
