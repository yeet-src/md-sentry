// Title rail: what is being watched, the running tallies, and the clock.
// The one number that matters is `protected` — an agent writing to a file it
// is supposed to only read — so it is the only thing here allowed to be red.
import { Box, Text } from "yeet:tui";
import { C_BAD, C_BRAND, C_DIM, C_EXT, C_RAIL, C_TITLE, fmtCount, hhmmss } from "@/lib/format.js";

const SEP = <Text fg={C_DIM}>{"  ·  "}</Text>;

export default ({ snap, agent, channel, paused, tick }) => (
  <Box height="1" direction="row" bg={C_RAIL}>
    <Text break="none">
      {() => {
        const t = snap.get().totals;
        return [
          <Text bold fg={C_BRAND}>{" md-sentry "}</Text>,
          <Text fg={C_DIM}>{agent}</Text>,
          SEP,
          <Text fg={C_TITLE}>{fmtCount(t.changes)}</Text>, <Text fg={C_DIM}>{" changes"}</Text>,
          SEP,
          <Text fg={C_BAD}>{fmtCount(t.agent)}</Text>, <Text fg={C_DIM}>{" agent"}</Text>,
          SEP,
          <Text fg={C_EXT}>{fmtCount(t.external)}</Text>, <Text fg={C_DIM}>{" external"}</Text>,
          SEP,
          t.agentProtected
            ? <Text bold fg={C_BAD}>{`${fmtCount(t.agentProtected)} protected!`}</Text>
            : <Text fg={C_DIM}>{"0 protected"}</Text>,
        ];
      }}
    </Text>
    <Box width="1fr" />
    <Text break="none">
      {() => {
        tick.get(); // repaint the clock every publish window
        return [
          paused.get() ? <Text bold fg={C_BAD}>{"paused "}</Text> : "",
          channel ? <Text fg={C_DIM}>{`slack→${channel} `}</Text> : "",
          <Text fg={C_DIM}>{hhmmss() + " "}</Text>,
        ];
      }}
    </Text>
  </Box>
);
