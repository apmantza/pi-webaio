# Google CDP speed and concurrent-session plan

Status: proposed; design and measurement only. No implementation is implied by this document.

## Problem

`aio-websearch` can be called by several Pi sessions at once. A single shared Google tab would race: one request can navigate or replace the query while another is typing, waiting for results, or extracting the page. The current implementation avoids that specific race by creating a fresh target, but pays for repeated setup.

The current path is layered:

1. `bin/launch.mjs` keeps one dedicated Chrome process alive.
2. `src/google-ai.ts` starts a Google extractor child process.
3. `extractors/common.mjs` starts a new `bin/cdp.mjs` child for almost every CDP command.
4. `bin/cdp.mjs` starts or contacts a per-tab daemon.
5. `extractors/google-search.mjs` creates a fresh tab, navigates to Google, waits, extracts, and closes it.

The existing per-tab daemon is therefore not yet a shared broker: the tab and daemon normally disappear at the end of each search, and the command-line process is recreated for each operation.

## Decision

Use **one shared Chrome process with session-scoped tab leases**, coordinated by a broker that is safe across separate Pi processes.

Do not launch one Chrome process per Pi session. That would reintroduce cold-start cost, profile locking, port conflicts, and excess resource use.

```text
shared dedicated Chrome
├── Pi session A → Google Search tab
├── Pi session B → Google Search tab
├── Pi session C → Google Search tab
└── optional provider tabs (Google AI / Reddit)
```

A single in-process tab manager is insufficient: concurrent Pi sessions may be separate Node processes. Cross-process ownership requires an out-of-process broker or an equivalent OS-level lock/registry.

## Proposed architecture

### Broker

Add a long-lived, fail-soft CDP broker (initially likely `bin/google-cdp-broker.mjs` plus a TypeScript client). In the final ownership model, the broker is the **sole owner and supervisor of the dedicated Chrome process** for its profile. It should:

- use an atomic per-profile startup lock and owner nonce;
- validate PID, profile, port, `/json/version`, and `Browser.getVersion` before adopting an existing Chrome;
- apply an explicit headless/visible mode policy rather than allowing concurrent clients to kill or relaunch a healthy instance;
- own one browser-level CDP WebSocket per dedicated Chrome profile;
- maintain `sessionId + provider → targetId` mappings;
- attach to targets once and multiplex CDP commands by request ID/session ID;
- serialize work per leased tab while allowing different sessions to run concurrently;
- keep Google Search, Google AI, and Reddit on separate provider lanes when they can overlap;
- use framed JSON IPC over a Windows named pipe and Unix domain socket elsewhere;
- use startup race resolution, a heartbeat, a bounded idle exit, and broker restart detection;
- use a bounded, fair queue with global and per-provider tab/concurrency caps;
- forward one absolute request deadline and cancellation state, and ignore late results after cancellation or timeout.

The broker should replace the repeated `extractors/common.mjs → spawn(bin/cdp.mjs)` path rather than sit on top of it. The existing `bin/cdp.mjs` daemon can remain as a compatibility path during rollout, but production Google calls must have one owner for each target.

### Session identity and leases

A lease must use a stable client/session identity, not a tool-call ID, cwd, or query string. The current `websearch.ts` path does not pass a Pi session ID, so this must be designed rather than assumed.

- Prefer a Pi-provided session ID if the extension API exposes one.
- Otherwise register each broker client with a random process-start/session nonce and owning process ID; use request UUIDs separately.
- Heartbeat active leases from the extension client.
- Treat client disconnect as cancellation, mark its tab dirty, and reap it after a bounded TTL.
- Reap leases when the client disappears or the TTL expires.
- Recreate a target after browser restart; never trust a stale target ID.
- A same-session concurrent request queues behind the tab mutex or fails within the search deadline.
- Different sessions receive different targets and must not mutate each other's pages.

The tab is session-scoped, but Chrome profile cookies/storage remain shared initially. This prevents tab races, not account or personalization leakage: cookies, consent, locale, local storage, CAPTCHA state, and Google history may affect another session. Document this as an intentional limitation and do not describe F22 as full session isolation. Full cookie/storage isolation would require separate browser contexts or processes and is a later security/privacy decision, not a first performance optimization.

### Request lifecycle

A request should look conceptually like:

```json
{
  "id": "request-uuid",
  "sessionId": "pi-session-id",
  "provider": "google-search",
  "operation": "search",
  "query": "...",
  "deadlineAt": 0
}
```

The broker should:

1. validate the provider and deadline;
2. atomically acquire the session/provider tab lease;
3. verify the broker browser generation, full target ID, owner token, and target origin; never use a prefix or the current `PAGES_CACHE` as authority;
4. navigate directly to a canonical Google search URL where possible;
5. wait in-page for result selectors rather than polling through repeated CLI processes;
6. extract results in the same CDP connection;
7. release the lease while keeping the tab warm;
8. mark the tab dirty after timeout, navigation error, verification, or protocol loss.

A dirty tab must be reset or replaced before reuse. `websearch.ts` must pass an absolute deadline and abort/cancellation signal into the provider; the broker must cancel or quarantine the operation, close/recreate the target when necessary, and only then return the lease. Late responses from an old request must be fenced by request ID, target generation, and operation state; fencing must prevent side effects, not merely hide a late result.

## Performance priorities

Implement and measure in this order:

1. Add phase timings for Chrome readiness, broker/child startup, target allocation, navigation, consent, result readiness, extraction, and teardown.
2. Keep Chrome warm and avoid invoking the launcher probe on every request when a healthy broker owns the profile.
3. Reuse session-scoped Google tabs with an async mutex and TTL.
4. Navigate directly to search URLs instead of opening Google home, typing, and submitting when the page permits it.
5. Replace per-command CDP child processes with one broker-owned connection.
6. Only then evaluate a broader worker-process browser pool for Playwright and other browser work.

The broker cannot remove Google network/navigation or hydration time. It mainly removes cold startup, tab setup, repeated Node process startup, and cross-session races. Since HTTP engines already run concurrently with Google in `websearch.ts`, the first implementation should target Google Search only; Google AI, Reddit, and a general Playwright worker are separate follow-ups. Measure completion-before-deadline and phase p50/p95, not process latency alone.

## Failure and Pi-safety requirements

- Every broker request must resolve or reject exactly once.
- Socket close must reject all pending requests; no orphaned promises or unhandled rejections.
- Child-process `error`, `close`, timeout, and kill paths must be idempotent.
- A broker failure must become a normal provider error/status, never an extension-level uncaught exception.
- The 7-second `aio-websearch` deadline remains authoritative; broker work may continue only if it is safely detached and cannot mutate a later request.
- IPC logs must stay off stdout and be bounded/redacted.
- On Windows, named pipes are not enumerable or safely unlinkable like Unix sockets: use connect-probe/readiness, bounded newline framing, frame-size limits, backpressure, half-close handling, and pipe ACL/capability authentication.
- The broker must not expose unrestricted CDP commands to arbitrary local clients; use a narrow internal protocol or authenticated local IPC.
- A failed Google lane must not kill Reddit, HTTP engines, or the Pi process.

## Testing plan

Offline tests should cover:

- two simulated Pi clients acquiring different session tabs concurrently;
- same-session serialization and cancellation;
- broker startup races and stale socket/pipe cleanup;
- heartbeat expiry and orphan-tab cleanup;
- Chrome restart and stale target regeneration;
- timeout fencing so a late response cannot affect the next request;
- pending-request rejection on WebSocket/IPC close;
- Google, Google AI, and Reddit lane separation;
- Windows named-pipe and Unix-socket framing using fake transports.

A local benchmark should compare cold/warm runs at one, two, and four concurrent Pi sessions, reporting p50/p95 for total time, completion-before-deadline, and each phase. It must include launcher/startup races, same-session overlap, different-session overlap, broker restart, and tab cleanup. Do not claim a speedup until this benchmark shows where the time is actually spent.

## Rollout

1. Ship instrumentation and a compatibility-safe broker behind an environment flag.
2. Use the broker for Google Search only; leave Google AI/Reddit on existing paths initially.
3. Enable session-scoped warm tabs after race and cleanup tests pass.
4. Migrate Google AI and Reddit into separate broker lanes.
5. Retain the old path as a bounded fallback for one release, with explicit provider status.
6. Remove the fallback only after concurrent-session and Pi-crash tests are green.

## Relationship to the roadmap

This is F22, a dedicated Google-CDP performance/concurrency item. F10 remains the general worker-process/browser crash-isolation item; F22 does not complete F10. F3 remains the cookie/profile/session-state item; session-scoped tabs do not provide F3-level storage isolation. The first target is Google CDP time-to-answer and cross-session race safety.

## Live measurement log

### 2026-08-05 — warm legacy vs broker Google search (INVALIDATED)

Command: `node scripts/bench-google-cdp.mjs --live --query "pi coding agent" --samples 3` (Windows, Chrome already running via the shared profile).

| Lane | n | completed | p50 | p95 |
| --- | --- | --- | --- | --- |
| legacy-first/warm | 3 | 3 | 6407.8 ms | 6813.4 ms |
| broker-first/warm | 3 | 3 | 5888.6 ms | 5958.8 ms |

**Invalidated**: the broker lane never ran broker code in this sample. Two
protocol bugs (missing `provider` field in the client search frame; a broken
`brokerPaths` seam in `ensureGoogleBroker`) made every broker search fail and
silently fall back to legacy — both lanes measured the legacy path. Fixed in
commit 30ab13d; see the corrected entries below.

### 2026-08-06 — corrected warm + cold legacy vs broker Google search

Machine: Windows, dedicated greedysearch Chrome profile, live Google, query
"pi coding agent". Harness: `scripts/bench-google-cdp.mjs` with `--cold`
(graceful `Browser.close` before each sample) and phase timings derived from
the broker envelope (`timings`: targetSetupMs, navigationMs, extractionMs,
resetMs). Cold lanes ran as separate invocations so each lane starts from a
killed Chrome.

| Lane | n | completed | p50 | p95 |
| --- | --- | --- | --- | --- |
| legacy-first/warm | 3 | 3 | 5617.3 ms | 6325.5 ms |
| broker-first/warm | 3 | 3 | 659.1 ms | 1009.7 ms |
| legacy-first/cold | 2 | 2 | 6475.8 ms | 11936.4 ms |
| broker-first/cold | 2 | 2 | 1061.0 ms | 1133.8 ms |

Broker warm phase breakdown (representative sample): targetSetup ~30 ms,
navigation ~116 ms, extraction ~163-328 ms, reset ~22-35 ms.

Known limitations (stated, not waived):

- Order effect: in the warm run the legacy lane ran first; the broker lane
  benefited from a fully warm Chrome/profile. The cold lanes control for
  startup and still show a large gap.
- n=3 warm / n=2 cold are bounded samples justified by live-Google politeness,
  not statistical estimates.
- broker-ipc phase is still not instrumented (total minus broker phases
  includes IPC + queueing + client overhead).
- Single machine; cold-start cost varies with disk cache and system load.

Interpretation: with the protocol bugs fixed, the broker path completes warm
Google searches in ~0.7 s p50 versus ~5.6 s legacy (~8x on this run), and
cold samples in ~1.1 s versus ~6.5 s (~6x). The gap is dominated by the
legacy path creating a fresh tab with stealth injection and waiting for full
page load + interactive submission, while the broker reuses session-scoped
warm targets. This is a measured difference on one machine under the stated
confounds — reproducible via the harness, not a universal claim.

### 2026-08-06 — issue #94 legacy wait experiment

Query: `pi coding agent`; Windows; live Google; dedicated Chrome profile; direct
legacy extractor invocations. Baseline used commit `6915125` (original waits);
the optimized variant is the current uncommitted condition-driven experiment.
Each variant completed 10/10 searches with positive result counts.

| Variant | n | completed | positive results | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline waits | 10 | 10 | 10 | 5161 ms | 5331 ms |
| condition-driven waits | 10 | 10 | 10 | 3631 ms | 4081 ms |

The final optimized runs returned 6–7 results on every sample. A separate
instrumented baseline sample (n=3, before wait replacement) measured the fixed phases as:
`postNavWait` 1206–1211 ms, `postTypeWait` 302–308 ms, with `resultsLoad`
1050–1218 ms. Representative optimized phase output was setup 1076–2192 ms,
homepageLoad 521–1023 ms, inputWait 120–294 ms, typing 249–423 ms,
resultsLoad 314–694 ms, and extraction 250–607 ms. Setup includes the existing
CDP/tab setup and is not a wait-removal target.

The first optimized attempt after strict submission validation was invalidated
at 0/10: awaiting delayed form submission crossed a destroyed Chrome execution
context. The implementation was corrected by scheduling native submit and
requiring the post-submit URL; the table reports only the corrected 10/10 run.

Interpretation: the final condition-driven variant reduced p50 wall time by
~1530 ms (~30%) in this bounded sample, with no observed success/result-count
regression. This is not a universal performance claim: n=10, one machine/query, changing
Google/Chrome state, and p95 remains sensitive to startup/renderer variance.
The fixed `submitSearch` 100 ms in-page delay was intentionally left unchanged;
stealth ordering and the default Google path remain otherwise unchanged.
