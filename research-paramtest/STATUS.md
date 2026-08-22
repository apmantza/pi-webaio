# Research Status

- **Query:** how does the pi extension API register tools
- **Sub-queries:** how does the pi extension API register tools; pi extension registerTool signature; pi extension lifecycle events
- **Started:** 2026-08-18T06:33:02.078Z
- **Finished:** 2026-08-18T06:33:10.112Z
- **Mode:** single-round MVP (search → rank → fetch → bundle + audit)
- **Sources consulted:** 46
- **Sources fetched:** 4 (max requested: 4)
- **Reachability:** 4 ok, 0 skipped (anti-bot), 0 dead
- **Primary sources:** 0

## Fetch ledger

| ID | Status | URL |
| --- | --- | --- |
| S1 | fetched | https://pi.dev/docs/latest/extensions |
| S2 | fetched | https://pi.ubitools.com/extensions/ |
| S3 | fetched | https://hochej.github.io/pi-mono/coding-agent/extensions/ |
| S4 | fetched | https://pidocs.seepine.com/en/extensions |

## Ranked but not fetched (beyond maxSources=4)

- S5: https://deepwiki.com/davis7dotsh/my-pi-setup/2.1-extension-api-and-registration-model
- S6: https://minepi.com/
- S7: https://www.mathsisfun.com/numbers/pi.html
- S8: https://www.piday.org/million/
- S9: https://pi.dev/packages
- S10: http://www.geom.uiuc.edu/~huberty/math5337/groupe/digits.html
- S11: https://en.wikipedia.org/wiki/Pi
- S12: https://wumbo.net/symbols/pi/
- S13: https://vi.wikipedia.org/wiki/Pi
- S14: https://www.britannica.com/science/pi-mathematics
- S15: https://simple.wikipedia.org/wiki/Pi
- S16: https://www.youtube.com/watch?v=qAiivspEHmU
- S17: https://github.com/earendil-works/pi/issues/1720
- S18: https://github.com/open-gsd/gsd-pi/blob/main/docs/dev/extending-pi/06-the-extension-lifecycle.md
- S19: https://pi.dev/docs/latest
- S20: https://github.com/BEOKS/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- S21: https://docs.rs/pi_agent_rust/latest/pi/extensions/fn.is_lifecycle_event.html
- S22: https://pi-doc.com/docs/latest/extensions.html
- S23: https://deepwiki.com/earendil-works/pi/6.1-extension-api-and-lifecycle-events
- S24: https://github.com/nicholaswagner/pi-extensions
- S25: https://deepwiki.com/agentic-dev-io/pi-agent/5.1-extension-api-and-lifecycle-events
- S26: https://pi.dev/docs/latest/sdk
- S27: https://github.com/brglng/pi-packages/blob/main/packages/pi-permission-system/docs/cross-extension-api.md
- S28: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- S29: https://thinkpeace.github.io/pi-agent-for-java-devs/chapter-10-extension-system
- S30: https://skills.rest/skill/pi-extension-lifecycle
- S31: https://deepwiki.com/varunisrani/Pi-coding-agent-/5.3-writing-extensions
- S32: https://deepwiki.com/earendil-works/pi/6.3-extension-examples-and-patterns
- S33: https://skillsmp.com/creators/gotgenes/pi-autoformat/pi-skills-pi-extension-lifecycle
- S34: https://www.aibuilderclub.com/blog/pi-agent-extensions-guide
- S35: https://piex.dev/en/blogs/pi-extension-mechanism/
- S36: https://myctm.comparethemarket.com/?AFFCLIE=QUERY_PARAM(SRC%2CEI32)
- S37: https://www.comparethemarket.com/
- S38: https://www.comparethemarket.com/car-insurance/
- S39: https://www.moneysupermarket.com/?msockid=3f7bfb41a6946fce176decf8a7106ecf
- S40: https://www.gocompare.com/
- S41: https://www.moneysupermarket.com/gas-and-electricity/?msockid=3f7bfb41a6946fce176decf8a7106ecf
- S42: https://cdn2.comparethemarket.com/market/cms/static-homepage/index.html
- S43: https://www.confused.com/
- S44: https://www.comparethemarkat.com/
- S45: https://motorbreakdown.comparethemarket.com/user/login
- S46: https://deepwiki.com/michaelliv/pi-dynamic-workflows/2.1-pi-extension-integration

## Claim stance (heuristic, non-authoritative)

> Stance is keyword/pattern-based, not semantic entailment — verify before treating as fact.

- **Verdict:** likely_false
- **Support score:** 0  |  **Conflict score:** 4.8
- **Supporting / conflicting / neutral sources:** 0 / 4 / 0
- See `STANCE.md` and `data/stance.json` for the per-source breakdown.

## Next steps for the agent

- Fill in `reports/CLAIMS.md` with claims cited by source ID (S1, S2, ...), using `reports/EVIDENCE.md` and `data/evidence.json`.
- Review `reports/GAPS.md` for sub-queries with weak or no coverage.
- `STANCE.md` offers a candidate (non-authoritative) stance per source — confirm before citing as fact.
- This is a single-round MVP bundle — no iterative follow-up round was run.
