#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Shared process helpers keep start/stop/restart behavior aligned.
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir
ensure_electron_bin
build_assistant

if stop_running_assistant; then
  ACTION="restarted"
else
  ACTION="started"
fi

NEW_PID="$(start_assistant)"

echo "assistant $ACTION (pid: $NEW_PID)"
echo "log: $LOG_FILE"
