/**
 * Exhaustive model checker for cookie-cache key isolation.
 * Same machine as tla/CookieCache.tla, executed by BFS so it runs without
 * Java/TLC (CI has no JVM).
 *
 * Contract (src/cookie-cache.ts header): a cached cookie set is never replayed
 * under a different network/browser identity. The identity that shapes the
 * request in src/fetch.ts is (browser, os) — Sec-Ch-Ua-Platform and the UA
 * string both vary with `os`. cookieCacheKey() keys on (origin, proxy,
 * browser) only, so os-only-different renders collide.
 *
 * Invariant: a non-null read must only observe an entry written by the same
 * identity that is reading.
 *
 * Usage: node tla/check-cookie-model.mjs
 */
const IDENTITIES = [
  // origin, proxy, browser, os
  { id: "win", origin: "https://x.test", proxy: "", browser: "chrome_145", os: "windows" },
  { id: "lin", origin: "https://x.test", proxy: "", browser: "chrome_145", os: "linux" },
];

// Two candidate key definitions. `os` is the axis under test.
const keyPre = (i) => [i.origin, i.proxy, i.browser].join("|");
const keyPost = (i) => [i.origin, i.proxy, i.browser, i.os].join("|");

// The cookie set each identity harvested (writer-tagged, so a read can be
// checked against the reader's own identity).
const SET_OF = { win: "set_win", lin: "set_lin" };

function init() {
  return { store: {}, identity: null, read: null, writes: [] };
}

const key = (s) => JSON.stringify([
  Object.entries(s.store).sort(),
  s.identity,
  s.read === null ? null : s.read.tag,
]);

function* successors(s, KeyFn) {
  // Harvest under an identity and store it (tagged with its writer).
  for (const i of IDENTITIES) {
    const n = structuredClone(s);
    n.store[KeyFn(i)] = { tag: SET_OF[i.id], writer: i.id };
    n.writes.push(i.id);
    yield { label: `harvest(${i.id})->${KeyFn(i)}`, s: n };
  }
  // Warm-path read under an identity.
  for (const i of IDENTITIES) {
    const n = structuredClone(s);
    n.identity = i.id;
    n.read = n.store[KeyFn(i)] ?? null;
    yield { label: `read(${i.id},key=${KeyFn(i)})`, s: n };
  }
}

function check(s, KeyFn) {
  const errs = [];
  // Entries that exist in the store but collide across identities are the
  // mechanism; the observable defect is a cross-identity read.
  if (s.read && s.identity && s.read.writer !== s.identity) {
    errs.push(
      `CROSS-IDENTITY REPLAY: read under "${s.identity}" returned a set harvested by "${s.read.writer}"`,
    );
  }
  // Collision check: two different identities sharing one key.
  const byKey = new Map();
  for (const i of IDENTITIES) byKey.set(KeyFn(i), (byKey.get(KeyFn(i)) ?? []).concat(i.id));
  for (const [k, ids] of byKey) {
    if (ids.length > 1) errs.push(`KEY COLLISION: ${ids.join("+")} share key "${k}"`);
  }
  return errs;
}

function run(label, KeyFn) {
  const start = init();
  const seen = new Map([[key(start), null]]);
  const q = [start];
  const reds = [];
  while (q.length) {
    const cur = q.shift();
    for (const { label: a, s } of successors(cur, KeyFn)) {
      const k = key(s);
      if (seen.has(k)) continue;
      seen.set(k, { prev: key(cur), action: a });
      for (const e of check(s, KeyFn)) {
        const tag = e.split(":")[0];
        if (!reds.some((r) => r.tag === tag)) reds.push({ tag, err: e, node: k });
      }
      q.push(s);
    }
  }
  console.log(`\n=== ${label} (${seen.size} states) ===`);
  if (!reds.length) {
    console.log("GREEN: no cross-identity replay over the explored graph");
    return 0;
  }
  for (const r of reds) {
    const path = [];
    let n = r.node;
    while (seen.get(n)) { const e = seen.get(n); path.unshift(e.action); n = e.prev; }
    console.log(`RED [${r.tag}] ${r.err}`);
    console.log("  " + path.join("\n  "));
  }
  return 1;
}

const redPre = run("PRE-FIX key = (origin, proxy, browser)", keyPre);
const redPost = run("POST-FIX key = (origin, proxy, browser, os)", keyPost);

console.log(
  redPre && !redPost
    ? "\nRESULT: pre-fix red, post-fix green — the os axis is a real gap and the fix closes it."
    : `\nRESULT: unexpected (pre=${redPre}, post=${redPost})`,
);
process.exit(redPre && !redPost ? 0 : 1);
