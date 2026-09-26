---- MODULE CdpDaemon ----
(*
 * PlusCal/TLA+ model of the bin/cdp.mjs per-tab daemon lifecycle.
 *
 * One Chrome target, one socket path P, one registry slot R, two daemon
 * generations (A = old, B = successor). The question is socket/registry
 * ownership across generations:
 *
 *   - bind:   unlink P (stale cleanup), bind P, register self in R
 *   - shutdown (as coded): unlink P + remove R, UNCONDITIONALLY —
 *     even when R already names a live successor that bound P after us.
 *
 * Reachable path (all three steps are in the code today):
 *   1. A is alive but momentarily unreachable (transient connect failure);
 *      a CLI unlinks P and spawns B.
 *   2. B binds P and registers itself (R = B).
 *   3. A's 20-minute idle timer (rearmed only by commands, which now all go
 *      to B) fires; A.shutdown() unlinks P and deletes R.
 *   4. B is alive, registered nowhere, reachable by nobody: the next CLI
 *      spawns C, which steals from B — a cascading socket theft. Each
 *      generation self-heals via its own idle timeout, so this is churn +
 *      spurious respawns, not a process leak.
 *
 * Invariant SocketOwnership:
 *   a live daemon named by the registry keeps its socket bound —
 *   R = B /\ B alive  =>  P bound by B.
 *
 * The fix (guarded shutdown): unlink P and remove R only when R still names
 * this daemon; when R names a successor, touch neither. Stale-socket cleanup
 * stays covered: the next generation's startup unlink removes dead paths,
 * and listers already skip + CAS-remove dead-pid entries.
 *
 * Out of scope for this machine (filed, not modeled): PID reuse. Owner
 * liveness (_isPidAlive) and Chrome aliveness (launch.mjs isRunning) check
 * PID *existence*, not identity — if the OS recycles the number, a daemon
 * (or launch.mjs) mistakes an unrelated process for its owner (or Chrome).
 * The model below assumes no PID reuse within an owner lifetime; the orphan
 * guarantee holds only under that assumption.
 *)
EXTENDS Naturals, TLC

CONSTANTS Daemons

VARIABLES alive,      \* [d |-> Bool] — daemon process running
          boundBy,    \* "none" | daemon that holds the socket path P
          registry,   \* "none" | daemon named in slot R
          idleArmed,  \* [d |-> Bool] — idle timer still pending
          serving     \* [d |-> Bool] — d bound P and registered R, and has not
                      \* shut down itself since. Only d's own shutdown clears
                      \* it; a successor's authoritative takeover (bind)
                      \* clears the predecessor's flag — the stale-cleanup
                      \* bind is intended, the shutdown-time release of what
                      \* another generation owns is the steal.

vars == <<alive, boundBy, registry, idleArmed, serving>>

Init ==
    /\ alive = [d \in Daemons |-> FALSE]
    /\ boundBy = "none"
    /\ registry = "none"
    /\ idleArmed = [d \in Daemons |-> FALSE]
    /\ serving = [d \in Daemons |-> FALSE]

Bind(d) ==
    /\ ~alive[d]
    /\ alive' = [alive EXCEPT ![d] = TRUE]
    /\ boundBy' = d            \* unlink-then-bind: takes P unconditionally
    /\ registry' = d           \* registers self unconditionally
    /\ idleArmed' = [idleArmed EXCEPT ![d] = TRUE]
    /\ serving' = [o \in Daemons |-> o = d]  \* authoritative takeover

Serve(d) ==
    /\ alive[d] /\ boundBy = d /\ registry = d
    /\ idleArmed' = [idleArmed EXCEPT ![d] = TRUE]  \* resetIdle()
    /\ UNCHANGED <<alive, boundBy, registry, serving>>

\* Shutdown as coded: unconditional unlink + registry removal.
ShutdownUnguarded(d) ==
    /\ alive[d]
    /\ alive' = [alive EXCEPT ![d] = FALSE]
    /\ boundBy' = "none"
    /\ registry' = "none"
    /\ idleArmed' = [idleArmed EXCEPT ![d] = FALSE]
    /\ serving' = [serving EXCEPT ![d] = FALSE]

\* Shutdown guarded: only release what still names us.
ShutdownGuarded(d) ==
    /\ alive[d]
    /\ alive' = [alive EXCEPT ![d] = FALSE]
    /\ idleArmed' = [idleArmed EXCEPT ![d] = FALSE]
    /\ serving' = [serving EXCEPT ![d] = FALSE]
    /\ IF registry = d
       THEN /\ boundBy' = "none"
            /\ registry' = "none"
       ELSE UNCHANGED <<boundBy, registry>>

\* ── Invariant ──
\* A serving daemon stays bound and registered. Only its own shutdown — or
\* an authoritative takeover bind — may clear serving[d]; a predecessor's
\* shutdown clearing B's binding is the steal.
SocketOwnership ==
    \A d \in Daemons : serving[d] =>
        (alive[d] /\ boundBy = d /\ registry = d)

THEOREM []SocketOwnership
====
