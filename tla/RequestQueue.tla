---- MODULE RequestQueue ----
(*
 * PlusCal/TLA+ model of src/request-queue.ts (pi-webaio), crash-consistency core.
 *
 * Faithful to the code as of 2026-09-26:
 *   - next():      queued /\ retries < MAX -> in_progress   (lock-protected)
 *   - complete():  in_progress -> completed
 *   - fail():      retries' = retries+1; retries<MAX ? queued : failed
 *   - resume():    in_progress -> queued (leases dropped); failed STAYS
 *                  failed, completed stays completed (fixed 2026-09-26;
 *                  previously every non-completed entry -> queued, which
 *                  wedged failed entries as unretryable queued).
 *   - webpull resume path also runs requeueCompletedMissingFiles() +
 *     addPreservingCompletedFiles(); the completed-before-write repair is
 *     modeled as already-applied, so what remains is the fail/resume shape.
 *
 * Run with TLC (needs Java):
 *   tlc -config RequestQueue.cfg RequestQueue.tla
 * with e.g. URLs = {u1, u2}, MAX_RETRIES = 1, Workers = {w1, w2}.
 *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS URLs, MAX_RETRIES, Workers

VARIABLES status, retries, heldBy

vars == <<status, retries, heldBy>>

TypeOK ==
    /\ status \in [URLs -> {"queued", "in_progress", "completed", "failed"}]
    /\ retries \in [URLs -> 0 .. MAX_RETRIES]
    /\ heldBy \in [URLs -> SUBSET Workers]

Init ==
    /\ status = [u \in URLs |-> "queued"]
    /\ retries = [u \in URLs |-> 0]
    /\ heldBy = [u \in URLs |-> {}]

(* --algorithm Queue
variables dummy = 0;
begin
  \* Workers act; crash/resume is a separate process below.
  \* (Actions are written as TLA+ next-state conjuncts instead so TLC
  \*  explores every interleaving, including crash at any point.)
  skip;
end algorithm; *)

NextOne(w, u) ==
    /\ status[u] = "queued"
    /\ retries[u] < MAX_RETRIES
    /\ heldBy[u] = {}
    /\ status' = [status EXCEPT ![u] = "in_progress"]
    /\ heldBy' = [heldBy EXCEPT ![u] = {w}]
    /\ UNCHANGED retries

CompleteOne(w, u) ==
    /\ status[u] = "in_progress"
    /\ w \in heldBy[u]
    /\ status' = [status EXCEPT ![u] = "completed"]
    /\ heldBy' = [heldBy EXCEPT ![u] = {}]
    /\ UNCHANGED retries

FailOne(w, u) ==
    /\ status[u] = "in_progress"
    /\ w \in heldBy[u]
    /\ retries' = [retries EXCEPT ![u] = retries[u] + 1]
    /\ status' = [status EXCEPT ![u] =
                    IF retries'[u] < MAX_RETRIES THEN "queued" ELSE "failed"]
    /\ heldBy' = [heldBy EXCEPT ![u] = {}]

\* resume() as coded after the 2026-09-26 fix: only in_progress leases are
\* dropped back to queued; failed stays failed, completed stays completed.
CrashResume ==
    /\ status' = [u \in URLs |->
                    IF status[u] = "in_progress" THEN "queued" ELSE status[u]]
    /\ heldBy' = [u \in URLs |-> {}]
    /\ UNCHANGED retries

Next ==
    \/ \E w \in Workers, u \in URLs : NextOne(w, u)
    \/ \E w \in Workers, u \in URLs : CompleteOne(w, u)
    \/ \E w \in Workers, u \in URLs : FailOne(w, u)
    \/ CrashResume

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* ── Invariants ──

\* Conservation: every URL is in exactly one bucket.
Conservation ==
    LET s == {u \in URLs : status[u] = "queued"}
        p == {u \in URLs : status[u] = "in_progress"}
        c == {u \in URLs : status[u] = "completed"}
        f == {u \in URLs : status[u] = "failed"}
    IN Cardinality(s) + Cardinality(p) + Cardinality(c) + Cardinality(f)
         = Cardinality(URLs)

\* A queued entry must be retryable, i.e. next() can actually pick it up.
\* Violation == wedged queue: isDone() = FALSE but next() = NULL forever.
NoWedged ==
    \A u \in URLs : status[u] = "queued" => retries[u] < MAX_RETRIES

\* At most one worker holds a URL in_progress (the next() lock).
Mutex ==
    \A u \in URLs : Cardinality(heldBy[u]) <= 1
       /\ (status[u] = "in_progress" <=> heldBy[u] /= {})

IsDone == \A u \in URLs : status[u] \notin {"queued", "in_progress"}

THEOREM Spec => []TypeOK /\ []Conservation /\ []Mutex
====
