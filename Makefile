# Build the yeet script project.
#
#   make         — build everything (BPF objects + JS bundle)
#   make bpf     — compile bpf/*.bpf.c into bin/* only
#   make veristat — load the built object with veristat (verifier check on this kernel)
#   make bundle  — bundle the JS entry with esbuild
#   make clangd  — write a local .clangd pointing at the resolved toolchain
#   make clean   — remove build artifacts
#
# This is the build *frontend*: it orchestrates two independent
# compilers — clang for the BPF objects, esbuild for the JS bundle.
# Neither understands the other; the JS references compiled objects in
# bin/ only by path, resolved at runtime. `yeet run` invokes `make`
# automatically when running this project from a trusted remote source,
# so the default goal must leave the project runnable.
#
# clang, bpftool and esbuild come from the static toolchain resolved by
# build/toolchain.mk (a shared per-machine cache, or binaries vendored in
# the bootstrap repo) — so the build needs no system C/BPF toolchain.

.DEFAULT_GOAL := all

include build/toolchain.mk
include build/bpf.mk

all: bpf bundle

# Bundle the entry with the vendored esbuild. esbuild honors tsconfig `paths`
# (so `@/` resolves at bundle time), while `yeet:*` builtins and `*.bpf.o`
# objects stay external. The bundle is written to src/index.jsx, which the
# entry ladder prefers over src/main.jsx — so once built, that is what runs.
# The .jsx extension keeps the bundle eligible for component auto-mount.
# Compiled BPF objects in bin/ are loaded by path at runtime, never imported,
# so they are not bundled.
#
# The build needs no npm/node: the starter imports only `yeet:*` builtins and
# local `@/` modules, which esbuild resolves on its own. If you add third-party
# packages to package.json, install them into node_modules with the package
# manager of your choice — esbuild inlines whatever it finds there.
ESBUILD_FLAGS := --bundle --format=esm --platform=neutral \
	--main-fields=module,main --conditions=import,module \
	--jsx=automatic --jsx-import-source=yeet:tui

# Two entries, two bundles. src/main.jsx is the TUI and becomes src/index.jsx,
# which the entry ladder prefers — that is what `yeet run .` runs. src/dump.js
# is the pipe-friendly NDJSON entry, bundled beside it so `yeet run
# src/dump.bundle.js` works from a plain checkout with no build knowledge.
bundle: | toolchain
	$(ESBUILD) src/main.jsx $(ESBUILD_FLAGS) --outfile=src/index.jsx '--external:yeet:*' '--external:*.bpf.o'
	$(ESBUILD) src/dump.js  $(ESBUILD_FLAGS) --outfile=src/dump.bundle.js '--external:yeet:*' '--external:*.bpf.o'

clean: clean-bpf
	rm -rf node_modules dist src/index.jsx src/dump.bundle.js

.PHONY: all bundle clean
