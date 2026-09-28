/* md-sentry dump — every watched markdown change as newline-delimited JSON,
 * one object per change, straight from the kernel probe. Feed it to jq, a log
 * pipeline, or a file. No TUI: this is the entry to pipe.
 *
 * Bundled to src/dump.bundle.js by `make` (the `@/` aliases below are
 * bundle-time only, so run the bundle, not this file):
 *
 *   yeet run src/dump.bundle.js
 *   yeet run src/dump.bundle.js -- --agent claude | jq -c 'select(.protected and .agent)'
 *   yeet run src/dump.bundle.js -- --agent 12345 --secs 10 > changes.ndjson
 *   yeet run src/dump.bundle.js -- --count 20 | jq -r '[.op,.path,.comm,(.agent|tostring)]|@tsv'
 */
import { snap, start } from "@/probes/changes.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};
const SECS = args.secs != null ? Number(args.secs) : null;
const COUNT = args.count != null ? Math.max(1, Number(args.count) | 0) : null;

let emitted = 0;
let stopped = false;
let cap = null;

async function shutdown() {
  if (stopped) return;
  stopped = true;
  if (cap) {
    try {
      await cap.stop();
    } catch {}
  }
  if (typeof yeet !== "undefined" && yeet.exit) yeet.exit();
}

try {
  cap = await start((err) => console.error(String(err?.message ?? err)));
} catch (err) {
  console.error(String(err?.message ?? err));
  await shutdown();
}

/* The probe publishes a snapshot on its own window rather than calling back
 * per event, so print whatever is new since the last look. The cursor is the
 * monotonic `seq` the tracker stamps on each change, NOT an index into `log` —
 * the log is capped and shifts from the front, so an index would skip whatever
 * fell off between polls under a fast agent. */
if (cap) {
  let lastSeq = 0;
  const pump = setInterval(() => {
    if (stopped) return;
    for (const c of snap.get().log) {
      if (c.seq <= lastSeq) continue;
      lastSeq = c.seq;
      console.log(JSON.stringify(c));
      if (COUNT && ++emitted >= COUNT) {
        clearInterval(pump);
        shutdown();
        return;
      }
    }
  }, 200);

  if (SECS != null) setTimeout(shutdown, SECS * 1000);
}
