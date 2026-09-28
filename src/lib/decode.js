/* Pure decoders for the raw bytes the kernel hands up. No BPF imports here —
 * these are exercised by the unit tests under test/ with plain arrays.
 *
 * The geometry constants mirror the kernel struct in src/bpf/probe.bpf.c; the
 * packed path buffers only decode correctly if both sides agree, so changing
 * one means changing the other. */

export const NCOMP = 12;
export const COMP_LEN = 40;

export function asBytes(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const a = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) a[i] = v.charCodeAt(i) & 0xff;
    return a;
  }
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v.length === "number") return Uint8Array.from(v);
  return Uint8Array.from(Object.values(v));
}

/* No TextDecoder in the isolate — decode by hand, stopping at the first NUL. */
export function cstr(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    const nul = v.indexOf("\0");
    return nul >= 0 ? v.slice(0, nul) : v;
  }
  let s = "";
  for (const b of Object.values(v)) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/* Reassemble the absolute path from the leaf-first packed component buffer.
 * Each COMP_LEN slot holds one NUL-terminated name; `depth` slots are valid.
 * A path deeper than the buffer is truncated, marked with a leading ellipsis
 * so it never silently looks rooted. */
export function unpackPath(buf, depth) {
  const bytes = asBytes(buf);
  if (!bytes || !depth) return "";
  const comps = [];
  const n = Math.min(depth, NCOMP);
  for (let i = 0; i < n; i++) {
    const start = i * COMP_LEN;
    let end = start;
    const lim = Math.min(start + COMP_LEN, bytes.length);
    while (end < lim && bytes[end] !== 0) end++;
    let s = "";
    for (let j = start; j < end; j++) s += String.fromCharCode(bytes[j]);
    comps.push(s);
  }
  comps.reverse();
  const joined = comps.join("/");
  return depth >= NCOMP ? "…/" + joined : "/" + joined;
}

/* Render the bounded write slice as a single readable line: printable ASCII
 * kept, everything else (control bytes, UTF-8 tails, binary) collapsed to a
 * middle dot, trimmed, and cut at the first newline so a multi-line write
 * shows its first line. */
export function preview(buf, len) {
  const bytes = asBytes(buf);
  if (!bytes || !len) return "";
  let s = "";
  const n = Math.min(len, bytes.length);
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0x0a || b === 0x0d) {
      if (s.length) break; /* first non-empty line only */
      continue;
    }
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "·";
  }
  return s.trim();
}

const OP_NAMES = {
  1: "create",
  2: "append",
  3: "truncate",
  4: "modify",
  5: "delete",
  6: "rename",
};

export const opName = (op) => OP_NAMES[op] || "modify";
