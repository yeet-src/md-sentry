// The change feed: every watched markdown change, newest first, one row each.
//
// Column order is the order you read the question in: when, who did it (agent
// or not), which process, what it did, to which file, and the line it wrote.
// The path is colored by verdict (red = agent touched something protected), so
// a bad row is visible without reading a word of it.
import { Box, Text } from "yeet:tui";
import {
  C_BAD, C_DIM, C_EXT, C_FAINT, C_TEXT, clip, fitPath, hhmmss, opColor, pad, pathColor,
} from "@/lib/format.js";

// Fixed left columns, so the leftover width can go to path + preview.
const TIME_W = 9;   // "hh:mm:ss" is exactly 8, so 9 leaves the gap
const WHO_W = 9;    // "agent" / "external"
const PROC_W = 17;  // comm·pid
const OP_W = 10;
const FIXED = TIME_W + WHO_W + PROC_W + OP_W + 2;

const Row = ({ c, cols }) => {
  const room = Math.max(10, cols - FIXED);
  const pathStr = c.newPath ? `${c.path} → ${c.newPath}` : c.path;
  // Weight the path so its basename always survives when a preview shares the
  // line; with no preview it gets the whole remainder.
  const pathW = c.preview ? Math.min(pathStr.length, Math.ceil(room * 0.55)) : Math.min(pathStr.length, room);
  const prevW = room - pathW - 3;

  return (
    <Text height="1" break="none" overflow="hidden">
      <Text fg={C_DIM}>{pad(hhmmss(c.wall), TIME_W)}</Text>
      <Text bold fg={c.agent ? C_BAD : C_EXT}>{pad(c.agent ? "agent" : "external", WHO_W)}</Text>
      <Text fg={C_FAINT}>{pad(clip(`${c.comm}·${c.pid}`, PROC_W - 1), PROC_W)}</Text>
      <Text fg={opColor(c.op)}>{pad(c.op + (c.count > 1 ? `×${c.count}` : ""), OP_W)}</Text>
      <Text fg={pathColor(c)}>{pad(fitPath(pathStr, pathW), pathW)}</Text>
      {c.preview && prevW > 4
        ? [<Text fg={C_FAINT}>{"  ▎"}</Text>, <Text fg={C_DIM}>{clip(c.preview, prevW)}</Text>]
        : ""}
    </Text>
  );
};

export const FeedHeader = ({ width }) => (
  <Text height="1" break="none" fg={C_FAINT}>
    {() =>
      pad("time", TIME_W) + pad("who", WHO_W) + pad("process", PROC_W) +
      pad("op", OP_W) + "file" + " ".repeat(Math.max(0, width() - FIXED - 4))}
  </Text>
);

export default ({ snap, width, maxRows }) => (
  <Box height="1fr" overflow="hidden">
    {() => {
      const log = snap.get().log;
      if (log.length === 0) {
        return (
          <Text height="1" fg={C_FAINT}>
            {"  watching — no watched markdown has changed yet"}
          </Text>
        );
      }
      const cols = width();
      // Newest first: take the tail of the log, then reverse it.
      return log.slice(-Math.max(1, maxRows())).reverse().map((c) => <Row c={c} cols={cols} />);
    }}
  </Box>
);
