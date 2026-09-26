/**
 * Exhaustive model checker for strategy-memory.ts.
 * Checks the re-probe state machine and invariant:
 * - A domain must never remain stuck in reprobeNext = true after
 *   a success (either cheaper or remembered).
 */
const MAX_SUCCESS = 10;
const STRATEGIES = ["plain", "wreq", "browser"];

function init() {
  return {
    lastSuccess: "browser",
    successCount: 0,
    reprobeNext: false,
    state: "idle", // idle | fetching | reprobing
  };
}

const key = (s) => JSON.stringify([s.lastSuccess, s.successCount, s.reprobeNext, s.state]);

function* successors(s, buggy = false) {
  if (s.state === "idle") {
    if (!s.reprobeNext) {
      // Normal fetch
      yield { label: "startNormal", s: { ...s, state: "fetching" } };
    } else {
      // Re-probe fetch
      yield { label: "startReprobe", s: { ...s, state: "reprobing" } };
    }
  } else if (s.state === "fetching") {
    // Normal fetch succeeds at remembered rung
    const count = s.successCount + 1;
    if (count >= MAX_SUCCESS) {
      yield {
        label: `succeedNormal(reprobeScheduled)`,
        s: { ...s, successCount: 0, reprobeNext: true, state: "idle" },
      };
    } else {
      yield {
        label: `succeedNormal(${count})`,
        s: { ...s, successCount: count, state: "idle" },
      };
    }
  } else if (s.state === "reprobing") {
    // 1. Cheaper strategy succeeds (e.g. plain or wreq)
    const currentIdx = STRATEGIES.indexOf(s.lastSuccess);
    for (let i = 0; i < currentIdx; i++) {
      yield {
        label: `reprobeCheaperSucceeds(${STRATEGIES[i]})`,
        s: {
          ...s,
          lastSuccess: STRATEGIES[i],
          successCount: 1,
          reprobeNext: false,
          state: "idle",
        },
      };
    }

    // 2. Cheaper fails, remembered strategy succeeds
    if (buggy) {
      // BUGGY: else branch doesn't clear reprobeNext
      yield {
        label: "reprobeRememberedSucceeds[BUGGY]",
        s: { ...s, successCount: 1, state: "idle" },
      };
    } else {
      // FIXED: clearing reprobeNext on re-probe completion
      yield {
        label: "reprobeRememberedSucceeds[FIXED]",
        s: { ...s, successCount: 1, reprobeNext: false, state: "idle" },
      };
    }
  }
}

function check(s) {
  // If we just finished a re-probe and succeeded at the remembered rung,
  // reprobeNext MUST be false so subsequent fetches don't keep re-probing forever.
  if (s.state === "idle" && s.successCount === 1 && s.reprobeNext) {
    return [`STUCK_REPROBE: reprobeNext is true after successful fetch at remembered rung ${s.lastSuccess}`];
  }
  return [];
}

// Run buggy mode
console.log("=== CHECKING PRE-FIX (BUGGY) MODEL ===");
{
  const start = init();
  const seen = new Map([[key(start), null]]);
  const q = [start];
  let red = null;

  while (q.length && !red) {
    const cur = q.shift();
    for (const { label, s } of successors(cur, true)) {
      const k = key(s);
      if (seen.has(k)) continue;
      seen.set(k, { prev: key(cur), label });
      const errs = check(s);
      if (errs.length) { red = { err: errs[0], node: k }; break; }
      q.push(s);
    }
  }

  if (red) {
    const path = []; let n = red.node;
    while (seen.get(n)) { const e = seen.get(n); path.unshift(e.label); n = e.prev; }
    console.log(`RED: ${red.err}`);
    console.log("  " + path.join(" -> "));
  } else {
    console.log("GREEN");
  }
}

// Run fixed mode
console.log("\n=== CHECKING POST-FIX MODEL ===");
{
  const start = init();
  const seen = new Map([[key(start), null]]);
  const q = [start];
  let red = null;

  while (q.length && !red) {
    const cur = q.shift();
    for (const { label, s } of successors(cur, false)) {
      const k = key(s);
      if (seen.has(k)) continue;
      seen.set(k, { prev: key(cur), label });
      const errs = check(s);
      if (errs.length) { red = { err: errs[0], node: k }; break; }
      q.push(s);
    }
  }

  if (red) {
    console.log(`RED: ${red.err}`);
  } else {
    console.log(`GREEN: All ${seen.size} states satisfy invariant (no stuck re-probe)`);
  }
}
