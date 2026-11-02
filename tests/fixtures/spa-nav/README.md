# `spa-nav` fixtures — provenance

Captured from the live web on 2026-11-02 for issue #154. **Do not edit these
files.** They are byte-faithful captures, and their value is exactly that they
are what the network returned, including quirks.

| File | What it is |
| --- | --- |
| `nocheck.html.gz` | `https://www.typescriptlang.org/tsconfig/noCheck.html`, fetched with a Chrome 145 UA. 164,101 bytes decompressed; `Disable full type checking` occurs **exactly once** (asserted in `tests/spa-nav-fallback.test.mjs`). |
| `nocheck-jina.txt` | The Jina reader response for the same URL (`https://r.jina.ai/…`), HTTP 200, 2,804 bytes. It is the *bug*: navigation only, and it omits the definition entirely. |

## Why they are not normalised

`nocheck-jina.txt` contains trailing whitespace on a few lines. That is what the
reader proxy emitted, so `git diff --check` flags it — and `preCleanHtml` /
`parseJinaBody` are exercised against the real bytes, not a tidied copy. Editing
the capture to satisfy a whitespace lint would quietly turn the evidence into a
fixture that no longer reproduces anything.

## If the live site changes

Nothing here fetches the network, so a site redesign will **not** redden this
suite — the fixtures keep testing the shape they captured. That is deliberate for
a regression test. If you want to know whether the live page still reproduces,
re-run the probe in the PR #180 description against the URL; if the definition
ever appears in the reader response, re-capture and update the premise tests,
which assert the occurrence counts precisely so a drifted fixture says so out
loud instead of passing.
