# Speed Benchmarks

Benchmarks are for the **full public `aio-websearch` tool path** unless noted —
HTTP engines (DDG/Brave/Yahoo/Bing) + Google CDP lane + Reddit CDP companion,
collected under the 7s hard response deadline (`SEARCH_DEADLINE_MS`), mirroring
`registerWebsearchTool.execute`.

Harness: `scripts/bench-full-search.mjs` (rotates distinct queries per sample
to avoid the 10-min search cache; shares one `chromeReady` between the Google
and Reddit lanes exactly like the tool).

## Full-tool: legacy vs broker (2026-08-16)

**Machine:** Windows (dev laptop), Node 24.18.1, Chrome (headless CDP), warm
browser infrastructure (Chrome already launched). Rotated query set "pi
coding agent ..." (extension API / tool registration / skills / etc.).

### Zero-spacing burst (n=10) — worst case, back-to-back calls

| Metric | Legacy (`PI_WEBAIO_CDP_BROKER=0`) | Broker (`=1`) |
| --- | --- | --- |
| p50 total | 4,561 ms | 4,538 ms |
| p95 total | 7,014 ms | **4,571 ms** |
| avg total | 5,061 ms | **4,540 ms** |
| HTTP success | 10/10 (100%) | 10/10 (100%) |
| Google success | 8/10 (80%) | **10/10 (100%)** |
| Reddit success | 10/10 (100%) | 10/10 (100%) |
| Deadline cuts | 0 | 0 |
| Processes (before→after) | 506 → 529 | 509 → 523 |
| Working set (before→after) | 8.86 GB → 9.35 GB | 8.33 GB → 10.45 GB |

**Reading:** the broker's p50 is comparable (HTTP engines dominate total
latency); its p95 is far tighter (4,571 vs 7,014 ms — legacy occasionally
spawns a fresh CDP CLI that lands at the 7s ceiling, the broker reuses warm
Chrome); and it never dropped a Google search (100% vs 80%).

### Steady-state spacing (n=20, 4s between calls) — real usage

Burst benchmarks hammer the HTTP engines and Reddit with back-to-back calls,
which rate-limits them (Brave 429, Reddit error). Real aio-websearch calls are
spaced by user thinking time; the benchmark supports a `--spacing-ms` gap.

| Metric | Legacy | Broker |
| --- | --- | --- |
| p50 total | 4,666 ms | **4,519 ms** |
| p95 total | 6,156 ms | **4,555 ms** |
| avg total | 4,774 ms | **3,046 ms** |
| HTTP success | 20/20 (100%) | 20/20 (100%) |
| Google success | 20/20 (100%) | 20/20 (100%) |
| Reddit success | 7/20 (35%) | 7/20 (35%) |
| Deadline cuts | 0/20 | 0/20 |
| Processes (before→after) | 489 → 494 | 489 → 505 |
| Working set (before→after) | 11.09 GB → 10.92 GB | 9.89 GB → 11.65 GB |

**Reading:** under realistic spacing both modes reach 100% HTTP + Google
success with 0 deadline cuts. The broker's **avg is 36% lower** (3,046 vs
4,774 ms) because warm-Chrome samples are much faster (some broker samples
land ~1.5s); p95 stays tight (4,555 vs 6,156 ms). Reddit success (35% in both)
is Reddit-side rate-limiting under 20 rapid queries — identical across modes,
so it is not a broker regression.

### Cold-start (first call, Chrome killed) — Google lane only

| | Legacy | Broker |
| --- | --- | --- |
| First googleSearch | 11,618 ms | **3,012 ms** |
| Results | 5 | 4 |

**Reading:** the broker's Chrome launch + CDP connect + search is **3.9×
faster** on a truly cold start (3.0 vs 11.6 s) — the first search of a
session is ~9s faster with the broker.

### Multi-session concurrency (3 simultaneous searches, Google lane)

| | Legacy | Broker |
| --- | --- | --- |
| 3 concurrent searches | 20,011 ms | **2,284 ms** |
| Success | 1/3 (2 hit "Request deadline expired") | **3/3 (3–4 results each)** |

**Reading:** legacy's concurrent searches collide — each spawns an independent
CDP CLI against the same Chrome, and 2 of 3 hit the deadline. The broker's
lease system serializes the shared Chrome cleanly: all 3 succeed in 2.3s.
This is the decisive reliability win for concurrent pi sessions.

## Google lane only (smoke harness)

`scripts/smoke-google-mode.mjs` (googleSearch only, not the full tool):

| | Legacy | Broker |
| --- | --- | --- |
| Cold | ~3.3–5.9 s | 2.3–2.5 s |
| Warm | 3.3–3.9 s | 0.7–1.7 s |
| Result parity | consistent | consistent (after #101 fix) |

## Notes

- Brave occasionally rate-limits (HTTP 429) under burst benchmarks; this is
  engine-side, identical in both modes, and excluded from the success columns
  (it shows as 0 brave results, not a provider failure).
- "Warm" = browser/broker infrastructure already healthy; cold-start is
  reported separately where measured.
- Burst (zero-spacing) benchmarks reflect worst-case back-to-back calls and
  trigger engine-side rate-limiting; steady-state (spaced) runs better reflect
  real usage.
- Sample sizes are small (n=10–20 per stable variant); treat as indicative,
  not conclusive, per issue #97's acceptance criteria.
