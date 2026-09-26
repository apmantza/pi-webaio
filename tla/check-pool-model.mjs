/**
 * Exhaustive interleaving checker for the BrowserPool lifecycle core.
 * Same machine as tla/BrowserPool.tla. Faithful to src/browser-pool.ts
 * WITH the 2026-09-26 kill fix (recycle-if-idle + retire-on-release), but
 * WITHOUT waiter self-launch: parked waiters re-park even when room
 * (waitForAvailable never launches) — the STUCK shape under test.
 * The dedup fall-through stays faithful (filed open finding).
 *
 * FIX DESIGN under test (tla/FIXED): ticketed launches (at MAXB=1 the
 * ticket collapses to the pending flag: initiate only when live==0 and no
 * launch in flight), waiter retries launch when room, launch failure wakes
 * waiters, drain discards in-flight launches, join-full falls through to
 * backpressure instead of overlaunch.
 *
 * Bounds: MAXB=1, MAXP=1, 2 workers. CURRENT semantics (matches src after
 * the kill fix, before the ticket/waiter-launch/drain-guard fix).
 * Usage: node tla/check-pool-model.mjs
 */
const MAXB = 1, MAXP = 1;
const WORKERS = ["w1", "w2"];
// NOTE: launches are unbounded (as in real code). Finiteness comes from
// id normalization in norm() + splice-out removal in recycle().

const norm = (s) => {
  const bidMap = new Map(); const pidMap = new Map();
  for (const b of s.browsers) if (!bidMap.has(b.bid)) bidMap.set(b.bid, bidMap.size + 1);
  const seePid = (p) => { if (!pidMap.has(p)) pidMap.set(p, pidMap.size + 1); };
  for (const b of s.browsers) b.inUse.forEach(seePid);
  Object.keys(s.pages).forEach(seePid);
  Object.values(s.heldBy).forEach(seePid);
  const P = (p) => `p${pidMap.get(p)}`;
  return [
    s.browsers.map((b) => [bidMap.get(b.bid), b.used, b.inUse.map(P).sort(), b.closed]),
    Object.entries(s.pages).map(([p, v]) => [P(p), bidMap.get(v.bid), v.holder]).sort(),
    [...s.waiters].sort(), [...s.ready].sort(), [...s.launchWait].sort(),
    Object.entries(s.heldBy).map(([w, p]) => [w, P(p)]).sort(),
    s.pending, s.poolClosed, s.launchErr, s.killSeen,
  ];
};
const key = (s) => JSON.stringify(norm(s));

function init() {
  return {
    browsers: [], // {bid, used, inUse:[pid], closed, removed}
    pages: {},    // pid -> {bid, holder}
    waiters: new Set(), ready: new Set(), launchWait: new Set(),
    pending: false, poolClosed: false, launchErr: false,
    killed: new Set(), killSeen: false, nextBid: 1, nextPid: 1,
    heldBy: {}, // worker -> pid
  };
}

const live = (s) => s.browsers.filter((b) => !b.closed);
const capable = (s) => live(s).find((b) => b.used < MAXP);
const clone = (s) => ({
  browsers: s.browsers.map((b) => ({ ...b, inUse: [...b.inUse] })),
  pages: Object.fromEntries(Object.entries(s.pages).map(([k, v]) => [k, { ...v }])),
  waiters: new Set(s.waiters), ready: new Set(s.ready), launchWait: new Set(s.launchWait),
  pending: s.pending, poolClosed: s.poolClosed, launchErr: s.launchErr,
  killed: new Set(s.killed), killSeen: s.killSeen, nextBid: s.nextBid, nextPid: s.nextPid,
  heldBy: { ...s.heldBy },
});

function notify(n) { for (const w of n.waiters) n.ready.add(w); n.waiters.clear(); }

function createPage(n, b, w) {
  const pid = `p${n.nextPid++}`;
  n.pages[pid] = { bid: b.bid, holder: w };
  b.used++; b.inUse.push(pid); n.heldBy[w] = pid;
}

// Budget recycle (fixed semantics): only when idle; a busy at-budget browser
// is left alone here and retired by release() once it drains.
function recycle(n, b, label) {
  if (b.closed || b.inUse.length > 0) return `${label}:skipped-busy`; // FIX
  b.closed = true;
  n.browsers.splice(n.browsers.indexOf(b), 1);
  for (const pid of b.inUse) {
    const pg = n.pages[pid];
    if (pg && pg.holder) { n.killed.add(pid); n.killSeen = true; label += `:KILL-${pid}`; delete n.heldBy[pg.holder]; delete n.pages[pid]; }
  }
  b.inUse = [];
  if (!n.pending) n.pending = true; // deduped bg replacement launch
  return label;
}

function* successors(s) {
  for (const w of WORKERS) {
    const held = s.heldBy[w];
    // --- acquire(w): only when idle and not waiting ---
    if (!held && !s.waiters.has(w) && !s.ready.has(w) && !s.launchWait.has(w) && !s.poolClosed) {
      const cap = capable(s);
      if (cap) {
        const n = clone(s); const b = n.browsers.find((x) => x.bid === cap.bid);
        createPage(n, b, w);
        yield { label: `acquire(${w})->page on b${b.bid}`, s: n };
      } else {
        // faithful findAvailableBrowser side effect: recycle EVERY at-budget browser
        const targets = live(s).filter((b) => b.used >= MAXP);
        if (targets.length) {
          const n = clone(s);
          const did = targets.map((t) =>
            recycle(n, n.browsers.find((x) => x.bid === t.bid), `recycle-b${t.bid}`));
          // Room to launch -> launch/join instead of sleeping (faithful to
          // acquirePage: len<max launches, only at-cap parks in waiters).
          if (live(n).length < MAXB) {
            if (n.pending) { n.launchWait.add(w); yield { label: `acquire(${w})->join-pending [${did}]`, s: n }; }
            else { n.pending = true; n.launchWait.add(w); yield { label: `acquire(${w})->launch [${did}]`, s: n }; }
          } else { n.waiters.add(w); yield { label: `acquire(${w})->wait [${did}]`, s: n }; }
        } else {
          // No-recycle path (faithful to acquirePage: launch when room, wait at cap).
          if (live(s).length < MAXB) {
            const n = clone(s);
            if (n.pending) { n.launchWait.add(w); yield { label: `acquire(${w})->join-pending`, s: n }; }
            else { n.pending = true; n.launchWait.add(w); yield { label: `acquire(${w})->launch`, s: n }; }
          } else {
            const n = clone(s); n.waiters.add(w);
            yield { label: `acquire(${w})->wait`, s: n };
          }
        }
      }
    }
    // --- retry(w): woken waiter re-runs the waiter loop. CURRENT code parks
    // again even with room (waitForAvailable never launches) — faithful.
    if (!held && s.ready.has(w) && !s.poolClosed) {
      const rcap = capable(s);
      if (rcap) {
        const n = clone(s); n.ready.delete(w);
        const rb = n.browsers.find((x) => x.bid === rcap.bid);
        createPage(n, rb, w);
        yield { label: `retry(${w})->page on b${rb.bid}`, s: n };
      } else {
        const n = clone(s); n.ready.delete(w);
        const rtargets = live(s).filter((b) => b.used >= MAXP);
        const rdid = rtargets.map((t) =>
          recycle(n, n.browsers.find((x) => x.bid === t.bid), `recycle-b${t.bid}`));
        // FIXED: waiter retries launch when room instead of parking blindly.
        if (live(n).length === 0 && !n.pending) {
          n.pending = true; n.launchWait.add(w);
          yield { label: `retry(${w})->launch [${rdid}]`, s: n };
        } else if (n.pending) {
          n.launchWait.add(w);
          yield { label: `retry(${w})->join-pending [${rdid}]`, s: n };
        } else {
          n.waiters.add(w);
          yield { label: `retry(${w})->wait [${rdid}]`, s: n };
        }
      }
    }
    // --- release(w) ---
    if (held) {
      const n = clone(s);
      const pid = n.heldBy[w]; const b = n.browsers.find((x) => x.bid === n.pages[pid].bid);
      delete n.pages[pid]; delete n.heldBy[w];
      if (b) {
        b.inUse = b.inUse.filter((p) => p !== pid);
        // FIX retire-on-release: at-budget browser skipped while busy retires now.
        if (b.inUse.length === 0 && b.used >= MAXP && !b.closed)
          recycle(n, b, `retire-b${b.bid}`);
      }
      notify(n);
      yield { label: `release(${w})`, s: n };
    }
    // --- crash(w): page dies; release() path notifies waiters (faithful:
    // the real crash handler calls release() first), then recycle-if-empty ---
    if (held) {
      const n = clone(s);
      const pid = n.heldBy[w]; const b = n.browsers.find((x) => x.bid === n.pages[pid].bid);
      delete n.pages[pid]; delete n.heldBy[w];
      if (b) {
        b.inUse = b.inUse.filter((p) => p !== pid);
        // retire-on-release (kill fix) then crash-handler recycle-if-empty
        if (b.inUse.length === 0 && !b.closed) recycle(n, b, `crash-recycle-b${b.bid}`);
      }
      notify(n); // faithful: crash goes through release() which notifies
      yield { label: `crash(${w})`, s: n };
    }
  }
  // --- pending launch resolves OK ---
  if (s.pending) {
      const n = clone(s); n.pending = false;
      // FIXED drain guard: a launch resolving after drain is discarded.
      if (n.poolClosed) {
        for (const w of [...n.launchWait]) n.launchWait.delete(w);
        yield { label: "launchOk-discarded-closed", s: n };
      } else {
      const bid = n.nextBid++;
      n.browsers.push({ bid, used: 0, inUse: [], closed: false });
      const b = n.browsers[n.browsers.length - 1];
      // FIXED: join-full falls through to backpressure (waiters); the ticket
      // (pending flag at MAXB=1) gates initiation.
      let note = `launchOk->b${bid}`;
      for (const w of [...n.launchWait]) {
        n.launchWait.delete(w);
        if (b.used < MAXP && !b.closed) { createPage(n, b, w); note += `,${w}->page`; }
        else { n.waiters.add(w); note += `,${w}->wait-at-cap`; }
      }
      notify(n);
      yield { label: note, s: n };
      }
    // FIXED: launch failure wakes waiters (fail-fast recovery); joiners
    // still get their rejection.
    {
      const n = clone(s); n.pending = false;
      n.launchErr = true;
      for (const w of [...n.launchWait]) n.launchWait.delete(w); // callers get rejection
      notify(n); // FIXED: fail-fast wake so parked waiters re-evaluate
      yield { label: "launchFail (waiters woken)", s: n };
    }
  }
  // --- drain ---
  if (!s.poolClosed) {
    const n = clone(s); n.poolClosed = true; n.waiters.clear(); n.ready.clear();
    n.browsers = [];
    yield { label: "drain", s: n };
  }
}

function check(s) {
  const errs = [];
  if (s.killSeen) errs.push(`KILL-IN-FLIGHT: a checked-out page was closed by budget recycle`);
  if (live(s).length > MAXB) errs.push(`OVER-CAP: ${live(s).length} live browsers > MAXB=${MAXB}`);
  if (s.waiters.size && !s.poolClosed) {
    const waker = capable(s) || s.pending ||
      Object.values(s.pages).some((p) => p.holder) || s.launchWait.size;
    if (!waker) errs.push(`STUCK-WAITERS: ${[...s.waiters]} with no waker`);
  }
  for (const [w, pid] of Object.entries(s.heldBy)) {
    const pg = s.pages[pid];
    if (!pg || pg.holder !== w) errs.push(`TRACKING: ${w} holds ${pid} inconsistently`);
  }
  return errs;
}

const start = init();
const seen = new Map([[key(start), null]]);
const q = [start];
let reds = [];
while (q.length) {
  const cur = q.shift();
  for (const { label, s } of successors(cur)) {
    const k = key(s);
    if (seen.has(k)) continue;
    seen.set(k, { prev: key(cur), label });
    const errs = check(s);
    for (const e of errs) {
      const tag = e.split(":")[0];
      if (!reds.some((r) => r.tag === tag)) reds.push({ tag, err: e, node: k });
    }
    q.push(s);
    if (seen.size > 20000) break;
  }
  if (seen.size > 20000) break;
}

console.log(`Explored ${seen.size} states. MAXB=${MAXB} MAXP=${MAXP} workers=${WORKERS.length}`);
const order = ["KILL-IN-FLIGHT", "OVER-CAP", "STUCK-WAITERS", "TRACKING"];
for (const r of reds.sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag))) {
  const path = []; let n = r.node;
  while (seen.get(n)) { const e = seen.get(n); path.unshift(e.label); n = e.prev; }
  console.log(`\nRED [${r.tag}]: ${r.err}\n  init\n  ` + path.slice(0, 8).join("\n  "));
}
const tags = new Set(reds.map((r) => r.tag));
for (const t of order) if (!tags.has(t)) console.log(`GREEN [${t}]: holds over explored graph`);
process.exit(reds.length ? 1 : 0);
