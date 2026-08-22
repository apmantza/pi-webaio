# Speed Benchmarks

Benchmarks are for the **full public `aio-websearch` tool path** unless noted —
HTTP engines (DDG/Brave/Yahoo/Bing) + Google CDP lane + Reddit CDP companion,
collected under the 7s hard response deadline (`SEARCH_DEADLINE_MS`), mirroring
`registerWebsearchTool.execute`.

Harness: `scripts/bench-full-search.mjs` (rotates distinct queries per sample
to avoid the 10-min search cache; shares one `chromeReady` between the Google
and Reddit lanes exactly like the tool).

## Full-tool cold/warm, 3s spacing (2026-08-22)

Usage: `node --experimental-strip-types scripts/bench-full-search.mjs
<legacy|broker> [samples] [spacingMs] [query...]`. Sample 1 is the cold sample
(fresh process / broker spawn); samples 2–n are warm. Queries rotate so no
sample hits the search cache. n=10, spacing 3000ms.

| Metric | Broker | Legacy |
| --- | ---: | ---: |
| cold (sample 1) | 2,904 ms | 2,912 ms |
| warm p50 (samples 2–10) | 2,903 ms | 2,904 ms |
| overall p50 | 2,904 ms | 2,906 ms |
| overall p95 | 2,918 ms | 2,915 ms |
| HTTP success | 10/10 | 10/10 |
| deadline cuts | 10/10 (by design — response-budget return) | 10/10 |

### True settlement times (instrumented run, same day)

`bench-full-search.mjs` now stamps each lane's actual settlement and keeps
listening past the response-budget cut (`actual-settle` per sample, plus an
"actual full-settle" summary line). Same environment, n=10, spacing 3000ms:

| Metric | Broker | Legacy |
| --- | ---: | ---: |
| return latency (budget cut) | p50 2,902 ms / p95 2,914 ms | p50 2,908 ms / p95 2,916 ms |
| actual full-settle | p50 3,083 ms / p95 3,256 ms | p50 3,081 ms / p95 3,390 ms |
| **HTTP lanes actually settle at** | **~0.87–1.34 s** | ~0.90–1.41 s |
| Google lane settles at | ~3.08–3.20 s (fails here — no CDP) | ~3.08–3.39 s (same) |
| Reddit settles at | ~2.90 s (budget miss) | ~2.90 s |

Interpretation: the genuinely useful work (HTTP consensus results) completes
in ≈1s; everything between that and the 2.9s return is spent waiting on CDP
lanes that cannot make the budget in this bench environment. The response
target is doing its job — the tool returns at 2.9s rather than at the ~3.1s
full-settle time of the slowest lane.

### Google lane: daemon state vs SERP latency (2026-08-22 follow-up)

`scripts/probe-google-lane.mjs --kill-first` splits the Google lane into
chromeReady (daemon/browser acquisition) vs the actual SERP fetch:

| Probe | chromeReady | search | total | results |
| --- | ---: | ---: | ---: | ---: |
| run1 (after daemon kill) | 186 ms | 4,328 ms | 4,514 ms | 10 |
| run2–6 (warm daemon) | 155–176 ms | 3,785–5,769 ms | 3,944–5,938 ms | 10 each |

Findings:

- **Daemon state is not the bottleneck** — `chromeReady` is ~170 ms whether
  the broker daemon was killed or already running; browser reuse works.
- **The SERP fetch itself ran 3.8–5.9 s warm**, consistently over the 2.9 s
  lane cap while still returning 10 results.
- A live `aio-websearch` call minutes later agreed: `Google: timeout
  (response budget 2900ms)` where the same morning's live calls returned
  `Google:8` inside the budget, and yesterday's #97 bench recorded Google
  success 10/10 under the cap.
- Conclusion: **same-day progressive throttling** is the best explanation
  (Brave went quota-dead mid-session the same way). The lane cap did its job;
  nothing regressed in the code path. Re-run the probe after a cool-down to
  confirm recovery.

#### Recovery confirmed (~20 min later)

A/B pagination test (`maxResults` 8 vs 10) plus a 6-run spaced stability
probe, all warm daemon:

| Probe | latency | results |
| --- | ---: | ---: |
| max=8 ×2 | 740 / 1,070 ms | 8 each |
| max=10 ×2 | 709 / 1,419 ms | 10 each |
| stability runs 1–6 (2 s spacing) | p50 1,382 ms (1,175–1,403) | 9–10 each |

No pagination penalty at `max=10` (single SERP page satisfied it). The slow
window fully recovered within ~20 minutes with zero code changes — confirming
transient server-side throttling rather than any structural latency. Steady-
state Google lane cost is ≈1.2–1.4 s, comfortably inside the 2.9 s budget.

Environment caveats for this run: Brave was quota-exhausted for the entire
session (`brave=0` in every sample, matching live `rate-limited` statuses), and
the Google lane never settled inside the 2.9s budget in this bench context
(CDP/Chrome unavailable here; in live tool sessions the same day Google settled
every time with a warm browser pool). Latency is pinned at the response budget
by design — the tool returns what settled instead of waiting out slow tails.

## Full-tool: broker with 2.9s response target (#97, 2026-08-21)

The public `aio-websearch` orchestration now returns providers that settle by a
2.9s response target while preserving the 7s hard safety deadline for child/browser
work. In this path HTTP engines use a 2.7s per-engine budget, Google remains
capped under 3s, and Reddit still serializes after Google but is marked as a late
provider timeout if it misses the response target.

Live broker run, zero-spacing burst, n=10, query family
`"pi coding agent post97final 1787328255"`:

| Metric | Broker (#97 response target) |
| --- | ---: |
| p50 total | **2,876 ms** |
| p95 total | **2,906 ms** |
| avg total | **2,731 ms** |
| HTTP success | 10/10 (100%) |
| Google success | 10/10 (100%) |
| Reddit success | 6/10 (60%) |
| Response-budget cuts | 4/10 |
| Processes (before→after) | 578 → 580 |
| Working set (before→after) | 8.51 GB → 8.88 GB |

**Reading:** the full public broker path now meets the warm p50 target for #97
(p50 < 3.0s) while preserving HTTP + Google success. Reddit is opportunistic
within the response target: fast Reddit runs are included, and late Reddit runs
surface as explicit timeouts instead of holding the whole search open.

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
