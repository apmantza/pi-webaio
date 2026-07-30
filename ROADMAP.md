# pi-webaio Roadmap

Consolidated plan of bugfixes + new features.

**Sources:** an 8-tool smoke test (bugfixes) and a 6-repo inspiration survey
(henyo-pi-web, demigodmode/pi-web-agent, BetterWright, xaccefy/pi-webxp,
Lincoln504/pi-research, sfiorini/pi-stef). Decision: **no new skills**.

Effort: **S** ≤ half-day, **M** ~1–2 days, **L** multi-day.

## v0.7.3 bugfix batch — status

> **Shipped as 0.7.3** (released 2026-07-29). The batch was originally labelled
> v0.6.3 below; it landed as 0.7.3.

| ID | Status | Notes |
| -- | ------ | ----- |
| B1 | ✅ Investigated — no code defect | Current source already writes vertical results to the URL-keyed session cache (`storeContent` runs on both the disk and non-disk markdown branches of `webfetch.ts`). The original observation was a stale `dist`. `storeContent` is in-memory (session) while `storeResult` is disk-persistent (24h) — an inherent asymmetry, not a bug. |
| B2 | ✅ Fixed + tested | `src/verticals/wikipedia.ts`; offline test in `tests/unit.test.mjs`. |
| B3 | ✅ Fixed + tested | Per-source guard in `src/tools/webresearch.ts`; `classifyReachability` tests in `tests/webresearch.test.mjs`. Root trigger (GitLab over-match) logged separately as B6. |
| B4 | ✅ Fixed | `googleStatus` surfaced in `src/tools/websearch.ts`. |
| B5 | ✅ Fixed + tested | `resolveCorpusDir` in `src/tools/webquery.ts`; test in `tests/webquery.test.mjs` (now wired into `test:all`). |
| H3 | ✅ Audited — clean | No enum-of-literals unions exist; existing unions are legitimate string/record + boolean/number. No change needed. |
| F7 | ✅ Done + tested | Omitted-sections TOC in `src/prune-markdown.ts`. |
| B6 | ✅ Fixed + tested | GitLab host gating (`isKnownGitLabHost` + `WEBAIO_GITLAB_HOSTS` env) on repo-root URLs in `src/verticals/gitlab.ts`, plus a soft-fail try/catch in `extractGitLab` so a mis-routed host falls through to the HTML pipeline. Tests in `tests/unit.test.mjs`. |
| B7 | ✅ Investigated — non-bug | Alleged "summary-cache collision" is a misdiagnosis: Wikipedia (a vertical) skips AI summarization entirely (`"> via "` prefix → `skipSummary`), the summary cache is keyed per-URL (no collision), and the display always uses the current result's own body. The only real bias is by-design search-context injection into *fresh* summaries (never a vertical). No change. |
| B8 | ✅ Fixed + tested | `formatPullHeadline` in `src/tools/webpull.ts` distinguishes "0 new pages (N already completed — pass resume:false)" from a genuine zero-result pull. Tests in `tests/unit.test.mjs`. |

Verification: `npm run lint` clean; full `test:all` = 931 tests, 0 failures (2 expected skips); `dist/` rebuilt.

### Also in this batch (dependencies / security / hygiene)

- **Removed `sharp`** — declared but never imported (zero usages repo-wide); dropping it clears a high-severity libvips advisory and a heavy native binary.
- **Bumped `@modelcontextprotocol/sdk` → ^1.30.0** and pinned **`@hono/node-server` ^2.0.5** via `overrides` (clears the moderate Windows path-traversal advisory).
- **Bumped `brace-expansion` override → ^5.0.8** (clears the high DoS advisory at the top level; the copy nested under the `@earendil-works/pi-coding-agent` **peer** cannot be governed by our overrides — accepted as an upstream/transitive-peer advisory).
- **Bumped peer `@earendil-works/pi-coding-agent` and dep `@earendil-works/pi-tui` → ^0.82.0** — the old `^0.79.0` (caret on `0.x` = `<0.80.0`) excluded the running pi (0.82.1).
- **Added `.github/dependabot.yml`** — weekly scheduled npm + github-actions version updates (security-update PRs already existed but were unmerged; this adds proactive cadence).
- **`lens_diagnostics` triage** — 42 blocking findings triaged via `lens_diagnostic_mark` (security false-positives confirmed, path-traversal flagged for the H1 pass, sonarcloud case-declarations confirmed already-braced).

---

## Track A — Bugfixes (from the tool check)

| ID   | Defect                                                                                                                                          | Fix                                                                                  | File(s)                                            | Effort |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- | ------ |
| B1   | `aio-webcontent` returns "no content" for vertical-extractor fetches (Wikipedia/npm/PyPI) while `aio-webresult` works — vertical path skips the URL-keyed cache | Write vertical results to the session store, same as the normal pipeline             | `src/content.ts`, `src/session-store.ts`, `src/tools/webfetch.ts` | S      |
| B2   | Wikipedia vertical renders `## Content → [object Object]`                                                                                       | Serialize the content object instead of template-interpolating it                    | `src/verticals/wikipedia.ts`                       | S      |
| B3   | `aio-webresearch` hard-aborts the whole run when one ranked source times out                                                                     | Catch per-source fetch failures, reclassify as `dead`, continue                      | research orchestration                             | S/M    |
| B4   | `aio-websearch` with `google:true` silently returns zero Google results — no error surfaced                                                      | Report per-engine status/timeout in the result (source badges)                       | `src/tools/websearch.ts`, `src/google-ai.ts`       | S      |
| B5   | `aio-webquery` `dir` footgun: default omits the hostname segment; relative paths resolve to cwd, not the temp base (docs say otherwise)           | Default to `<temp>/<hostname>` as documented; resolve relative dirs against the temp base; error shows the resolved path | `src/tools/webquery`                     | S      |
| B6   | GitLab vertical matcher is over-greedy: `parseGitLabUrl` matches ANY two-segment path, so `https://handwiki.org/wiki/Okapi_BM25` is mis-routed to the GitLab API (`handwiki.org/api/v4/projects/...`) and times out. Affects `aio-webfetch` generally (it was the trigger for B3) | Tighten matching (require a known GitLab host or a successful API probe) without breaking self-hosted GitLab detection | `src/verticals/gitlab.ts`, `src/verticals/registry.ts` | M      |
| B7   | Alleged "summary-cache collision": a second Wikipedia fetch reportedly showed the first fetch's AI-summary topic | **Non-bug** — Wikipedia verticals skip AI summarization (`"> via "` prefix), summary cache is keyed per-URL, display uses the current body; only real bias is by-design search-context injection into fresh summaries | `src/tools/webfetch.ts`, `src/session-store.ts` | —      |
| B8   | `aio-webpull` of an already-pulled site prints "Pulled 0 pages" silently (resume defaults on; prior queue fully completed → 0 new) | `formatPullHeadline` reports "0 new pages (N already completed — pass resume:false to re-pull)" | `src/tools/webpull.ts` | S      |

## Track B — Security hardening

| ID  | Item                                  | Detail                                                                                                                            | File(s)                                  | Effort |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| H1  | ✅ SSRF: DNS-pinning + fail-closed + metadata floor | `createPinnedLookup()` pins the *validated* IP into the request (closes re-resolve TOCTOU); deny on any guard exception; un-overridable cloud-metadata floor | `src/security.ts`, `src/fetch.ts` | M      |
| H2  | ✅ Secret redaction in output/errors     | Complement the existing block-on-secret scanner: strip `api_key`/`token`/jwt/credentials from returned text and error messages     | new `src/redact.ts` + `fetch-error.ts`/`render-result.ts` | S/M    |
| H3  | Typebox schema audit                  | Use `Type.String({enum})` not `Type.Union(Type.Literal…)` (some providers drop `anyOf/const`)                                      | tool schemas in `src/tools/*`            | S      |

### Security cross-checks from inspiration survey #8 (done — 2026-07-29)

Surfaced by `docs/inspirations8.md`; completed 2026-07-29 (36 new tests in `tests/security-crosscheck.test.mjs`). Additive hardening only — the
fail-closed guard and non-overridable metadata floor must be preserved.

| ID  | Item                                          | Detail                                                                                                                                                          | Status        |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| H4  | Redirect re-validation on every hop           | Re-run each redirect `Location` through the SSRF validator (max 5 hops) so a public URL can't 302 into a private/metadata address; confirm the wreq-js + Playwright ladder does this *(zeldrisho/pi-web-fetch)*. **Outcome:** Playwright fallback fixed (`installSsrfRedirectGuard` `page.route` + sync `fastSsrfBlock` aborts dangerous navigations/redirects/subresources); wreq-js is an opaque native binding with no redirect hook, so its hops stay unvalidated (initial dial still protected by the fail-closed pre-flight check + metadata floor) — documented limitation in `fetch.ts` | partial ✅ |
| H5  | IPv6 blocked-range coverage                   | Cross-check/add NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), discard (`100::/64`), benchmarking (`198.18.0.0/15`), IPv4-mapped (`::ffff:0:0/96`) *(zeldrisho/pi-web-fetch)*. **Outcome:** all added — NAT64 + `198.18.0.0/15` allow-listable; RFC 6666 `100::/64` discard-only in a new NON-overridable `isNeverPublicFloorIp()` (checked before the allow-list + filtered in `createPinnedLookup`); hex IPv4-mapped (`::ffff:7f00:1`) + hex-spelled mapped metadata (`::ffff:a9fe:a9fe`) now caught | fixed ✅ |
| H6  | Dangerous-port blocklist                      | Block service ports (22/25/3306/5432/6379/11211/27017/9200) even on otherwise-allowed hosts, compatible with `WEBAIO_SSRF_ALLOW_RANGES` *(sebaxzero/pi-safe-search)*. **Outcome:** `DANGEROUS_PORTS` (24 ports) + `isDangerousPort()` threaded through `validateUrlForSsrf` + `fastSsrfBlock`; a dangerous port is blocked unless EVERY resolved IP was explicitly allow-listed (an opted-in internal DB range keeps access); mixed answer sets fail closed; web ports (80/443/8080) unaffected | fixed ✅ |
| H7  | MCP-path sanitization (homoglyph/base64/hook) | NFKC + Cyrillic/Greek homoglyph folding, zero-width strip, base64-blob redaction, and re-sanitize at the `tool_result` hook boundary (esp. the MCP server path) *(sebaxzero/pi-safe-search)*. **Outcome:** `normalizeForInjection()` (NFKC + zero-width strip + Cyrillic/Greek homoglyph fold) before injection pattern matching; entropy-guarded long-base64-blob masking in `redact.ts` (skips hex digests/data-URIs/short tokens, idempotent); MCP `CallTool` error path now wraps messages in `redactSecrets()` (parity with the pi TUI path). A host `tool_result` hook re-sanitize was NOT added — pi-webaio sanitizes inside the tool, not at a host hook | fixed ✅ |

## Track C — New features

### Tier 1 — v0.7 centerpiece (convergent signal from multiple repos)

| ID  | Feature                                   | Detail                                                                                                                                                  | Effort |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F1  | **Iterative cited-report research loop**  | Bounded coordinator/evaluator: `answer / answer-with-caveat / search-again / headless-escalate` under a fixed budget; synthesizes CLAIMS.md instead of leaving it to the agent *(pi-web-agent + pi-research)* | L      |
| F2  | **Source trust-tier + evidence-quality grading** ✅ | `classifySourceProfile()` (official-docs/api/issue/forum/community) + caveat reasons (`community-only`, `low-diversity`, `bot-check`, `possible-conflict`); feeds F1 + source selection *(pi-web-agent, henyo)* | M      |
| F3  | **Stateful fetching**                     | Per-host cookie jar (auto-store/inject `Set-Cookie`, clear on session end) and/or persistent named login profiles; strengthens the paywall `cookies` strategy *(pi-webxp, pi-stef, BetterWright)* | M/L    |
| F4  | **Backend `doctor`**                      | `npm run diagnose:backends` probing search engines / `gh auth` / Playwright with 3s timeouts *(pi-web-agent, BetterWright)*                              | S/M    |

### Tier 2 — quick wins (reuse shipped code)

| ID  | Feature                                    | Detail                                                                              | Effort |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------- | ------ |
| F5  | BM25-rank + domain-diversify search results | Reuse `src/bm25.ts` in `aio-websearch`; cap per-domain *(henyo)*                    | S/M    |
| F6  | Content-hash dedup + diff-mode             | SHA-256 skip-unchanged for cache/pull-resume; `aio-webcontent` diff vs cached *(pi-research, BetterWright)* | M      |
| F7  | "Omitted sections" TOC on truncation       | `prune-markdown.ts` appends residual headings, not just a count *(henyo)*           | S      |
| F8  | Local-knowledge pre-check before live fetch | Query pulled corpora via `aio-webquery` before `aio-webfetch` *(pi-research)*       | S/M    |
| F9  | Context7 + DeepWiki verticals              | Library-docs + repo-Q&A extractors *(pi-webxp)*                                     | M      |

### Tier 3 — strategic backlog

| ID  | Feature                             | Detail                                                                                       | Effort |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| F10 | Worker-process browser-pool isolation | Crash-isolate each browser in a child worker *(pi-research)* — `src/browser-pool.ts`        | M/L    |
| F11 | Config layering                     | defaults → global → project → env → runtime (currently env-only) *(pi-web-agent, pi-stef)*   | M      |
| F12 | Coherent-fingerprint refinement     | Prefer native coherence over injected JS getters in `applyStealth()` *(BetterWright)*        | M      |
| F13 | Interactive browser-flow tool       | `goto/click/type/extract` automation *(pi-stef, BetterWright)* — likely out of scope         | L      |
| F14 | Video / frame understanding         | Video Q&A for YouTube URLs + local files. **Reference verified (survey #8b — diegopetrucci/pi-web-access):** Q&A rides Gemini's native whole-video ingestion (pass the YouTube URL straight to Gemini; local files via resumable Gemini Files-API upload, poll until ACTIVE), with ffmpeg/yt-dlp frame *export* (≤12 JPEGs as base64) as a separate additive feature — NOT frame-sampled VLM Q&A; model gemini-3-flash-preview, 50 MB cap *(pi-web-access)* | L      |

### New items from inspiration survey #8 (`docs/inspirations8.md`)

| ID  | Feature                                        | Detail                                                                                                                                                          | Effort |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F15 | Keyless hosted-MCP search/Q&A fallback         | Speak minimal MCP (SSE) to hosted endpoints (`mcp.exa.ai`, `mcp.deepwiki.com`) for zero-key search; lowers install friction; fragile but well-fallbacked *(ByteTrue/pi-web-search `exa-free.ts`, heyhuynhgiabuu/pi-search `deepwiki.ts`)* | S/M    |
| F16 | Fuzzy `findText` retrieval over cached content | Typo-tolerant sliding-window, accent/case-normalized, phrase-hit bonus, merged snippets with context + TUI highlight markers; cheaper than an LLM, nicer than grep; pairs with F8 *(xl0/pi-lovely-web `find.ts`)* | M      |
| F17 | In-flight request coalescing                   | Dedup identical concurrent fetches/searches with refcounted cancellation isolation (one caller aborting doesn't cancel another's shared request); bounded by maxEntries *(zeldrisho/pi-packages `inflight.ts`)* | S/M    |
| F18 | robots.txt `Crawl-delay` + politeness          | Honor robots.txt `Crawl-delay` in the per-domain throttle; `Retry-After` parsing + exponential backoff with jitter *(DanyPops/web-spider `throttle.ts`)*          | S/M    |

> **inspiration7.md review (competitor study, assessed vs 0.7.1):** its Tier-1/2
> recommendations — active bot-protection wait loop, user lifecycle hooks
> (`afterFetch`/`afterExtract`), and the config-driven SSRF CIDR allow-list — all
> **shipped in 0.7.2** after the study was written. Its curator/result-ranking idea
> maps to F2 + F5; Context7/DeepWiki (`@xaccefy/pi-lookup`) maps to F9. The one
> genuinely new, still-open item is video/frame understanding (added above as F14).

### Inspiration #8 reference implementations (`docs/inspirations8.md`)

All 23 surveyed repos (18 in #8 + 5 in #8b) are substantive (no stubs); most are 0–16★ =
technique inspiration, except Hound (735★) and rpiv (541★). Best borrow per open item:

| Item | Best borrow (file)                                                                                                                                          | Value             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| F1   | citation contract (pi-search `citations.ts`); link-authority `PageGraph` (web-spider `graph.ts`); draft/journal substrate (pi-source-drafts `journal.ts`); Brave LLM-context grounding (zeldrisho) | HIGH              |
| F3   | persistent `profileDir` + cookie sharing (thurstonsand); per-session owned browser process (web-spider-daemon `playwright-session-registry.ts`)            | HIGH              |
| F5   | six-signal ranking + max-2-per-domain cap (Hound); round-robin + cooldown + coverage-learning router (web-spider `web-search.ts`); ranked link summary (pi-smart-web-search) | HIGH              |
| F6   | `InflightCoalescer` + refcounted cancel isolation (zeldrisho `inflight.ts`); FNV-1a dedup (pi-source-drafts); shared `canonicalizeUrl` (web-spider); byte-bounded LRU (zeldrisho) | HIGH              |
| F8   | `tool_result` auto-capture + "search local first" nudge (pi-source-drafts `index.ts`); fuzzy `findText` (xl0 `find.ts`)                                    | HIGH              |
| F9   | Context7 + DeepWiki keyless (pi-search `context7.ts`/`deepwiki.ts`); Context7 client w/ trust scores (supi-web); provider factory (rpiv `factory.ts`)      | HIGH — fastest win |
| F10  | out-of-process browser worker over Unix socket — spawn-race, heartbeat, idle-exit (thurstonsand `fetch-worker.ts`)                                          | HIGH — copy model |
| F11  | scoped config + dynamic enums + migration + tool gating (xl0 `config.ts`); walk-up + XDG layering (webveil); fail-soft + migration (rpiv); unknown-key guard (pi-search) | HIGH — 5+ refs    |
| F12  | headed-escalation merged-budget clock + UA laundering (thurstonsand `browser-session.ts`); latest-Chrome-profile selector (Thinkscape); 202 detect + jittered pacing (pi-smart-web-search) | HIGH              |
| F13  | interactive login browser + idle-timer suppression (thurstonsand); declarative action spec → local + cloud (Wade11s `browser-action-language.ts`)         | HIGH              |
| F14  | **solved (survey #8b)** — Gemini native video ingestion + Files-API upload + ffmpeg/yt-dlp frame export (pi-web-access `youtube-extract.ts`/`video-extract.ts`); reframe around this, not frame-sampled VLM Q&A | HIGH — ref verified |

**Extraction-quality micro-borrows** (small, fold into the pipeline): shadow-DOM
`getHTML({shadowRoots})` capture + `document.contentType` routing (thurstonsand);
Windows-1252 charset fallback + non-text to 0600-file-never-in-context (xl0);
thinness-gated format-qualified alternate-link fallback (Thinkscape). **Skip:**
Eddie0521/pi-web-suite `ssrf.ts` (fails open + TOCTOU — a regression).

**Survey #8b additions (5 repos):** F14 is now reference-backed (pi-web-access — see F14 row);
F3 adds Chrome cookie harvesting/decryption (pi-web-access `chrome-cookies.ts`, Windows-unsupported

- security-sensitive, gated); F9 adds a near drop-in Context7 API v2 client (pi-web-kit `context7.ts`);
F11 adds a config ladder DEFAULT→env→global→project(gated)→runtime (pi-web-kit `config.ts`) + a
user→project deep-merge (pi-lab `settings.ts`); F15 adds a keyless hosted-MCP client (pi-web-kit
`exa-mcp.ts`) + Exa `deep`/`deep-lite` search types (pi-lab `exa.ts`); F1 adds a deterministic-fallback
cited-summary curator (pi-web-access `summary-review.ts`); F16 adds a lazy inline-script index +
`script=N` retrieval (pi-lab webfetch). New micro-borrows: event-bus extension tier + `beforeFetch`
redirect hook (georgebashi), per-URL fetch fallback provenance (pi-web-kit `fallback.ts`),
byte-bounded LRU cache (recurring), X/Twitter vertical (pi-lab). Full detail in `docs/inspirations8.md` §8b.

---

## Sequencing

- **v0.7.3 (patch — DONE):** B2, B3, B4, B5, B6, B8, F7 fixed; H3 audited clean; B1 & B7 investigated (no defect). Dependency/security bumps (sharp removed; MCP SDK/hono/brace-expansion; pi peer 0.82) + `dependabot.yml` added; lens blocking findings triaged.
- **Security patch (DONE — shipped in 0.7.3):** H1 (SSRF DNS-pinning + fail-closed + metadata floor; the flagged github-pipeline path sanitization was verified already fixed by `08e64ae`) + H2 (secret redaction in output/errors). 51 new offline tests (30 ssrf-hardening + 21 redact). Caveat: `wreq-js` (primary fetcher) is a native binding with no `lookup` hook, so DNS-pinning is enforced on the Playwright path while the primary path keeps the fail-closed pre-flight check.
- **Pre-0.8.0 feature work (DONE — on master):** F2 (source trust-tier + evidence-quality grading; `src/source-trust.ts` + opt-in `rankSources` `trustBoost`) and F4 (backend `doctor`; `npm run diagnose:backends`). 69 new tests; full suite 931 / 0 fail.
- **v0.8.0 (feature release):** F1 (iterative cited-report research loop — the centerpiece; F2's grading feeds it). Inspiration #8 de-risks it — assemble from pi-search's citation contract + web-spider's `PageGraph` + pi-source-drafts' journal substrate.
- **v0.8.x (inspiration-informed order):** F9 first (fastest win — Context7 + DeepWiki already implemented keyless in heyhuynhgiabuu/pi-search, slots into the vertical registry + MCP SDK dep); then F11 (5+ reference impls: xl0/webveil/rpiv/pi-search); then F5 (Hound diversity-cap + web-spider round-robin), F6 (zeldrisho `InflightCoalescer`), F8 (pi-source-drafts auto-capture + xl0 fuzzy `findText`), F3; plus new F15–F18.
- **Browser-isolation cluster (F10/F13, + F3):** shares one answer — study thurstonsand/pi-web-tools `fetchers/local/` (worker over a socket) + web-spider-daemon `playwright-session-registry.ts` (per-session process) end-to-end before designing.
- **Backlog:** F12 (coherent-fingerprint; thurstonsand headed-escalation is the reference), F14 (video/frame — reference verified in survey #8b via pi-web-access's Gemini-native-ingestion + ffmpeg-frame-export design; remaining work is adoption + a Windows cookie path).
- **Security cross-checks (DONE — survey #8):** H4–H7 — Playwright redirect guard added (wreq-js hops remain an unhookable documented limitation); IPv6 NAT64/benchmarking/discard-floor + hex-metadata coverage; dangerous-port blocklist (allow-list-aware, fails closed); homoglyph folding + base64-blob redaction + MCP error-path redaction parity. 36 new tests (`tests/security-crosscheck.test.mjs`).
