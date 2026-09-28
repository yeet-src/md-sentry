// The protected board: one row per protected glob with its most recent change,
// loudest (most recently touched) first. This is the "is anything wrong right
// now" panel — the feed below it is the evidence.
import { Box, Text } from "yeet:tui";
import { sortBoard } from "@/lib/model.js";
import {
  C_BAD, C_DIM, C_EXT, C_FAINT, C_TEXT, basename, hhmmss, opColor, pad,
} from "@/lib/format.js";
import { shortGlob } from "@/lib/glob.js";

const LABEL_W = 22;

const Row = ({ row }) => {
  if (!row.last) {
    return (
      <Text height="1" break="none">
        <Text fg={C_FAINT}>{"  " + pad(shortGlob(row.pattern), LABEL_W)}</Text>
        <Text fg={C_FAINT}>{"  no changes"}</Text>
      </Text>
    );
  }
  const c = row.last;
  return (
    <Text height="1" break="none" overflow="ellipsis">
      <Text bold fg={C_TEXT}>{"  " + pad(shortGlob(row.pattern), LABEL_W)}</Text>
      {"  "}
      <Text fg={opColor(c.op)}>{pad(c.op, 9)}</Text>
      <Text fg={C_DIM}>{hhmmss(c.wall) + " "}</Text>
      <Text bold fg={c.agent ? C_BAD : C_EXT}>{pad(c.agent ? "agent" : "external", 9)}</Text>
      <Text fg={C_DIM}>{`${c.comm}·${c.pid} `}</Text>
      <Text fg={C_TEXT}>{basename(c.path)}</Text>
    </Text>
  );
};

export default ({ snap, maxRows }) => (
  <Box overflow="hidden">
    {() => {
      const rows = sortBoard(snap.get().protected);
      const cap = Math.max(1, maxRows());
      const shown = rows.slice(0, cap);
      const out = shown.map((row) => <Row row={row} />);
      if (rows.length > cap) {
        out.push(
          <Text height="1" fg={C_FAINT}>{`  … +${rows.length - cap} more globs`}</Text>,
        );
      }
      return out;
    }}
  </Box>
);
