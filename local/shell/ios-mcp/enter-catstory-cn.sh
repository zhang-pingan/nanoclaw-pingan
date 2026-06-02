#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup_on_failure() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    "$SCRIPT_DIR/revert-catapp-trace.sh" >/dev/null 2>&1 || true
    "$SCRIPT_DIR/cleanup-catstory-cn.sh" >/dev/null 2>&1 || true
  fi
  return "$exit_code"
}

trap cleanup_on_failure EXIT

"$SCRIPT_DIR/prepare-catstory-cn.sh"
"$SCRIPT_DIR/apply-catapp-trace.sh"

echo "catstory cn iOS MCP workflow entry prepared"
