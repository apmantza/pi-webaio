---- MODULE StrategyMemory ----
(*
 * PlusCal/TLA+ model of src/strategy-memory.ts (pi-webaio).
 * Models domain fetch strategy tracking, ladder escalation, and the re-probe cycle.
 *
 * Strategies ordered cheapest to most expensive:
 *   1: "plain"
 *   2: "wreq"
 *   3: "browser"
 *
 * Invariant NoPermanentReProbe:
 *   After a fetch cycle completes with a success at any viable rung,
 *   the system must not remain stuck in reprobeNext = TRUE indefinitely.
 *)
EXTENDS Naturals, TLC

CONSTANTS MAX_SUCCESS

VARIABLES lastSuccess, successCount, reprobeNext, state

vars == <<lastSuccess, successCount, reprobeNext, state>>

Strategies == {1, 2, 3}  \* 1=plain, 2=wreq, 3=browser

TypeOK ==
    /\ lastSuccess \in Strategies
    /\ successCount \in 0..MAX_SUCCESS
    /\ reprobeNext \in BOOLEAN
    /\ state \in {"idle", "fetching", "reprobing"}

Init ==
    /\ lastSuccess = 3       \* domain needs browser
    /\ successCount = 0
    /\ reprobeNext = FALSE
    /\ state = "idle"

\* Normal fetch starting at remembered rung (when not reprobing)
StartNormal ==
    /\ state = "idle"
    /\ ~reprobeNext
    /\ state' = "fetching"
    /\ UNCHANGED <<lastSuccess, successCount, reprobeNext>>

\* Normal fetch succeeds at remembered rung
SucceedNormal ==
    /\ state = "fetching"
    /\ IF successCount + 1 >= MAX_SUCCESS
       THEN /\ reprobeNext' = TRUE
            /\ successCount' = 0
       ELSE /\ successCount' = successCount + 1
            /\ reprobeNext' = reprobeNext
    /\ state' = "idle"
    /\ UNCHANGED <<lastSuccess>>

\* Start a re-probe (because reprobeNext was set)
StartReprobe ==
    /\ state = "idle"
    /\ reprobeNext
    /\ state' = "reprobing"
    /\ UNCHANGED <<lastSuccess, successCount, reprobeNext>>

\* Re-probe: cheaper rung (e.g. 1) unexpectedly succeeds! (escape hatch)
ReprobeCheaperSucceeds(strat) ==
    /\ state = "reprobing"
    /\ strat < lastSuccess
    /\ lastSuccess' = strat
    /\ successCount' = 1
    /\ reprobeNext' = FALSE
    /\ state' = "idle"

\* Re-probe: cheaper rung fails, falls back to remembered rung and succeeds
ReprobeRememberedSucceeds ==
    /\ state = "reprobing"
    \* Bug in code: reprobeNext was NOT cleared on the else branch!
    \* Fixed code: reprobeNext' = FALSE
    /\ reprobeNext' = FALSE
    /\ successCount' = 1
    /\ state' = "idle"
    /\ UNCHANGED <<lastSuccess>>

Next ==
    \/ StartNormal
    \/ SucceedNormal
    \/ StartReprobe
    \/ \E s \in 1..(lastSuccess - 1) : ReprobeCheaperSucceeds(s)
    \/ ReprobeRememberedSucceeds

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* ── Invariant: After re-probe succeeds at remembered rung, reprobeNext must be FALSE
ReProbeResets ==
    state = "idle" /\ successCount = 1 => ~reprobeNext

THEOREM Spec => []TypeOK /\ []ReProbeResets
====
