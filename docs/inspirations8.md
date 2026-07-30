# pi-webaio Inspiration Survey #8 — 18-repo assessment

**Date:** 2026-07-29 · **Method:** 5 parallel subagents, each told to read READMEs **and**
key source files (package.json + main entry + 1–3 interesting modules) via `aio-webmap`

+ `aio-webfetch`, and to be honest about stubs. **Result: all 18 repos are real,
substantive, and actively maintained — none are stubs or AI scaffolds.** Most are 0–16★,
so treat them as *technique* inspiration, not proven-at-scale libraries; the exceptions
are **Hound (735★)** and **rpiv (541★)**. Code quality across the set is well above
scaffold-tier (real tests, careful comments, honest notes about reversed decisions).

---

## TL;DR — prioritized borrow list

| Priority | Borrow | Best source (file) | Roadmap | Value |
| -------- | ------ | ------------------ | ------- | ----- |
| 1 | **Context7 + DeepWiki verticals, both keyless** — F9 is fully de-risked, already implemented | heyhuynhgiabuu/pi-search `src/tools/context7.ts` + `deepwiki.ts`; supi-web `src/context7-client.ts` | **F9** | **HIGH — fastest win** |
| 2 | **Out-of-process browser worker** (Unix-socket IPC, spawn-race resolution, 5s heartbeat, 5-min idle-exit) | thurstonsand/pi-web-tools `fetchers/local/fetch-worker.ts` + `worker-protocol.ts` | **F10** | **HIGH — copy this model** |
| 3 | **Per-session owned browser *process*** (not `newContext`), `snapshotVersion` stale-check, name-reservation race fix | DanyPops/web-spider-daemon `adapters/playwright-session-registry.ts` | **F3 + F10 + F13** | **HIGH — 3 items at once** |
| 4 | **Scoped config**: dynamic model-populated enums, `visibleWhen`, legacy migration, `setActiveTools` gating | xl0/pi-lovely-web `config.ts` (+ webveil walk-up/XDG layering, rpiv fail-soft/migration) | **F11** | **HIGH — 5+ reference impls** |
| 5 | **Structured citation contract** (index/url/title/source + dedupe + footer) for the research loop | heyhuynhgiabuu/pi-search `src/tools/citations.ts` | **F1** | **HIGH** |
| 6 | **PageGraph** — directed link-authority graph over crawled pages (roots/sinks/findPath/byPageRank) | DanyPops/web-spider `src/graph.ts` | **F1** | **HIGH** |
| 7 | **Six-signal ranking + domain-diversity cap** (max 2 per domain in top results) | dondai1234/master-fetch (Hound) `search.py`/`envelope.py` | **F5** | **HIGH** |
| 8 | **Round-robin + per-engine cooldown + coverage-learning site router** | DanyPops/web-spider `src/web-search.ts` | **F5** | **HIGH** |
| 9 | **In-flight request coalescer with refcounted cancellation isolation** | zeldrisho/pi-packages `inflight.ts` | **F6 / new** | **HIGH** |
| 10 | **`tool_result` auto-capture + `before_agent_start` "search local first" nudge** | cframe1337/pi-source-drafts `src/index.ts` | **F8** | **HIGH** |
| 11 | **Fuzzy `findText`** (typo-tolerant, accent-normalized, snippet-merged) over cached fetch | xl0/pi-lovely-web `find.ts` | **new / F8** | **HIGH** |
| 12 | **Declarative browser-action spec → local cmds + cloud NL prompt** (one spec, three backends) | Wade11s/pi-web-toolkit `browser-action-language.ts` | **F13** | **HIGH** |
| 13 | **Headed-escalation with a merged budget clock** (cf-mitigated header → headless wait → brief visible window) + HeadlessChrome UA laundering | thurstonsand/pi-web-tools `browser-session.ts` | **F12** | **HIGH** |

---

## By roadmap item

### F1 — iterative cited-report research loop (the centerpiece)

The richest set of building blocks; no single repo has the whole loop, but together they de-risk it:

+ **Structured citation contract** — heyhuynhgiabuu/pi-search `src/tools/citations.ts`: every tool emits `citations[]` (index/url/title/source) in `details`, plus `extractCitationsFromMcpText`, `formatCitationFooter`, URL-based `dedupeCitations`. A shared citation struct is a concrete CLAIMS.md building block. **HIGH.**
+ **PageGraph link-authority** — DanyPops/web-spider `src/graph.ts`: nodes=pages, edges=outbound links (anchor text + `isExternal`), reverse inbound-index, `roots()`/`sinks()`/`findPath`/`reachableFrom`/`byPageRank()`. Layering this on `aio-webpull`'s flat BM25 corpus lets research rank pages by inbound-link authority. Note the deliberate `Object.create(null)` (not Map) for jiti/cross-realm safety. **HIGH.**
+ **Durable draft/journal substrate** — cframe1337/pi-source-drafts `src/journal.ts`: append-only WAL + in-memory inverted index + binary CDB content store, tombstone deletes, crash-safe. A natural durable home for the loop's intermediate findings. **HIGH.**
+ **Brave LLM Context grounding mode** — zeldrisho/pi-web-search `src/brave.ts`: `/res/v1/llm/context` returns RAG-ready grounding snippets already rendered as markdown (structured-table snippets → markdown tables). "Search that returns pre-chunked cited content" feeds the loop directly. **MED-HIGH.**
+ **Artifact-digest + exempt-highlights output policy** — thurstonsand/pi-web-tools `delivery.ts`: bodies to disk, tool result is only a digest (title/facts/paths, hard 260-char excerpt cap) while objective-steered highlights are *exempt* from the cap. **MED.**
+ **Intent-aware multi-query fan-out** — Hound `search.py`: query-intent detection generates expanded variants distributed across engines. **MED.**
+ **Grounded single-shot `smartQuery`** — xl0/pi-lovely-web `smart.ts`: strong grounding prompt ("say 'Not found on page.'"), context-budget clamping, retry gated on retryable-error, session-self-disable when the model is unavailable. **MED.**

### F3 — stateful fetching (cookie jar / login profiles)

+ **Persistent `profileDir` + `context.request` cookie sharing** — thurstonsand/pi-web-tools `settings.ts` (`getDefaultProfileDir` under `~/.pi/agent/browser-profile`); headless fetches share the profile's cookies. **HIGH.**
+ **Per-session owned browser process** — web-spider-daemon `playwright-session-registry.ts`: full-process isolation so cookies/storage/history never leak across named sessions. **HIGH.**

### F5 — BM25-rank + domain-diversify search

+ **Six-signal ranking + diversity cap** — Hound: cross-variant consensus, domain reputation, answer-signal, title/URL relevance, and **max 2 per domain in top results**. Directly portable to `src/search.ts`. **HIGH.**
+ **Round-robin + cooldown + coverage-learning site router** — web-spider `src/web-search.ts`: `RoundRobinSearchEngine` with per-engine cooldown (one engine's rate limit doesn't collapse the group), nested in a fallback engine; a *learning* site-router remembers which engines actually returned results for a domain (e.g. Reddit blocks all crawlers but Google-backed ones) and skips non-covering engines. pi-webaio fans out 5 engines with a 7s cap but has no cooldown/round-robin/coverage-learning. **HIGH.**
+ **Ranked "Read these pages" link summary + fetch guidance** — joematthews/pi-smart-web-search `markdown.ts`: two-section output (snippets by query + a ranked link list with an explicit `FETCH_INSTRUCTION`), result N above == link N below. **MED-HIGH.**
+ **Sequential fallback chain (fallback-on-empty, `attempted`/`causes` telemetry)** — dabito/pi-lynx `engines.ts`: `runSearchChain()` advances on throw *or* (config-gated) on empty; last engine always resolves; aggregate `SearchChainError` carries `attempted[]` + `causes[]`. **MED.**
+ **Validated search-param normalization** — heyhuynhgiabuu/pi-search `src/exa/params.ts`: pure, fully-validated domain include/exclude, recency-vs-date mutual exclusion, bounds. A model for turning pi-webaio's loose params into a testable layer. **MED.**

### F6 — content-hash dedup + diff-mode

+ **In-flight coalescer with refcounted cancellation isolation** — zeldrisho/pi-packages `inflight.ts`: dedups identical concurrent ops but tracks a `waiters` count so one caller aborting does *not* cancel another's shared request; the `AbortController` only fires when the last waiter leaves; bounded by `maxEntries`. Correct-by-construction and easy to get wrong. **HIGH.**
+ **FNV-1a content-hash dedup + section-level index** — cframe1337/pi-source-drafts `src/index.ts`/`memory-index.ts`: `hashContent` + `findByHash` prevent duplicate saves; `##` sections indexed separately with TF-IDF + title 2× weight + project/session locality boost. **HIGH.**
+ **Shared `canonicalizeUrl`** — web-spider `src/cache-key.ts`: one canonical form (strip fragment, **sort query params**, drop trailing slash) shared across every cache adapter. pi-webaio normalizes http→https + trailing slash but doesn't sort query params. **MED.**
+ **Byte-bounded + entry-bounded expiring LRU (`sizeOf`)** — zeldrisho/pi-web-fetch `src/cache.ts`: evicts on both entry count and aggregate bytes. pi-webaio's caches are entry-count-only; byte-bounding stops a few huge pages blowing the budget. **MED.**

### F8 — local-knowledge pre-check before live fetch

+ **`tool_result` auto-capture + `before_agent_start` "search local first" nudge** — cframe1337/pi-source-drafts `src/index.ts`: passively snapshots web_search/fetch output into searchable drafts, then injects a hidden system message ("N drafts exist, use `search_drafts` first"). A concrete F8 implementation. **HIGH.**
+ **Fuzzy `findText`** — xl0/pi-lovely-web `find.ts`: typo-tolerant sliding-window, accent/case/punctuation normalization, phrase-hit bonus, merged snippets with 500-char context, PUA markers for TUI highlighting; `exact`/`lower`/`fuzzy` modes. More nuanced than grep, cheaper than an LLM. Pairs well with F8. **HIGH (new).**
+ **Project/session locality ranking boost** — pi-source-drafts `memory-index.ts`: `currentProject +5` / `currentSession +10`. A nice idea `aio-webquery` lacks. **new.**

### F9 — Context7 + DeepWiki verticals  ← *fully de-risked*

+ **Context7 + DeepWiki, both keyless** — heyhuynhgiabuu/pi-search `src/tools/context7.ts` (resolve name→ID via `/api/v1/search`, fetch `/api/v1/{id}?type=txt&tokens=N`; sniffs `{` to handle Context7 lying about content-type) and `src/tools/deepwiki.ts` (`mcp.deepwiki.com/mcp` JSON-RPC `ask_question` → synthesized answer + file citations). pi-webaio already ships an MCP server + SDK dep, so adding an MCP *client* call for DeepWiki is cheap. **HIGH — this is literally F9, implemented.**
+ **Context7 client (search→ID→fetch, trust/benchmark scores)** — supi-web `src/context7-client.ts`: `searchLibrary()` returns a markdown table with Context7's own `trustScore`/`benchmarkScore` (a ready-made source-trust signal); notable error-message craftsmanship branching on whether a key is configured. **HIGH (Context7 half).**
+ **Provider factory + capability narrowing** — rpiv-web-tools `providers/factory.ts`: one `createSearchProvider(name, {apiKey, baseUrl})` switch over 10 providers; consumers narrow with `"fetch" in provider`. A tidy pattern for pi-webaio's vertical registry. **HIGH.**
+ **Keyless search via hosted MCP endpoint** — ByteTrue/pi-web-search `src/providers/exa-free.ts`: a minimal MCP client (`initialize` → `notifications/initialized` → `tools/call`) speaking SSE to `mcp.exa.ai`, with three parse-fallback strategies. Fragile by nature but well-guarded; a zero-key search fallback. **HIGH as a technique.**

### F10 — worker-process browser-pool isolation

+ **Out-of-process browser worker over a Unix socket** — thurstonsand/pi-web-tools `fetchers/local/fetch-worker.ts` + `worker-protocol.ts`: the host *never imports playwright-core*; a standalone `node fetch-worker.ts <json-config>` owns the browser over `~/.pi/agent/fetch-worker/worker.sock`. PID file + `spawn.lock` + **spawn-race resolution** (a newcomer probes the socket; if a live worker answers it `process.exit(0)` rather than stealing the path), **5s heartbeats** (detect a wedged worker independent of work duration), **5-min idle-exit**. This is F10 already built and battle-tested. **HIGH — copy this model.**
+ **Daemon "sole owner of cache + network"** — web-spider-daemon: a loopback daemon solely owns the SQLite page cache + all network I/O; the pi extension is a thin client. A heavier commitment than pi-webaio's in-process design — borrow the *idea* (sole cache owner, session isolation), not necessarily the whole daemon. **MED-HIGH.**

### F11 — config layering  ← *5+ reference implementations*

+ **Scoped config + dynamic enums + migration + tool gating** — xl0/pi-lovely-web `config.ts` (on `@xl0/pi-lovely-config` `defineScopedConfig`, global `~/.pi/agent/…` + project `.pi/…`): dynamic enum fields populated from the user's *authenticated* models at runtime with `visibleWhen`; legacy-key + legacy-filename migration (best-effort, never blocks startup); `applyToolConfig()` uses `pi.setActiveTools()` to add/remove tools based on config. **The cleanest F11 reference.**
+ **Walk-up + XDG + env layering, injectable/testable** — wighawag/webveil `core/config.ts`: precedence `env > nearest webveil.json walking up from cwd > $XDG_CONFIG_HOME global > defaults`, merged key-by-key, frontend-neutral filename, `ResolveOptions` injects cwd/env/homeDir/globalPath. **HIGH.**
+ **Fail-soft typed config + legacy migration + pass-through** — rpiv-web-tools `providers/config.ts`: typebox, `additionalProperties: true` so unknown/legacy keys pass through, `Value.Check` (no mutation), malformed-JSON/EISDIR/schema-violation all degrade to `{}` ("the orchestrator never handles config blew up at startup"), plus legacy `apiKey`→`apiKeys.brave` auto-migration. **HIGH.**
+ **env→file→defaults + unknown-key guard** — heyhuynhgiabuu/pi-search `src/config.ts`: `disabledTools` merged from env+file+args, `validateDisabledTools` rejects unknown names, external-key fallback. **HIGH.**
+ **Shared CJS config core** — Wade11s/pi-web-toolkit `utils/config-core.cjs`: one module owns schema/defaults/validation/precedence/write, deliberately CJS so the *same file* is imported by the TS runtime AND the bash installer (`validate`/`raw-get`/`resolve`/`write`). Note it's env→file→default; adapt the layer order to pi-webaio's defaults→global→project→env→runtime. **HIGH.**
+ **Fail-soft typebox + atomic 0600 write** — ByteTrue/pi-web-search `src/config.ts`: degrade to `{}`, writes via tmp-file + atomic `rename` at `0600`. **MED.**
+ **Synthesis:** webveil (layering mechanics) + xl0 (scoped/dynamic/migration/gating) + rpiv (fail-soft robustness) together give a complete F11 design.

### F12 — coherent-fingerprint refinement

+ **Headed-escalation with a merged budget clock** — thurstonsand/pi-web-tools `browser-session.ts` (`escalatedFetch`) + `fetch-worker.ts` (`resolveChallenge`): detect Cloudflare via the `cf-mitigated: challenge` *response header* (not title/body heuristics), wait headless up to `headlessWaitSecs` (10), escalate to a briefly-visible window up to `headedWaitSecs` (20), drawing from **one merged deadline** so a fast step's leftover spills into the next. pi-webaio has a bot-wait loop but no headed-escalation-with-budget model. **HIGH.**
+ **HeadlessChrome UA laundering** — thurstonsand `launchHeadlessWithNormalUserAgent()`: probe `navigator.userAgent`; if it contains `HeadlessChrome`, relaunch overriding to `Chrome`; cache the result. **MED.**
+ **Latest-Chrome-profile selector** — Thinkscape/agent-smart-fetch `profiles.ts`: filter `wreq-js` profiles to `chrome_*`, sort, pick the last — always track the newest fingerprint rather than pinning `chrome_145`. **LOW-MED.**
+ **Coherent stealth reference** — Hound `browser.py`/`test_stealth.py`: 4 fingerprint profiles, JS-layer patches, Bezier mouse curves, Turnstile solver. **MED.**
+ **HTTP 202 soft-ban detection + jittered request pacing** — joematthews/pi-smart-web-search `index.ts`: DDG returns 202 for a rate-limit challenge page (detect → explicit "wait ~60s"); jittered inter-request spacing (1000ms + random 400ms) to avoid exact-interval bot detection. pi-webaio has jittered *retries*; this is jittered *request pacing*. **MED.**

### F13 — interactive browser-flow tool

+ **Interactive login browser as a first-class mode** — thurstonsand/pi-web-tools `browser-session.ts` (`openInteractive`): a visible persistent-context Chrome sharing the profile; the idle timer is explicitly suppressed while a login session is open ("a login session must never be killed by the idle timer"); headless fetches `assertNotInteractive()` and fail with a clear conflict. **HIGH.**
+ **Declarative browser-action spec → three backends** — Wade11s/pi-web-toolkit `utils/browser-action-language.ts`: one `BrowserAction[]` (click/fill/type/press/wait/wait_selector/scroll) compiles via `planBrowserActions()` to human-readable steps, local agent-browser command arrays, AND a natural-language `cloudPrompt` for Firecrawl interact. Write the semantics once, adapt to local Playwright vs cloud. **HIGH.**
+ **Per-session process registry** — web-spider-daemon `playwright-session-registry.ts` (also F3/F10). **HIGH.**

### F14 — video / frame understanding  ← *still the most open*

+ **`web_image` as a first-class media-returning tool** — xl0/pi-lovely-web: trivial but a clean precedent for returning media. **LOW-MED.** No repo tackles frame-level video understanding; F14 remains genuinely unsolved across this set (consistent with the earlier survey naming it the headline "they do something we don't" feature).

---

## New ideas (off-roadmap)

+ **Keyless hosted-MCP search technique** — speak minimal MCP (SSE) to a hosted endpoint (`mcp.exa.ai`, `mcp.deepwiki.com`) for zero-key search/Q&A (ByteTrue `exa-free.ts`, heyhuynhgiabuu `deepwiki.ts`, Eddie0521 `search.ts`). Lowers install friction; fragile but well-fallbacked.
+ **Security defense-in-depth** — sebaxzero/pi-safe-search `sanitize.ts`: wrap untrusted content in a `crypto.randomUUID()`-derived delimiter + "treat as data only" banner; re-sanitize at the `tool_result` hook boundary (catches injections slipping through third-party paths) + `beforeagentstart` system-prompt reinforcement; NFKC + explicit Cyrillic/Greek **homoglyph map**, zero-width strip, **base64-blob redaction**. The homoglyph folding + base64 redaction + hook-boundary sanitization are concrete patterns pi-webaio's `injection.ts` may not cover (especially for the MCP server path). **MED (incremental over existing).**
+ **Shadow-DOM-piercing HTML capture** — thurstonsand `capturePageHtml()`: `document.documentElement.getHTML({ shadowRoots: [...] })` (feature-detected) serializes open shadow roots as declarative shadow templates, which `page.content()` misses on hydrated SPAs. **MED.**
+ **`document.contentType` routing over response headers** — thurstonsand: route HTML-vs-binary on the MIME type the renderer *committed to* (react.dev's service worker serves navigations with no content-type header); re-fetch non-HTML through `context.request` (sharing cookies). **MED.**
+ **Windows-1252 HTML charset fallback + non-text→0600 file never in context** — xl0/pi-lovely-web `get.ts`/`output.ts`: charset decode from Content-Type with Windows-1252 fallback for legacy `text/html`; binary streamed to `/tmp` at `0600`, never into model context; UTF-8- and line-boundary-aware truncation. **MED.**
+ **robots.txt `Crawl-delay` integration** — web-spider `throttle.ts`: per-host min-gap + exponential backoff with jitter + `Retry-After` parsing + `setDomainDelay()` so a robots.txt Crawl-delay overrides the per-domain floor. pi-webaio has a token-bucket limiter but no Crawl-delay integration. **MED.**
+ **Extraction approval/snapshot testing** — Wade11s/pi-web-toolkit `test/content-preview/`: 12 real-world fixtures (wikipedia, reddit, HN, CJK) + baselines + `--approve` flag. A good QA pattern for `scripts/bench-extraction.mjs`. **MED (process).**
+ **Package-scoped proxy that never touches the global dispatcher** — ByteTrue/pi-web-search `src/proxy.ts`: undici `EnvHttpProxyAgent` as a per-package dispatcher passed explicitly, honors `NO_PROXY`, idempotent; generic web-fetch keeps a separate stricter SSRF transport. (They burned a "web-proxy-global-side-effect" bug to learn it.) **MED.**

---

## Security cross-checks / verification targets

These are things to **verify or harden** in pi-webaio, surfaced by the survey:

1. **Redirect re-validation through the SSRF policy on every hop** — zeldrisho/pi-web-fetch `network-redirects.ts` runs each `Location` back through `validateRemoteUrl` (max 5 hops) so a public URL can't 302 into a private/metadata address. **Verify pi-webaio's wreq/Playwright fallback ladder does the equivalent.**
2. **Comprehensive IPv6 block ranges** — zeldrisho `network-policy.ts` (node:net `BlockList`) includes NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), discard (`100::/64`), benchmarking (`198.18.0.0/15`), IPv4-mapped (`::ffff:0:0/96`). The NAT64 and `100::` entries are easy to miss — **cross-check pi-webaio's metadata floor / CIDR list.**
3. **Dangerous-port blocklist** — sebaxzero `fetch.ts` blocks 22/3306/6379/27017 etc. pi-webaio's SSRF doc doesn't mention ports. **Cheap additive hardening.**
4. **Mutual confirmation of DNS-pinning** — zeldrisho `network-transport.ts` `requestPinned` uses a `lookup` callback returning the already-validated address — the *same* design as pi-webaio's `createPinnedLookup`. Confirms the approach is the right one.

**Explicit skip:** Eddie0521/pi-web-suite `ssrf.ts` — resolves DNS then re-resolves at connect (the exact TOCTOU pi-webaio v0.7.3 closed) and **fails open** ("rather let through than mis-kill"). pi-webaio is strictly ahead; nothing to borrow.

---

## Per-repo quick reference

| Repo | ★ | Quality | Top borrow | Roadmap |
| ---- | - | ------- | ---------- | ------- |
| thurstonsand/pi-web-tools | 0 | **goldmine** (65 files, Vitest, CI, dense eng comments) | out-of-process browser worker; interactive login browser; headed-escalation budget clock | F10/F13/F3/F12 |
| DanyPops/web-spider | 0 | very active (v0.14.0, 30+ test files, hexagonal) | PageGraph; round-robin/cooldown/coverage-learning search; per-session browser process | F1/F5/F3/F10/F13 |
| heyhuynhgiabuu/pi-search | 13 | product-polished (Changesets, Vitest, biome) | Context7 + DeepWiki (keyless); citation contract; config layering | F9/F1/F11 |
| dondai1234/master-fetch (Hound) | **735** | production-shaped (673 tests, Docker) | six-signal ranking + diversity cap; envelope classify_source/freshness; neural reranker arch | F5/source-trust/F1 |
| juicesharp/rpiv-web-tools | **541** | very high (codecov, Dependabot, architecture.md) | provider factory + capability narrowing; fail-soft config + legacy migration | F9/F11 |
| cframe1337/pi-source-drafts | 0 | genuinely engineered (WAL + inverted index, 71 tests) | tool_result auto-capture + "search local first"; FNV-1a dedup; journal substrate | F8/F6/F1 |
| xl0/pi-lovely-web | 10 | careful (tsgo/TS7, biome, snapshots) | scoped config + dynamic enums + migration; fuzzy findText; grounded smartQuery | F11/F8(new)/F1 |
| wighawag/webveil | 0 | meticulous (ADRs, claim/review protocols) | walk-up + XDG + env config layering; fail-loud egress proxy | F11/security |
| Wade11s/pi-web-toolkit | 2 | thoughtful (approval/snapshot tests) | declarative browser-action language; shared CJS config core | F13/F11 |
| zeldrisho/pi-packages (pi-web-fetch) | 0 | security-conscious (contract tests, 20 releases) | InflightCoalescer; redirect re-validation; IPv6 range table; byte-bounded LRU | F6/security |
| zeldrisho/pi-packages (pi-web-search) | 0 | careful (contract tests) | Brave LLM Context grounding mode; InflightCoalescer | F1(new)/F6 |
| ByteTrue/pi-package-mono (pi-web-search) | 3 | substantive (security audit archive) | keyless hosted-MCP search; package-scoped proxy; fail-soft config | F9(new)/F11 |
| mrclrchtr/supi (supi-web) | 48 | solid (release-please, 255 PRs) | Context7 client (trust/benchmark scores); output-budget→temp-file spill | F9/new |
| joematthews/pi-smart-web-search | 16 | most polished code, narrow | ranked "Read these pages" summary; 202 soft-ban detect; jittered pacing | F5/F12 |
| Thinkscape/agent-smart-fetch | 53 | high, but a near-sibling of pi-webaio | thinness-gated format-qualified alternate-link fallback; latest-Chrome-profile selector | new/F12 |
| sebaxzero/pi-safe-search | 1 | small but coherent | random-delimiter wrapping; tool_result hook gate; homoglyph/base64 redaction | security(new) |
| dabito/pi-lynx | 2 | deliberately minimal | sequential search-chain (fallback-on-empty, attempted/causes telemetry) | F5 |
| Eddie0521/pi-web-suite | 0 | **derivative fork of rpiv** | keyless MCP endpoint (only) — **ssrf.ts is a regression, skip** | F9(low) |

---

## Synthesized action plan

+ **Quick wins (de-risked, high value):** F9 first — heyhuynhgiabuu/pi-search gives both Context7 + DeepWiki keyless, and pi-webaio already has the vertical registry + an MCP SDK dep. supi-web's Context7 client is a clean alternative reference.
+ **F11 has the most reference material** — xl0 (scoped/dynamic/migration/gating) + webveil (walk-up/XDG layering) + rpiv (fail-soft/migration) + pi-search (unknown-key guard) together are a complete design; this is well-trodden ground.
+ **The browser-isolation cluster (F3/F10/F13) shares one answer** — thurstonsand's `fetchers/local/` (worker over a socket) + web-spider-daemon's `playwright-session-registry.ts` (per-session process) are near-reference implementations for all three at once. Study these end-to-end before designing.
+ **F1 (centerpiece) is assemble-from-parts** — pi-search citations + web-spider PageGraph + pi-source-drafts journal/drafts + (optionally) Brave LLM-context grounding. No single repo has the loop; the parts are all here.
+ **F5** — Hound's diversity-cap + envelope is the best external cross-check for the new `src/source-trust.ts`; web-spider's round-robin/cooldown/coverage-learning is the orchestration layer pi-webaio lacks.
+ **F6** — zeldrisho's InflightCoalescer (cancellation isolation is the hard part, solved) + pi-source-drafts FNV-1a dedup + web-spider canonicalizeUrl.
+ **Security** — verify redirect re-validation, add IPv6 NAT64/`100::` ranges + a dangerous-port blocklist; consider sebaxzero's hook-boundary sanitization + homoglyph/base64 redaction for the MCP path.
+ **F14 remains open** — nothing in this set solves frame-level video understanding; it stays the differentiator to design from scratch.

**Caveat:** 0–16★ repos = technique inspiration, not proven-at-scale. Hound (735★) and rpiv (541★) are the exceptions. web-spider's daemon model is a heavier architectural commitment than pi-webaio's in-process design — borrow the ideas, not the whole daemon, unless F10 explicitly wants a separate process.

---

## Survey #8b — 5 additional repos (2026-07-29)

A follow-up batch. All five are substantive and source-verified (no stubs). The headline
result: **F14 (video/frame understanding) is no longer open** — `diegopetrucci/pi-web-access`
implements it, with a corrected mental model.

### diegopetrucci/pi-web-access — *F14 reference (verified)*

0★ but a purpose-pinned fork ("The Last Harness", releases to tlh-v0.10.10, active); the most
technically ambitious of the batch.

+ **F14 mechanism (corrected):** video Q&A rides **Gemini's native whole-video multimodal
  ingestion**, NOT frame-sampling-into-a-VLM. YouTube: the URL is passed straight to Gemini
  (`youtube-extract.ts`: `tryGeminiWeb` → `tryGeminiApi` → `tryPerplexity`). Local files:
  resumable upload to the **Gemini Files API** (`video-extract.ts` `uploadToFilesApi`,
  `X-Goog-Upload-Protocol: resumable`), poll until `ACTIVE`, then query; uploaded files deleted
  in `finally`. Default model `gemini-3-flash-preview`, 50 MB cap. **Frame extraction is a
  separate export feature** (`timestamp`/`frames` params): `yt-dlp -g` gets a stream URL +
  duration, `ffmpeg -ss <t> -frames:v 1 -vcodec mjpeg pipe:1` grabs ≤12 JPEG frames returned as
  base64 to the agent (exported, not fed back into an internal VLM loop). → **Reframe F14 around
  Gemini native ingestion + Files-API upload + ffmpeg/yt-dlp frame export. HIGH.**
+ **Real Chrome cookie harvesting/decryption** (`chrome-cookies.ts`): reads the local browser's
  Cookies SQLite DB, PBKDF2 key derivation (1003 iters on macOS via Keychain, 1 iter on Linux via
  `secret-tool`), AES-CBC decrypt of `encrypted_value`, Google-cookie allowlist, `node:sqlite`.
  Powers "Gemini Web as the logged-in user." → **F3/F13 HIGH reference. CAVEAT: returns null on
  Windows (needs a DPAPI path) and is security-sensitive — gated opt-in only.**
+ **Cited-summary "curator" with deterministic fallback** (`summary-review.ts`): LLM draft +
  no-LLM `buildDeterministicSummary` fallback + per-result `SummaryMeta` (model, durationMs,
  tokenEstimate, fallbackUsed, fallbackReason). → **F1 MED-HIGH.** (Uses the old `@mariozechner/pi-ai` scope.)
+ **Layered capability fallback chains** (Exa→Perplexity→Gemini API→Gemini Web; Jina→Gemini) with
  a "something always works" guarantee. → F15/robustness MED.

### jvm/pi-mono → packages/pi-web-kit — *F9/F11/F15 references*

⭐12, very polished monorepo (Scorecard/Semgrep/TruffleHog/CODEOWNERS, per-package tests).

+ **Context7 docs vertical — direct API v2 client** (`src/providers/context7.ts`): `libs/search`
  (returns `trustScore`/`benchmarkScore`/`versions`) + `context` (codeSnippets/infoSnippets/rules),
  Bearer auth, version pinning via `id@version`. → **F9 HIGH — near drop-in for `src/verticals/`.**
+ **Config layering ladder** (`src/config.ts` `resolveConfig`): DEFAULT → env → global
  `~/.pi/agent/pi-web-kit.json` → project (gated by `includeProject`) → runtime CLI; `requireKey()`
  names the exact env var in the error. → **F11 HIGH — near-exact match for the desired ladder.**
+ **Keyless hosted-MCP search/fetch** (`src/providers/exa-mcp.ts`): full MCP streamable-HTTP client
  (`initialize` → capture `mcp-session-id` → `notifications/initialized` → `tools/call`), `x-api-key`
  set only if present (works keyless), SSE + JSON parsing. → **F15 HIGH — working reference.**
+ **Per-URL fetch fallback with provenance** (`src/providers/fallback.ts`): re-fetch only the
  *missing* URLs through tinyfish→firecrawl→markdown_new, stamp `fallbackProvider`/`fallbackFrom`. → new MED.
+ **Byte-bounded LRU fetch cache** (`src/cache.ts`): dual eviction on maxEntries (100) + maxBytes
  (20 MB) + TTL (30 min). → new/hardening MED.

### georgebashi/pi-web-fetch — *extensibility reference*

⭐25, spec-driven (`openspec/` design docs), single-purpose.

+ **4-stage site-hook extension API** (`types.ts`/`registry.ts`): `beforeFetch`/`afterFetch`/
  `afterExtract`/`summarize`, each short-circuitable; registry searches 3 priority tiers
  (event-bus → local → built-in) via picomatch globs. → **new/extensibility MED** — the borrowable
  bits are an **event-bus tier** (let other pi extensions inject handlers) and a **`beforeFetch`
  redirect hook** (e.g. "use `gh` for github.com"). Complements pi-webaio's `src/hooks.ts`.
+ **Abort-aware browser tab pool** (`browser-pool.ts`): wait-queue with `AbortSignal` integration,
  launch dedup, idle-timeout. → **F10 LOW-MED** — honest caveat: in-process tab pooling, NOT worker
  isolation; only the abort-integrated wait queue + launch dedup are worth borrowing.
+ **trafilatura extraction** (Python subprocess) → new LOW (conflicts with pure-Node stance; benchmark only).

### anthod0/pi-lab → packages/webfetch + websearch — *small, focused, pi-webaio supersedes*

⭐6 monorepo of 9 extensions, tested, shared `@pi-lab/utils`. Narrower than pi-webaio; borrow value concentrated.

+ **Inline-script index + lazy `script=N` retrieval** (webfetch `content.ts`/`tool.ts`): strips
  scripts from the body, emits a numbered preview index, agent pulls one script on demand with
  pagination. A lazy, agent-driven alternative to pi-webaio's eager `data-islands.ts`. → **F16 MED.**
+ **Optimizer `rewriteUrl` pre-fetch hook** (webfetch `optimizers/types.ts`): `match`/`rewriteUrl`/
  `processHtml` with a `defaultProcess` fallback — a cleaner pre-fetch separation than pi-webaio's
  vertical contract. → new LOW-MED.
+ **X/Twitter vertical** (webfetch `optimizers/x.ts`): brace-depth-scanned `window.INITIAL_STATE`
  extraction, iterative entity decode, best-bitrate MP4 selection. → new MED (if X content matters).
+ **Exa hosted search backend** (websearch `exa.ts`): `type` (auto/fast/instant/deep-lite/deep),
  category, include/exclude domains, date range, `fresh`→`maxAgeHours=0`; citation-friendly
  highlights. → **F15 MED** (keyed not keyless, but a strong extra engine; the `deep`/`deep-lite`
  taxonomy informs F1's research-depth knob).
+ **Shared user→project settings deep-merge** (`@pi-lab/utils` `settings.ts`): `~/.pi/agent/settings.json`
  + `<cwd>/.pi/settings.json`, project overrides user. → **F11 HIGH reference** (covers the middle two layers).
+ Byte-sized LRU cache (50 MB `sizeCalculation`), cross-domain-redirect surfacing, Readability
  ≥10%-ratio guard → new LOW (pi-webaio already more advanced).

### #8b reference map (updates + new)

| Item | New borrow from #8b (file)                                                                  | Value                    |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------ |
| F14  | Gemini native video ingestion + Files-API upload + ffmpeg/yt-dlp frame export (pi-web-access `youtube-extract.ts`/`video-extract.ts`) | HIGH — **F14 no longer open** |
| F3   | Chrome cookie harvesting/decryption (pi-web-access `chrome-cookies.ts`) — Windows-unsupported, security-sensitive | HIGH ref, gated          |
| F9   | Context7 API v2 client w/ trust/benchmark scores + version pinning (pi-web-kit `context7.ts`) | HIGH — near drop-in      |
| F11  | config ladder DEFAULT→env→global→project(gated)→runtime (pi-web-kit `config.ts`); user→project deep-merge (pi-lab `settings.ts`) | HIGH                     |
| F15  | keyless hosted-MCP client (pi-web-kit `exa-mcp.ts`); Exa `deep`/`deep-lite` search types (pi-lab `exa.ts`) | HIGH                     |
| F1   | deterministic-fallback cited-summary curator + SummaryMeta (pi-web-access `summary-review.ts`) | MED-HIGH                 |
| F16  | lazy inline-script index + `script=N` retrieval (pi-lab webfetch `content.ts`/`tool.ts`)    | MED                      |
| new  | event-bus extension tier + `beforeFetch` redirect hook (georgebashi `registry.ts`/`types.ts`) | MED                      |
| new  | per-URL fetch fallback with provenance tagging (pi-web-kit `fallback.ts`)                   | MED                      |
| new  | byte-bounded LRU cache (pi-web-kit `cache.ts`, pi-lab `cache.ts`) — recurring               | MED                      |
| new  | X/Twitter vertical (pi-lab webfetch `optimizers/x.ts`)                                      | MED                      |
