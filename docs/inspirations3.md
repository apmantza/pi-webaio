# Inspiration Review #3 — External Repositories

This is the third inspiration pass for **pi-webaio**. It covers nine repositories selected for direct or tangential influence on the extension’s architecture, extraction quality, anti-bot resilience, and tool-surface design.

> **Amendment note:** The first draft of this review pattern-matched enthusiastically against nine external repos, several of which are unsupervised, large-scale crawling *frameworks* rather than tool-surfaces for an LLM agent. A follow-up critical pass (see [Amendment — Critical Reassessment](#amendment--critical-reassessment)) walked back or re-scoped several recommendations, and a new section assesses whether a dedicated single-page scrape tool is worth adding. Read both before treating the opportunity matrix below as a roadmap.

---

## Analyzed Repositories

| # | Repository | Link | Primary relevance |
|---|------------|------|-------------------|
| 1 | `unclecode/crawl4ai` | <https://github.com/unclecode/crawl4ai> | Direct parallel — async crawler, extraction strategies, hooks, adaptive crawling |
| 2 | `browser-use/browser-use` | <https://github.com/browser-use/browser-use> | Agent-native DOM understanding, watchdog system, MCP server |
| 3 | `apify/crawlee` | <https://github.com/apify/crawlee> | Production framework patterns — unified interface, request queue, session pool |
| 4 | `scrapy/scrapy` | <https://github.com/scrapy/scrapy> | Mature middleware + pipeline architecture |
| 5 | `microsoft/markitdown` | <https://github.com/microsoft/markitdown> | Universal file→markdown conversion, plugin system |
| 6 | `D4Vinci/Scrapling` | <https://github.com/D4Vinci/Scrapling> | Adaptive parsing performance, multi-mode fetcher, MCP server |
| 7 | `Genymobile/scrcpy` | <https://github.com/Genymobile/scrcpy> | Architectural discipline — minimal dependencies, clean protocol layering |
| 8 | `alirezamika/autoscraper` | <https://github.com/alirezamika/autoscraper> | Example-based rule learning — potential new tool surface |
| 9 | `lwthiker/curl-impersonate` | <https://github.com/lwthiker/curl-impersonate> | TLS/JA3 fingerprint engineering, regression-testing signatures |

---

## Per-Repository Findings

### 1. crawl4ai — Highest-priority parallel

crawl4ai is the closest peer to pi-webaio: an async, LLM-friendly crawler built on Playwright with Docker API deployment. Its most transferable ideas:

- **Pluggable extraction strategies** — `JsonCssExtractionStrategy` (JSON schema → CSS → structured data), `LLMExtractionStrategy`, `RegexExtractionStrategy`, `CosineExtractionStrategy`. pi-webaio’s `verticals/` registry is hard-coded per site; crawl4ai’s schema-driven approach is strictly more composable.
- **Content filtering** — `PruningContentFilter` (threshold-based) and `BM25ContentFilter` (query-aware) produce `raw_markdown` + `fit_markdown`. pi-webaio’s `prune-markdown.ts` does score-based pruning but lacks BM25 query-relevance filtering.
- **Adaptive crawling** — `AdaptiveCrawler` + `AsyncUrlSeeder` (sitemap + BM25 intersection) learns relevance scores over pages. pi-webaio’s `adaptive-selector.ts` is DOM-only; crawl4ai goes page-level.
- **Hooks system** — 8 hook points (`before_goto`, `on_page_context_created`, `after_goto`, …). Functions serialize to JSON for Docker. pi-webaio has no plugin/hooks system — this is the highest-value gap.
- **Browser pool tiers** — permanent + hot + cold, with janitor cleanup and page pre-warming. pi-webaio’s `browser-pool.ts` auto-recycles but lacks tier strategy.
- **Prefetch mode** — `prefetch=True` returns HTML + links only, skipping markdown/extraction/media. 5–10× faster for URL discovery. Maps to `aio-webmap`.
- **Security hardening** — Docker API ships JWT auth, loopback bind, AST sandbox, CORS deny-by-default. Relevant if pi-webaio ever self-hosts an API.

### 2. browser-use — Agent-native browser control

browser-use is an LLM-driven browser agent framework (not an extraction-first crawler). Its key imports:

- **Watchdog system** — 13 specialized watchdogs: `captcha_watchdog`, `crash_watchdog`, `dom_watchdog`, `downloads_watchdog`, `popups_watchdog`, `permissions_watchdog`, `security_watchdog`, `storage_state_watchdog`. pi-webaio handles errors linearly (poll → classify); a watchdog layer would be more proactive.
- **DOM serialization** — Context-aware DOM serializer assigns numbered refs to interactive elements using paint-order (not just CSS selectors). pi-webaio’s `interactive-elements.ts` is selector-based only.
- **Live-DOM markdown extraction** — Markdown is produced from the live DOM, not `outerHTML`, avoiding stale markup for SPAs.
- **Filesystem abstraction** — Virtual filesystem so agents read/write without path confusion. Useful if pi agent uses parallel file ops.
- **Token + cost tracking** — Per-request token usage with model-specific pricing. pi-webaio estimates tokens but doesn’t track per-request cost.

### 3. crawlee — Production framework patterns

Apify’s TypeScript crawler framework. Clean architecture despite its size:

- **Unified `requestHandler`** — Same handler pattern across `CheerioCrawler`, `PlaywrightCrawler`, `PuppeteerCrawler`, `HttpCrawler`, `JsdomCrawler`. pi-webaio’s `mode: auto/fast/fingerprint/browser` is similar but less type-safe.
- **Request queue** — Persistent URL queue with BFS/DFS ordering, same-origin filtering, auto-resume. richer than pi-webaio’s `request-queue.ts`.
- **Dataset + KeyValueStore** — `Dataset.pushData()` for tabular results; `KeyValueStore` for state. All disk-backed.
- **Session pool** — Rotation strategies, cookie sharing, error-tracking per session to prevent correlation.
- **Autoscaling** — `AutoscaledPool` adjusts concurrency from CPU/memory + request latency, not just a fixed `4 × CPU cores`.
- **Crawler plugins** — e.g. `playwright-extra` plugin, `snapshot` plugin. Would enable community extensions for pi-webaio.
- **Typed generics** — `Crawler<Context extends BrowserCrawlingContext>` — a model for pi-webaio’s TypeScript internals.

### 4. scrapy — Mature extensible engine

Scrapy’s contribution is architectural, not tactical:

- **Item Pipeline** — Post-processing chain: clean → validate → deduplicate → export. pi-webaio has no general post-processing chain.
- **Downloader Middleware** — Intercepts requests/responses at stages: retry, cookies, headers, redirect, compression, proxy, throttle. pi-webaio has pieces scattered across `fetch.ts`, `bot-detection.ts`, `security.ts`. A middleware stack would unify them.
- **AutoThrottle** — Adaptive concurrency from response latency. pi-webaio’s token-bucket is simpler.
- **LinkExtractor** — `deny` / `allow` / `restrict_xpaths` / `restrict_css` / `unique`. pi-webaio’s link extraction is less flexible.

### 5. microsoft/markitdown — Universal file→markdown

Microsoft’s converter handles 20+ formats (PDF, DOCX, PPTX, XLSX, images, audio, HTML, ZIP) and surfaces a plugin API.

- **Plugin system** — 3rd-party plugins with `enable_plugins` flag. pi-webaio’s 19 vertical extractors are internal-only.
- **Narrow API** — `convert_local()`, `convert_stream()`, `convert_response()` — caller picks scope. pi-webaio is all-in-one; splitting would reduce attack surface.
- **Multi-modal** — Image → LLM captioning, audio → transcription. pi-webaio currently handles HTML/PDF/JSON/text only.
- **YAML front matter** — Extracted fields as YAML + content body. pi-webaio already does this in pull output.

### 6. Scrapling — Adaptive parser + multi-mode fetch

Superset of BeautifulSoup with fetcher + spider + MCP server. Claims 12–40× faster than BS4/PyQuery.

- **`find_similar()`** — Structural similarity scoring (tag path, text density, attributes, siblings). Conceptually identical to pi-webaio’s `adaptive-selector.ts` but benchmarks at lxml speed (~2 ms for 5,000 elements).
- **Multi-mode fetching** — `Fetcher` (static), `AsyncDynamicSession` (Playwright), `AsyncStealthySession` — unified API. Maps to `aio-webfetch` mode param.
- **Spider with checkpoint** — `Spider(crawldir=…)` auto-saves progress; Ctrl+C pauses gracefully.
- **MCP server** — Built-in via `scrapling[ai]` extras.
- **Interactive shell** — `scrapling shell` REPL + `scrapling extract <url> <file>` for zero-code extraction.

### 7. scrcpy — Architectural discipline

Not a web-crawling tool. Worth studying for:

- **Protocol layering** — ADB transport → H.264 codec → SDL display. Clean separation. Maps to fetcher → parser → renderer in pi-webaio.
- **Minimal dependencies** — SDL, libav, libusb. Single binary. pi-webaio’s dep list (`wreq-js`, `linkedom`, `defuddle`, `sharp`) is already lean.
- **Graceful degradation** — Falls back if codec unsupported; scales resolution dynamically.
- **Zero side effects** — Nothing left on the device after disconnect. Session cleanup should be equally clean.

### 8. AutoScraper — Example-based rule learning

Lightweight scraper that learns DOM-to-data rules from a wanted-list example.

- **`build(url, wanted_list)`** — Figures out common DOM paths for wanted items.
- **`get_result_exact()`** vs **`get_result_similar()`** — Same page type vs. similar page structure. Maps to vertical extractors vs. generic extraction.
- **`save()` / `load()`** — JSON-serialized learned rules. Could persist alongside `storage.ts` cached results.
- **New tool opportunity** — A hypothetical `aio-weblearn` would let pi agents say “extract prices like this” and get a reusable rule. Combined with `adaptive-selector.ts` this becomes structural fingerprinting rules.

### 9. curl-impersonate — TLS fingerprint engineering

Patched curl binaries that replicate exact Chrome/Firefox/Edge/Safari TLS/JA3/JA4 fingerprints.

- **TLS fingerprint matching** — Patches cipher-suite ordering, ALPN/NPN, ALPS, EC curves, compression, server preferences. pi-webaio delegates this to `wreq-js` browser profiles.
- **JA3/JA4 validation** — Test suite verifies actual TLS handshakes match target browser signatures via YAML spec. pi-webaio has no fingerprint regression tests — a gap if `wreq-js` updates silently drift.
- **`CURL_IMPERSONATE` env var** — `LD_PRELOAD` auto-impersonates for any libcurl-using process. A model for enforcing fingerprinting at the process boundary if pi-webaio ever spawns curl subprocesses.

---

## Cross-Cutting Themes

### Pluggability

Every reviewed repo enables extension without forking:

- crawl4ai — 8 hook points + custom strategies
- crawlee — middleware + crawler plugins
- scrapy — item pipelines + downloader middleware + extensions
- Scrapling — fetcher plugins + MCP server

**pi-webaio gap**: no hooks or plugin system. The 19 vertical extractors are hard-coded.

### Checkpoint / Resume

- crawl4ai — `resume_state` + `on_state_change`
- Scrapling — `crawldir` + Ctrl+C graceful pause
- crawlee — persistent request + result storage

**pi-webaio status**: `request-queue.ts` already covers this. Strongest part of the architecture relative to peers.

### Anti-bot sophistication

- crawl4ai — 3-tier detection + proxy escalation + user-supplied `fallback_fetch_function`
- Scrapling — multi-mode fetcher (fast → stealth)
- browser-use — 13 watchdogs (captcha, crash, dom, …)
- curl-impersonate — TLS/JA3 fingerprinting as the foundation

**pi-webaio status**: `bot-detection.ts` + paywall bypass + proxy support is solid. Watchdog pattern and proxy escalation would close the gap.

### Content quality

- crawl4ai — fit-markdown + BM25 filtering + content scorer
- browser-use — LLM-friendly DOM serialization
- markitdown — multi-format → structured markdown with YAML front matter
- Scrapling — lxml-speed HTML parsing

**pi-webaio status**: chunker + format options + vertical extractors. `prune-markdown.ts` is score-based, not query-aware.

### Identity management

- crawl4ai — `browser_profiler` — persistent profiles with cookies, auth state
- crawlee — `SESSION_POOL` with rotation strategies
- browser-use — `BrowserProfile` abstraction

**pi-webaio gap**: no named browser profiles. `browser` / `os` params are one-off. No save/load/reuse with cookies, localStorage, or auth state.

---

## Prioritized Opportunity Matrix

> Statuses below reflect the [amendment](#amendment--critical-reassessment): ✅ keep, ⚠️ security-gate first, 🔽 re-scoped/narrowed, ⬇️ de-prioritized, ❌ dropped.

### Tier 1 — Immediate (≤ 2 weeks, single-file changes)

| # | Status | Opportunity | Source repos | pi-webaio module |
|---|--------|-------------|-------------|-----------------|
| 1.1 | ⚠️ | **Named browser profiles** — save/load/export browser identity (cookies, locale, viewport, stealth args). Requires an encryption-at-rest + explicit-opt-in design pass before implementation; persisted cookies/auth-state are a secret-at-rest concern for a tool built around not leaking credentials. | crawl4ai `browser_profiler`, browser-use `BrowserProfile` | `browser-pool.ts` |
| 1.2 | ✅ | **Watchdog pattern** — `captcha_watchdog`, `crash_watchdog`, `dom_watchdog` for fetch lifecycle | browser-use watchdogs | `fetch.ts` |
| 1.3 | 🔽 | **Sticky per-domain proxy mapping** — narrowed from "proxy rotation" since proxy support already exists; the actual gap is session-to-proxy stickiness per domain, not rotation itself | crawlee proxy rotation | `browser-pool.ts` |
| 1.4 | ✅ | **TLS fingerprint regression tests** — JA3-style checksums for each `wreq-js` profile | curl-impersonate signature DB | `tests/` |

### Tier 2 — Short-term (1–2 months)

| # | Status | Opportunity | Source repos | pi-webaio module |
|---|--------|-------------|-------------|-----------------|
| 2.1 | ⚠️ | **Declarative, allowlisted lifecycle hooks** — narrowed from a general "hook middleware chain" of user-provided callables (crawl4ai's own hook system caused RCE via sandbox escape in v0.8.x). Only fixed, vetted lifecycle events (`onBotDetected`, `onRedirect`, etc.) with no arbitrary code execution. | crawl4ai hooks (cautionary), scrapy middleware | new `hooks.ts` or `fetch.ts` |
| 2.2 | ✅ | **Query-aware content pruning** — BM25 relevance filtering when `query` param is passed | crawl4ai `BM25ContentFilter` | `prune-markdown.ts` |
| 2.3 | ✅ | **Image/audio/video conversion** — OCR + transcription in `aio-webfetch` detection pipeline | markitdown multi-modal converters | `aio-webfetch` tool handler |
| 2.4 | ✅ | **Prefetch mode for `aio-webmap`** — lightweight URL-discovery (HTML + links, no extraction) | crawl4ai `prefetch=True` | `aio-webmap` tool handler |

### Tier 3 — Medium-term (3–6 months)

| # | Status | Opportunity | Source repos | pi-webaio module |
|---|--------|-------------|-------------|-----------------|
| 3.1 | ❌ | ~~`aio-weblearn` tool~~ — dropped. AutoScraper's rule-learning exists to substitute for reasoning it doesn't have; pi-webaio's calling agent already reasons over markdown/CSS more flexibly than any learned rule set would. See [amendment](#amendment--critical-reassessment) and [scrape-tool assessment](#should-pi-webaio-expose-a-dedicated-web-scrape-tool). | AutoScraper | — |
| 3.2 | ⬇️ | **Deep crawl strategies** — BFS/DFS/BFF with scored prioritization in queue. De-prioritized: these exist in crawl4ai/Scrapling because they're unsupervised frameworks with no LLM deciding what to fetch next; pi-webaio's agent-driven, per-call usage pattern rarely needs this. | crawl4ai `deep_crawling/`, Scrapling spider | `request-queue.ts` |
| 3.3 | ✅ | **MCP server mode** — serve pi-webaio as MCP server for non-pi consumers | browser-use MCP, Scrapling `[ai]` | new run mode |
| 3.4 | ✅ | **Plugin system for vertical extractors** — registry-based external contributions with manifest | markitdown plugins, crawlee plugins | `verticals/registry.ts` |

### Tier 4 — Research / Aspirational

| # | Opportunity | Source repos |
|---|-------------|-------------|
| 4.1 | **Docker self-hosted API** — JWT auth, loopback bind, sandboxed hooks, monitoring dashboard | crawl4ai Docker API |
| 4.2 | **Agent harness** — give the LLM a direct, dependable browser surface for task completion | browser-use CLI 3.0 (Browser Harness) |
| 4.3 | **Shadow DOM flattening + virtual scroll** — `flatten_shadow_dom=True`, `VirtualScrollConfig` | crawl4ai |
| 4.4 | **wasm-compiled HTML parsing** — selectolax/mechanicalsoup-wasm as `linkedom` alternative for pure-speed extraction | Scrapling benchmarks |

---

## Where pi-webaio Already Leads

The review also confirmed capabilities that are stronger than any single peer:

| Capability | Status |
|-----------|--------|
| Phase-aware error system (25 codes × 10 phases × 7 categories) | Unique among reviewed repos |
| CJK-aware RAG chunking with overlap | crawl4ai has chunking but simpler |
| 7-strategy paywall bypass chain with per-domain tuning | crawl4ai has bot-UA fallback only |
| GitHub vertical (repo/tree/blob/issue/PR/actions/check log) | No peer matches this depth |
| Pre-compiled `dist/` — zero jiti transpile at startup | Most peers transpile at runtime |
| 19-pattern secret scanning pre-flight | None have this depth |
| Response ID + 24 h TTL disk-backed persistence | crawlee has storage but no response IDs |
| Search context bridging (recent query → AI summarization prompt) | Unique |
| Comprehensive SSRF guard (RFC 1918/6598/3927 + IPv6 + cloud metadata) | crawl4ai SSRF covers Docker API only |
| URL cardinality escape hatch (`avoid: "domain|ip"`) | None |

---

## Amendment — Critical Reassessment

On review, the original analysis was too quick to treat every pattern found in these repos as a transferable win. Five corrections:

### 1. Scope mismatch was understated

crawl4ai, crawlee, and scrapy are standalone crawling **frameworks** built for unsupervised, large-scale jobs with no human or LLM in the loop deciding what to fetch next — that's *why* they need BFS/DFS deep-crawl strategies, autoscaled worker pools, and item pipelines. pi-webaio is a tool surface called by an LLM agent that is already doing the per-call reasoning. Most invocations are "fetch this specific thing" or "pull this doc site" — a handful to a few hundred URLs — not unsupervised million-page crawls. Tier 3.2 (deep crawl BFS/DFS/BFF) is a much weaker fit than originally implied and should be read as low-priority/optional, not a natural next step.

### 2. The hooks/plugin recommendation ignored a security lesson in the source material itself

crawl4ai's own changelog (read during this review) documents **RCE via hook sandbox escape and AST sandbox escape** in v0.8.0–v0.8.7 — their hook system was a live vulnerability class serious enough to require a security-hardening release. Recommending "add a hook middleware chain" (Tier 2.1) without weighing that pi-webaio's entire threat model is built around *not* trusting fetched content or arbitrary callables (SSRF guard, secret scanning, prompt-injection detection) was an oversight. If pursued at all, this must be **declarative and allowlisted** (e.g. named lifecycle events with fixed, vetted behaviors), never "pass us a function to `eval`/execute." Downgraded from a clean win to "needs a security design pass first."

### 3. Named browser profiles wasn't actually cost/benefit weighed

The original review framed persistent named browser profiles (Tier 1.1) as the single highest-impact, lowest-effort item. But pi-webaio's call pattern is stateless, per-tool-invocation from an agent — not a long-lived interactive browsing session like browser-use's. Persistent profiles mean **persisted cookies and auth-state on disk**, which is a secret-at-rest problem for a tool whose whole security posture is "don't leak credentials." Downgraded from "immediate, single-file change" to "needs a security design pass first" (encryption at rest, explicit opt-in, clear lifecycle/expiry).

### 4. `aio-weblearn` (AutoScraper-inspired) is the weakest recommendation and should be dropped

AutoScraper needs rule-learning from examples because it has **no LLM** to interpret pages — the wanted-list mechanism is a substitute for reasoning. pi-webaio's actual consumer is an LLM agent that can already read a page's markdown/CSS and construct a targeted extraction inline, more flexibly than any learned rule set. A dedicated "learn extraction rules" tool would largely duplicate what the calling agent already does better, for real ongoing maintenance cost. **Recommendation: cut from the roadmap entirely.**

### 5. Some "gaps" were overstated relative to what pi-webaio already ships

pi-webaio already has anti-bot browser-profile cycling, proxy support (HTTP/HTTPS/SOCKS5), and browser-pool auto-recycling. The delta versus crawlee/crawl4ai was described as bigger than it really is in places — e.g. Tier 1.3 "proxy rotation" was framed as a gap when proxy support already exists; the actual gap is narrower: **sticky per-domain session-to-proxy mapping**, not rotation itself. The opportunity matrix entry has been reworded accordingly.

### Net effect on the opportunity matrix

- **Keep as-is:** 1.4 (TLS fingerprint regression tests), 2.2 (query-aware BM25 pruning), 2.4 (prefetch mode for `aio-webmap`).
- **Re-scope/narrow:** 1.3 (proxy rotation → sticky per-domain mapping only, not general rotation).
- **Security-gate before building:** 1.1 (named browser profiles — needs encryption-at-rest + opt-in design), 2.1 (hooks — must be declarative/allowlisted, not arbitrary callables).
- **De-prioritize:** 3.2 (deep crawl BFS/DFS/BFF) — real but low-value given pi-webaio's call pattern.
- **Drop entirely:** 3.1 (`aio-weblearn`) — duplicates agent reasoning that already exists upstream of the tool call.

---

## Should pi-webaio expose a dedicated web-scrape tool?

A natural question raised by this review: several of the surveyed projects (crawl4ai, Scrapling, AutoScraper, crawlee/Cheerio) center on **structured, repeatable extraction** — CSS/XPath schema → JSON, not just "page → markdown." pi-webaio currently has no equivalent; `aio-webfetch` produces markdown/html/text/json/raw of a whole page, and the 19 `verticals/` extractors are hard-coded per known site. Does pi-webaio need a general-purpose `aio-webscrape` tool that takes a CSS/XPath schema and returns structured JSON from arbitrary pages?

**Assessment: no, not as a new tool — the case is weaker than it first appears.**

1. **The LLM already does this job, and does it better.** The entire value proposition of pi-webaio's existing tools is that they hand a page to an LLM agent as clean markdown, and the agent extracts what it needs *semantically*, without a schema. A schema-based scrape tool (`baseSelector` + `fields[]` à la crawl4ai's `JsonCssExtractionStrategy`) requires the agent to already know the page's DOM structure well enough to write CSS/XPath selectors — at which point it has effectively already solved the extraction problem and gains little by delegating to a second tool call. This is the reverse of AutoScraper's justification (no LLM in the loop) and the same objection that killed the `aio-weblearn` idea above.
2. **It duplicates functionality that already exists in a more agent-friendly form.** `aio-webfetch` with `format: "markdown"` + `chunks: true`, or `format: "json"`, already gets structured, parseable output for an agent to post-process. Adding a second, schema-driven tool increases the tool surface (more choices for the agent to get wrong) without adding capability the agent can't already reach via markdown extraction plus its own reasoning.
3. **Where it *would* help — repeated extraction across many similar pages — is a low-frequency use case for pi-webaio's actual usage pattern.** The scenario where a CSS-schema scraper earns its keep is a **stable, repeated** job: same schema applied to hundreds/thousands of same-shaped pages (product listings, search results). That's crawl4ai/crawlee/AutoScraper's home turf as unsupervised frameworks. pi-webaio is invoked per-turn by an agent that rarely runs the exact same extraction hundreds of times in one session; when it does (e.g. "pull all product prices from this category"), the agent can already loop `aio-webfetch` calls and extract inline from each page's markdown, or use `aio-webpull` with `routes` to fetch many pages in one call and post-process the compiled output itself.
4. **A real gap does exist, but it's narrower than "add a scrape tool":** structured *table* extraction from a single already-fetched page (e.g. pull a specific HTML `<table>` into clean rows/columns) is a legitimately common, low-risk need that markdown conversion sometimes mangles. This is better solved as a **small enhancement to `aio-webfetch`'s existing output modes** (e.g. a `tables: true` flag that returns detected `<table>` elements as JSON arrays alongside the markdown) than as a new standalone tool with its own schema language, CSS/XPath engine exposure, and security surface (selector injection, ReDoS-prone XPath, etc.).

**Recommendation:** do not add a general-purpose `aio-webscrape`/schema-extraction tool. If structured extraction pain shows up in practice, prefer a narrow, additive option on `aio-webfetch` (table detection/JSON, as above) over a new tool with its own selector engine and threat surface. This keeps the tool count low and keeps extraction logic where it belongs — in the calling agent's reasoning over clean markdown — rather than reintroducing the schema-maintenance burden these frameworks (and their unsupervised-crawl use case) exist to solve.

---

## Sources

- <https://github.com/unclecode/crawl4ai>
- <https://github.com/browser-use/browser-use>
- <https://github.com/apify/crawlee>
- <https://github.com/scrapy/scrapy>
- <https://github.com/microsoft/markitdown>
- <https://github.com/D4Vinci/Scrapling>
- <https://github.com/Genymobile/scrcpy>
- <https://github.com/alirezamika/autoscraper>
- <https://github.com/lwthiker/curl-impersonate>
