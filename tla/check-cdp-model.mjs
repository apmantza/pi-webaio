/**
 * Exhaustive model checker for the cdp.mjs per-tab daemon lifecycle.
 * Same machine as tla/CdpDaemon.tla, executed by BFS so it runs without
 * Java/TLC (CI has no JVM).
 *
 * One Chrome target, one socket path P, one registry slot R, two daemon
 * generations (A = old, B = successor):
 *
 *   bind(d):      unlink P (stale cleanup), bind P, register d in R
 *   serve(d):     command resets the idle timer (stays alive + reachable)
 *   shutdown(d):  as coded: unlink P + remove R UNCONDITIONALLY, even when
 *                 R already names a live successor that bound P after us.
 *
 * Invariant SocketOwnership: a serving daemon stays bound and registered —
 * (serving[d]) => (alive[d] && boundBy === d && registry === d). Only d's
 * own shutdown may clear serving[d]; a predecessor clearing it is the steal.
 *
 * The fix under test: guarded shutdown — unlink P / remove R only when R
 * still names this daemon; otherwise touch neither.
 *
 * Environmental assumption (filed, not modeled): no PID reuse within an
 * owner lifetime. Owner liveness (_isPidAlive) checks PID existence, not
 * identity, so a recycled PID reads as a live owner.
 *
 * Usage: node tla/check-cdp-model.mjs
 */
const DAEMONS = ["A", "B"];

function init() {
  return {
    alive: { A: false, B: false },
    boundBy: "none",
    registry: "none",
    idle: { A: false, B: false },
    // serving[d]: d bound P and registered R, and has not shut down itself
    // since. Only d's own shutdown may clear it.
    serving: { A: false, B: false },
  };
}

const key = (s) => JSON.stringify([s.alive, s.boundBy, s.registry, s.idle, s.serving]);

const clone = (s) => structuredClone(s);

function* successors(s, guarded) {
  // bind(d): a dead generation (re)starts: unlink-then-bind + register.
  // B can only bind once A no longer holds P (A alive-but-unreachable keeps
  // its fd; the CLI unlinked the *path*, so B's bind succeeds).
  for (const d of DAEMONS) {
    if (!s.alive[d] && s.boundBy !== d) {
      const n = clone(s);
      n.alive[d] = true;
      n.boundBy = d;
      n.registry = d;
      n.idle[d] = true;
      n.serving[d] = true;
      // Takeover is authoritative: the CLI spawned d because the previous
      // holder was unreachable, so the previous holder stops serving. (The
      // stale-cleanup bind is intended; the shutdown-time release of what
      // another generation owns is the steal.)
      for (const o of DAEMONS) if (o !== d) n.serving[o] = false;
      yield { label: `bind(${d})`, s: n };
    }
  }
  // serve(d): a command reaches the bound daemon and rearms its idle timer.
  for (const d of DAEMONS) {
    if (s.alive[d] && s.boundBy === d && s.registry === d) {
      const n = clone(s);
      n.idle[d] = true;
      yield { label: `serve(${d})`, s: n };
    }
  }
  // idleTimeout(d): the idle timer fires and the daemon shuts down.
  // Note: after B steals P, commands go to B, so A's timer is the one left
  // pending — exactly the generation most likely to fire first.
  for (const d of DAEMONS) {
    if (s.alive[d] && s.idle[d]) {
      const n = clone(s);
      n.alive[d] = false;
      n.idle[d] = false;
      n.serving[d] = false; // only d's own shutdown clears its serving flag
      if (!guarded) {
        // As coded: unconditional unlink + registry removal.
        n.boundBy = "none";
        n.registry = "none";
        yield { label: `shutdown(${d})[unguarded: unlink+unregister]`, s: n };
      } else if (s.registry === d) {
        // Fixed: release only what still names us.
        n.boundBy = "none";
        n.registry = "none";
        yield { label: `shutdown(${d})[guarded: owned, released]`, s: n };
      } else {
        yield { label: `shutdown(${d})[guarded: successor owns, untouched]`, s: n };
      }
    }
  }
}

function check(s) {
  for (const d of DAEMONS) {
    // A live serving daemon must stay bound and registered: only its own
    // shutdown may take those away. A predecessor's shutdown clearing them
    // is the steal.
    if (s.serving[d] && !(s.alive[d] && s.boundBy === d && s.registry === d)) {
      return [`SOCKET-STEAL: daemon ${d} is serving but boundBy=${s.boundBy}, registry=${s.registry} (alive=${s.alive[d]})`];
    }
  }
  return [];
}

function run(label, guarded) {
  const start = init();
  const seen = new Map([[key(start), null]]);
  const q = [start];
  let red = null;
  while (q.length && !red) {
    const cur = q.shift();
    for (const { label: a, s } of successors(cur, guarded)) {
      const k = key(s);
      if (seen.has(k)) continue;
      seen.set(k, { prev: key(cur), action: a });
      const errs = check(s);
      if (errs.length) { red = { err: errs[0], node: k }; break; }
      q.push(s);
    }
  }
  console.log(`\n=== ${label} (${seen.size} states) ===`);
  if (!red) {
    console.log("GREEN: SocketOwnership holds over the explored graph");
    return 0;
  }
  const path = [];
  let n = red.node;
  while (seen.get(n)) { const e = seen.get(n); path.unshift(e.action); n = e.prev; }
  console.log(`RED ${red.err}`);
  console.log("  init\n  " + path.join("\n  "));
  return 1;
}

const redPre = run("PRE-FIX shutdown (unconditional unlink)", false);
const redPost = run("POST-FIX shutdown (registry-guarded unlink)", true);

console.log(
  redPre && !redPost
    ? "\nRESULT: pre-fix red, post-fix green — guarded shutdown closes the steal."
    : `\nRESULT: unexpected (pre=${redPre}, post=${redPost})`,
);
process.exit(redPre && !redPost ? 0 : 1);
