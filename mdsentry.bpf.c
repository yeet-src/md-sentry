/* vmlinux.h dumped from a recent kernel emits a block of kfunc/ksym
 * prototypes (e.g. bpf_stream_vprintk) that collide with the ones in an
 * older bundled bpf_helpers.h. We call no kfuncs, so suppress that block
 * — bpf_helpers.h supplies every helper we use. */
#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

/* md-sentry — watch the markdown files that steer an LLM agent (its
 * instructions, memory, and skills) and report every create / modify /
 * delete / rename in real time, tagged by who did it.
 *
 * Two questions decide each event, and the kernel side answers both:
 *
 *   WHAT changed — the file. Coarse-filtered here to basenames ending
 *   `.md`; the precise watch/protected globbing is JavaScript's job. The
 *   path is reconstructed by walking the dentry's parent chain into a
 *   leaf-first array of components (JS reverses and joins). The walk stops
 *   at its mount root, so a path is reported relative to the mount it lives
 *   on — fine for agent config, which sits on the rootfs.
 *
 *   WHO changed it — agent or human. A `tracked` set of tgids holds the
 *   agent's process subtree: seeded from the sysgraph in JS, grown at fork
 *   and exec (a tracked parent's children join; a fresh process whose comm
 *   matches the configured needle joins), pruned at exit. Every change event
 *   carries `agent = tgid ∈ tracked` — that one bit is the provenance.
 *
 * The change itself is caught at the syscall that performs it:
 *   - a writable openat/open registers the returned fd as watched and the
 *     open flags decide the op (append / truncate / create / modify);
 *   - the first write to a watched fd emits the change and snapshots a
 *     bounded slice of the user write buffer as a preview — the actual line
 *     being appended to CLAUDE.md, say;
 *   - close emits a create for a writable open that never wrote (a `touch`);
 *   - vfs_unlink and vfs_rename catch deletes and move/replace edits that a
 *     write-buffer hook would miss.
 *
 * This only ever observes and reports. eBPF here streams events up to JS
 * after the fact; it cannot and does not block the change. */

char LICENSE[] SEC("license") = "GPL";

#ifndef BPF_ANY
#define BPF_ANY 0
#endif

#ifndef S_IFMT
#define S_IFMT  0170000
#define S_IFREG 0100000
#endif

/* Open flags, defined locally rather than pulled from a uapi header so the
 * CO-RE object stays header-light. Values are the asm-generic ones every
 * common arch shares. */
#define O_ACCMODE 00000003
#define O_WRONLY  00000001
#define O_RDWR    00000002
#define O_CREAT   00000100
#define O_TRUNC   00001000
#define O_APPEND  00002000

enum md_op {
    MD_CREATE = 1,
    MD_APPEND,
    MD_TRUNC,
    MD_MODIFY,
    MD_DELETE,
    MD_RENAME,
};

/* Path is carried as leaf-first components packed into a flat byte buffer:
 * slot i lives at i*COMP_LEN and holds one NUL-terminated name, comp[0] the
 * basename. `depth` says how many slots are valid; JS reads only those,
 * reverses, and joins. Typing the buffers as __u8[] makes the daemon hand JS
 * a Uint8Array (not a string truncated at the first NUL), so the packing
 * survives the lift. NCOMP deep covers the agent-config paths that matter;
 * anything deeper is truncated and JS renders a leading ellipsis. */
#define NCOMP    12
#define COMP_LEN 40
#define PATH_LEN (NCOMP * COMP_LEN)
#define PREV_LEN 256
#define COMM_LEN 16
#define NEEDLE_LEN 16

struct event {
    __u64 ts;                    /* bpf_ktime_get_ns at the change */
    __u32 pid;                   /* tgid that performed the change */
    __u32 ppid;                  /* its parent tgid */
    __u32 uid;                   /* real uid */
    __u32 nbytes;                /* bytes the write asked for (0 if not a write) */
    __u8  agent;                 /* 1 = tgid is in the agent subtree */
    __u8  op;                    /* enum md_op */
    __u8  depth;                 /* valid slots in comp[] */
    __u8  ndepth;                /* valid slots in ncomp[] (rename target only) */
    __u16 prev_len;              /* bytes captured in preview[] */
    __u16 _pad;
    char  comm[COMM_LEN];
    __u8  comp[PATH_LEN];        /* leaf-first packed path of the changed file */
    __u8  ncomp[PATH_LEN];       /* leaf-first packed path of a rename's target */
    __u8  preview[PREV_LEN];     /* bounded slice of the write buffer */
};

/* Force the verifier/BTF to retain `struct event` so the daemon can lift
 * ring-buffer records into typed JS objects by name. */
__attribute__((used)) static const struct event __event_anchor;

/* The comm needle for exec-time membership, patched from JS. Empty (len 0)
 * disables comm matching — pid-seeded mode relies only on fork/exec
 * propagation from the seeded subtree. */
char needle[NEEDLE_LEN] = "";
__u32 needle_len = 0;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 20);
} events SEC(".maps");

/* The agent process subtree, by tgid. Seeded and queried from JS. */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 16384);
    __type(key, __u32);
    __type(value, __u8);
} tracked SEC(".maps");

/* Flags of an in-flight writable open, keyed by pid_tgid, carried from the
 * syscall enter (where the flags live) to its exit (where the fd lands). */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 16384);
    __type(key, __u64);
    __type(value, __u32);
} pending_open SEC(".maps");

struct md_watch {
    __u8 op;       /* op_from_flags of the open */
    __u8 emitted;  /* a change has already been reported for this fd */
};

/* fds that hold a writable handle to a watched `.md`, keyed by
 * (tgid << 32 | fd). LRU so a process that never closes — or an fd we miss
 * the close of — can't leak the table; eviction just drops a stale gate. */
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 8192);
    __type(key, __u64);
    __type(value, struct md_watch);
} watched SEC(".maps");

static __always_inline int is_tracked(__u32 tgid)
{
    return bpf_map_lookup_elem(&tracked, &tgid) != NULL;
}

static __always_inline void track(__u32 tgid)
{
    __u8 one = 1;
    bpf_map_update_elem(&tracked, &tgid, &one, BPF_ANY);
}

static __always_inline char to_lower(char c)
{
    return (c >= 'A' && c <= 'Z') ? c + 32 : c;
}

/* Does the current process's comm start with the configured needle? Used to
 * pick up a freshly exec'd agent session whose pid wasn't in the seed. */
static __always_inline int comm_matches(void)
{
    __u32 nl = needle_len;
    if (nl == 0 || nl > NEEDLE_LEN)
        return 0;

    char comm[COMM_LEN];
    bpf_get_current_comm(&comm, sizeof(comm));

    int ok = 1;
    for (int j = 0; j < NEEDLE_LEN; j++) {
        if ((__u32)j < nl && to_lower(comm[j & (COMM_LEN - 1)]) != needle[j])
            ok = 0;
    }
    return ok;
}

static __always_inline __u32 parent_tgid(void)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    return BPF_CORE_READ(task, real_parent, tgid);
}

/* Resolve a process fd to its struct file via the task's fd table — the same
 * lookup the kernel does, bounds-checked against the table's size. */
static __always_inline struct file *fd_file(__u32 fd)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    struct file **fdarray = BPF_CORE_READ(task, files, fdt, fd);
    __u32 max_fds = BPF_CORE_READ(task, files, fdt, max_fds);
    if (!fdarray || fd >= max_fds)
        return NULL;

    struct file *file = NULL;
    bpf_probe_read_kernel(&file, sizeof(file), &fdarray[fd]);
    return file;
}

static __always_inline int is_regular(struct file *file)
{
    umode_t mode = BPF_CORE_READ(file, f_inode, i_mode);
    return (mode & S_IFMT) == S_IFREG;
}

/* Coarse kernel-side filter: does this dentry's name end in ".md"? The full
 * watch/protected decision is JS's; this only keeps the ringbuf from carrying
 * every write on the box. */
static __always_inline int name_is_md(struct dentry *dentry)
{
    char nm[64];
    long r = bpf_probe_read_kernel_str(nm, sizeof(nm),
                                       BPF_CORE_READ(dentry, d_name.name));
    if (r < 4) /* "x.md\0" is the shortest match */
        return 0;
    __u32 len = (__u32)r - 1;
    if (len < 3 || len > 63)
        return 0;
    __u32 a = (len - 3) & 63, b = (len - 2) & 63, c = (len - 1) & 63;
    return nm[a] == '.' && nm[b] == 'm' && nm[c] == 'd';
}

/* Climb the dentry's parent chain into a leaf-first component array, stopping
 * at the mount root (a dentry whose parent is itself). Returns the count of
 * components written. The destination is the ring-buffer record, so the
 * variable-offset writes stay inside a bounded, verifier-visible region. */
static __always_inline __u8 walk_path(struct dentry *dentry, __u8 *comp)
{
    __u8 depth = 0;
    for (int i = 0; i < NCOMP; i++) {
        if (!dentry)
            break;
        struct dentry *parent = BPF_CORE_READ(dentry, d_parent);
        if (dentry == parent) /* mount root: its name is "/" — skip it */
            break;
        bpf_probe_read_kernel_str(comp + i * COMP_LEN, COMP_LEN,
                                  BPF_CORE_READ(dentry, d_name.name));
        depth++;
        dentry = parent;
    }
    return depth;
}

static __always_inline int is_writable(__u64 flags)
{
    __u32 acc = flags & O_ACCMODE;
    return acc == O_WRONLY || acc == O_RDWR;
}

/* The open's intent, most specific first: an append is an append even though
 * O_CREAT may also be set; a truncating open replaces content; a plain
 * O_CREAT is a create; anything else is an in-place modify. */
static __always_inline __u8 op_from_flags(__u32 f)
{
    if (f & O_APPEND)
        return MD_APPEND;
    if (f & O_TRUNC)
        return MD_TRUNC;
    if (f & O_CREAT)
        return MD_CREATE;
    return MD_MODIFY;
}

/* Reserve and submit one change event for the calling task. `nd` is the
 * rename target dentry (NULL otherwise); `ubuf`/`ucount` carry a user write
 * buffer to preview (NULL/0 otherwise). */
static __always_inline void emit(struct dentry *d, struct dentry *nd, __u8 op,
                                 const void *ubuf, __u64 ucount)
{
    __u32 tgid = bpf_get_current_pid_tgid() >> 32;

    struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return;

    /* No memset of the whole record (too large for the BPF backend to zero
     * in one call). Every scalar is assigned below, and the variable-length
     * buffers carry their own bound — depth, ndepth, prev_len — so JS never
     * reads past what was written; unwritten tail bytes stay uninterpreted. */
    e->ts = bpf_ktime_get_ns();
    e->pid = tgid;
    e->ppid = parent_tgid();
    e->uid = bpf_get_current_uid_gid();
    e->agent = is_tracked(tgid) ? 1 : 0;
    e->op = op;
    e->ndepth = 0;
    e->prev_len = 0;
    e->nbytes = 0;
    e->_pad = 0;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));

    e->depth = walk_path(d, e->comp);
    if (nd)
        e->ndepth = walk_path(nd, e->ncomp);

    if (ubuf && ucount) {
        __u32 n = ucount > PREV_LEN ? PREV_LEN : (__u32)ucount;
        if (bpf_probe_read_user(e->preview, n, ubuf) == 0)
            e->prev_len = n;
        e->nbytes = ucount > 0xffffffffULL ? 0xffffffffU : (__u32)ucount;
    }

    bpf_ringbuf_submit(e, 0);
}

SEC("tp/sched/sched_process_exec")
int handle_exec(struct trace_event_raw_sched_process_exec *ctx)
{
    __u32 tgid = bpf_get_current_pid_tgid() >> 32;
    if (is_tracked(parent_tgid()) || is_tracked(tgid) || comm_matches())
        track(tgid);
    return 0;
}

/* Runs in the parent's context, so a tracked parent's brand-new child joins
 * the subtree immediately — even a worker that forks but never execs. */
SEC("tp/sched/sched_process_fork")
int handle_fork(struct trace_event_raw_sched_process_fork *ctx)
{
    __u32 ptgid = bpf_get_current_pid_tgid() >> 32;
    if (is_tracked(ptgid))
        track((__u32)ctx->child_pid);
    return 0;
}

SEC("tp/sched/sched_process_exit")
int handle_exit(struct trace_event_raw_sched_process_template *ctx)
{
    __u64 id = bpf_get_current_pid_tgid();
    __u32 tgid = id >> 32;
    if ((__u32)id != tgid) /* a thread exit, not the process */
        return 0;
    bpf_map_delete_elem(&tracked, &tgid);
    return 0;
}

static __always_inline int open_enter(__u64 flags)
{
    if (!is_writable(flags))
        return 0;
    __u64 id = bpf_get_current_pid_tgid();
    __u32 fl = (__u32)flags;
    bpf_map_update_elem(&pending_open, &id, &fl, BPF_ANY);
    return 0;
}

static __always_inline int open_exit(long ret)
{
    __u64 id = bpf_get_current_pid_tgid();
    __u32 *flp = bpf_map_lookup_elem(&pending_open, &id);
    if (!flp)
        return 0;
    __u32 flags = *flp;
    bpf_map_delete_elem(&pending_open, &id);

    if (ret < 0)
        return 0;
    __u32 fd = (__u32)ret;

    struct file *file = fd_file(fd);
    if (!file || !is_regular(file))
        return 0;
    struct dentry *dentry = BPF_CORE_READ(file, f_path.dentry);
    if (!name_is_md(dentry))
        return 0;

    __u64 key = ((__u64)(id >> 32) << 32) | fd;
    struct md_watch w = { .op = op_from_flags(flags), .emitted = 0 };
    bpf_map_update_elem(&watched, &key, &w, BPF_ANY);
    return 0;
}

SEC("tp/syscalls/sys_enter_openat")
int on_openat_enter(struct trace_event_raw_sys_enter *ctx)
{
    return open_enter((__u64)ctx->args[2]); /* openat(dfd, path, flags, mode) */
}

SEC("tp/syscalls/sys_exit_openat")
int on_openat_exit(struct trace_event_raw_sys_exit *ctx)
{
    return open_exit(ctx->ret);
}

SEC("tp/syscalls/sys_enter_open")
int on_open_enter(struct trace_event_raw_sys_enter *ctx)
{
    return open_enter((__u64)ctx->args[1]); /* open(path, flags, mode) */
}

SEC("tp/syscalls/sys_exit_open")
int on_open_exit(struct trace_event_raw_sys_exit *ctx)
{
    return open_exit(ctx->ret);
}

/* A redirected write (`echo >> CLAUDE.md`) opens the file on one fd, dup2's
 * it onto another (stdout), and writes there — so the write never names the
 * fd we registered. Follow the dup: copy the watch to the new fd so the write
 * hook still finds it and can capture the preview. Done at enter, before the
 * call; dup2/dup3 to a fresh target almost always succeed, and a rare failure
 * only leaves a gate on an fd nothing writes to. */
static __always_inline void dup_watch(__u32 oldfd, __u32 newfd)
{
    if (oldfd == newfd)
        return;
    __u32 tgid = bpf_get_current_pid_tgid() >> 32;
    __u64 ok = ((__u64)tgid << 32) | oldfd;
    struct md_watch *w = bpf_map_lookup_elem(&watched, &ok);
    if (!w)
        return;
    __u64 nk = ((__u64)tgid << 32) | newfd;
    struct md_watch nw = { .op = w->op, .emitted = w->emitted };
    bpf_map_update_elem(&watched, &nk, &nw, BPF_ANY);
}

SEC("tp/syscalls/sys_enter_dup2")
int on_dup2(struct trace_event_raw_sys_enter *ctx)
{
    dup_watch((__u32)ctx->args[0], (__u32)ctx->args[1]);
    return 0;
}

SEC("tp/syscalls/sys_enter_dup3")
int on_dup3(struct trace_event_raw_sys_enter *ctx)
{
    dup_watch((__u32)ctx->args[0], (__u32)ctx->args[1]);
    return 0;
}

static __always_inline int do_write(__u32 fd, const void *buf, __u64 count)
{
    __u32 tgid = bpf_get_current_pid_tgid() >> 32;
    __u64 key = ((__u64)tgid << 32) | fd;

    struct md_watch *w = bpf_map_lookup_elem(&watched, &key);
    if (!w || w->emitted)
        return 0;
    w->emitted = 1;

    struct file *file = fd_file(fd);
    if (!file)
        return 0;
    emit(BPF_CORE_READ(file, f_path.dentry), NULL, w->op, buf, count);
    return 0;
}

SEC("tp/syscalls/sys_enter_write")
int on_write(struct trace_event_raw_sys_enter *ctx)
{
    return do_write((__u32)ctx->args[0], (const void *)ctx->args[1],
                    (__u64)ctx->args[2]);
}

SEC("tp/syscalls/sys_enter_pwrite64")
int on_pwrite(struct trace_event_raw_sys_enter *ctx)
{
    return do_write((__u32)ctx->args[0], (const void *)ctx->args[1],
                    (__u64)ctx->args[2]);
}

/* A writable .md open that closes without ever writing is a create with no
 * content — a `touch`, an editor opening a new buffer. Report it here, since
 * no write hook will. Restricted to creates: an append/truncate/modify that
 * never wrote is a no-op, and a redirected one already emitted via its dup
 * target, so reporting at close would double-count it. fd is still live at
 * close enter. */
SEC("tp/syscalls/sys_enter_close")
int on_close(struct trace_event_raw_sys_enter *ctx)
{
    __u32 tgid = bpf_get_current_pid_tgid() >> 32;
    __u64 key = ((__u64)tgid << 32) | (__u32)ctx->args[0];

    struct md_watch *w = bpf_map_lookup_elem(&watched, &key);
    if (!w)
        return 0;
    if (!w->emitted && w->op == MD_CREATE) {
        struct file *file = fd_file((__u32)ctx->args[0]);
        if (file)
            emit(BPF_CORE_READ(file, f_path.dentry), NULL, MD_CREATE, NULL, 0);
    }
    bpf_map_delete_elem(&watched, &key);
    return 0;
}

SEC("fentry/vfs_unlink")
int BPF_PROG(on_unlink, struct mnt_idmap *idmap, struct inode *dir,
             struct dentry *dentry)
{
    if (!dentry || !name_is_md(dentry))
        return 0;
    emit(dentry, NULL, MD_DELETE, NULL, 0);
    return 0;
}

SEC("fentry/vfs_rename")
int BPF_PROG(on_rename, struct renamedata *rd)
{
    struct dentry *od = BPF_CORE_READ(rd, old_dentry);
    struct dentry *nd = BPF_CORE_READ(rd, new_dentry);
    if (!name_is_md(od) && !name_is_md(nd))
        return 0;
    emit(od, nd, MD_RENAME, NULL, 0);
    return 0;
}
