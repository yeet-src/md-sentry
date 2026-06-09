/* What md-sentry watches, and what it treats as protected. Both are lists of
 * globs matched against the absolute path of any changed `.md` file (the
 * kernel coarse-filters to `.md`; these decide the rest). `**` spans any
 * number of directories, `*` any run within one, `?` a single character.
 *
 * The globs are tail-anchored on purpose — `**​/CLAUDE.md`, not `/home/.../
 * CLAUDE.md` — so they match wherever an agent keeps its brain, and so a path
 * reported relative to its mount (see the kernel side) still matches on the
 * part that survives.
 *
 * `protected` is the louder subset: a change to one of these by the agent is
 * the event worth a red row and a Slack alert. Keep `protected` a subset of
 * `watch`.
 *
 * Default export so data.js can import the whole policy as one object. There
 * is no filesystem in the isolate — this ships as code, not a file read at
 * runtime. */

const watch = [
  "**/CLAUDE.md", // Claude Code / Claude project instructions
  "**/AGENTS.md", // the cross-tool agent instruction convention
  "**/GEMINI.md",
  "**/.claude/**/*.md", // instructions, memory, skills under ~/.claude
  "**/MEMORY.md", // agent memory index
  "**/memory/**/*.md", // memory notes (this repo's own layout, OpenClaw, …)
  "**/skills/**/*.md", // skill definitions
  "**/*.skill.md",
  "**/commands/**/*.md", // slash-command prompts
  "**/.hermes/**/*.md", // Hermes skill/memory files
  "**/.openclaw/**/*.md", // OpenClaw markdown memory
];

const protected_ = [
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "**/.claude/**/*.md",
  "**/MEMORY.md",
  "**/memory/**/*.md",
  "**/skills/**/*.md",
  "**/*.skill.md",
  "**/.hermes/**/*.md",
  "**/.openclaw/**/*.md",
];

export default { watch, protected: protected_ };
