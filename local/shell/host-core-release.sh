#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

usage() {
  echo "Usage: $0 snapshot <create|list|select|verify|remove> [options]" >&2
  echo "Legacy aliases: $0 <publish|activate> --version <label> [--skip-validation]" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage
ensure_core_runtime

if [ "$1" = "snapshot" ]; then
  [ "$#" -ge 2 ] || usage
  COMMAND_ARGUMENTS=("$@" --runtime-home "$RUNTIME_HOME")
else
  [ "$1" = "publish" ] || [ "$1" = "activate" ] || usage
  COMMAND_ARGUMENTS=("$@" --runtime-home "$RUNTIME_HOME")
fi

exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- npx tsx "$HOST_CORE_RELEASE_CLI" \
  "${COMMAND_ARGUMENTS[@]}"
