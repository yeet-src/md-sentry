/* md-sentry — a kernel-level integrity monitor for the markdown files that
 * steer an LLM agent: its instructions (CLAUDE.md / AGENTS.md), its memory,
 * and its skills. Every create / modify / delete / rename of a watched `.md`
 * file is caught in the kernel and shown in real time, tagged `agent` when the
 * change came from the agent's own process subtree and `external` when it came
 * from anything else (a human in vim, a different tool). A protected file
 * changed by the agent is the loud case — a red row and, if configured, a
 * Slack alert.
 *
 *   yeet run . -- --agent claude
 *   yeet run . -- --agent 12345 --channel C0123ABCD
 *
 * Flags:
 *   --agent <pid|substring>   the agent: a pid seeds its subtree, a string
 *                             matches a session by comm/argv0 (default "claude")
 *   --channel <id>            Slack channel for protected-agent alerts
 *
 * For a pipe-friendly stream of the same events, build and run the NDJSON
 * entry instead: `yeet run src/dump.bundle.js`.
 *
 *   kernel → user : probes/probe.js loads the object; probes/changes.js seeds
 *                   the agent subtree, subscribes to the ring buffer, and feeds
 *                   the pure model in lib/model.js.
 *
 * Layout: probes/ (BPF-aware) → components/ (pure UI) → lib/ (pure helpers),
 * composed here. This file owns view state and all keyboard input.
 *
 * This observes and reports. It cannot block a change — by the time the event
 * reaches here the write has already happened. */
import { Box, Text, mount } from "yeet:tui";
import { paused, setPaused, snap, start, status } from "@/probes/changes.js";
import { CHANNEL } from "@/lib/alert.js";
import { describeAgent } from "@/lib/scope.js";
import { C_FAINT } from "@/lib/format.js";
import TitleBar from "@/components/titlebar.jsx";
import Board from "@/components/board.jsx";
import Feed, { FeedHeader } from "@/components/feed.jsx";
import Footer from "@/components/footer.jsx";

import { tick } from "@/probes/changes.js";

// A probe that can't load degrades to a status line rather than rejecting into
// the void — the UI stays up and says what went wrong.
try {
  await start((err) => status.set(String(err?.message ?? err)));
} catch (err) {
  status.set(String(err?.message ?? err));
}

// ── input ────────────────────────────────────────────────────────────────────
tty.on("keydown", (e) => {
  const k = (e.key ?? "").toLowerCase();
  if (e.code === "Escape" || k === "q") return yeet.exit();
  if (k === "p") return setPaused(!paused.get());
});

// ── layout ───────────────────────────────────────────────────────────────────
const Rule = ({ label, width }) => (
  <Text height="1" break="none" fg={C_FAINT}>
    {() => "── " + label + " " + "─".repeat(Math.max(0, width() - label.length - 4))}
  </Text>
);

// Rows the feed may emit. It sits in a height="1fr" Box, so the layout already
// hands it the leftover space — this only has to agree with that. Emitting
// more rows than the viewport has makes the renderer write past the bottom of
// the screen, which shows up as stale fragments smeared across the panels.
const CHROME = 2;       // title rail + footer rail
const RULES = 2;        // the two section rules
const FEED_HEADER = 1;
// The board is capped at half the leftover so a long protected list can never
// crowd the feed out entirely.
const boardCap = (rows) => Math.max(3, Math.floor((rows - CHROME - RULES - FEED_HEADER) / 2));
const feedBudget = (rows) =>
  Math.max(3, rows - CHROME - RULES - FEED_HEADER - boardCap(rows));

const Root = (size) => {
  // `width` is a THUNK, never a snapshot. Passing size.get().cols as a plain
  // value reads the signal during view construction, which freezes that whole
  // subtree for the life of the process.
  const width = () => size.get().cols;
  return (
    <Box>
      <TitleBar snap={snap} agent={describeAgent()} channel={CHANNEL} paused={paused} tick={tick} />
      <Rule label="protected" width={width} />
      <Board snap={snap} maxRows={() => boardCap(size.get().rows)} />
      <Rule label="changes" width={width} />
      <FeedHeader width={width} />
      <Feed snap={snap} width={width} maxRows={() => feedBudget(size.get().rows)} />
      <Footer paused={paused} status={status} />
    </Box>
  );
};

mount(Root);
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
