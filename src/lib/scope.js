/* Who the agent is. `--agent <pid|substring>`: a number seeds that process's
 * subtree, a string matches a session by comm / argv[0] basename. The subtree
 * is resolved once from the system graph here; the kernel keeps it live after
 * that (fork adds children, exit prunes). */

const raw = (typeof yeet !== "undefined" && yeet.args) || {};

const agentArg = raw.agent ?? raw.a ?? "claude";
export const AGENT_PID = /^\d+$/.test(String(agentArg)) ? Number(agentArg) : null;
export const AGENT_MATCH = AGENT_PID == null ? String(agentArg).toLowerCase() : null;

export const describeAgent = () =>
  AGENT_PID != null ? `pid ${AGENT_PID}` : `cmdline ~ "${AGENT_MATCH}"`;

/* Walk the graph once and return the tgids that make up the agent: the
 * matching roots plus every descendant. In pid mode the root is the given pid;
 * in match mode every process whose comm or argv[0] basename contains the
 * needle is a root. */
export async function seedSubtree() {
  const res = await yeet.graph.query(`{ procs { pid stat { ppid comm } cmdline } }`);
  const list = (res && res.data && res.data.procs) || [];

  const children = new Map();
  const nodes = new Map();
  for (const p of list) {
    const st = p.stat;
    if (!st) continue;
    nodes.set(p.pid, { pid: p.pid, comm: st.comm || "", cmdline: (p.cmdline || []).join(" ") });
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(p.pid);
  }

  const roots = [];
  if (AGENT_PID != null) {
    if (nodes.has(AGENT_PID)) roots.push(AGENT_PID);
  } else {
    for (const n of nodes.values()) {
      const argv0 = n.cmdline.split(" ")[0] || "";
      const base = argv0.slice(argv0.lastIndexOf("/") + 1).toLowerCase();
      if (n.comm.toLowerCase().indexOf(AGENT_MATCH) >= 0 || base.indexOf(AGENT_MATCH) >= 0) {
        roots.push(n.pid);
      }
    }
  }

  const tracked = new Set();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    if (tracked.has(pid)) continue;
    tracked.add(pid);
    for (const kid of children.get(pid) || []) queue.push(kid);
  }
  return { tracked, roots, total: list.length };
}
