/* md-sentry — a kernel-level integrity monitor for the markdown files that
 * steer an LLM agent: its instructions (CLAUDE.md / AGENTS.md), its memory,
 * and its skills. Every create / modify / delete / rename of a watched `.md`
 * file is caught in the kernel and shown in real time, tagged AGENT when the
 * change came from the agent's own process subtree and EXTERNAL when it came
 * from anything else (a human in vim, a different tool). A protected file
 * changed by the agent is the loud case — a red row and, if configured, a
 * Slack alert.
 *
 *   yeet run examples/md-sentry/main.js -- --agent claude
 *   yeet run examples/md-sentry/main.js -- --agent 12345 --channel C0123ABCD
 *   yeet run examples/md-sentry/main.js -- --once --secs 5 | less -R
 *
 * Flags:
 *   --agent <pid|substring>   the agent: a pid seeds its subtree, a string
 *                             matches a session by comm/argv0 (default "claude")
 *   --channel <id>            Slack channel for protected-agent alerts
 *   --interval N              redraw period in ms (default 1000)
 *   --secs N                  live: exit after N seconds; once: collection window
 *   --once                    collect a window, print one report, exit
 *                             (auto-selected when output is piped)
 *
 * This observes and reports. It cannot block a change — by the time the event
 * reaches here the write has already happened. */

import { CHANNEL, PROTECTED_GLOBS, capture, compileMatchers, describeAgent } from "./data.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};

const TTY = (typeof tty !== "undefined" && tty) || null;
const ONCE = !!args.once || !TTY;
const INTERVAL = Math.max(100, Number(args.interval ?? 1000) | 0);
const SECS = args.secs != null ? Math.max(0, Number(args.secs)) : null;
const WINDOW_MS = (SECS != null ? SECS : 3) * 1000;

const ESC = "\x1b";
const ERASE = `${ESC}[2K`;
const at = (row, col) => `${ESC}[${row};${col}H`;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visLen = (s) => stripAnsi(s).length;

function clip(line, width) {
  if (visLen(line) <= width) return line;
  let out = "";
  let vis = 0;
  for (let i = 0; i < line.length && vis < width; ) {
    const esc = line[i] === "\x1b" && /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
    } else {
      out += line[i++];
      vis++;
    }
  }
  return out.includes("\x1b[") ? out + "\x1b[0m" : out;
}

function fitPath(path, width) {
  if (width <= 0) return "";
  if (path.length <= width) return path;
  if (width <= 1) return path.slice(-width);
  const base = path.slice(path.lastIndexOf("/"));
  if (base.length >= width - 1) return "…" + path.slice(-(width - 1));
  const head = path.slice(0, width - 1 - base.length);
  return head + "…" + base;
}

function fit(text, width, align) {
  let s = String(text ?? "");
  if (s.length > width) s = width <= 1 ? s.slice(0, width) : s.slice(0, width - 1) + "…";
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

function log(msg = "") {
  const s = String(msg);
  console.log(TTY ? s.replace(/\r?\n/g, "\r\n") + "\r" : s);
}

const red = (s) => style.fg(String(s), 248, 113, 113);
const amber = (s) => style.fg(String(s), 251, 191, 36);
const cyan = (s) => style.fg(String(s), 34, 211, 238);
const green = (s) => style.fg(String(s), 74, 222, 128);
const magenta = (s) => style.fg(String(s), 232, 121, 249);
const slate = (s) => style.fg(String(s), 148, 163, 184);
const dim = (s) => style.dim(String(s));
const bold = (s) => style.bold(String(s));

const OP_COLOR = {
  create: green,
  append: amber,
  truncate: amber,
  modify: amber,
  delete: red,
  rename: magenta,
};
const paintOp = (op) => (OP_COLOR[op] || amber)(op);

function hhmmss(ms) {
  const d = ms != null ? new Date(ms) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LOG_CAP = 500;
const COALESCE_MS = 1500;

/* Coalesce a tool that opens the same file twice in a breath (coreutils
 * `touch` does) into one row with a repeat count, while keeping genuinely
 * separate edits — including an agent appending on a loop — distinct. */
const sameChange = (a, b) =>
  a.pid === b.pid && a.op === b.op && a.path === b.path && a.newPath === b.newPath;

class Tracker {
  constructor() {
    this.log = [];
    this.matchers = compileMatchers(PROTECTED_GLOBS);
    this.lastByGlob = new Map();
    this.totals = { changes: 0, agent: 0, external: 0, protected: 0, agentProtected: 0 };
  }

  add(c) {
    const last = this.log[this.log.length - 1];
    if (last && sameChange(last, c) && c.wall - last.wall < COALESCE_MS) {
      last.count++;
      last.wall = c.wall;
      if (c.preview) last.preview = c.preview;
      this.touch(last);
      return last;
    }

    c.count = 1;
    this.log.push(c);
    if (this.log.length > LOG_CAP) this.log.shift();

    this.totals.changes++;
    if (c.agent) this.totals.agent++;
    else this.totals.external++;
    if (c.protected) this.totals.protected++;
    if (c.protected && c.agent) this.totals.agentProtected++;
    this.touch(c);
    return c;
  }

  /* Record this change as the latest for every protected glob it matches, on
   * either end of a rename. */
  touch(c) {
    for (const m of this.matchers) {
      if (m.test(c.path) || (c.newPath && m.test(c.newPath))) {
        this.lastByGlob.set(m.pattern, c);
      }
    }
  }

  snapshot() {
    return {
      log: this.log,
      totals: this.totals,
      protected: this.matchers.map((m) => ({ pattern: m.pattern, last: this.lastByGlob.get(m.pattern) || null })),
    };
  }
}

const provTag = (c) => (c.agent ? red("AGENT") : cyan("EXT  "));

function paintPath(c, s) {
  if (c.agent && c.protected) return red(s);
  if (c.agent) return amber(s);
  return cyan(s);
}

function changeLine(c, cols) {
  const who = dim(fit(`${c.comm}·${c.pid}`, 16, "left"));
  const op = paintOp(c.op);
  const rep = c.count > 1 ? dim(`×${c.count}`) : "";
  const head = `${dim(hhmmss(c.wall))} ${provTag(c)} ${who} ${op} ${rep}`;

  /* Whatever the fixed left columns don't use goes to path + preview, with the
   * path weighted so its basename always survives when a preview is present. */
  const room = Math.max(10, cols - visLen(head) - 2);
  const pathStr = c.newPath ? `${c.path} → ${c.newPath}` : c.path;
  const pathW = c.preview ? Math.min(pathStr.length, Math.ceil(room * 0.55)) : Math.min(pathStr.length, room);
  let line = `${head} ${paintPath(c, fitPath(pathStr, pathW))}`;

  if (c.preview) {
    const prevW = cols - visLen(line) - 3;
    if (prevW > 4) line += dim("  ▎") + dim(fit(c.preview, prevW, "left"));
  }
  return line;
}

function shortGlob(p) {
  return p.replace(/^\*\*\//, "").replace(/\*\*/g, "…");
}

function protectedRow(row, cols) {
  const label = fit(shortGlob(row.pattern), 22, "left");
  if (!row.last) {
    return `  ${slate(label)}  ${dim("— no changes")}`;
  }
  const c = row.last;
  const tag = c.agent ? red("AGENT") : cyan("EXT");
  const file = c.path.slice(c.path.lastIndexOf("/") + 1);
  const tail = `${paintOp(c.op)} ${dim(hhmmss(c.wall))} ${tag} ${dim(`${c.comm}·${c.pid}`)} ${file}`;
  return clip(`  ${bold(label)}  ${tail}`, cols);
}

const rule = (cols) => dim("─".repeat(Math.max(1, cols)));

function headerLine(snap, cols) {
  const t = snap.totals;
  const parts = [
    bold("md-sentry"),
    dim(describeAgent()),
    `${t.changes} ${dim("changes")}`,
    `${red(String(t.agent))} ${dim("agent")}`,
    `${cyan(String(t.external))} ${dim("external")}`,
    t.agentProtected ? red(`${t.agentProtected} protected!`) : dim("0 protected"),
  ];
  const left = parts.join(dim("  ·  "));
  const slack = CHANNEL ? dim(`slack→${CHANNEL} `) : "";
  const time = slack + dim(hhmmss());
  const pad = cols - visLen(left) - visLen(time);
  return pad > 1 ? left + " ".repeat(pad) + time : left;
}

export function renderScreen(snap, cols, rows) {
  const finite = rows !== Infinity;
  const out = [headerLine(snap, cols), rule(cols)];

  /* Protected status board: every protected glob with its most recent change,
   * the louder ones (an agent touched them) first. */
  const board = [...snap.protected].sort((a, b) => {
    const la = a.last ? a.last.wall : -1;
    const lb = b.last ? b.last.wall : -1;
    return lb - la;
  });
  const boardCap = finite ? Math.min(board.length, Math.max(3, Math.floor((rows - 6) / 2))) : board.length;
  out.push(dim("PROTECTED"));
  for (const row of board.slice(0, boardCap)) out.push(protectedRow(row, cols));
  if (board.length > boardCap) out.push(dim(`  … +${board.length - boardCap} more globs`));
  out.push(rule(cols));

  out.push(dim("CHANGES"));
  if (snap.log.length === 0) {
    out.push("", dim("  watching — no watched markdown has changed yet"));
    return out.slice(0, finite ? rows : out.length).map((l) => clip(l, cols));
  }

  const avail = finite ? rows - out.length : snap.log.length;
  const recent = snap.log.slice(-Math.max(1, avail)).reverse();
  for (const c of recent) out.push(changeLine(c, cols));

  return out.slice(0, finite ? rows : out.length).map((l) => clip(l, cols));
}

function size() {
  const s = (TTY && TTY.size && TTY.size()) || {};
  return {
    cols: Math.max(40, (s.cols | 0) || 100),
    rows: Math.max(10, (s.rows | 0) || 24),
  };
}

let stopped = false;
let resolveDone;
const done = new Promise((r) => (resolveDone = r));

async function shutdown(cap, restore) {
  if (stopped) return;
  stopped = true;
  if (cap) await cap.stop();
  if (restore && TTY) {
    TTY.showCursor();
    TTY.main();
  }
  resolveDone();
  if (typeof yeet !== "undefined" && yeet.exit) yeet.exit();
}

function fail(err) {
  if (TTY) {
    TTY.showCursor();
    TTY.main();
  }
  console.error(String((err && err.message) || err));
  if (typeof yeet !== "undefined" && yeet.exit) yeet.exit();
}

async function live(tracker) {
  TTY.alt();
  TTY.hideCursor();
  TTY.clear();
  if (TTY.on) TTY.on("resize", () => TTY.clear());

  const draw = () => {
    try {
      const { cols, rows } = size();
      const lines = renderScreen(tracker.snapshot(), cols, rows);
      let out = "";
      let r = 1;
      for (const line of lines) out += at(r++, 1) + ERASE + line;
      for (; r <= rows; r++) out += at(r, 1) + ERASE;
      if (TTY.beginFrame) TTY.beginFrame();
      TTY.write(out);
      if (TTY.endFrame) TTY.endFrame();
    } catch {
      /* A single bad frame shouldn't tear the dashboard down. */
    }
  };

  let cap;
  try {
    cap = await capture((c) => tracker.add(c), (err) => console.error(String(err)));
  } catch (err) {
    return fail(err);
  }

  draw();
  const timer = setInterval(draw, INTERVAL);
  if (SECS != null) {
    setTimeout(() => {
      clearInterval(timer);
      shutdown(cap, true);
    }, SECS * 1000);
  }
  await done;
  clearInterval(timer);
}

function once(tracker) {
  capture((c) => tracker.add(c), (err) => console.error(String(err)))
    .then((cap) => {
      setTimeout(async () => {
        try {
          const { cols } = size();
          const snap = tracker.snapshot();
          if (snap.totals.changes === 0) {
            log(dim(`md-sentry — no watched markdown changed in ${WINDOW_MS / 1000}s (${describeAgent()})`));
          } else {
            for (const line of renderScreen(snap, cols, Infinity)) log(line);
          }
        } catch (err) {
          console.error(String((err && err.message) || err));
        }
        await shutdown(cap, false);
      }, WINDOW_MS);
    })
    .catch(fail);
}

if (import.meta.main) {
  const tracker = new Tracker();
  if (ONCE) {
    once(tracker);
  } else {
    live(tracker).catch(fail);
  }
  if (TTY) await done;
}
