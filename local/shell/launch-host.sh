#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

parse_host_mode "$@"

case "$HOST_MODE" in
  current)
    inspect_workflow_state current
    preflight_collaboration_store current
    exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- node "$BACKEND_ENTRY"
    ;;
  active)
    "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" verify-active
    preflight_collaboration_store active
    exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" launch-active
    ;;
esac
