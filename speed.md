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
browser infrastructure (Chrome already launched). n=10, rotated query set
"pi coding agent ..." (extension API / tool registration / skills / etc.).

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

**Reading:**

- The broker's p50 is comparable (4,538 vs 4,561 ms) — HTTP engines dominate
  total latency in both modes; the Google lane is a fraction of it.
- The broker's **p95 is far tighter** (4,571 vs 7,014 ms): legacy occasionally
  spawns a fresh CDP CLI per call that lands near the 7s ceiling; the broker
  reuses a warm Chrome, so it never approaches the deadline.
- The broker **never dropped a Google search** (100% vs 80% legacy) in this
  sample — the legacy miss was a search that hit the deadline ceiling.
- Both modes show no persistent process/working-set growth after cleanup
  (deltas are the transient Chrome/daemon processes during the run).

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
- Sample sizes are small (n=10) per stable variant; treat as indicative, not
  conclusive, per issue #97's acceptance criteria.
