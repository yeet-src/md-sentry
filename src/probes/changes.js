/* The change stream as reactive signals. Loads nothing itself — probe.js owns
 * the object — but binds every map, seeds the agent subtree, subscribes to the
 * ring buffer once, and feeds the pure model in lib/model.js. The only
 * BPF-aware module besides probe.js; components read the signals below and
 * never see a map.
 *
 * The kernel reports every create / modify / delete / rename of a `.md` file
 * with the tgid that did it and a bit saying whether that tgid is in the
 * agent's subtree. Everything above that — policy matching, the path and
 * preview, the Slack alert — happens here. */
import { DataSec, HashMap, LruHashMap, RingBuf } from "yeet:bpf";
import { signal } from "yeet:tui";
import { control, DATA_SEC } from "@/probes/probe.js";
import policy from "@/lib/policy.js";
import { compileMatchers } from "@/lib/glob.js";
import { createTracker } from "@/lib/model.js";
import { cstr, opName, preview, unpackPath } from "@/lib/decode.js";
import { AGENT_MATCH, seedSubtree } from "@/lib/scope.js";
import { maybeAlert } from "@/lib/alert.js";

const WATCH = compileMatchers(policy.watch);
const PROT = compileMatchers(policy.protected);
const matchesAny = (ms, path) => ms.some((m) => m.test(path));

export const isWatched = (path) => matchesAny(WATCH, path);
export const isProtected = (path) => matchesAny(PROT, path);
export const PROTECTED_GLOBS = policy.protected;

/* Raw kernel record → a normalized, classified change. Pure given the policy,
 * so the tests drive it with fixture records. */
export function normalize(e) {
  const path = unpackPath(e.comp, e.depth >>> 0);
  const newPath = e.ndepth ? unpackPath(e.ncomp, e.ndepth >>> 0) : null;
  const prevLen = e.prev_len >>> 0;

  /* A rename's "watched-ness" is true if either end is watched — a move that
   * lands a markdown file in a protected spot matters as much as one that
   * leaves it. */
  const watched = isWatched(path) || (newPath != null && isWatched(newPath));
  const prot = isProtected(path) || (newPath != null && isProtected(newPath));

  return {
    wall: Date.now(),
    pid: e.pid >>> 0,
    ppid: e.ppid >>> 0,
    uid: e.uid >>> 0,
    agent: !!(e.agent & 1),
    op: opName(e.op),
    comm: cstr(e.comm) || "?",
    path,
    newPath,
    preview: prevLen ? preview(e.preview, prevLen) : "",
    nbytes: e.nbytes >>> 0,
    watched,
    protected: prot,
  };
}

// ── state the UI reads ───────────────────────────────────────────────────────
const tracker = createTracker(PROTECTED_GLOBS);

export const snap = signal(tracker.snapshot());
export const status = signal("starting");
export const seeded = signal({ tracked: 0, roots: 0, total: 0 });

// `tick` exists so a component can depend on "a frame passed" without reading
// the whole snapshot — the clock in the title rail, for instance.
export const tick = signal(0);

/* Mirror of the pause flag as a PLAIN boolean. The ring-buffer callback must
 * not read a signal: it fires outside the reactive graph, and with a render in
 * flight that read is a guard violation the subscription swallows — every
 * event silently dropped, no error anywhere. main.jsx flips it via setPaused. */
export const paused = signal(false);
let pausedFlag = false;
export const setPaused = (v) => {
  pausedFlag = v;
  paused.set(v);
};

// ── publish window ───────────────────────────────────────────────────────────
// Never .set() per event: a busy agent fires many changes a second, and one
// re-render per event is one per event too many. Accumulate into the tracker
// (a plain object) and publish a snapshot on a timer — one repaint per frame.
const PUBLISH_MS = 400;
let dirty = false;

const publish = () => {
  tick.update((n) => n + 1);
  if (!dirty) return;
  dirty = false;
  snap.set(tracker.snapshot());
};

/* Bind the maps, seed the subtree, push the comm needle, and start streaming.
 * Resolves once the ring buffer is subscribed; throws with a privilege hint if
 * the daemon can't load the program. */
export async function start(onError = () => {}) {
  const tracked = new HashMap(control, "tracked");
  new HashMap(control, "pending_open");
  new LruHashMap(control, "watched");

  if (AGENT_MATCH) {
    /* Prime the kernel's exec-time needle so agent sessions that start after
     * we attach are adopted without waiting for the next reseed. */
    const needle = AGENT_MATCH.slice(0, 15);
    try {
      await new DataSec(control, DATA_SEC).patch({ needle, needle_len: needle.length });
    } catch (err) {
      onError(err);
    }
  }

  async function reseed() {
    try {
      const s = await seedSubtree();
      seeded.set({ tracked: s.tracked.size, roots: s.roots.length, total: s.total });
      if (s.tracked.size) {
        const pairs = [...s.tracked].map((pid) => [pid, 1]);
        await tracked.updateBatch(pairs).catch(async () => {
          for (const [k, v] of pairs) await tracked.update(k, v).catch(() => {});
        });
      }
    } catch (err) {
      onError(err);
    }
  }
  await reseed();

  /* New agent sessions can start after we attach; the kernel only propagates
   * membership to descendants of pids already in the set, so re-seed
   * periodically to adopt fresh roots (match mode) without missing a subtree. */
  const reseedTimer = AGENT_MATCH ? setInterval(reseed, 5000) : null;

  const sub = await new RingBuf(control, "events").subscribe(
    (rec) => {
      if (pausedFlag) return;
      const c = normalize(rec.event ?? rec); // events are WRAPPED under btf_struct
      if (!c.watched) return;                // a stray README the policy doesn't cover
      maybeAlert(c).catch(() => {});
      tracker.add(c);
      dirty = true;
    },
    (err) => onError(err),
  );

  const timer = setInterval(publish, PUBLISH_MS);
  status.set("watching");

  return {
    async stop() {
      clearInterval(timer);
      if (reseedTimer) clearInterval(reseedTimer);
      try { await sub.unsubscribe(); } catch {}
      try { await control.stop(); } catch {}
    },
  };
}
