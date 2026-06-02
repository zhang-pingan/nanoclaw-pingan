#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

status=0

if ! "$SCRIPT_DIR/revert-catapp-trace.sh"; then
  status=1
fi

if ! "$SCRIPT_DIR/cleanup-catstory-cn.sh"; then
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "catstory cn iOS MCP workflow exit cleaned"
else
  echo "catstory cn iOS MCP workflow exit cleanup had failures"
fi

exit "$status"
