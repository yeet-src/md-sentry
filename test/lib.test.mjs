// Unit tests for the pure layers: the glob policy that decides what is watched
// and protected, the decoders that turn packed kernel bytes back into a path,
// and the tracker's coalescing and protected-board bookkeeping.
//
// These need no kernel — which is the point. The policy is the part most
// likely to be edited (a new agent puts its brain somewhere new), and getting
// it wrong is silent: md-sentry just stops reporting a file.
//
//   node test/lib.test.mjs
import { compileMatchers, globToRe, shortGlob } from "../src/lib/glob.js";
import { COMP_LEN, cstr, opName, preview, unpackPath } from "../src/lib/decode.js";
import { createTracker, sortBoard } from "../src/lib/model.js";
import policy from "../src/lib/policy.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── glob ─────────────────────────────────────────────────────────────────────
const m = (glob, path) => globToRe(glob).test(path);

check("**/ spans any depth", m("**/CLAUDE.md", "/home/u/proj/CLAUDE.md"));
check("**/ also matches at root", m("**/CLAUDE.md", "/CLAUDE.md"));
check("basename is anchored", !m("**/CLAUDE.md", "/home/u/NOTCLAUDE.md"));
check("* does not cross a / on its own", !m("**/x/*.md", "/a/x/deep/c.md"));
check("dir glob matches nested", m("**/.claude/**/*.md", "/home/u/.claude/skills/x.md"));
check("dir glob matches direct child", m("**/.claude/**/*.md", "/home/u/.claude/x.md"));
check("dir glob needs the dir", !m("**/.claude/**/*.md", "/home/u/other/x.md"));
check("? is one char", m("**/NOTE?.md", "/a/NOTE1.md") && !m("**/NOTE?.md", "/a/NOTE12.md"));
check("dots are literal", !m("**/AGENTS.md", "/a/AGENTSXmd"));

// A path that matches `watch` but not `protected` must exist, or the two
// lists have silently converged and the distinction is doing nothing.
const watchOnly = policy.watch.filter((g) => !policy.protected.includes(g));
check("watch is a strict superset of protected", watchOnly.length > 0, watchOnly.join(","));
check("protected is a subset of watch",
  policy.protected.every((g) => policy.watch.includes(g)),
  policy.protected.filter((g) => !policy.watch.includes(g)).join(","));

eq("shortGlob trims the leading **/", shortGlob("**/.claude/**/*.md"), ".claude/…/*.md");

// ── decode ───────────────────────────────────────────────────────────────────
// Pack leaf-first components the way the kernel does: one NUL-terminated name
// per COMP_LEN slot, comp[0] the basename.
const pack = (names) => {
  const buf = new Uint8Array(names.length * COMP_LEN);
  names.forEach((n, i) => {
    for (let j = 0; j < n.length; j++) buf[i * COMP_LEN + j] = n.charCodeAt(j);
  });
  return buf;
};

eq("unpackPath reverses to an absolute path",
  unpackPath(pack(["CLAUDE.md", "proj", "u", "home"]), 4), "/home/u/proj/CLAUDE.md");
eq("unpackPath reads only `depth` slots",
  unpackPath(pack(["CLAUDE.md", "proj", "u", "home"]), 2), "/proj/CLAUDE.md");
eq("unpackPath of depth 0 is empty", unpackPath(pack(["x"]), 0), "");
// A path deeper than the buffer is truncated and must SAY so, never look rooted.
check("a too-deep path is marked with an ellipsis",
  unpackPath(pack(new Array(12).fill("d")), 12).startsWith("…/"));

eq("cstr stops at the first NUL", cstr([0x62, 0x61, 0x73, 0x68, 0, 0x78]), "bash");
eq("preview keeps printable ascii", preview(new Uint8Array([0x68, 0x69]), 2), "hi");
eq("preview collapses non-printables", preview(new Uint8Array([0x68, 0x01, 0x69]), 3), "h·i");
eq("preview cuts at the first line", preview(new Uint8Array([0x61, 0x0a, 0x62]), 3), "a");
eq("preview skips leading newlines", preview(new Uint8Array([0x0a, 0x61]), 2), "a");
eq("opName falls back to modify", opName(99), "modify");
eq("opName maps rename", opName(6), "rename");

// ── model ────────────────────────────────────────────────────────────────────
const mk = (over = {}) => ({
  wall: 1000, pid: 7, comm: "bash", op: "append",
  path: "/home/u/CLAUDE.md", newPath: null, preview: "", agent: true, protected: true,
  ...over,
});

{
  const t = createTracker(policy.protected);
  t.add(mk());
  t.add(mk({ wall: 1200 })); // same pid/op/path, inside the coalesce window
  const s = t.snapshot();
  eq("a repeat inside the window coalesces", s.log.length, 1);
  eq("the coalesced row counts the repeats", s.log[0].count, 2);
  eq("a coalesced repeat is not double-counted", s.totals.changes, 1);
}

{
  const t = createTracker(policy.protected);
  t.add(mk());
  t.add(mk({ wall: 5000 })); // past COALESCE_MS — a genuinely separate edit
  eq("a repeat past the window stays separate", t.snapshot().log.length, 2);
}

{
  const t = createTracker(policy.protected);
  t.add(mk({ agent: true, protected: true }));
  t.add(mk({ wall: 9000, agent: false, path: "/home/u/AGENTS.md" }));
  const s = t.snapshot();
  eq("agent/external are tallied apart", [s.totals.agent, s.totals.external], [1, 1]);
  eq("agent-on-protected is its own tally", s.totals.agentProtected, 1);
}

{
  // seq must be monotonic and survive the log cap, or dump.js silently skips
  // events once the log starts shifting.
  const t = createTracker(policy.protected);
  for (let i = 0; i < 600; i++) t.add(mk({ wall: 1000 + i * 5000, pid: i }));
  const log = t.snapshot().log;
  check("the log is capped", log.length === 500, String(log.length));
  check("seq keeps counting past the cap", log[log.length - 1].seq === 600, String(log[log.length - 1].seq));
  check("seq is strictly increasing", log.every((c, i) => i === 0 || c.seq > log[i - 1].seq));
}

{
  // A rename must register against BOTH ends: a move that lands a file in a
  // protected spot matters as much as one that leaves it.
  const t = createTracker(policy.protected);
  t.add(mk({ op: "rename", path: "/home/u/.claude/.tmp", newPath: "/home/u/AGENTS.md" }));
  const row = t.snapshot().protected.find((r) => r.pattern === "**/AGENTS.md");
  check("a rename's destination touches its glob", !!row.last);
}

{
  const t = createTracker(policy.protected);
  t.add(mk({ wall: 1000, path: "/home/u/CLAUDE.md" }));
  t.add(mk({ wall: 9000, path: "/home/u/AGENTS.md" }));
  const board = sortBoard(t.snapshot().protected);
  eq("the board puts the most recent change first", board[0].pattern, "**/AGENTS.md");
  check("globs with no change sort last", board[board.length - 1].last === null);
}

{
  const ms = compileMatchers(["**/CLAUDE.md"]);
  check("compileMatchers keeps the pattern as its label", ms[0].pattern === "**/CLAUDE.md");
  check("compileMatchers tests", ms[0].test("/a/b/CLAUDE.md"));
}

console.log(failed ? `\n${failed} failing` : "\nall passing");
process.exit(failed ? 1 : 0);
