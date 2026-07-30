# Observability Gaps — pi-webaio

Audit of places where the tools fail, degrade, or behave surprisingly but the
user/agent cannot see **why**, or where diagnostic signal is generated
internally and then discarded.

**Method:** every finding below is grounded in reproduced tool output, a quoted
`file:line`, or a measured count. No source was modified.

**Swallow census (measured):** a brace-matching scan over `index.ts` + `src/**`
found **210** `catch` blocks; of those **72** have comment-only bodies and **0**
are literally empty. A further **20** use the arrow form `.catch(() => {})`.
Most are legitimately best-effort (`handle.close()`, cache flushes). The
findings below are the subset that hide an *actionable* failure cause.

---

## P1 — Batch fetch silently drops a valid URL and mis-attributes the error

**Evidence (reproduced live).** Batch mixing one good and one bad URL:

```
aio-webfetch(urls: ["https://example.com",
                    "https://this-domain-definitely-does-not-exist-xyz123.invalid/page"])

Fetched 0/2 URLs:

Errors:
✗ https://example.com/: [SECURITY] Blocked request to private/internal URL:
  https://this-domain-definitely-does-not-exist-xyz123.invalid/page [blocked_ssrf]
```

Reversed order reproduces the same loss:

```
aio-webfetch(urls: ["...invalid/page", "https://example.com"])

Fetched 0/2 URLs:

Errors:
✗ https://this-domain-definitely-does-not-exist-xyz123.invalid/page: ... [blocked_ssrf]
```

Controls: `aio-webfetch(url: "https://example.com")` alone → `✓ Fetched and
saved ... Title: Example Domain`. `aio-webfetch(urls: [example.com,
iana.org/help/example-domains])` → `Fetched 2/2`, both succeed.

**What the user cannot see:**

- `example.com` is **dropped entirely** — `Fetched 0/2` yet it produces *no
  success line and no error line*. There is no record that a valid URL was lost
  or why.
- In the first ordering the single error line is **attributed to the wrong
  URL**: `✗ https://example.com/:` carries the invalid domain's `blocked_ssrf`
  message. An agent reading this would conclude `example.com` is an internal
  address.

**Root locus:** the batch runs `runInBatches(targets, Math.min(4, targets.length), …)`
(`src/tools/webfetch.ts:819-821`) with concurrency 2 over a **single shared
`wreqSession`** created at `src/tools/webfetch.ts:790-798` and passed into every
concurrent fetch (lines 911 / 1024 / 1063). The `blocked_ssrf` throw from the
bad URL disrupts the in-flight valid fetch on that shared session; the per-URL
`try/catch` (lines 1018-1050) is meant to contain each URL's error, but the
valid URL's result is lost before it can be recorded as either ok or error.
The render loop itself is per-result-correct (`✗ ${r.url}: ${r.error}`,
`src/tools/webfetch.ts:1726-1737`), so the contamination happens upstream of
rendering, in the shared-session fetch path.

**Why it matters:** this is the exact silent-loss class the SSRF-abort fix
(comment at `src/tools/webfetch.ts:1030-1032`) targeted, surviving in a new
form. A batch is only as trustworthy as its worst URL; today one bad URL can
erase a good one with zero explanation.

**Fix:** (a) give each concurrent fetch its own session (or isolate the SSRF
validation so a throw cannot poison a sibling's socket); (b) as a defensive
backstop, after `runInBatches` assert `results.length === targets.length` and
for any `undefined`/missing slot synthesize an explicit error result
(`✗ <url>: no result recorded (internal error)`) so the count can never lie;
(c) never render an error whose `r.error` references a different URL than
`r.url`. **Effort: M.**

---

## P2 — Non-Google search-engine failures are invisible (failed == empty)

**Evidence.** `multiSearch` returns only counts, no per-engine status
(`src/search.ts:838-844`):

```ts
return { results: merged, ddgCount: counts.ddg, braveCount: counts.brave,
         yahooCount: counts.yahoo, bingCount: counts.bing };
```

When an engine returns HTTP ≥ 400, hits a quota, or parses 0 results, the code
records a cooldown/failure **internally** and `continue`s
(`src/search.ts:801-818`) — the caller only ever sees a count of `0`. The TUI
then renders an engine label **only when the count is truthy**
(`src/tools/websearch.ts:234-237` and `313-318`):

```ts
if (httpCounts.ddg)   engineLabel.push(`DDG:${httpCounts.ddg}`);
if (httpCounts.brave) engineLabel.push(`Brave:${httpCounts.brave}`);
...
```

So a label like `DDG:10+Brave:8` is shown, and Yahoo/Bing simply vanish.

**What the user cannot see:** whether Yahoo returned 0 results *legitimately*
or is *down / rate-limited / cooled down*. Google alone gets explicit treatment
via `googleStatus` (`src/tools/websearch.ts:94-159`, surfaced at 258-263,
e.g. `_(Google: requested but returned nothing — error (…))_`). The other four
engines have no equivalent — a confirmed asymmetry.

**Why it matters:** an agent that sees only `DDG:10` may trust a thin result set
without knowing three engines were unavailable. Quota/rate-limit state
(`isQuotaError`, `src/search.ts:117-125`) is computed and then thrown away.

**Fix:** return a per-engine status map from `multiSearch`
(`{ ddg: {count, status: "ok"|"empty"|"http_429"|"cooled_down"|"error", latencyMs} }`)
and render a compact note for any non-`ok` engine, mirroring `googleStatus`
(e.g. `_(Brave: cooled down after recent failures)_`). **Effort: S.**

---

## P3 — `diagnose:backends` never probes wreq-js, the primary fetch layer

**Evidence (ran it):**

```
$ npm run diagnose:backends
  ✓ GitHub CLI (gh)        authenticated as @apmantza
  ✓ Playwright             importable, chromium installed
  ✓ Headless Chrome (CDP)  binary at .../chrome.exe; CDP assets present
  ⊘ Search engines         network probe disabled
  ⊘ Jina reader proxy      network probe disabled
Summary: 3 available, 0 missing, 0 degraded, 2 skipped
```

`grep -niE "wreq|dns|proxy|tmpdir|temp|storage|MCP|sdk" scripts/diagnose-backends.mjs`
returns **no** probe definitions for any of those (only a hint string mentioning
"proxy" at line 393).

**What the user cannot see:** `wreq-js` is layer 1 of the fetch stack (every
`aio-webfetch` depends on it — `src/fetch.ts` imports `wreqFetch`/`createSession`),
yet the doctor never imports or exercises it. It also does not check DNS
resolution, proxy reachability, temp-dir/storage writability (where every
result is persisted), or the MCP SDK. A broken `wreq-js` install reports
**all-green** (`3 available, 0 missing`), giving false confidence. The two
network probes are off by default, so a default run says nothing about actual
reachability either.

**Fix:** add an offline `wreq-js` probe (dynamic import + construct a session,
no network needed) and a temp-dir write probe; add a DNS-resolution check and
proxy-env validation to the `--live` path. **Effort: S.**

---

## P4 — Browser-launch failures and timing are swallowed

**Evidence.**

- Replacement browser launch is fully silenced:
  `this.launchBrowser().catch(() => {});` (`src/browser-pool.ts:282`). If the
  pool cannot relaunch, later `acquire()` calls hang/fail with **no record** of
  the launch error.
- Channel-launch failure reason is discarded before fallback
  (`src/browser-pool.ts:194-203`): the first `chromium.launch(launchOpts)`
  `catch (err)` deletes `channel` and retries; `err` is never logged, so if the
  bundled browser also fails the user sees the second error with no trace of the
  first (e.g. "channel 'chrome' not found").
- No launch timing anywhere: `_launchBrowser` (`src/browser-pool.ts:186-215`)
  has no `Date.now()`/log; a slow 2-3 s launch (called out in the file header,
  line 4) is invisible. `fetch.ts:477` has a single `console.warn` on the
  per-request path but the pooled path logs nothing.

**What the user cannot see:** why a `mode: browser`/`auto` fetch is slow or why
it eventually fails when the pool is exhausted; whether the Chrome channel or
the bundled browser was used; that a pre-warm/replace launch silently failed.

**Fix:** log launch start/finish + chosen channel under `PI_WEBAIO_DEBUG`;
surface replacement-launch failures into pool state so `acquire()` can report
"pool degraded: last launch failed (<reason>)" instead of hanging. **Effort: M.**

---

## P5 — Per-engine search latency is measured but never surfaced

**Evidence.** `latencyMs` is computed for every engine
(`src/search.ts:784, 791`) and persisted into health records
(`record.lastLatencyMs`, `record.totalLatencyMs`, `src/search.ts:50-51`), but
the `multiSearch` return shape (P2) omits it and no tool renders it. The 7-second
search cap means a slow engine dominates wall time, yet the result shows only
counts.

**What the user cannot see:** which engine was slow / hit the cap; whether a
missing engine timed out at 7 s vs returned fast-and-empty.

**Fix:** include `latencyMs` in the per-engine status map from P2 and render it
(`Brave:8 (1.2s)`); flag engines that hit the cap. **Effort: S** (folds into P2).

---

## P6 — User-defined vertical extractor load errors are silenced

**Evidence.** `initUserExtractors().catch(() => {});` (`index.ts:20`) and the
matcher swallows `// ignore matcher errors during attribution`
(`src/verticals/registry.ts:101`). A user extractor that throws on load
(bad path, syntax error) is dropped with no message.

**What the user cannot see:** that their custom vertical (a documented feature,
`docs/custom-verticals.md`) failed to register — their URL silently falls
through to the generic pipeline and they assume the extractor is working.

**Fix:** `console.warn` a one-line load failure per bad file (this is a
user-actionable config error, not a best-effort background task). **Effort: S.**

---

## P7 — Bot-block fallback detail discarded; generic message on total failure

**Evidence.** In the alternate-profile loop, each failed profile is swallowed:
`} catch { /* swallow — try next profile */ }` (`src/fetch.ts:1102`). When all
three fallback browsers **and** Playwright fail, `smartFetch` returns `null`
(`src/fetch.ts:1128`) and the caller produces a generic bot-block error — none
of the per-profile statuses/HTTP codes are retained. Related best-effort
swallows at `src/fetch.ts:469` (`/* try next launch option */`) and
`src/content.ts:243,392,876` (`/* ignore */`) similarly drop extraction-fallback
causes.

**What the user cannot see:** whether the block was a 403 on every profile, a
timeout, or a challenge page — so they cannot judge whether `bypass: true` or a
different `browser` profile would help.

**Fix:** accumulate `{profile, status|error}` per attempt and, on total failure,
append a compact ladder summary to the FetchError detail (e.g.
`tried plain+firefox+safari+edge+playwright; all blocked (403)`). **Effort: M.**

---

## P8 — `PI_WEBAIO_DEBUG` gates almost nothing; key decisions are unlogged

**Evidence.** `grep PI_WEBAIO_DEBUG src/` finds it in only two files:
`src/content.ts` (5 sites, RSC/extraction traces) and `src/paywall.ts` (2 sites,
bypass attempts). Nothing else is gated. Notably unlogged everywhere:
search-engine cooldown transitions (`recordProviderCooldown`,
`src/search.ts:83`), strategy-memory rung selection/re-probe
(`src/strategy-memory.ts`), session-cache hits/misses, and the batch
shared-session lifecycle (P1).

**What the user cannot see:** a coherent debug trail for the two most common
complaints — "why was this engine missing?" and "why did this fetch take the
browser path?". Today those decisions leave no trace even with debug on.

**Fix:** route cooldown, strategy-memory, and cache-hit events through a single
`debug()` helper gated on `PI_WEBAIO_DEBUG`; document the flag's full coverage
in `docs/usage.md`. **Effort: M.**

---

## Minor / noted, lower priority

- **Single-fetch error view is actually decent** — `buildUserFacingFetchErrorSummary`
  already surfaces elapsed-for-timeout and partial-download %
  (`src/tools/fetch-error.ts:444-450`), and the TUI shows phase/category badges
  - retry hint (`src/tools/render-result.ts:682-692`). Not a gap; listed so it
  isn't "fixed" redundantly. The one omission: when a `userErrorSummary` exists
  the raw `errorText` is suppressed in the collapsed TUI view
  (`src/tools/render-result.ts:675-677`) — full detail only lives in the agent
  text, so a TUI-only reader loses the underlying message.
- **Pre-flight secret block is a good counter-example** — a single bad URL
  yields a clear `phase=validation code=blocked_ssrf category=validation
  retryable=false` line (reproduced live). The batch path (P1) is where that
  clarity is lost.
