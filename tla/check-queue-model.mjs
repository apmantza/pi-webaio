/**
 * Exhaustive interleaving checker for the RequestQueue crash-consistency core.
 * Same state machine as tla/RequestQueue.tla (PlusCal model), executed by BFS
 * in Node so it runs without Java/TLC. Faithful to src/request-queue.ts:
 * resume() resets only in_progress to queued (fixed 2026-09-26); failed stays
 * failed, so NoWedged holds over the full graph.
 *
 * Checks: Conservation, NoWedged (queued => retries < MAX), Mutex,
 * and Stuck (¬isDone but next() returns null).
 *
 * Usage: node tla/check-queue-model.mjs
 */
const URLS = ["u1", "u2"];
const WORKERS = ["w1", "w2"];
const MAX = 1; // smaller than prod (3); bug reproduces for any MAX >= 1

const key = (s) => JSON.stringify([s.status, s.retries, s.held]);

function init() {
  const status = {}, retries = {}, held = {};
  for (const u of URLS) { status[u] = "queued"; retries[u] = 0; held[u] = null; }
  return { status, retries, held };
}

function* successors(s) {
  // next(w,u)
  for (const w of WORKERS) for (const u of URLS) {
    if (s.status[u] === "queued" && s.retries[u] < MAX && s.held[u] === null) {
      const n = structuredClone(s);
      n.status[u] = "in_progress"; n.held[u] = w;
      yield { label: `next(${w},${u})`, s: n };
    }
  }
  // complete(w,u)
  for (const w of WORKERS) for (const u of URLS) {
    if (s.status[u] === "in_progress" && s.held[u] === w) {
      const n = structuredClone(s);
      n.status[u] = "completed"; n.held[u] = null;
      yield { label: `complete(${w},${u})`, s: n };
    }
  }
  // fail(w,u)
  for (const w of WORKERS) for (const u of URLS) {
    if (s.status[u] === "in_progress" && s.held[u] === w) {
      const n = structuredClone(s);
      n.retries[u] += 1;
      n.status[u] = n.retries[u] < MAX ? "queued" : "failed";
      n.held[u] = null;
      yield { label: `fail(${w},${u})->${n.status[u]} r=${n.retries[u]}`, s: n };
    }
  }
  // crash + resume (fixed semantics: only in_progress -> queued)
  {
    const n = structuredClone(s);
    for (const u of URLS) {
      if (n.status[u] === "in_progress") n.status[u] = "queued";
      n.held[u] = null;
    }
    yield { label: "CRASH+resume", s: n };
  }
}

function checkInvariants(s) {
  const errs = [];
  const vals = Object.values(s.status);
  if (vals.length !== URLS.length) errs.push("Conservation violated");
  for (const u of URLS) {
    if (s.status[u] === "queued" && s.retries[u] >= MAX)
      errs.push(`WEDGED: ${u} queued with retries=${s.retries[u]} >= MAX=${MAX}`);
    const holders = URLS.filter((v) => s.held[v] !== null);
    if (new Set(holders.map((v) => v + ":" + s.held[v])).size !== holders.length)
      errs.push("Mutex violated");
    if ((s.status[u] === "in_progress") !== (s.held[u] !== null))
      errs.push(`Mutex/link violated on ${u}`);
  }
  const isDone = URLS.every((u) => !["queued", "in_progress"].includes(s.status[u]));
  const nextable = URLS.some((u) => s.status[u] === "queued" && s.retries[u] < MAX);
  const anyInProgress = URLS.some((u) => s.status[u] === "in_progress");
  if (!isDone && !nextable && !anyInProgress) errs.push("STUCK: !isDone but next()=null and no work in flight (hang)");
  return errs;
}

// BFS with parent pointers for transcript
const start = init();
const seen = new Map([[key(start), null]]);
const q = [start];
let red = null;

while (q.length && !red) {
  const cur = q.shift();
  for (const { label, s } of successors(cur)) {
    const k = key(s);
    if (seen.has(k)) continue;
    seen.set(k, { prev: key(cur), label, state: s });
    const errs = checkInvariants(s);
    if (errs.length) { red = { state: s, errs, node: k }; break; }
    q.push(s);
  }
}

console.log(`Explored ${seen.size} states. MAX_RETRIES=${MAX}, urls=${URLS.length}, workers=${WORKERS.length}`);
if (!red) { console.log("GREEN: all invariants hold on the explored graph."); process.exit(0); }

// reconstruct transcript
const path = [];
let n = red.node;
while (seen.get(n)) { const e = seen.get(n); path.unshift(`${e.label}  => ${JSON.stringify(e.state.status)} retries=${JSON.stringify(e.state.retries)}`); n = e.prev; }
console.log(`\nRED (${red.errs.join(" | ")}):`);
console.log("  init     => " + JSON.stringify(start.status));
for (const p of path.slice(0, 8)) console.log("  " + p);
process.exit(1);
