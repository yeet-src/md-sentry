/* md-sentry data layer — load the probe, decide who the agent is, and turn
 * raw kernel change records into normalized, classified change events. The
 * eBPF side (mdsentry.bpf.c) reports every create / modify / delete / rename
 * of a `.md` file along with the tgid that did it and a bit saying whether
 * that tgid is in the agent's process subtree. This module owns everything
 * above the kernel: seeding that subtree from the sysgraph, matching paths
 * against the watch/protected policy, building the path and preview, and
 * firing a Slack alert when the agent touches a protected file. main.js and
 * dump.js are pure presentation over what `capture()` emits. */

import { DataSec, HashMap, LruHashMap, RingBuf } from "yeet:bpf";
import bpf from "./mdsentry.bpf.o";

import policy from "./config.js";

/* Mirror the kernel struct's geometry so the packed path buffers decode the
 * same way they were written. */
const NCOMP = 12;
const COMP_LEN = 40;

/* libbpf truncates the object name to 8 chars for the internal data section;
 * "mdsentry" is already 8, so it stays clean. */
const DATA_SEC = "mdsentry.data";

const raw = (typeof yeet !== "undefined" && yeet.args) || {};

/* --agent <pid|substring>: a number seeds that process's subtree; a string
 * matches a session by comm / argv[0] basename and also primes the kernel's
 * exec-time needle so later sessions are picked up. Defaults to "claude". */
const agentArg = raw.agent ?? raw.a ?? "claude";
const AGENT_PID = /^\d+$/.test(String(agentArg)) ? Number(agentArg) : null;
const AGENT_MATCH = AGENT_PID == null ? String(agentArg).toLowerCase() : null;

/* Slack channel for protected-file alerts; alerting is skipped entirely if
 * unset or if the runtime has no yeet.alert (experimental features off). */
export const CHANNEL = raw.channel ?? raw.c ?? null;
const ALERT_THROTTLE_MS = Math.max(0, Number(raw["alert-throttle"] ?? 15000) | 0);

const OP_NAMES = {
  1: "create",
  2: "append",
  3: "truncate",
  4: "modify",
  5: "delete",
  6: "rename",
};

/* A change is a content change (vs a pure metadata create) when it carries a
 * write; used to decide alert wording and severity ordering. */
export function opName(op) {
  return OP_NAMES[op] || "modify";
}

function asBytes(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const a = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) a[i] = v.charCodeAt(i) & 0xff;
    return a;
  }
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v.length === "number") return Uint8Array.from(v);
  return Uint8Array.from(Object.values(v));
}

function cstr(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    const nul = v.indexOf("\0");
    return nul >= 0 ? v.slice(0, nul) : v;
  }
  let s = "";
  for (const b of Object.values(v)) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/* Reassemble the absolute path from the leaf-first packed component buffer.
 * Each COMP_LEN slot holds one NUL-terminated name; `depth` slots are valid.
 * A path deeper than the buffer is truncated, marked with a leading ellipsis
 * so it never silently looks rooted. */
function unpackPath(buf, depth) {
  const bytes = asBytes(buf);
  if (!bytes || !depth) return "";
  const comps = [];
  const n = Math.min(depth, NCOMP);
  for (let i = 0; i < n; i++) {
    const start = i * COMP_LEN;
    let end = start;
    const lim = Math.min(start + COMP_LEN, bytes.length);
    while (end < lim && bytes[end] !== 0) end++;
    let s = "";
    for (let j = start; j < end; j++) s += String.fromCharCode(bytes[j]);
    comps.push(s);
  }
  comps.reverse();
  const joined = comps.join("/");
  return depth >= NCOMP ? "…/" + joined : "/" + joined;
}

/* Render the bounded write slice as a single readable line: printable ASCII
 * kept, everything else (control bytes, UTF-8 tails, binary) collapsed to a
 * middle dot, trimmed, and cut at the first newline so a multi-line write
 * shows its first line. */
function preview(buf, len) {
  const bytes = asBytes(buf);
  if (!bytes || !len) return "";
  let s = "";
  const n = Math.min(len, bytes.length);
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0x0a || b === 0x0d) {
      if (s.length) break; /* first non-empty line only */
      continue;
    }
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "·";
  }
  return s.trim();
}

function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]*/)*"; /* any number of leading directories */
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".indexOf(c) >= 0) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

const WATCH_RES = policy.watch.map(globToRe);
const PROT_RES = policy.protected.map(globToRe);
const matchesAny = (res, path) => res.some((re) => re.test(path));

export function isWatched(path) {
  return matchesAny(WATCH_RES, path);
}
export function isProtected(path) {
  return matchesAny(PROT_RES, path);
}

/* The protected globs as labelled matchers, for the status panel. */
export const PROTECTED_GLOBS = policy.protected;
export function compileMatchers(globs) {
  return globs.map((pattern) => {
    const re = globToRe(pattern);
    return { pattern, test: (p) => re.test(p) };
  });
}

export function normalize(e) {
  const op = opName(e.op);
  const path = unpackPath(e.comp, e.depth >>> 0);
  const newPath = e.ndepth ? unpackPath(e.ncomp, e.ndepth >>> 0) : null;
  const prevLen = e.prev_len >>> 0;
  const text = prevLen ? preview(e.preview, prevLen) : "";

  /* A rename's "watched-ness" is true if either end is a watched file — a
   * move that lands a markdown file in a protected spot matters as much as
   * one that leaves it. */
  const watched = isWatched(path) || (newPath != null && isWatched(newPath));
  const prot = isProtected(path) || (newPath != null && isProtected(newPath));

  return {
    wall: Date.now(),
    pid: e.pid >>> 0,
    ppid: e.ppid >>> 0,
    uid: e.uid >>> 0,
    agent: !!(e.agent & 1),
    op,
    comm: cstr(e.comm) || "?",
    path,
    newPath,
    preview: text,
    nbytes: e.nbytes >>> 0,
    watched,
    protected: prot,
  };
}

/* Walk the sysgraph once and return the set of tgids that make up the agent:
 * the matching roots plus every descendant. In pid mode the root is the given
 * pid; in match mode every process whose comm or argv[0] basename contains the
 * needle is a root. The kernel keeps this set live afterward via fork/exec. */
export async function seedSubtree() {
  const res = await yeet.graph.query(`{ procs { pid stat { ppid comm } cmdline } }`);
  const list = (res && res.data && res.data.procs) || [];

  const children = new Map();
  const nodes = new Map();
  for (const p of list) {
    const st = p.stat;
    if (!st) continue;
    nodes.set(p.pid, { pid: p.pid, comm: st.comm || "", cmdline: (p.cmdline || []).join(" ") });
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(p.pid);
  }

  const roots = [];
  if (AGENT_PID != null) {
    if (nodes.has(AGENT_PID)) roots.push(AGENT_PID);
  } else {
    for (const n of nodes.values()) {
      const argv0 = n.cmdline.split(" ")[0] || "";
      const base = argv0.slice(argv0.lastIndexOf("/") + 1).toLowerCase();
      if (n.comm.toLowerCase().indexOf(AGENT_MATCH) >= 0 || base.indexOf(AGENT_MATCH) >= 0) {
        roots.push(n.pid);
      }
    }
  }

  const tracked = new Set();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    if (tracked.has(pid)) continue;
    tracked.add(pid);
    for (const kid of children.get(pid) || []) queue.push(kid);
  }
  return { tracked, roots, total: list.length };
}

export const describeAgent = () =>
  AGENT_PID != null ? `pid ${AGENT_PID}` : `cmdline ~ "${AGENT_MATCH}"`;

/* Slack alert for a protected file changed by the agent, throttled per path so
 * a looping agent doesn't spam the channel. Silently degrades to nothing when
 * alerting isn't available or no channel was given. */
const lastAlert = new Map();

function blocksFor(c) {
  const actor = `${c.comm} (pid ${c.pid}, uid ${c.uid})`;
  const fields = [
    `*File*\n\`${c.newPath || c.path}\``,
    `*Operation*\n${c.op}${c.op === "rename" && c.path ? ` (from \`${c.path}\`)` : ""}`,
    `*Actor*\n${actor}`,
    `*When*\n<!date^${Math.floor(c.wall / 1000)}^{date_short_pretty} {time_secs}|now>`,
  ];
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:rotating_light: *md-sentry* — agent changed a protected file` },
    },
    { type: "section", fields: fields.map((t) => ({ type: "mrkdwn", text: t })) },
  ];
  if (c.preview) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Preview*\n\`\`\`${c.preview.slice(0, 280)}\`\`\`` },
    });
  }
  return blocks;
}

export async function maybeAlert(c) {
  if (!c.protected || !c.agent) return false;
  if (typeof yeet === "undefined" || typeof yeet.alert === "undefined") return false;
  if (!CHANNEL) return false;

  const key = c.newPath || c.path;
  const now = c.wall;
  const prev = lastAlert.get(key) || 0;
  if (now - prev < ALERT_THROTTLE_MS) return false;
  lastAlert.set(key, now);

  const text = `md-sentry: agent ${c.comm} (pid ${c.pid}) ${c.op} protected ${key}`;
  try {
    await yeet.alert({ method: "slack", channel: CHANNEL, text, blocks: blocksFor(c) });
    return true;
  } catch {
    /* Experimental features off, bad channel, rate limit — never let an alert
     * failure disturb the live view. */
    return false;
  }
}

/* Load the probe, bind every map, seed the agent subtree, push the comm
 * needle, and stream normalized + classified changes to `onEvent`. Unwatched
 * `.md` changes (a stray README the policy doesn't cover) are dropped here so
 * consumers only ever see agent-brain files. Rejects with a privilege hint if
 * the daemon can't load or verify the program. */
export async function capture(onEvent, onError) {
  let control;
  try {
    control = await bpf
      .bind("events", { kind: "ringbuf", btf_struct: "event" })
      .bind("tracked", { kind: "hash_map" })
      .bind("pending_open", { kind: "hash_map" })
      .bind("watched", { kind: "lru_hash_map" })
      .bind(DATA_SEC, { kind: "data" })
      .start();
  } catch (e) {
    const detail = e && (e.message || e.code) ? `${e.code ? `${e.code}: ` : ""}${e.message ?? ""}`.trim() : String(e);
    throw new Error(
      `Could not load the md-sentry eBPF probe${detail ? ` (${detail})` : ""}. ` +
        "It needs a kernel with BTF and the yeet daemon running with CAP_BPF " +
        "(it loads tracepoints on openat/write/close and fentry on vfs_unlink/vfs_rename).",
    );
  }

  const tracked = new HashMap(control, "tracked");
  new HashMap(control, "pending_open");
  new LruHashMap(control, "watched");

  if (AGENT_MATCH) {
    const needle = AGENT_MATCH.slice(0, 15);
    try {
      const cfg = new DataSec(control, DATA_SEC);
      await cfg.patch({ needle, needle_len: needle.length });
    } catch (err) {
      onError && onError(err);
    }
  }

  let seeded = { tracked: new Set(), roots: [], total: 0 };
  async function reseed() {
    try {
      seeded = await seedSubtree();
      if (seeded.tracked.size) {
        const pairs = [...seeded.tracked].map((pid) => [pid, 1]);
        await tracked.updateBatch(pairs).catch(async () => {
          for (const [k, v] of pairs) await tracked.update(k, v).catch(() => {});
        });
      }
    } catch (err) {
      onError && onError(err);
    }
  }
  await reseed();
  /* New agent sessions can start after we attach; the kernel only propagates
   * to descendants of pids already in the set, so re-seed periodically to
   * adopt fresh roots (match mode) without missing their subtree. */
  const reseedTimer = AGENT_MATCH ? setInterval(reseed, 5000) : null;

  const ring = new RingBuf(control, "events");
  const sub = await ring.subscribe(
    (rec) => {
      const c = normalize(rec.event ?? rec);
      if (!c.watched) return;
      maybeAlert(c).catch(() => {});
      onEvent(c);
    },
    (err) => onError && onError(err),
  );

  return {
    seed: () => seeded,
    async stop() {
      if (reseedTimer) clearInterval(reseedTimer);
      try {
        await sub.unsubscribe();
      } catch {}
      try {
        await control.stop();
      } catch {}
    },
  };
}
