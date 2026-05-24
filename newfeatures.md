# Proposed New Features for pi-webaio

> Inspired by analysis of Scrapy, Crawlee, Scrapling, and you-get.
> Each feature includes rationale, target tools, and implementation sketch.

---

## 1. Request Queue with Checkpoint / Resume

**Source**: Crawlee (`RequestQueue`)

**Target tools**: `aio-webpull`

**Problem**: `aio-webpull` currently fetches pages from a flat URL list. If interrupted mid-pull (crash, Ctrl+C, timeout), the entire pull must restart from scratch. For sites with 100+ pages, this wastes significant time and bandwidth.

**Proposed solution**: A persistent, disk-backed request queue that tracks:
- Queued URLs (not yet fetched)
- In-progress URLs (currently being fetched)
- Completed URLs (with status — success/failed)
- Failed URLs (with retry count and last error)

On restart with the same output directory, the queue resumes from where it left off — completed pages are skipped, failed pages are retried (up to a configurable max).

```typescript
// src/request-queue.ts — sketch
interface QueueEntry {
  url: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  retries: number;
  lastError?: string;
  depth?: number;
}

class RequestQueue {
  constructor(outDir: string);  // persists as JSONL next to output

  async add(urls: string[]): Promise<void>;
  async next(): Promise<string | null>;         // dequeue next
  async complete(url: string): Promise<void>;
  async fail(url: string, error: string): Promise<void>;
  async pending(): Promise<number>;             // still to fetch
  async total(): Promise<number>;

  // On resume: scan existing output markdown files, mark as completed
  static async resume(outDir: string): Promise<RequestQueue>;
}
```

**Integration into `aio-webpull`**: The `doPull` loop iterates over `queue.next()` instead of a static array. On SIGINT/SIGTERM (graceful shutdown), in-progress entries are re-queued.

**Prior art**: Scrapy's `JOBDIR` scheduler persistence, Crawlee's `RequestQueue`.

---

## 2. Browser Pool for Same-Domain Site Pulls

**Source**: Crawlee (`browser-pool`)

**Target tools**: `aio-webpull`, `aio-webfetch` (browser mode)

**Problem**: When `aio-webpull` escalates to browser mode (or `mode: "browser"` is explicit), it currently launches a new Playwright browser instance for each page, navigates, extracts content, and closes it. That's ~2-3 seconds of overhead per page for browser launch + teardown alone. For a 100-page site pull, that's 200-300 seconds wasted.

**Proposed solution**: A browser pool that keeps 1-N browser instances alive and reuses them across pages.

```typescript
// src/browser-pool.ts — sketch  
interface BrowserPoolOptions {
  maxBrowsers?: number;      // default: 2
  maxPagesPerBrowser?: number;  // default: 50, then recycle
  headless?: boolean;
  channel?: string;          // "chrome" for system Chrome
}

class BrowserPool {
  constructor(options: BrowserPoolOptions);

  async acquirePage(): Promise<{ browser: Browser, page: Page, release: () => void }>;
  async drain(): Promise<void>;  // close all

  // Health metrics
  stats(): { active: number; idle: number; totalLaunched: number; crashes: number };
}
```

**Behavior**:
- Acquire a page → navigate → extract → release page back to pool
- If a page crashes (navigation timeout, tab crash), it's retired and a new one is spawned
- After `maxPagesPerBrowser` navigations, the browser is recycled (memory leak defense)
- Browsers are pre-warmed: launch once, reuse across many requests to the same domain

**Integration into `aio-webpull`**: The `pullPages` worker pool acquires a page from `BrowserPool` instead of `chromium.launch()`. On drain, all browsers are closed.

**Prior art**: Crawlee's `browser-pool` (Playwright + Puppeteer), Scrapling's tab pool in `DynamicSession`.

---

## 3. Multi-Session / Multi-Fetcher Routing

**Source**: Scrapling (multi-session spiders), Crawlee (different crawler classes per use case)

**Target tools**: `aio-webpull`

**Problem**: Many sites mix HTTP-friendly pages (APIs, listing pages, sitemaps) with JS-heavy pages (detail pages with dynamic content, login walls, Cloudflare-protected pages). Currently, `aio-webpull` uses a single mode for the entire site — either all fast HTTP or all headless browser. There's no way to route different URLs through different fetcher strategies.

**Proposed solution**: A URL routing system that maps URL patterns to fetcher modes (fast, fingerprint, browser, or even vertical extractors).

```typescript
// Concept: extend webpull options
interface WebPullOptions {
  // ...
  routes?: Array<{
    pattern: string | RegExp;   // URL pattern to match
    mode: ScrapeMode;            // "fast" | "fingerprint" | "browser"
    extractor?: string;          // optional: "npm", "pypi", "wikipedia", etc.
  }>;
}
```

Example usage:
```
aio-webpull https://docs.example.com \
  --routes '[{"pattern":"/api/","mode":"fast"},{"pattern":".*","mode":"browser"}]'
```

**Implementation**:
- Routes are evaluated in order; first match wins
- Default route (implicit): uses the pull's global `mode`
- Each route can also specify extractors for known site patterns
- Session state (cookies) can be shared across routes of the same type

**Benefits**:
- Listing pages (simple HTML) fetched at HTTP speed
- Detail pages (JS-rendered) fetched via browser
- API endpoints fetched directly
- Known-site vertical extractors (npm, PyPI, etc.) invoked automatically

**Prior art**: Scrapling's `Spider` with `sid` (session ID) routing, Crawlee's `Router` class.

---

## 4. Adaptive Element Tracking & Similarity-Based Relocation

**Source**: Scrapling (`auto_save` / `adaptive` mode)

**Target tools**: `aio-webpull`, `aio-webfetch` (docs sites, structured content extraction)

**Problem**: When pulling docs sites or structured pages, the main content selector (e.g., `article`, `main`, `.content`) is often hardcoded. If the site redesigns and changes its CSS classes or HTML structure mid-pull (or between pulls), the extraction breaks silently — returning empty or garbage data.

Scrapling solves this with an **adaptive element tracking** system:
1. On first fetch, the user's selector finds element(s)
2. The system computes a **structural fingerprint** of those elements: tag path, attribute patterns, text density, sibling structure, position in DOM tree
3. On subsequent fetches (or after a site change), it uses that fingerprint to **relocate** the elements even if CSS classes or IDs changed
4. A similarity scoring algorithm ranks candidate elements and picks the best match

**Proposed solution**: A lightweight adaptive selector module for pi-webaio.

```typescript
// src/adaptive-selector.ts — sketch

interface ElementFingerprint {
  // Structural signature of the selected element(s)
  tagPath: string[];               // e.g. ["html", "body", "div", "main", "article"]
  depth: number;                   // DOM depth
  textDensity: number;             // text length / HTML length
  linkDensity: number;             // <a> text / total text
  childTagSignature: string;       // sorted child tag frequency hash
  attributePatterns: Record<string, string>;  // e.g. {"class": "*-content", "data-*": ".*"}
  siblingPosition: { index: number; total: number };
}

class AdaptiveSelector {
  constructor(fingerprint?: ElementFingerprint);

  // Save the current selection as the reference fingerprint
  static capture(element: Element): ElementFingerprint;

  // Given a page, find the best-matching element using the saved fingerprint
  locate(page: Document, threshold?: number): Element | null;

  // Score a candidate against the fingerprint (0-1)
  private score(candidate: Element, fingerprint: ElementFingerprint): number;
}
```

**Integration into webpull**: When pulling docs sites, the main content selector can optionally be set to "adaptive". On the first page, the system captures the element fingerprint. On subsequent pages (or across multiple pulls), it uses the fingerprint to locate the content — automatically surviving minor redesigns.

**Scope**: This could start simple — just `tagPath + depth + attributePatterns` — and be extended later with full text-density and child-signature analysis.

**Prior art**: Scrapling's `auto_save` / `adaptive` parsing, AutoScraper (similar but slower).

---

## Additional Notes

- **Priority order**: 1 (Request Queue) > 2 (Browser Pool) > 3 (Multi-Session Routing) > 4 (Adaptive Selectors)
- **Dependencies**: Feature 2 (Browser Pool) has no new deps — uses existing Playwright. Feature 3 and 4 are pure TypeScript. Feature 1 uses only `node:fs`.
- **Risk**: Feature 4 (adaptive selectors) has the highest algorithmic complexity and the hardest-to-validate correctness. Start with fingerprint capture + tag-path matching, iterate.
