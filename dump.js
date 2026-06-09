/* md-sentry dump — every watched markdown change as newline-delimited JSON,
 * one object per change, straight from the kernel probe. Feed it to jq, a log
 * pipeline, or a file.
 *
 *   yeet run examples/md-sentry/dump.js
 *   yeet run examples/md-sentry/dump.js -- --agent claude | jq -c 'select(.protected and .agent)'
 *   yeet run examples/md-sentry/dump.js -- --agent 12345 --secs 10 > changes.ndjson
 *   yeet run examples/md-sentry/dump.js -- --count 20 | jq -r '[.op,.path,.comm,(.agent|tostring)]|@tsv'
 */

import { capture } from "./data.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};
const SECS = args.secs != null ? Number(args.secs) : null;
const COUNT = args.count != null ? Math.max(1, Number(args.count) | 0) : null;

let n = 0;
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
  cap = await capture(
    (c) => {
      if (stopped) return;
      console.log(JSON.stringify(c));
      if (COUNT && ++n >= COUNT) shutdown();
    },
    (err) => console.error(String((err && err.message) || err)),
  );
} catch (err) {
  console.error(String((err && err.message) || err));
  if (typeof yeet !== "undefined" && yeet.exit) yeet.exit();
}

if (cap && SECS != null) setTimeout(shutdown, SECS * 1000);
