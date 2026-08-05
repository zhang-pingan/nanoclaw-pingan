#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

parse_host_mode "$@"

case "$HOST_MODE" in
  current)
    inspect_workflow_state current
    exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- node "$BACKEND_ENTRY"
    ;;
  active)
    exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" launch-active
    ;;
esac
