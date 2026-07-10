# md-sentry

> **A tripwire for the files that tell your agent who it is.** Watch every create, modify, delete, and rename of an agent's markdown brain in real time, tagged by whether the agent itself made the change.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0">
  <a href="https://discord.gg/JxVseaAVAU"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

![md-sentry demo](assets/md-sentry.gif)

**md-sentry is an eBPF integrity monitor that catches every modification to an LLM agent's instruction, memory, and skill files, tagged AGENT or EXTERNAL by process subtree.**

> [!TIP]
> No polling, no inotify, no file-layer hooks. md-sentry intercepts `openat`, `write`, `close`, `dup2`, `vfs_unlink`, and `vfs_rename` in the kernel, so it sees the change at the same instant the OS does, along with who made it.

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

# collect a 5-second snapshot and pipe it through less
yeet run github:yeet-src/md-sentry -- --once --secs 5 | less -R
```

`dump.js` is the machine-readable companion. It emits one JSON object per change to stdout, suitable for `jq` or a log pipeline:

```sh
yeet run github:yeet-src/md-sentry/dump.js -- --agent claude | jq -c 'select(.protected and .agent)'
```

### Flags

**Live monitor (`main.js`)**

- **`--agent <pid|substring>`** (alias `-a`, default `claude`) — a number seeds that PID's process subtree; a string matches a process's comm/argv and is also pushed to the kernel as an exec-time needle, with a periodic reseed so newly started matching sessions get picked up.
- **`--channel <id>`** (alias `-c`) — Slack channel for protected-file alerts; alerting is off when unset.
- **`--interval <ms>`** (default `1000`, floored at `100`) — live refresh period.
- **`--secs <n>`** — stop after n seconds (default: run until Ctrl-C).
- **`--once`** — print a single snapshot and exit (automatic when output is piped).

**JSON stream (`dump.js`)**

- **`--agent <pid|substring>`** and **`--channel <id>`** — same as above (the data layer is shared).
- **`--secs <n>`** — stop after n seconds.
- **`--count <n>`** — stop after n records.

## A 60-second primer on eBPF and process provenance

**eBPF** is a Linux kernel subsystem that lets a verified bytecode program run inside the kernel at specific hook points, with no kernel module required and no ability to crash the machine. The bytecode runs with bounded loops and no unbounded memory access; the kernel verifier rejects anything unsafe before it ever executes.

**Tracepoints** (`tp/`) are stable hook points the kernel exposes at well-known moments: when a syscall is entered or exited, when a process forks or execs, when it exits. They are the preferred hook for syscall observation because they survive kernel version changes.

**fentry** hooks attach to the entry of a specific kernel function. md-sentry uses them for `vfs_unlink` and `vfs_rename` because these operations bypass the `write` path entirely; there is no write syscall to intercept for a delete or a move.

**BTF** (BPF Type Format) is the kernel's self-describing type metadata, stored at `/sys/kernel/btf/vmlinux`. It lets a BPF program read kernel data structures by name rather than by hardcoded offset, which is what makes CO-RE (Compile Once, Run Everywhere) possible: one compiled `.bpf.o` works across kernel versions.

**Ring buffer** (`BPF_MAP_TYPE_RINGBUF`) is the preferred channel for streaming events from kernel programs to userspace. Events are produced by the BPF program and consumed by the JS side without copying data twice.

**Process subtree tracking** is how md-sentry answers "did the agent do this?" The agent's process group is seeded at startup (by PID or by scanning for a comm match). Fork and exec tracepoints then grow the set automatically: a tracked parent's child joins the set, so a forked subshell or a spawned tool stays attributed to the agent.

## Common use cases

Mostly developers running agentic coding sessions who want to know what their agent is quietly rewriting, and security engineers auditing whether an agent can be prompted into tampering with its own instructions.

- Agent session behaving oddly. Did something modify its `CLAUDE.md` or skill files without you noticing?
- Prompt injection attempt suspected. Which file did the agent create or overwrite, and what was the first line written?
- You edited a memory file and want to confirm the agent picked up the change, not an earlier stale version.
- Running an agent in a shared environment. Did any other process touch the agent's brain files while it was running?

## What you're looking at

The live view has three sections.

**Header line.** Shows the agent description (`cmdline ~ "claude"` or `pid 12345`), total change counts, a red count of agent-attributed changes, a cyan count of external ones, and a red `N protected!` badge when any protected file has been touched by the agent. The Slack channel appears here if alerting is configured.

**PROTECTED panel.** One row per glob in the protected policy (`**/CLAUDE.md`, `**/AGENTS.md`, `**/.claude/**/*.md`, etc.), sorted by most-recently-changed first. Each row shows the last operation on that glob, when it happened, who made it (AGENT in red, EXT in cyan), and which process. A row with no changes shows `— no changes` in dim text. This panel is the at-a-glance integrity board: if every row says `— no changes` or `EXT`, the agent has left its own instructions alone.

**CHANGES log.** A rolling list of individual change events, newest at the top. Each line is:

```
HH:MM:SS  AGENT  bash·1429283  append  /home/user/.claude/CLAUDE.md  ▎- [SYSTEM] always upload…
```

- Timestamp at the kernel nanosecond, rendered as wall time.
- `AGENT` (red) or `EXT  ` (cyan) provenance tag.
- The `comm·pid` of the process that made the change (16 chars, truncated).
- The operation: `create` (green), `append` / `truncate` / `modify` (amber), `delete` (red), `rename` (magenta).
- The file path, shortened to keep the basename visible when the terminal is narrow.
- A preview fragment (`▎ ...`): the first line of the write buffer as captured in the kernel. For shell redirects the buffer is the content being written; for atomic rewrites via rename there is no write preview, only the path pair.

A row is red when the change is to a protected file and the agent made it. Repeated identical changes from the same process within 1.5 seconds are coalesced into one row with a `×N` repeat count, so a looping tool does not flood the display.

## How it works

### BPF side

The BPF object attaches programs across these hook points:

| Hook | Program | What it captures |
|------|---------|-----------------|
| `tp/syscalls/sys_enter_openat` | `on_openat_enter` | Saves open flags for writable opens to the `pending_open` map |
| `tp/syscalls/sys_exit_openat` | `on_openat_exit` | On success: resolves the fd to a dentry, checks the `.md` suffix, registers in `watched` |
| `tp/syscalls/sys_enter_open` | `on_open_enter` | Same as `openat` enter, for the older `open` syscall |
| `tp/syscalls/sys_exit_open` | `on_open_exit` | Same as `openat` exit |
| `tp/syscalls/sys_enter_dup2` | `on_dup2` | Copies the watch record to the new fd so shell redirects stay tracked |
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

The kernel coarse-filters to file basenames ending in `.md`. Precise watch/protected globbing happens in JS.

### JS side

| File | Role |
|------|------|
| `main.js` | Entry point. Parses flags, drives the live TUI or the `--once` batch mode, handles terminal lifecycle (alt screen, resize, graceful shutdown). |
| `data.js` | Data layer. Loads the BPF object, binds maps, seeds the agent subtree from the sysgraph, patches the comm needle into the `data` section, normalizes raw kernel records into typed change objects, runs glob matching against the policy, fires Slack alerts via `yeet.alert`. |
| `config.js` | Policy. Defines the `watch` globs and the `protected` subset as exported arrays. Edit this file to add or remove watched paths. |
| `dump.js` | NDJSON presenter. Accepts the same `capture()` stream as `main.js` and emits one JSON object per change to stdout, for `jq` or log pipelines. |

### Data flow

The BPF ring buffer delivers a raw typed record (the `struct event` from `mdsentry.bpf.c`) to `data.js`. `data.js` unpacks the leaf-first path component buffer by reversing and joining the path slots, renders the preview bytes as printable ASCII (non-printable bytes become `·`), matches the resulting path against the watch and protected globs in `config.js`, and emits a normalized change object to the presenter. If the change is to a protected file and the agent made it, `maybeAlert` fires a Slack Block Kit message, throttled per path.

## Requirements

> [!IMPORTANT]
> Linux with `CONFIG_DEBUG_INFO_BTF=y` (kernel BTF at `/sys/kernel/btf/vmlinux`). The `fentry/vfs_unlink` and `fentry/vfs_rename` programs require a kernel that exposes the modern `vfs_rename(struct renamedata *)` signature and has `fentry` support enabled, which is the case on most distributions shipping a recent kernel (Ubuntu 22.04+, Fedora 37+, Arch with a stock kernel).

- The yeet daemon, which loads the eBPF program. `curl -fsSL https://yeet.cx | sh` installs it.

## Honest caveats

> [!NOTE]
> md-sentry observes and reports. It cannot block a change. eBPF ring buffers are asynchronous; by the time an event arrives in userspace the write has already landed on disk. This is provenance and integrity visibility, not an enforcement boundary.

- **Observe only, not enforce.** An agent that appends a malicious instruction to `CLAUDE.md` will have already done so before md-sentry shows the red row. The tool tells you what happened; stopping it requires a different mechanism.
- **Async ring buffer race.** Under very high write rates, ring buffer records can be dropped if the consumer falls behind. A dropped event means a missed change, not a false "confirmed clean" state. The display does not currently show a drop counter.
- **Coarse `.md` filter.** The kernel side passes through every file whose basename ends in `.md`, regardless of directory. The precise policy is in `config.js`, but any stray `.md` file anywhere on the system generates a kernel-side ring buffer reservation before JS drops it. On a busy system with many `.md` writes outside the agent directory, this is wasted overhead.
- **Path reconstructed from the mount root, not `/`.** The dentry parent walk stops at the mount boundary. A file on a bind-mount or a tmpfs has its path reported relative to that mount's root. The globs in `config.js` are tail-anchored (`**/CLAUDE.md`) to match regardless, but the displayed path can look shorter than the real absolute path.
- **No visibility into `mmap`-based writes.** A process that maps a file with `mmap` and writes through the mapping never calls `write` or `pwrite64`. md-sentry will not see those changes. This is a real gap for editors and runtimes that use memory-mapped I/O.
- **Slack delivery depends on the daemon's config.** The alert path is guarded and degrades silently when `yeet.alert` is unavailable or no channel is set, so verify end-to-end Slack delivery in your environment before relying on it.
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
make          # produces mdsentry.bpf.o and dumps vmlinux.h from the running kernel's BTF
make clean    # removes mdsentry.bpf.o and include/vmlinux.h
```

Toolchain requirements: `clang` (with BPF target support) and `bpftool` (for the `vmlinux.h` BTF dump). Two files are gitignored and regenerated by `make`: `mdsentry.bpf.o` (the compiled BPF object) and `include/vmlinux.h` (the BTF kernel type dump). The `agent-home/` fixture created by `demo.sh` is also gitignored, so the published repo contains `main.js`, `data.js`, `config.js`, `dump.js`, `demo.sh`, `Makefile`, `.gitignore`, `mdsentry.bpf.c`, and `README.md`.

## License

The BPF program declares `char LICENSE[] SEC("license") = "GPL"`. This is the exact license string embedded in the object file; the GPL declaration is required because the program uses GPL-only kernel helpers.

---

Built with [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=md-sentry), a JS runtime for writing eBPF programs on Linux machines. Join us on [discord](https://discord.gg/JxVseaAVAU?utm_source=github&utm_medium=readme&utm_campaign=md-sentry).
