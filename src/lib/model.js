/* The change log, as a pure model. No signals and no BPF in here: it takes
 * normalized change objects and answers "what should the screen show", which
 * makes it directly testable (test/model.test.mjs) and keeps probes/changes.js
 * to nothing but kernel plumbing. */

// Relative, not `@/`: this module is pure and the tests under test/ import it
// directly with node, which knows nothing about the bundle-time aliases.
import { compileMatchers } from "./glob.js";

const LOG_CAP = 500;
const COALESCE_MS = 1500;

/* Coalesce a tool that opens the same file twice in a breath (coreutils
 * `touch` does) into one row with a repeat count, while keeping genuinely
 * separate edits — including an agent appending on a loop — distinct. */
const sameChange = (a, b) =>
  a.pid === b.pid && a.op === b.op && a.path === b.path && a.newPath === b.newPath;

export function createTracker(protectedGlobs) {
  const log = [];
  const matchers = compileMatchers(protectedGlobs);
  const lastByGlob = new Map();
  const totals = { changes: 0, agent: 0, external: 0, protected: 0, agentProtected: 0 };
  // Monotonic id per distinct change, handed out at admission. The log is
  // capped and shifts from the front, so a consumer that streams (dump.js)
  // cannot use an index into it as a cursor — it would silently skip whatever
  // fell off. `seq` never resets, so "everything after seq N" stays exact.
  let seq = 0;

  /* Record this change as the latest for every protected glob it matches, on
   * either end of a rename. */
  const touch = (c) => {
    for (const m of matchers) {
      if (m.test(c.path) || (c.newPath && m.test(c.newPath))) lastByGlob.set(m.pattern, c);
    }
  };

  return {
    add(c) {
      const last = log[log.length - 1];
      if (last && sameChange(last, c) && c.wall - last.wall < COALESCE_MS) {
        last.count++;
        last.wall = c.wall;
        if (c.preview) last.preview = c.preview;
        touch(last);
        return last;
      }

      c.count = 1;
      c.seq = ++seq;
      log.push(c);
      if (log.length > LOG_CAP) log.shift();

      totals.changes++;
      if (c.agent) totals.agent++;
      else totals.external++;
      if (c.protected) totals.protected++;
      if (c.protected && c.agent) totals.agentProtected++;
      touch(c);
      return c;
    },

    /* A fresh snapshot each call: the UI publishes these into a signal, and a
     * signal only notifies on set(), so the arrays must be new objects. */
    snapshot() {
      return {
        log: log.slice(),
        totals: { ...totals },
        protected: matchers.map((m) => ({
          pattern: m.pattern,
          last: lastByGlob.get(m.pattern) || null,
        })),
      };
    },
  };
}

/* The protected board, loudest first: whatever changed most recently at the
 * top, globs nothing has touched at the bottom. */
export const sortBoard = (rows) =>
  [...rows].sort((a, b) => (b.last ? b.last.wall : -1) - (a.last ? a.last.wall : -1));
