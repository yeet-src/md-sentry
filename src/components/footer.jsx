// Key-hint rail. Raised key-caps: the glyph in bold gold on a tile a shade
// lighter than the rail, then a dimmed label, so keys pop out of the line.
import { Box, Text } from "yeet:tui";
import { C_CAP, C_DIM, C_RAIL, C_WARN } from "@/lib/format.js";

const hint = (keys, label) => [
  <Text bg={C_CAP} bold fg={C_WARN}>{` ${keys} `}</Text>,
  <Text fg={C_DIM}>{` ${label}   `}</Text>,
];

export default ({ paused, status }) => (
  <Box height="1" direction="row" bg={C_RAIL}>
    <Text break="none">
      {() => ["  ", ...hint("p", paused.get() ? "resume" : "pause"), ...hint("q", "quit")]}
    </Text>
    <Box width="1fr" />
    <Text break="none" fg={C_DIM}>{() => status.get() + "  "}</Text>
  </Box>
);
