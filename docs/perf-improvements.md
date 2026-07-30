# pi-webaio — Performance Improvements (measured)

**Date:** 2026 (analysis run) · **Host:** Windows, Node v24.18.0, 16 CPUs · **Playwright 1.62.0, wreq-js present**
**Method:** Every finding below cites a real measurement. Live-network figures are marked **(live)** and are
median of ≥3 samples with range; deterministic CPU figures are median of ≥5 samples. Reproduction scripts are
in `.perf-tmp/` (`measure-local.mjs`, `measure-network.mjs`, `measure-engines.mjs`, `measure-pull.mjs`,
`measure-jina.mjs`), run with `node --experimental-strip-types .perf-tmp/<file>`.
The existing harness `npm run bench` (scripts/bench-extraction.mjs) was run once (concurrency 4, 25 URLs).

**Environment caveats (read first):**

- Bundled Playwright Chromium is **not installed** on this host; the browser fallback and `BrowserPool` use
  system Chrome via `channel:"chrome"` (both `fetchWithPlaywright` and `BrowserPool` try that channel first, so
  this matches production behavior on machines with Chrome).
- DuckDuckGo and Jina returned errors/nulls from this IP (likely rate-limited/geo-blocked). Those specific
  failure latencies are environment-dependent, but the *code paths* that pay them are unconditional, so the
  structural findings hold regardless.

---

## Baseline: `npm run bench` (1 run, 25 URLs, concurrency 4, 25s timeout)

```
Success rate 76% (19/25) · marker hit 73% · median tokens 535
p50 latency 1.6s · p95 latency 7.8s
```

| Category | p50 lat | Note |
| --- | --- | --- |
| verticals (arxiv/pypi/npm/cratesio/…) | 0.5–1.7s | API-first extractors — fast |
| **general-web** (full HTML pipeline) | **6.4s** | **slowest category by ~4x** |
| httpbin.org/get | 42.9s (EXT-ERR) | timeout outlier |

The general-web category dominates tail latency. Findings P0 and P1 below explain why.

---

## P0 — Jina proxy re-fetch burns ~4–5.5s per general-web page, then returns nothing

**Measured (live, n=1 each — slow, so single sample; corroborated by bench p50):**
`fetchJina()` (src/fetch-jina.ts) was timed on three real URLs:

- martinfowler.com/…continuousIntegration.html → **5563ms → null**
- paulgraham.com/startupideas.html → **4361ms → null**
- example.com → **3849ms → null**

**How/why it matters:** `runHtmlPipeline` (src/content.ts:580) calls `fetchJina(url)`
**unconditionally and BEFORE** Readability/Defuddle for every non-vertical public URL. `fetchJina` does a full
`smartFetch("https://r.jina.ai/<url>")` — i.e. it asks Jina's server to re-fetch the *same page we already
downloaded*. When Jina is blocked/rate-limited (as here) `parseJinaBody` rejects the challenge body and returns
null, so we pay ~4–5.5s and then fall through to Readability/Defuddle anyway. This is the dominant term in the
general-web p50 of 6.4s (≈ 0.29s smartFetch + ~4–5.5s wasted Jina + 0.2–2.6s extraction). There is no env flag to
disable it (only `PI_WEBAIO_DEBUG` logging exists).

**Estimated impact of fixing:** cuts general-web p50 from ~6.4s toward ~1–3s (a ~4–5s saving per
non-vertical page) — the single largest win available. Even in environments where Jina succeeds, it is a
redundant second round-trip that should not run *first*.

**Fix (effort S–M):** Make Jina lazy/opt-in rather than the first step — run Readability/Defuddle on the HTML we
already have, and only try Jina when local extraction yields too few words. Additionally add a short Jina timeout
(it currently inherits smartFetch's 30s) and a per-domain negative cache so a domain that just returned null is
not re-tried on the next page of a pull.

---

## P1 — Defuddle markdown conversion is ~2.6s on a large document

**Measured (offline, deterministic, n=5, median):** on a 625KB synthetic article HTML:

- `extractReadability` → **182.5ms**
- `Defuddle(cleaned, url, {markdown:true})` → **2605.3ms** (≈14x slower than Readability)

**How/why it matters:** Defuddle only runs when Readability fails/is skipped (src/content.ts:633), but when it
does run on a large page it adds ~2.6s of pure CPU. Combined with P0 this produces the bench p95 of 7.8s and the
httpbin 42.9s timeout. `DEFUDDLE_TIMEOUT` is 8000ms (src/content.ts:39), so a pathological page can stall a
worker for up to 8s.

**Estimated impact:** up to ~2.6s saved per page that falls through to Defuddle; bounds worst-case worker stalls.

**Fix (effort M):** (a) tighten `DEFUDDLE_TIMEOUT` (8s is generous for a CPU bound task); (b) prefer the much
cheaper Readability path — tune the "readability failed" heuristic (content < 1% of HTML) so more pages resolve
via Readability; (c) for very large HTML, consider truncating boilerplate via `preCleanHtml`/`compressHtml`
before Defuddle. Measure before/after on the bench corpus.

---

## P2 — Browser fallback launches+closes a browser per request (808ms); the pool that fixes this is only wired into webpull

**Measured (live, n=3, median):**

- `smartFetch` wreq fast path (example.com): **290ms** (range 276–342)
- `fetchWithPlaywright` per-request (launch+render+close, no pool): **808ms** (range 807–1027) — **~2.8x, +518ms**
- `BrowserPool` amortization: acquire#1 (cold launch) **295ms acquire + 266ms goto = 561ms**; acquire#2–4 (warm
  reuse) **~40ms acquire + ~24ms goto ≈ 64ms** each; `stats.totalLaunched=1`. Warm reuse is **~8.8x** faster than
  cold and **~12x** faster than the per-request path.

**How/why it matters:** `smartFetch`'s browser rungs — including the recent soft-block-404→browser escalation
(src/fetch.ts Rung 1c) and the bot-block fallback — call `fetchWithPlaywright` **without a pool** unless the
caller passes one. Only `aio-webpull` passes a `BrowserPool`. So every single `aio-webfetch` that escalates to a
browser pays the full 808ms launch+close, every time. The pool demonstrably cuts that to ~64ms.

**Estimated impact:** ~740ms saved per browser-escalated single fetch (808→64ms). For a 10-page pull where half
the pages need a browser, that is several seconds.

**Fix (effort M):** Give `smartFetch`/the tool layer a shared, lazily-created process-level `BrowserPool` so
single fetches and the 404/bot escalation reuse a warm browser instead of launch-close per request. (Note the
per-request path is the only one that can apply `--host-resolver-rules` SSRF pinning today — a pooled fix must
preserve the per-request SSRF redirect guard, which is already installed per-page.)

**UNMEASURED:** the soft-block-404 escalation *trigger* — react.dev returned HTTP 200 to wreq directly from this
IP (335–442ms, no escalation), so I could not time a real escalation end-to-end. Its browser-render component is
the 808ms measured above.

---

## P3 — Search fan-out is bounded by the slowest engine; one 429 blew the whole search to 8.5s

**Measured (live):**

- `searchWeb` (4 HTTP engines, unique queries, n=3): **1250–1419ms** total.
- Per-engine (n=2 each): DDG **ERR 140–216ms** (blocked here), Brave **380–704ms**, Yahoo **1084–1475ms**
  (slowest healthy), Bing **482–1083ms**.
- Two parallel `Promise.all` runs: run1 total **1253ms** (bounded by Yahoo); run2 total **8506ms** because Brave
  hit HTTP 429 and `fetchWithRetry` ran its full retry cycle (MAX_RETRIES=2, jittered 1s→2s backoff).

**How/why it matters:** `searchWeb` (src/search.ts) awaits **all** engines via `Promise.all` with **no per-engine
deadline** — each engine inherits smartFetch's 30s timeout. One slow or rate-limited engine delays the entire
merged result. The advertised "7s cap" is in the tool (src/tools/websearch.ts:87) but the outer race is
`OUTER_TIMEOUT = chromeReady ? 40000 : 7000` — so **when Google/Chrome is enabled the cap is 40s, not 7s**, and a
stalled engine can hold the search for up to 40s.

**Estimated impact:** bounds worst-case search latency; prevents one flaky engine from adding ~7s (8.5s→~1.3s in
the measured 429 case).

**Fix (effort S):** wrap each engine fetch in its own `Promise.race` with a ~4–5s deadline so a stalled engine
returns empty instead of holding the merge; and/or short-circuit `fetchWithRetry` backoff for search (search
engines should fail fast rather than retry 429s inside the 7s window).

---

## P4 — Per-host rate limiter caps single-host pull at ~6 pages/s; 32 workers are over-provisioned

**Measured:**

- `TokenBucket(10 burst, 5/s refill)` sustained throughput: **~6.1 req/s** regardless of worker count (30
  acquires: 4903ms @4 workers, 4932ms @32 workers). Dispatching 32 concurrent acquires took **5502ms** median vs
  **0ms** for 4 (the extra workers just queue on the bucket lock).
- Real single-host pull (live, 20 pages example.com): **32 workers → 6.37 pages/s** (3141ms); **4 workers → 4.03
  pages/s** (4962ms). Per-page latency median 1307ms (mostly waiting on the bucket).

**How/why it matters:** `aio-webpull` uses `concurrency = max(4, cpus*2)` = **32 workers** here (src/tools/webpull.ts:173;
note AGENTS.md says "4×CPU" but the code is 2×CPU). Throughput is **rate-limiter-bound, not CPU- or
network-bound**: 8x more workers bought only 1.58x throughput (4.03→6.37/s) because every host is capped at
burst-10-then-5/s. The surplus workers add lock contention and memory for no gain on single-host pulls.

**Estimated impact:** no throughput loss from right-sizing; lower memory/contention. (The 5/s cap itself is
deliberate politeness/anti-bot — do not raise it blindly.)

**Fix (effort S):** scale worker count to the rate limit for single-host pulls (e.g. ~8–12 workers saturates a
5/s bucket with headroom), or make concurrency aware of distinct-host count (more workers help when a pull spans
many domains, since each host has its own bucket). Multi-host pulls are where 32 workers actually pays off.

---

## P5 — Warm cache benefit is ~290ms (wreq) to ~808ms (browser) per hit — ensure it is not bypassed

**Measured (live/offline):**

- Session-cache `getStoredContent` for a 1MB doc: **0.058ms** (store: 2.27ms, which includes a SHA-256 of the
  content).
- vs a live `smartFetch` wreq fetch: **290ms**, and vs a browser render: **808ms**.

**How/why it matters:** a warm cache hit is **~5000x** cheaper than a live wreq fetch and avoids the network
entirely. The cache is consulted at the tool layer (src/tools/webfetch.ts), not in `smartFetch`. The opportunity
is not a missing cache but ensuring repeated fetches (e.g. within a research bundle or re-fetching a just-pulled
URL) actually hit it, and that `diff`/revalidation (304 handling) is preferred over full re-fetch.

**Estimated impact:** ~290–808ms saved per avoided re-fetch.

**Fix (effort S):** audit call sites that fetch without checking `getStoredContent` first; prefer conditional
revalidation (ETag/Last-Modified, src/http-validators.ts) for `diff`. Mostly verification work.

---

## P6 — Low-impact hot-path CPU (measured, small)

| Item | Measured | Verdict |
| --- | --- | --- |
| `estimateTokens` (420KB) + `chunkMarkdown(512/50)` | 12ms + 30ms = **~42ms/doc** | Only on chunk/answer mode; acceptable. (effort S if ever needed: cache token estimate per content hash.) |
| `JSON.parse` | 0.8MB 14.8ms · 4.3MB 49.8ms · 8.6MB **117ms** | Only for large vertical API payloads; bounded by MAX_RESPONSE_BYTES (10MB). Non-issue. |
| `parseBingResults` (linkedom) | 50 results 4.4ms · 500 results **31ms** | Real searches have ~10–30 results (~2ms). Non-issue. |
| `scoreAndRankResults` + BM25 (200 results) | **1.7ms** | Non-issue. |
| `hashContent` (SHA-256) | 1MB 0.94ms · 10MB 8.7ms | Fast; not repeated in tight loops. Non-issue. |
| `detectBotBlock` (1MB HTML) | **0.058ms** | Non-issue. |
| `validateUrlForSsrf` DNS | **0.3ms** (OS-cached) | Per-fetch DNS is cheap; the double-validate on browser escalation is negligible. Non-issue. |

---

## Non-findings (measured, confirmed NOT a problem)

- **`scanForSecrets` over large strings:** expensive in isolation (3MB→10ms, 30MB→120ms, 307MB→1202ms, ~4ms/MB,
  19 regexes) **but all 4 call sites pass only the URL** (src/content.ts:697,945; src/fetch.ts:879,1158), never a
  response body. URL scan = **0.002ms**. Not on a hot path. No action.
- **Content hashing / dedup:** SHA-256 at 10MB is 8.7ms and runs once per store; not repeated. No action.

---

## Priority summary (ordered by measured impact)

| # | Finding | Measured cost | Saving if fixed | Effort |
| --- | --- | --- | --- | --- |
| P0 | Jina re-fetch first, returns null | ~4–5.5s/page (3/3 null) | ~4–5s/page on general-web | S–M |
| P1 | Defuddle on large docs | 2.6s @625KB | up to 2.6s/page | M |
| P2 | Per-request browser launch (no pool) | 808ms vs 64ms pooled | ~740ms/escalated fetch | M |
| P3 | Search bounded by slowest engine / 429 | 8.5s worst case | bounds to ~1.3–5s | S |
| P4 | Rate limiter caps pull; 32 workers wasted | 6.4/s @32w vs 4.0/s @4w | right-size workers | S |
| P5 | Warm cache benefit | 0.058ms vs 290–808ms | ~290–808ms/hit | S |
| P6 | Misc CPU (tokens/JSON/parsers) | ≤117ms | negligible | — |

**Top three actions:** (1) stop running Jina *first* (P0) — biggest single latency win; (2) bound/tune Defuddle
and prefer Readability (P1); (3) share a warm `BrowserPool` across single fetches and the 404/bot escalation (P2).
