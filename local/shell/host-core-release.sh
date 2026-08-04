#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

usage() {
  echo "Usage: $0 <publish|activate> --version <version> [--skip-validation]" >&2
  echo "publish freezes without selecting; activate verifies release and runtime identity before selecting active-core" >&2
  exit 64
}

[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || usage
COMMAND="$1"
[ "$COMMAND" = "publish" ] || [ "$COMMAND" = "activate" ] || usage
[ "$2" = "--version" ] && [ -n "$3" ] || usage
VERSION="$3"
OPTION_ARGUMENTS=()
SEEN_SKIP=0
shift 3
for argument in "$@"; do
  case "$argument" in
    --skip-validation)
      [ "$SEEN_SKIP" -eq 0 ] || usage
      SEEN_SKIP=1
      ;;
    *) usage ;;
  esac
  OPTION_ARGUMENTS+=("$argument")
done

ensure_core_runtime
exec "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- npx tsx "$HOST_CORE_RELEASE_CLI" \
  "$COMMAND" \
  --version "$VERSION" \
  --runtime-home "$RUNTIME_HOME" \
  "${OPTION_ARGUMENTS[@]}"
