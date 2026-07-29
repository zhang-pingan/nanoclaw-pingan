#!/bin/bash
set -euo pipefail

PATH="/usr/bin:/bin"
export PATH

resolve_self() {
  local target="$1"
  local directory
  local link
  local hops=0

  while [ -L "$target" ]; do
    hops=$((hops + 1))
    if [ "$hops" -gt 32 ]; then
      echo "icarus-runtime:path_resolution_failed" >&2
      exit 78
    fi
    directory="$(cd -P "$(dirname "$target")" && pwd)"
    link="$(readlink "$target")"
    if [[ "$link" = /* ]]; then
      target="$link"
    else
      target="$directory/$link"
    fi
  done

  directory="$(cd -P "$(dirname "$target")" && pwd)"
  printf '%s/%s\n' "$directory" "$(basename "$target")"
}

SELF_PATH="$(resolve_self "$0")"
RUNTIME_ROOT="$(cd -P "$(dirname "$SELF_PATH")/.." && pwd)"
TOOLCHAIN_EXECUTOR="$RUNTIME_ROOT/libexec/icarus-runtime-toolchain"

if [ ! -x "$TOOLCHAIN_EXECUTOR" ]; then
  echo "icarus-runtime:toolchain_executor_missing" >&2
  exit 78
fi

exec "$TOOLCHAIN_EXECUTOR" launcher-exec "$@"
