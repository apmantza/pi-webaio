# pi-webaio Roadmap

Consolidated plan of bugfixes + new features.

**Sources:** an 8-tool smoke test (bugfixes) and a 6-repo inspiration survey
(henyo-pi-web, demigodmode/pi-web-agent, BetterWright, xaccefy/pi-webxp,
Lincoln504/pi-research, sfiorini/pi-stef). Decision: **no new skills**.

Effort: **S** ≤ half-day, **M** ~1–2 days, **L** multi-day.

## v0.7.3 bugfix batch — status

> The package is currently at **0.7.2** (AGENTS.md's "0.6.2" is stale), so this
> bugfix batch lands as **~0.7.3**, not v0.6.3 as originally labelled below.

| ID | Status | Notes |
| -- | ------ | ----- |
| B1 | ✅ Investigated — no code defect | Current source already writes vertical results to the URL-keyed session cache (`storeContent` runs on both the disk and non-disk markdown branches of `webfetch.ts`). The original observation was a stale `dist`. `storeContent` is in-memory (session) while `storeResult` is disk-persistent (24h) — an inherent asymmetry, not a bug. |
| B2 | ✅ Fixed + tested | `src/verticals/wikipedia.ts`; offline test in `tests/unit.test.mjs`. |
| B3 | ✅ Fixed + tested | Per-source guard in `src/tools/webresearch.ts`; `classifyReachability` tests in `tests/webresearch.test.mjs`. Root trigger (GitLab over-match) logged separately as B6. |
| B4 | ✅ Fixed | `googleStatus` surfaced in `src/tools/websearch.ts`. |
| B5 | ✅ Fixed + tested | `resolveCorpusDir` in `src/tools/webquery.ts`; test in `tests/webquery.test.mjs` (now wired into `test:all`). |
| H3 | ✅ Audited — clean | No enum-of-literals unions exist; existing unions are legitimate string/record + boolean/number. No change needed. |
| F7 | ✅ Done + tested | Omitted-sections TOC in `src/prune-markdown.ts`. |
| B6 | 🆕 New (discovered) | See Track A. Not yet fixed. |

Verification: `npm run lint` clean; full `test:all` = 765 tests, 0 failures; `dist/` rebuilt.

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

## Track B — Security hardening

| ID  | Item                                  | Detail                                                                                                                            | File(s)                                  | Effort |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| H1  | SSRF: DNS-pinning + fail-closed + metadata floor | `createPinnedLookup()` pins the *validated* IP into the request (closes re-resolve TOCTOU); deny on any guard exception; un-overridable cloud-metadata floor | `src/security.ts`, `src/fetch.ts` | M      |
| H2  | Secret redaction in output/errors     | Complement the existing block-on-secret scanner: strip `api_key`/`token`/jwt/credentials from returned text and error messages     | new `src/redact.ts` + `fetch-error.ts`/`render-result.ts` | S/M    |
| H3  | Typebox schema audit                  | Use `Type.String({enum})` not `Type.Union(Type.Literal…)` (some providers drop `anyOf/const`)                                      | tool schemas in `src/tools/*`            | S      |

## Track C — New features

### Tier 1 — v0.7 centerpiece (convergent signal from multiple repos)

| ID  | Feature                                   | Detail                                                                                                                                                  | Effort |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F1  | **Iterative cited-report research loop**  | Bounded coordinator/evaluator: `answer / answer-with-caveat / search-again / headless-escalate` under a fixed budget; synthesizes CLAIMS.md instead of leaving it to the agent *(pi-web-agent + pi-research)* | L      |
| F2  | **Source trust-tier + evidence-quality grading** | `classifySourceProfile()` (official-docs/api/issue/forum/community) + caveat reasons (`community-only`, `low-diversity`, `bot-check`, `possible-conflict`); feeds F1 + source selection *(pi-web-agent, henyo)* | M      |
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
| F14 | Video / frame understanding         | Frame-level visual Q&A for video URLs (local + YouTube); `sharp` is already a dep, the missing piece is a vision-model step. The headline "they do something we don't" feature *(pi-web-access)* | L      |

> **inspiration7.md review (competitor study, assessed vs 0.7.1):** its Tier-1/2
> recommendations — active bot-protection wait loop, user lifecycle hooks
> (`afterFetch`/`afterExtract`), and the config-driven SSRF CIDR allow-list — all
> **shipped in 0.7.2** after the study was written. Its curator/result-ranking idea
> maps to F2 + F5; Context7/DeepWiki (`@xaccefy/pi-lookup`) maps to F9. The one
> genuinely new, still-open item is video/frame understanding (added above as F14).

---

## Sequencing

- **v0.7.3 (patch — DONE):** B2, B3, B4, B5, F7 fixed; H3 audited clean; B1 investigated (no defect). B6 discovered and deferred.
- **Next patch:** B6 (GitLab vertical over-match).
- **v0.8.0 (feature release):** F1 + F2 (centerpiece — grading feeds the loop), H1, H2, F4.
- **v0.8.x:** F3, F5, F6, F8, F9.
- **Backlog:** F10–F13.
