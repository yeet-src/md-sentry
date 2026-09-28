// Pure presentation: palette, string helpers. No signals, no BPF. Imported by
// components through the `@/` alias.
//
// Palette follows the house truecolor convention (pktscope/exectop): chrome
// stays dim so it recedes, data stays bright, and strong color is reserved for
// MEANING. Here the meaning is provenance and severity — red is the agent
// touching a protected file, and nothing else gets to be red.
import { rgb } from "yeet:tui";

export const C_BRAND = rgb(125, 211, 252);
export const C_TITLE = rgb(240, 246, 252);
export const C_TEXT = rgb(235, 240, 245);
export const C_DIM = rgb(120, 130, 140);
export const C_FAINT = rgb(80, 88, 98);
export const C_SLATE = rgb(148, 163, 184);
export const C_OK = rgb(74, 222, 128);
export const C_WARN = rgb(251, 191, 36);
export const C_BAD = rgb(248, 113, 113);
export const C_EXT = rgb(34, 211, 238);   // cyan — a change from outside the agent
export const C_RENAME = rgb(232, 121, 249);
export const C_SEL_BG = rgb(38, 66, 104);
export const C_RAIL = rgb(28, 32, 38);
export const C_CAP = rgb(52, 58, 66);

// One color per operation. The row's op cell carries it, so a delete reads as
// a delete without a legend.
export const OP_COLOR = {
  create: C_OK,
  append: C_WARN,
  truncate: C_WARN,
  modify: C_WARN,
  delete: C_BAD,
  rename: C_RENAME,
};
export const opColor = (op) => OP_COLOR[op] || C_WARN;

// The path's color IS the verdict: red when the agent touched something
// protected, amber for any other agent write, cyan when it came from outside.
export const pathColor = (c) =>
  c.agent && c.protected ? C_BAD : c.agent ? C_WARN : C_EXT;

export const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
export const lpad = (s, n) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
export const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…");

// Shorten a path from the LEFT, so the basename always survives — the file
// name is the thing you are reading for.
export function fitPath(path, width) {
  if (width <= 0) return "";
  if (path.length <= width) return path;
  if (width <= 1) return path.slice(-width);
  const base = path.slice(path.lastIndexOf("/"));
  if (base.length >= width - 1) return "…" + path.slice(-(width - 1));
  return path.slice(0, width - 1 - base.length) + "…" + base;
}

export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

// No Intl in the isolate — toLocaleString() throws "Icu error", which inside a
// render kills the whole TUI on the first frame that has data. Hand-roll it.
export const fmtCount = (n) => {
  const s = String(Math.round(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
};

export function hhmmss(ms) {
  const d = ms != null ? new Date(ms) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
