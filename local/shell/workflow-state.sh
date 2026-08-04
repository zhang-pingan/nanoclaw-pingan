#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

usage() {
  echo "Usage: $0 <inspect|reset> --mode <current|active>" >&2
  exit 64
}

[ "$#" -eq 3 ] || usage
COMMAND="$1"
[ "$COMMAND" = "inspect" ] || [ "$COMMAND" = "reset" ] || usage
[ "$2" = "--mode" ] || usage
MODE="$3"
[ "$MODE" = "current" ] || [ "$MODE" = "active" ] || usage

if [ "$COMMAND" = "reset" ]; then
  assert_icarus_not_running
fi

"$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" verify
exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- npx tsx "$WORKFLOW_STATE_CLI" \
  "$COMMAND" \
  --mode "$MODE" \
  --runtime-home "$RUNTIME_HOME"
