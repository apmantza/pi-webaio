# Claim Stance (heuristic, non-authoritative)

> Stance is keyword/pattern-based, not semantic entailment — verify before treating as fact.

This is a deterministic, keyword/pattern-based heuristic — it does **not**
perform semantic entailment or fact-checking. It combines keyword overlap
with the query, English conflict-marker words, source-quality tier, and
freshness into a per-source stance and an aggregate verdict. Treat every
row below as a candidate lead for the agent to confirm, not a conclusion.

- **Research question:** how does the pi extension API register tools
- **Verdict:** likely_false
- **Support score:** 0  |  **Conflict score:** 4.8
- **Supporting sources:** 0  |  **Conflicting:** 4  |  **Neutral:** 0

## Candidate claim table (non-authoritative — confirm before citing)

| Source | Stance | Overlap | Conflict markers | Primary | Evidence strength |
| --- | --- | --- | --- | --- | --- |
| S1 | conflicting | 1 | false, invalidated | no | -1.2 |
| S2 | conflicting | 1 | false, invalidated | no | -1.2 |
| S3 | conflicting | 1 | false | no | -1.2 |
| S4 | conflicting | 1 | false, invalidated | no | -1.2 |

_Rows above are candidate leads only — always open the source and read
`reports/EVIDENCE.md` before treating a "supporting"/"conflicting" label
as fact._
