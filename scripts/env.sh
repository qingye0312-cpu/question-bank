#!/bin/sh
QBANK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Reuse this checkout's optional Rust installation; ordinary clones use PATH.
if [ -d "$QBANK_ROOT/.tooling/cargo" ] && [ -d "$QBANK_ROOT/.tooling/rustup" ]; then
  export CARGO_HOME="$QBANK_ROOT/.tooling/cargo"
  export RUSTUP_HOME="$QBANK_ROOT/.tooling/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
# Preserve the original Mac setup without tying the script to one username.
QBANK_CODEX_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1 && [ -x "$QBANK_CODEX_RUNTIME/node/bin/node" ]; then
  export PATH="$QBANK_CODEX_RUNTIME/node/bin:$PATH"
fi
if ! command -v pnpm >/dev/null 2>&1 && [ -x "$QBANK_CODEX_RUNTIME/bin/fallback/pnpm" ]; then
  export PATH="$QBANK_CODEX_RUNTIME/bin/fallback:$PATH"
fi
cd "$QBANK_ROOT" || exit 1
exec "$@"
