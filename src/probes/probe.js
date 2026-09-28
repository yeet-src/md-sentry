// The BPF object: loaded once, shared by every module that binds a map.
//
// All binds must happen before the single start(), so they live together here
// rather than being scattered across the modules that later read each map.
// `tracked` is seeded from JS (the agent's process subtree, resolved from the
// system graph) and then maintained in-kernel by the fork/exec/exit hooks;
// `probe.data` carries the comm needle that lets the kernel adopt agent
// sessions that start after we attach.
import { BpfObject } from "yeet:bpf";

// Bundled, this module sits at src/ so the object is one level up. Run
// standalone (the import.meta.main self-tests) it sits at src/probes/, so try
// that path too rather than making the self-test a special case.
const CANDIDATES = ["../bin/probe.bpf.o", "../../bin/probe.bpf.o"];

// The comm needle lives in .bss, NOT .data: `char needle[N] = ""` is
// zero-initialized, and clang puts zero-initialized globals in BSS. Binding
// "probe.data" bound a section that does not exist in this object, and the
// daemon reported that as a non-fatal "No service for map `probe.data`" —
// so the needle patch silently did nothing and comm-match mode never adopted
// agent sessions that started after attach. Check with:
//   bpftool btf dump file bin/probe.bpf.o | grep DATASEC
export const DATA_SEC = "probe.bss";

async function load() {
  let last;
  for (const exe of CANDIDATES) {
    try {
      return await new BpfObject({ exe, base: import.meta.dirname })
        .bind("events", { kind: "ringbuf", btf_struct: "event" })
        .bind("tracked", { kind: "hash" })
        .bind("pending_open", { kind: "hash" })
        .bind("watched", { kind: "lru-hash-map" })
        .bind(DATA_SEC, { kind: "data" })
        .start(); // the tracepoints and fentry probes auto-attach
    } catch (err) {
      last = err;
    }
  }
  // A load failure is almost always privileges or a kernel without BTF, and
  // the raw libbpf error says neither. Say what this program actually needs.
  const detail = last && (last.message || last.code)
    ? `${last.code ? `${last.code}: ` : ""}${last.message ?? ""}`.trim()
    : String(last);
  throw new Error(
    `Could not load the md-sentry eBPF probe${detail ? ` (${detail})` : ""}. ` +
      "It needs a kernel with BTF and the yeet daemon running with CAP_BPF " +
      "(it loads tracepoints on openat/write/close and fentry on vfs_unlink/vfs_rename).",
  );
}

export const control = await load();
