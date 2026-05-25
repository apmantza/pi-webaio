# pi-webaio — Inspirations

External projects and ideas worth borrowing from.

## scraperjs — <https://github.com/ruipgil/scraperjs>

Old-school PhantomJS scraper library, but a few patterns are worth considering:

### Router with path parameter extraction

Routes like `https?://youtube.com/watch/:id` extract params into `utils.params`. pi-webaio's `session-router` does pattern → mode/extractor routing, but doesn't extract path params for downstream use. Useful for multi-page scrapes where you need structured context (e.g. video IDs, article slugs) across the pipeline.

### Declarative promise-chain API

Fluent `.get().scrape().then().delay().timeout().async()` chain lets users define complex multi-step scraping workflows. pi-webaio tools are currently atomic (fetch one URL, return result). A "scraper chain" primitive could let users define pipelines: fetch page A → extract links → fan-out fetch → compile results.

### Code injection into pages

`utils.scraper.inject(path/to/code.js)` injects custom JS before scraping. pi-webaio already does this implicitly (Readability, RSC extraction), but making it user-configurable via `aio-webpull` routes could let users run custom extraction logic per URL pattern.

### Conditional chain termination

`utils.stop()` halts a scraping pipeline mid-chain based on runtime conditions. Useful for "stop crawling if we hit a login wall" or "abort if content looks like a paywall."

### Already solved in pi-webaio

- **Browser pooling** — `browser-pool.ts` does this better with Playwright
- **Static vs dynamic scraper** — wreq + Playwright fallback covers both cases
- **jQuery-style DOM selection** — linkedom + Readability already handle extraction

## metascraper — <https://github.com/microlinkhq/metascraper>

A modular library for extracting unified metadata from websites (Open Graph, Microdata, RDFa, Twitter Cards, JSON-LD, HTML). Plugin-based architecture with 40+ rule bundles.

### Modular rule-bundle architecture

Each metadata field (author, date, image, description, video, audio, logo, publisher, feed URL, etc.) is a separate npm package. Rules are ordered by priority — first match wins, then fallback. Users compose pipelines by importing only the rules they need:

```js
const metascraper = require('metascraper')([
  require('metascraper-author')(),
  require('metascraper-date')(),
  require('metascraper-image')(),
  require('metascraper-description')(),
])
```

**Relevance:** pi-webaio's extraction pipeline is a fixed sequence (PDF → JSON → Readability → defuddle, etc.). A rule-bundle system could let users plug in custom extractors or reorder the pipeline per URL pattern via `aio-webpull` routes.

### Vendor-specific extractors

Dedicated plugins for platforms like Amazon, Bluesky, Dribbble, Instagram, Reddit, Spotify, Telegram, TikTok, X (Twitter), YouTube. Each handles the site's specific HTML structure for reliable extraction.

**Relevance:** pi-webaio already has a `src/verticals/` registry (npm, PyPI, HackerNews, Reddit, arXiv, etc.). The metascraper approach of vendor rules as composable plugins is a good pattern to follow if we want to expand the verticals system.

### pickPropNames / omitPropNames

Users can specify exactly which metadata fields to extract (`pickPropNames`) or which to skip (`omitPropNames`). Rules for omitted fields are never executed, saving CPU.

**Relevance:** Could add a `pick` or `fields` parameter to `aio-webfetch` / `aio-webpull` so users who only need `title` + `image` + `description` don't pay for full markdown conversion.

### Structured metadata output

Returns a clean JSON object with normalized fields (`author`, `date`, `description`, `image`, `logo`, `publisher`, `title`, `url`, `audio`, `video`, `lang`, `feed`). pi-webaio currently returns markdown — adding an optional `structured` mode could return this same schema.

**Relevance:** A `aio-webfetch(url, { structured: true })` could return `{ title, description, image, author, date, lang }` alongside or instead of markdown. Useful for link previews, card generation, or bulk metadata collection.

### Defuddle + Readability connectors

metascraper has official connectors for both Mozilla Readability (`metascraper-readability`) and Defuddle (`metascraper-defuddle`) — the exact two libraries pi-webaio already uses. Confirms these are the right choices for content extraction.

### Benchmark-driven accuracy

Includes a benchmark suite comparing against html-metadata, open-graph-scraper, node-metainspector, and unfluff. Tests against 100+ real-world sites (BBC, TechCrunch, The Verge, Wikipedia, etc.) with snapshot tests.

**Relevance:** pi-webaio could benefit from a similar benchmark suite — fetch 50 diverse URLs and score extraction quality (title accuracy, description quality, image detection, etc.) when changing the extraction pipeline.

## AnyCrawl — <https://github.com/any4ai/AnyCrawl>

A high-performance crawling and scraping toolkit with SERP crawling, site crawling, and LLM-powered structured data extraction. Self-hosted API architecture.

### LLM-powered JSON extraction from pages

Pass a JSON schema and AnyCrawl uses an LLM to extract structured data from any page:

```json
{
  "url": "https://example.com",
  "json_options": {
    "schema": {
      "type": "object",
      "properties": {
        "company_mission": { "type": "string" },
        "is_open_source": { "type": "boolean" },
        "employee_count": { "type": "number" }
      }
    }
  }
}
```

**Relevance:** pi-webaio already has AI summarization via Google AI Mode for long content. Adding schema-based JSON extraction could be a powerful addition — users specify a JSON schema and get structured data instead of markdown. Could integrate with the existing summarization pipeline or as a separate `extract` mode.

### Multiple scraping engines per request

Users choose the engine per request: `cheerio` (static, fastest), `playwright` (JS rendering), or `puppeteer` (JS rendering with Chrome). This gives users control over speed vs. completeness.

**Relevance:** pi-webaio's `aio-webfetch` already has `mode` (fast, fingerprint, browser, auto) with auto-escalation. AnyCrawl's explicit engine selection is a simpler model — could add an `engine` parameter for users who want deterministic behavior.

### Site crawling with depth and strategy controls

Crawl API with `max_depth`, `limit`, `strategy` (all, same-domain, same-hostname, same-origin), `include_paths`, and `exclude_paths`. Per-page scrape options inherited from the Scrape API.

**Relevance:** pi-webaio's `aio-webpull` already does site crawling with `max` pages and discovery via sitemap/nav/crawl. Could add `max_depth`, `strategy` (same-domain vs same-origin vs all), and `include_paths`/`exclude_paths` for more precise control.

### Cache control with max_age and store_in_cache

`max_age` (ms) controls cache freshness — `0` forces refresh, `>0` accepts cached content within that age. `store_in_cache` controls whether results are stored.

**Relevance:** pi-webaio has 30-min session cache and 10-min search cache, but no user-facing cache control parameters. Adding `cache_ttl` or `fresh` parameters could let users opt-in to stale data for speed or force fresh fetches for accuracy.

### Self-hosted API architecture

AnyCrawl is designed as a self-hosted scraping API (Docker, pnpm monorepo) with middleware for auth, credits, logging, and rate limiting. Controllers for scrape, crawl, search, map, scheduled tasks, and webhooks.

**Relevance:** Not directly applicable to pi-webaio (which is a pi extension, not a server), but the separation of concerns (scrape vs crawl vs search as distinct controllers) is a clean architecture pattern.
