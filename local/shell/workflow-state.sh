#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

usage() {
  echo "Usage:" >&2
  echo "  $0 inspect|reset --mode <current|active>" >&2
  echo "  $0 backup|backups" >&2
  echo "  $0 restore|resume|discard-incomplete --backup <backup-id>" >&2
  echo "  $0 gc --keep <count>" >&2
  exit 64
}

[ "$#" -ge 1 ] || usage
COMMAND="$1"
shift

case "$COMMAND" in
  inspect|reset)
    [ "$#" -eq 2 ] || usage
    [ "$1" = "--mode" ] || usage
    [ "$2" = "current" ] || [ "$2" = "active" ] || usage
    ;;
  backup|backups)
    [ "$#" -eq 0 ] || usage
    ;;
  restore|resume|discard-incomplete)
    [ "$#" -eq 2 ] || usage
    [ "$1" = "--backup" ] || usage
    [ -n "$2" ] || usage
    ;;
  gc)
    [ "$#" -eq 2 ] || usage
    [ "$1" = "--keep" ] || usage
    [[ "$2" =~ ^[0-9]+$ ]] || usage
    ;;
  *) usage ;;
esac

if [ "$COMMAND" != "inspect" ] && [ "$COMMAND" != "backups" ]; then
  assert_icarus_not_running
fi

"$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" verify
exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- npx tsx "$WORKFLOW_STATE_CLI" \
  "$COMMAND" \
  "$@" \
  --runtime-home "$RUNTIME_HOME"
