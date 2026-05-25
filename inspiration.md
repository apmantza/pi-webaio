# Inspiration

Curated ideas and techniques from other projects that could inform pi-webaio's development.

---

## Maxun ([github.com/getmaxun/maxun](https://github.com/getmaxun/maxun))

*Open-source no-code web data platform — browser automation, extraction, crawling, scraping.*
Analyzed: 2026-05-25

### Content Stability Detection
Maxun's `waitForStability` waits for page readiness using a triple-race strategy:
- `networkidle` event (10s timeout)
- **innerText length stability** — polls `document.body.innerText.length` every 100ms; if it stays constant for 8+ consecutive iterations (and > 200 chars), the page is stable
- Hard 10s timeout as final fallback

**Relevance for pi-webaio:** Our `aio-webfetch` and `aio-webpull` could use a similar stability heuristic when using Playwright (browser mode) instead of blindly waiting for `networkidle`. SPA-heavy sites often fire networkidle before content actually settles.

### Shadow DOM Flattening with Digit UI Handling
Maxun's scrape module walks the DOM for shadow hosts, then replaces each with a `<span>` containing extracted text. Special case: handles digit-based UI components (common in payment/price displays) by extracting `--current: N` CSS custom properties from `[part*="digit"]` elements and reconstructing numbers.

**Relevance for pi-webaio:** Our extraction pipeline doesn't explicitly handle shadow DOM. Adding shadow root flattening before Readability/defuddle processing would improve extraction quality on modern SPAs (Google, component libraries, web components).

### Selector Generation via @medv/finder
Maxun embeds the full [finder](https://github.com/antonmedv/finder) algorithm in-browser to generate minimal, unique CSS selectors. Key features:
- Bottom-up search from target element toward `document.body`
- Penalty-based ranking (id: 0, attribute: 0.5, class: 1, tag: 2, wildcard: 3)
- 3-pass strategy: try all combinations → try 2 per level → try 1 per level
- Optimizes found paths by testing uniqueness via `querySelectorAll`

**Relevance for pi-webaio:** Our adaptive selector uses structural fingerprints (tag path, text density, child signatures). We could supplement with a finder-style algorithm to generate a human-readable CSS selector alongside the structural fingerprint, making selectors more debuggable and portable.

### Deep Iframe / Frame Traversal
Maxun's element picker traverses up to 4 levels of nested iframes and frames. It adjusts coordinates relative to each frame's bounding rect, and tracks the full frame hierarchy (by id, name, or src) for replay.

**Relevance for pi-webaio:** We don't currently handle iframes in browser mode. If we ever add interactive browsing, this recursive frame traversal pattern (with coordinate transformation) is the right approach.

### Pagination Auto-Detection
Multi-layered detection strategy:
1. **Text pattern matching** — 10+ languages for "next page" and "load more" button text
2. **Arrow symbol detection** — matches `>`, `›`, `→`, `»`, `⟩` patterns
3. **Container heuristic** — looks for element text matching `paginat|page-nav|pager|page-numbers|page-list`
4. **Empirical verification** — actually clicks the detected button and checks if item count increased or scroll height grew by >100px
5. **Scroll fallback** — if click didn't add content, tries actual scrolling and measures DOM change

**Relevance for pi-webaio:** If we ever add automatic list extraction or crawling with pagination handling, this empirical verification approach (click → measure → confirm) is more robust than pure heuristic detection.

### Field Auto-Detection via In-Browser Script Injection
Maxun injects `pageAnalyzer.js` into the page context, which analyzes the DOM structure around a list selector and infers what fields are present (e.g., title, price, description) based on common patterns and text density.

**Relevance for pi-webaio:** Our vertical extractors are hardcoded per-site. A generic auto-detection script that runs in-browser could dynamically infer data schemas from list pages, reducing the need for per-site extractors.

### Browser Pool with Atomic Reservation
Maxun's pool design:
- Per-user browser instances (max 2: one "recording", one "run")
- Atomic slot reservation with locks (prevents race conditions)
- Reserved → Initializing → Ready → (Failed) state machine
- Stale slot cleanup (slots stuck > 5 min are reclaimed)
- Stale lock cleanup (locks held > 1 min are force-released)

**Relevance for pi-webaio:** Our browser pool already handles reuse and recycling. The atomic reservation + state machine + stale cleanup pattern is more robust than our current approach. Worth considering for production hardening.

### Workflow Interpreter with Where/What Pairs
Maxun's core interpreter uses a declarative workflow format:
- **Where** — conditions (URL match, selector presence, cookie state)
- **What** — actions (navigate, click, scrape, scroll, screenshot)
- Conditional execution based on page state matching
- Concurrency control with max parallel operations
- Progress tracking with percentage reporting

**Relevance for pi-webaio:** Not directly applicable (we're a fetch/search tool, not a workflow engine), but the conditional execution pattern could inspire smarter retry logic — e.g., "if selector X is present, try extraction method Y before falling back".

### LLM-Powered Extraction Mode
Maxun offers an "AI Mode" where the user describes what data they want in natural language, and an LLM generates the extraction selectors and schema.

**Relevance for pi-webaio:** Our AI summarization already uses Google AI Mode. We could extend this to structured extraction — e.g., a parameter like `extract: "product names and prices"` that generates extraction selectors dynamically.

### Shadow DOM Depth Limiting
All shadow DOM / iframe / frame traversal is capped at depth 4 (`MAX_SHADOW_DEPTH = 4`, `MAX_IFRAME_DEPTH = 4`). Prevents infinite loops on deeply nested content.

**Relevance for pi-webaio:** Good practice to note — any recursive DOM traversal should have explicit depth limits.

---

## you-get ([github.com/soimort/you-get](https://github.com/soimort/you-get))

*Tiny CLI media downloader — extracts videos, audios, images from 60+ sites via site-specific extractors and a universal fallback.*
Analyzed: 2026-05-25

### Universal Extractor with Content-Type Gate
you-get's fallback extractor (`universal.py`) is a masterclass in progressive media discovery:
1. **HEAD request** first — checks `Content-Type` before any heavy fetching
2. If HTML: tries **embed extractor** first (known video platforms embedded via iframes), then falls through to regex-based media discovery
3. If non-HTML: **direct download** with content-disposition filename parsing
4. Regex patterns cover: `og:video:url` meta tags, `.m3u8` HLS streams, MPEG-DASH `.mpd`, common media extensions (`.flv`, `.mp3`, `.mp4`, `.webm`), high-res images (`.jpg`, `.png`, `.gif`), `data-original` attributes, `<img>` with large `width`, and even URL-encoded/escaped variants

**Relevance for pi-webaio:** Our binary detection in `aio-webfetch` is good but basic. We could add a similar progressive discovery layer for media URLs — especially HLS (`.m3u8`) and DASH (`.mpd`) streams, which are increasingly common. A HEAD-first check also saves bandwidth by avoiding full HTML fetches when the URL is already a direct resource.

### Embed Extractor with Recursive iframe Traversal
you-get's embed extractor scans HTML for known video platform embed patterns (Youku, Bilibili, Vimeo, Dailymotion, etc.), then recurses into `<iframe>` tags up to 3 levels deep. Each level extracts the iframe's `src` and re-runs the same pattern matching.

**Relevance for pi-webaio:** When we encounter pages with embedded content (iframes, embedded players, lazy-loaded widgets), we currently skip them entirely. A bounded recursive iframe extraction could surface media and data hidden inside embedded frames — useful for webpull on content-heavy sites.

### Site Registry Pattern
you-get maintains a `SITES` dictionary mapping domain fragments to extractor modules. The dispatcher (`any_download`) normalizes URLs, checks the registry, and dynamically imports the matching extractor via `import_module`. Sites not in the registry fall through to the universal extractor.

**Relevance for pi-webaio:** Our vertical extractors use a similar registry pattern (`src/verticals/registry.ts`). you-get's approach is cleaner — the domain-to-module mapping is a simple flat dict, and the dynamic import means new extractors are zero-config. Our registry does the same thing but with more ceremony. Worth noting as the "simple is better" reference implementation.

### Download Resume via Temporary Files
you-get uses a `.download` extension for in-progress files. On restart, it detects the temp file, checks size, and resumes via HTTP `Range` headers. If the file already exists at the expected size, it skips entirely. The `--force` flag bypasses all checks.

**Relevance for pi-webaio:** Our `aio-webpull` checkpoint/resume handles URL-level resume (which URLs to fetch), but not file-level resume (resuming a partially downloaded file). For large binary downloads in `aio-webfetch`, a Range-header resume would be valuable.

### M3U8 Playlist Extraction and Chunked Download
you-get has a `general_m3u8_extractor` that parses HLS playlist files, resolves relative URLs, and downloads segments. For large files, it splits downloads into 10MB chunks using `Range` headers, then merges via `ffmpeg`.

**Relevance for pi-webaio:** HLS streams are the dominant video delivery format. Supporting `.m3u8` natively (parse → resolve segments → merge) would make us a complete media downloader, not just a content scraper.

### YouTube Throttle Bypass via JS Obfuscation Decoding
you-get's YouTube extractor is remarkable — it downloads YouTube's player JavaScript, then uses **regex-based reverse engineering** to extract two critical functions:
1. **`dethrottle`** — reverses the `n` parameter obfuscation that throttles download speed
2. **`s_to_sig`** — reverses the signature transformation that validates stream URLs

It uses `dukpy` (a JavaScript engine for Python) to execute the extracted JS functions. This means it adapts to YouTube's JS changes without hardcoding — it reads whatever JS YouTube serves.

**Relevance for pi-webaio:** We don't need this level of adversarial extraction, but the technique of **downloading and executing a site's own JS to extract data** is clever. For any site that uses JS-based anti-bot or token generation, this pattern (fetch JS → execute in sandbox → get token) is more robust than trying to replicate the algorithm ourselves.

### Retry Logic with Timeout Handling
you-get's `urlopen_with_retry` wraps every HTTP request with up to 3 retries on `socket.timeout`. It also handles CDN failures by retrying HTTP errors (not just network errors). SSL can be optionally disabled via `--insecure`.

**Relevance for pi-webaio:** Our `smartFetch` already has retry logic with exponential backoff. you-get's simpler approach (fixed 3 retries, no backoff) is less sophisticated but more predictable. Our current approach is better, but worth noting that they retry on ALL HTTP errors (including 5xx), while we fail fast on 4xx.

### Progress Bar with Terminal Awareness
you-get's progress bar adapts to terminal width (`term.get_terminal_size()`), shows percentage, downloaded/total size, speed, and piece count. It uses Unicode block characters for visual feedback.

**Relevance for pi-webaio:** Not directly applicable (our output is structured JSON), but the concept of streaming progress during long operations is worth keeping in mind if we ever add interactive TUI features.

### Compression Handling (gzip + deflate)
you-get manually handles `Content-Encoding: gzip` and `Content-Encoding: deflate` by decompressing response bodies. This predates modern HTTP libraries that handle this automatically.

**Relevance for pi-webaio:** Our `wreq-js` already handles decompression transparently. Mentioned here only as a reminder that some edge cases (manual HTTP connections, WebSocket frames) might need explicit decompression.

### Fake Headers with Rotating User-Agent
you-get maintains a `fake_headers` dict with a realistic Edge browser User-Agent. It's used consistently across all requests. Users can also supply custom headers or cookies.

**Relevance for pi-webaio:** Our TLS fingerprinting via `wreq-js` is more sophisticated than static headers. But the principle of presenting a consistent, realistic browser identity across all layers (TLS + headers + fingerprint) is what makes anti-bot evasion effective. we should ensure our header profiles match our TLS browser profiles.

---

## GoogleScraper ([github.com/NikolaiT/GoogleScraper](https://github.com/NikolaiT/GoogleScraper))

*Professional search engine scraping tool — multi-engine, multi-mode (HTTP, Selenium, async), proxy-aware SERP extraction.*
Analyzed: 2026-05-25

### Multi-Mode Scraping Architecture
GoogleScraper supports three distinct transport modes through a shared abstract base class (`SearchEngineScrape`):
- **HTTP mode** — raw `urllib`/`requests` with crafted headers
- **Selenium mode** — real browser automation (Chrome/Firefox) for JS-heavy pages
- **HTTP-async mode** — `aiohttp` with up to 100 concurrent requests via asyncio event loop

Each mode implements the same interface (`search`, `set_proxy`, `switch_proxy`, `proxy_check`, `handle_request_denied`). A factory (`ScrapeWorkerFactory`) dispatches to the correct mode based on config.

**Relevance for pi-webaio:** Our fetch stack already has this layered approach (wreq-js → Playwright browser → fallback). GoogleScraper's abstract base class pattern with a factory is a clean way to ensure all modes share identical retry, caching, and proxy logic — just swapping the transport layer.

### Malicious Request Detection with Needles
Per-search-engine detection rules defined as structured "needles":
```python
malicious_request_needles = {
    'google': {
        'inurl': '/sorry/',
        'inhtml': 'detected unusual traffic'
    },
    # ... per engine
}
```
When detected, the scraper: tries another proxy → waits a configurable timeout → detects again → discards the proxy for the entire scrape session if still blocked.

**Relevance for pi-webaio:** Our bot-detection module (`src/bot-detection.ts`) does something similar for Cloudflare, Anubis, etc. GoogleScraper's approach of having **engine-specific needles** (URL + HTML content patterns) is simpler than our confidence scoring but equally effective for known patterns. We could adopt a similar needle-based config for search-specific bot pages.

### Proxy Pool with Health Status Tracking
Proxies are loaded from file or MySQL database, then tracked in a SQLAlchemy database with fields: `ip`, `port`, `proto`, `status`, `online`, `checked_at`, and ipinfo.io geo data. When a proxy is detected as blocked:
1. Switch to next proxy from pool
2. If no proxy available, wait `{engine}_proxy_detected_timeout` seconds
3. Re-test — if still blocked, discard proxy for the entire session

**Relevance for pi-webaio:** We support proxy via parameter but don't track proxy health across requests. For large-scale `aio-webpull` operations, maintaining a proxy health table (blocked, healthy, unknown) would improve throughput by avoiding known-bad proxies.

### Async Scraping with Configurable Concurrency
The async scheduler (`AsyncScrapeScheduler`) manages a queue of scrape jobs:
- `max_concurrent_requests` configures the asyncio concurrency (default 100)
- Uses `asyncio.wait()` to batch-fire requests
- Processes results as they complete (not in order)
- Each async task is a self-contained `AsyncHttpScrape` instance

**Relevance for pi-webaio:** Our `aio-webpull` uses a concurrency model (4 × CPU cores) that's similar. GoogleScraper's approach of having a separate scheduler that pulls from a job queue is cleaner than our inline concurrency — it separates job scheduling from execution.

### Compressed Caching with SHA256 Content Keys
Cache files are keyed by SHA256 hash of `[keyword, search_engine, scrape_mode, page_number]`. Supports two compression algorithms (`gzip`, `bzip2`) via a `CompressedFile` wrapper class. Cache cleanup is time-based (default 48h TTL), and cache files are stored in a dedicated directory (`.scrapecache`). The cache layer intercepts before any network request — if a valid cache entry exists, no request is made.

**Relevance for pi-webaio:** Our session cache uses normalized URL keys with 30-min TTL. GoogleScraper's approach of hashing the **complete request parameters** (not just URL) is more precise — two requests to the same URL with different modes or pages are correctly treated as distinct. The compressed storage also saves disk space for large SERP pages.

### Parser Registry with CSS Selector Configuration
Each search engine has a dedicated parser class (e.g., `GoogleParser`, `BingParser`). Parsers are defined by **CSS selector dictionaries** that specify extraction rules per search type:
```python
normal_search_selectors = {
    'results': {
        'us_ip': {
            'container': '#center_col',
            'result_container': 'div.g',
            'link': 'div.r > a:first-child::attr(href)',
            'snippet': 'div.s span.st::text',
            'title': 'div.r > a > h3::text',
            'visible_link': 'cite::text'
        },
        'de_ip': { ... },  # different selectors for German IP
    },
    'ads_main': { ... },
}
```
Selectors are organized by result type (organic, ads, etc.) and can have regional variants.

**Relevance for pi-webaio:** Our vertical extractors are code-based (TypeScript functions). GoogleScraper's **data-driven selector config** approach is more maintainable — adding a new extraction target is just adding selectors to a dict, not writing code. This is especially valuable for sites that change structure frequently (like search engines).

### IP-Region Specific Selectors
GoogleScraper's parser selectors can vary by request IP region (e.g., `us_ip` vs `de_ip` variants). The parser auto-selects based on the proxy's geolocation (tracked via ipinfo.io).

**Relevance for pi-webaio:** When using proxies in different regions, search engines serve different layouts. We don't currently handle this — our extraction is region-agnostic. For search-specific scraping, region-aware selectors would be essential.

### Advanced CSS Pseudo-Selectors
GoogleScraper extends standard CSS selectors with two custom pseudo-selectors:
- `::text` — extracts text content from the matched element
- `::attr(attribute-name)` — extracts a specific attribute value

These are implemented in `advanced_css()` and converted to XPath internally via `cssselect.HTMLTranslator`.

**Relevance for pi-webaio:** Our adaptive selector and vertical extractors use standard DOM APIs. Adding `::text` and `::attr()` support would make selector-based extraction more expressive without needing custom code.

### Human-Like Sleep Intervals
To avoid detection, GoogleScraper inserts randomized delays between requests:
- `sleeping_ranges` config defines probability-weighted sleep intervals (e.g., "10% chance of 0-1s sleep, 30% chance of 1-3s, etc.")
- Delays are pre-computed, randomly shuffled, and applied per-request
- Additional `fixed_sleeping_ranges` can enforce specific delays at specific request numbers
- Controlled by `do_sleep` config flag

**Relevance for pi-webaio:** Our rate limiter uses a token-bucket (5 req/s, burst 10). GoogleScraper's approach of **randomized, probability-weighted delays** is more human-like than a fixed bucket. For high-volume scraping where detection is a concern, combining token-bucket with randomized jitter would be more robust.

### Database-Backed State Persistence
All scrape state is persisted in SQLite via SQLAlchemy:
- `SearchEngineResultsPage` — stores parsed SERP results
- `Proxy` — tracks proxy health and geo data
- `ScraperSearch` — top-level scrape session metadata

Database locks (`db_lock`) protect concurrent writes from multiple threads. The `--shell` flag opens an interactive SQLite console for inspection.

**Relevance for pi-webaio:** Our `aio-webpull` request queue is disk-backed JSON with auto-save. GoogleScraper's use of a proper relational database is more queryable — you can search results by keyword, engine, date, etc. For large-scale operations, a SQLite backend would be more useful than JSON.

### Multi-Engine Support with Unified Interface
GoogleScraper supports 6 search engines (Google, Bing, Yahoo, Yandex, Baidu, DuckDuckGo) through a single unified interface. Each engine has:
- Its own parser class with CSS selectors
- Its own base URL config (with mode-specific overrides)
- Its own malicious request detection needles
- Its own sleeping range config

The `get_parser_by_search_engine()` factory returns the correct parser. The `get_base_search_url_by_search_engine()` cascades from mode-specific → engine-specific → default.

**Relevance for pi-webaio:** Our `aio-websearch` already searches multiple engines in parallel. GoogleScraper's pattern of per-engine config cascading (mode-specific → engine-specific → default) is a clean way to handle engine-specific behavior without code duplication.
