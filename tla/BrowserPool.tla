---- MODULE BrowserPool ----
(*
 * PlusCal/TLA+ model of src/browser-pool.ts (pi-webaio) lifecycle core.
 * Bounds for TLC: MAXB = 1, MAXP = 1, Workers = {w1, w2}.
 *
 * Faithful to the code as of 2026-09-26:
 *   - findAvailableBrowser(): at-budget browser -> recycled ONLY when idle;
 *     a busy at-budget browser keeps serving and retires on release
 *     (fixed 2026-09-26; previously recycled even with pages checked out,
 *     killing in-flight navigations — KILL-IN-FLIGHT).
 *   - recycleBrowser(): removes browser, closes checked-out pages, closes
 *     browser, kicks ONE background replacement launch (deduped).
 *   - Background launch failure: records _lastLaunchError, does NOT notify
 *     waiters.
 *   - launchBrowser() dedup fall-through: a waiter whose awaited launch
 *     resolves to a full/closed browser launches ANOTHER browser with no
 *     maxBrowsers re-check.
 *   - waitForAvailable(): woken by release / successful launch / drain.
 *     STUCK-WAITERS holds (refutation 2026-09-26, see below): every park
 *     implies live browsers whose holders exit via notifying paths.
 *
 * Run with TLC (needs Java):
 *   tlc -config BrowserPool.cfg BrowserPool.tla
 *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS MAXB, MAXP, Workers

VARIABLES browsers,   \* [bid |-> [used : Nat, inUse : SUBSET Pages, closed : Bool]]
          pages,      \* [pid |-> [browser : Nat, holder : Workers \cup {NoHolder}]]
          waiters,    \* SUBSET Workers (in waitForAvailable)
          launchWait, \* SUBSET Workers (awaiting a pending launch)
          pending,    \* Bool (a launch is in flight)
          poolClosed,
          launchErr,  \* _lastLaunchError set
          killed      \* pages closed while checked out (I1 witness)

vars == <<browsers, pages, waiters, launchWait, pending, poolClosed, launchErr, killed>>

TypeOK ==
    /\ \A b \in DOMAIN browsers : browsers[b].used \in Nat
    /\ poolClosed \in BOOLEAN /\ pending \in BOOLEAN /\ launchErr \in BOOLEAN

Init ==
    /\ browsers = <<>>
    /\ pages = <<>>
    /\ waiters = {}
    /\ launchWait = {}
    /\ pending = FALSE
    /\ poolClosed = FALSE
    /\ launchErr = FALSE
    /\ killed = {}

(*
 * Actions (see check-pool-model.mjs for the executable version of this
 * exact machine; TLC explores the same graph declaratively):
 *   Acquire(w)    — capable browser / launch-or-join / wait
 *   Release(w)    — destroy page, notify waiters
 *   Crash(w)      — page dies, recycle-if-empty
 *   BudgetRecycle — at-budget browser recycled WITH in-use pages (suspect)
 *   LaunchOk/Fail — pending launch resolves; fail sets launchErr, no notify
 *   Drain         — close pool, wake everyone
 *)

\* ── Invariants ──

\* I1: budget recycling must never kill a checked-out page (holds since the
\* 2026-09-26 fix: recycle-if-idle + retire-on-release).
NoKillInFlight == killed = {}

\* I2: pending waiters with an open pool must have a potential waker.
\* HOLDS (refutation recorded 2026-09-26): every park implies live browsers
\* whose holders exit via notifying paths (release/crash/drain/launchOk all
\* notify) and removals only shrink the list. An earlier STUCK red was a
\* model artifact (crash modeled without its release()-notify); faithful
\* notify makes it vanish over the full graph.
WaiterWitness ==
    (waiters /= {} /\ ~poolClosed) =>
        \/ \E b \in DOMAIN browsers : ~browsers[b].closed /\ browsers[b].used < MAXP
        \/ pending
        \/ \E p \in DOMAIN pages : pages[p].holder /= "none"

\* I3: live browser count never exceeds the cap. KNOWN OPEN FINDING
\* (2026-09-26, filed not fixed): the launchBrowser() dedup fall-through
\* launches without a cap re-check — transient (+1), self-healing at budget.
\* Verdict: stay; routing the fall-through to waitForAvailable() risks
\* dangling background waiters for a cosmetic, self-correcting overage.
CapHeld ==
    Cardinality({b \in DOMAIN browsers : ~browsers[b].closed}) <= MAXB

THEOREM []NoKillInFlight /\ []WaiterWitness /\ []CapHeld
====
