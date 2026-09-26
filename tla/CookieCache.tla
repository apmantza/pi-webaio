---- MODULE CookieCache ----
(*
 * PlusCal/TLA+ model of src/cookie-cache.ts (pi-webaio) key isolation.
 *
 * The module's stated contract (cookie-cache.ts header) is that a cached
 * cookie set is never replayed under a different network/browser identity:
 * "a cookie captured via one proxy or fingerprint profile is not safe to
 * inject under a different one".
 *
 * The identity that actually shapes the request is the pair (browser, os) —
 * src/fetch.ts threads both into buildHeaders(), and Sec-Ch-Ua-Platform /
 * the UA string vary with `os`. cookieCacheKey() as written keys on
 * (origin, proxy, browser) only, so two renders that differ solely in `os`
 * collide on one key.
 *
 * Entries therefore carry the identity that wrote them, and the invariant is
 * that a read may only observe an entry written by the same identity:
 *
 *   NoCrossIdentityReplay ==
 *       read /= "none"  =>  entryWriter[read] = readerIdentity
 *
 * The two candidate key functions differ only in whether `os` is an axis:
 *   KeyPre(os)  == "k_both"                       \* (origin, proxy, browser)
 *   KeyPost(os) == IF os = "windows" THEN "k_win" ELSE "k_lin"
 *
 * Space: 1 origin, 1 proxy, 1 browser, 2 OS values — the smallest space in
 * which the os axis can differ, which is all the axis needs to be refuted.
 *)
EXTENDS Naturals, TLC

CONSTANTS OSes

OSVals == {"windows", "linux"}

(* A harvested cookie set, tagged with the OS identity that produced it. *)
Sets == {"c_none", "c_win", "c_lin"}

VARIABLES store, reader, readResult

vars == <<store, reader, readResult>>

Init ==
    /\ store = [k \in {"k_both", "k_win", "k_lin"} |-> "c_none"]
    /\ reader = "none"
    /\ readResult = "none"

KeyPre(os)  == "k_both"
KeyPost(os) == IF os = "windows" THEN "k_win" ELSE "k_lin"

(* Harvest under `os` and store under that os's key. *)
Harvest(os, set, KeyFn) ==
    /\ store' = [store EXCEPT ![KeyFn(os)] = set]
    /\ UNCHANGED <<reader, readResult>>

(* Warm path: read the key for `os`. *)
Read(os, KeyFn) ==
    /\ reader' = os
    /\ readResult' = store[KeyFn(os)]
    /\ UNCHANGED store

\* The identity that owns each non-none set.
WriterOf(set) == IF set = "c_win" THEN "windows" ELSE "linux"

\* ── Invariant ──
\* A non-null read implies the entry's writer identity == the reader identity.
NoCrossIdentityReplay ==
    readResult = "c_none" \/ WriterOf(readResult) = reader

\* Under the fixed key the only reachable read for `os` is that os's own set
\* (or nothing), so the invariant holds for every trace.
Next ==
    \/ Harvest("windows", "c_win", KeyPost)
    \/ Harvest("linux", "c_lin", KeyPost)
    \/ \E o \in OSVals : Read(o, KeyPost)

Spec == Init /\ [][Next]_vars

THEOREM Spec => []NoCrossIdentityReplay
====
