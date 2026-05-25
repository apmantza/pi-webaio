# Proposed Future Features for pi-webaio

> Next-wave feature ideas after v0.4.0. Earlier proposals such as request queue/resume, browser pool, multi-session routing, and adaptive selectors are now implemented and should be treated as shipped foundations.

---

## 1. Schema-Based Structured Extraction

**Target tools:** `aio-webfetch`, `aio-webpull`

Allow callers to provide a JSON schema or natural-language extraction goal and receive structured JSON instead of only markdown.

```json
{
  "url": "https://example.com/product",
  "schema": {
    "name": "string",
    "price": "number",
    "availability": "string"
  }
}
```

**Why:** Markdown is good for human/agent reading, but JSON is better for downstream automation, datasets, monitoring, and workflows.

**Potential params:**

```ts
schema?: object;
extract?: string;
structured?: boolean;
```

---

## 2. User-Facing Cache Controls

**Target tools:** `aio-webfetch`, `aio-webpull`, `aio-websearch`

Expose cache behavior to callers instead of relying only on internal TTLs.

```ts
cacheTtlSeconds?: number;
fresh?: boolean;
storeInCache?: boolean;
```

**Why:** Some tasks need fresh content; others prefer speed and can tolerate stale cached pages.

---

## 3. Crawl Controls: Depth, Include/Exclude, Strategy

**Target tools:** `aio-webpull`, `aio-webmap`

Add precise crawl scoping controls.

```ts
maxDepth?: number;
includePaths?: string[];
excludePaths?: string[];
strategy?: "same-origin" | "same-hostname" | "same-domain" | "all";
```

**Why:** Real site pulls need more than a page limit. Agents often need “only docs/api/*”, “same origin only”, or “crawl depth 2”.

---

## 4. Incremental Recrawl / Change Detection

**Target tools:** `aio-webpull`, `aio-webmap`

Track previous crawl state using `ETag`, `Last-Modified`, content hash, output path, and extraction metadata. Skip unchanged pages and optionally report changed/added/removed URLs.

**Why:** Useful for docs monitoring, recurring research, changelog discovery, and avoiding repeated bandwidth/work.

**Potential outputs:**

```json
{
  "changed": ["https://example.com/docs/new"],
  "unchanged": ["https://example.com/docs/intro"],
  "removed": ["https://example.com/docs/old"],
  "added": ["https://example.com/docs/api"]
}
```

---

## 5. Extraction Trace / Debug Bundle

**Target tools:** `aio-webfetch`, `aio-webpull`

Add a debug mode that records how extraction happened.

**Trace fields:**

- fetch mode used
- redirects
- response headers summary
- bot detection result
- selected vertical extractor, if any
- extraction pipeline path
- Readability/Defuddle scores or quality signals
- fallback reason
- final content length
- warnings and prompt-injection findings

**Why:** Failed or low-quality extractions are hard to diagnose without knowing which path the pipeline took.

---

## 6. Shadow DOM and Iframe Flattening

**Target tools:** `aio-webfetch`, `aio-webpull` in browser mode

Before Readability/Defuddle, flatten content from:

- open shadow roots
- same-origin iframes
- embedded article/content frames

Use bounded recursion, e.g. max depth 3 or 4.

**Why:** Modern sites hide meaningful text inside web components and embedded frames. Current extraction can miss that content.

---

## 7. Output Format Controls

**Target tools:** `aio-webfetch`, `aio-webpull`

Allow callers to choose the desired representation.

```ts
format?: "markdown" | "json" | "html" | "text" | "jsonl";
manifest?: boolean;
```

For `aio-webpull`, a manifest could include URL, title, status, output path, content hash, extraction metadata, and warnings.

**Why:** Different consumers need different formats: agent context wants markdown, datasets want JSONL, debugging may need HTML/text.

---

## 8. Proxy Health Tracking

**Target tools:** `aio-webfetch`, `aio-webpull`, `aio-websearch`

Track proxy status across requests:

- healthy
- blocked
- rate-limited
- failed
- unknown
- optional geo/country metadata

**Why:** Proxy support exists, but large pulls/searches need memory of which proxies are bad for which domains.

---

## 9. Link Graph Output

**Target tools:** `aio-webmap`, `aio-webpull`

Produce a graph of discovered links.

```json
{
  "from": "https://site/a",
  "to": "https://site/b",
  "anchor": "API Reference",
  "rel": "internal"
}
```

**Why:** Useful for docs comprehension, dead-link detection, sitemap generation, crawl visualization, and agent context building.

---

## 10. Extraction Quality Benchmark Suite

**Target area:** tests/CI

Create a benchmark fixture set of real-world pages with expected title, description, main content, image, date, and extraction quality checks.

**Why:** The extraction pipeline is complex and regression-prone. A benchmark protects quality when changing extractor order, fallbacks, or bot-handling behavior.

**Possible metrics:**

- title exact/near match
- description presence
- main content length range
- boilerplate ratio
- image/date detection
- markdown cleanliness
- extractor fallback rate
