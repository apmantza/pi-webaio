# pi-webaio Future Features — Implementation Plan

This plan turns `newfeatures.md` into a staged roadmap. The order favors low-risk/high-impact features first, then deeper extraction and crawling improvements.

---

## Phase 1 — API Surface and Observability

### 1. Cache Controls

**Files likely involved:**

- `index.ts`
- session/disk cache code in `index.ts` or related helpers
- search cache logic
- tests in `tests/unit.test.mjs`

**Implementation steps:**

1. Add params: `cacheTtlSeconds`, `fresh`, `storeInCache`.
2. Include cache options in normalized cache keys where behavior changes output.
3. Make `fresh: true` bypass read-through cache but still write unless `storeInCache: false`.
4. Add tests for fresh fetch, TTL hit, TTL miss, and no-store behavior.

### 2. Extraction Trace / Debug Bundle

**Files likely involved:**

- `index.ts`
- `src/bot-detection.ts`
- vertical extractor registry
- storage/result serialization

**Implementation steps:**

1. Add `debug?: boolean` or `trace?: boolean` params.
2. Create a lightweight `ExtractionTrace` object passed through the fetch pipeline.
3. Record redirects, mode escalation, bot detection, chosen extractor, fallbacks, warnings, and content lengths.
4. Return trace inline when requested and persist it with `aio-webresult` storage.
5. Add snapshot-style unit tests for representative pipeline paths.

### 3. Output Format Controls

**Files likely involved:**

- `index.ts`
- `src/context-package.ts`
- storage layer

**Implementation steps:**

1. Add `format?: "markdown" | "json" | "html" | "text" | "jsonl"`.
2. Keep markdown as default for backward compatibility.
3. Preserve raw HTML/text internally when available so alternate formats do not require refetching.
4. Add `manifest?: boolean` to `aio-webpull`.
5. Write pull manifests with URL, title, status, path, hash, mode, extractor, and warnings.

---

## Phase 2 — Crawl Precision and Recrawl Efficiency

### 4. Crawl Controls

**Files likely involved:**

- `index.ts`
- discovery/crawl helpers
- `src/request-queue.ts`
- `src/session-router.ts`

**Implementation steps:**

1. Add params: `maxDepth`, `includePaths`, `excludePaths`, `strategy`.
2. Store URL depth in queue entries.
3. Filter discovered links before enqueueing.
4. Implement strategy checks: same-origin, same-hostname, same-domain, all.
5. Add tests for URL filtering, depth limiting, and cross-origin behavior.

### 5. Incremental Recrawl / Change Detection

**Files likely involved:**

- `src/request-queue.ts`
- storage/cache code
- `aio-webpull` output writer

**Implementation steps:**

1. Add crawl state file in output directory, e.g. `.pi-webaio-state.json`.
2. Store URL, output path, content hash, ETag, Last-Modified, status, and timestamp.
3. Send conditional headers when available.
4. Treat `304 Not Modified` as unchanged and skip extraction.
5. Compare current discovered URL set to previous set for added/removed reporting.
6. Add tests with mocked ETag/Last-Modified and hash changes.

### 6. Link Graph Output

**Files likely involved:**

- discovery helpers
- `aio-webmap`
- `aio-webpull` manifest output

**Implementation steps:**

1. Capture link source page, target URL, anchor text, rel, and internal/external classification.
2. Add `graph?: boolean` parameter.
3. Return graph in `aio-webmap` and optionally write `link-graph.jsonl` during pulls.
4. Add tests for canonicalization and deduplication.

---

## Phase 3 — Structured and Higher-Quality Extraction

### 7. Schema-Based Structured Extraction

**Files likely involved:**

- `index.ts`
- Google AI integration in `src/google-ai.ts`
- storage/result serialization

**Implementation steps:**

1. Add params: `schema?: object`, `extract?: string`, `structured?: boolean`.
2. For deterministic metadata, extract local fields first: title, description, author, date, image, lang, JSON-LD.
3. For user schemas, feed cleaned page text/markdown plus schema to the existing AI summarization path.
4. Validate output against requested schema where practical.
5. Return both `markdown` and `structured` unless caller requests JSON-only output.
6. Add tests for local metadata extraction and mocked AI structured extraction.

### 8. Shadow DOM and Iframe Flattening

**Files likely involved:**

- browser-mode fetch path
- Playwright extraction helpers
- fallback HTML processing

**Implementation steps:**

1. Add an in-page script that walks open shadow roots and same-origin iframes.
2. Replace each shadow host/frame with a bounded text/HTML snapshot.
3. Limit recursion depth to 3 or 4.
4. Feed flattened HTML into existing Readability/Defuddle pipeline.
5. Add fixtures with shadow roots and nested same-origin iframes.

---

## Phase 4 — Scale and Reliability

### 9. Proxy Health Tracking

**Files likely involved:**

- fetch wrapper / `smartFetch`
- bot detection
- pull/search orchestration

**Implementation steps:**

1. Add a small persistent proxy health store under `os.tmpdir()/pi-webaio/`.
2. Track status per proxy and domain.
3. Mark proxies blocked on bot-detection or repeated 403/429.
4. Prefer healthy proxies and avoid known-bad ones during a session.
5. Add diagnostic output in debug traces.

### 10. Extraction Quality Benchmark Suite

**Files likely involved:**

- `tests/`
- CI config
- possibly a new `benchmarks/` directory

**Implementation steps:**

1. Create a curated fixture list covering news, docs, blogs, ecommerce, SPA, PDF, JSON, and bot-prone pages.
2. Store expected fields and loose quality thresholds.
3. Avoid live-network-only CI by saving representative HTML fixtures where possible.
4. Add a command such as `npm run bench:extract`.
5. Track metrics: title match, content length, boilerplate ratio, image/date detection, fallback rate.

---

## Suggested Priority

1. Cache controls
2. Extraction trace/debug bundle
3. Crawl controls
4. Pull manifest/output formats
5. Incremental recrawl
6. Schema-based structured extraction
7. Link graph output
8. Shadow DOM/iframe flattening
9. Proxy health tracking
10. Extraction benchmark suite
