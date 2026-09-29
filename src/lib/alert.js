/* Slack alert for a protected file changed by the agent, throttled per path so
 * a looping agent doesn't spam the channel. Silently degrades to nothing when
 * alerting isn't available (experimental features off) or no channel was
 * given — an alert failure must never disturb the live view. */

const raw = (typeof yeet !== "undefined" && yeet.args) || {};

export const CHANNEL = raw.channel ?? raw.c ?? null;
const ALERT_THROTTLE_MS = Math.max(0, Number(raw["alert-throttle"] ?? 15000) | 0);

const lastAlert = new Map();

function blocksFor(c) {
  const actor = `${c.comm} (pid ${c.pid}, uid ${c.uid})`;
  const fields = [
    `*File*\n\`${c.newPath || c.path}\``,
    `*Operation*\n${c.op}${c.op === "rename" && c.path ? ` (from \`${c.path}\`)` : ""}`,
    `*Actor*\n${actor}`,
    `*When*\n<!date^${Math.floor(c.wall / 1000)}^{date_short_pretty} {time_secs}|now>`,
  ];
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:rotating_light: *md-sentry* — agent changed a protected file` },
    },
    { type: "section", fields: fields.map((t) => ({ type: "mrkdwn", text: t })) },
  ];
  if (c.preview) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Preview*\n\`\`\`${c.preview.slice(0, 280)}\`\`\`` },
    });
  }
  return blocks;
}

export async function maybeAlert(c) {
  if (!c.protected || !c.agent) return false;
  if (typeof yeet === "undefined" || typeof yeet.alert === "undefined") return false;
  if (!CHANNEL) return false;

  const key = c.newPath || c.path;
  const prev = lastAlert.get(key) || 0;
  if (c.wall - prev < ALERT_THROTTLE_MS) return false;
  lastAlert.set(key, c.wall);

  const text = `md-sentry: agent ${c.comm} (pid ${c.pid}) ${c.op} protected ${key}`;
  try {
    await yeet.alert({ method: "slack", channel: CHANNEL, text, blocks: blocksFor(c) });
    return true;
  } catch {
    return false;
  }
}
