#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir
ensure_electron_bin
build_assistant

if RUNNING_PID="$(find_running_assistant_pid)"; then
  echo "assistant already running (pid: $RUNNING_PID)"
  echo "log: $LOG_FILE"
  exit 0
fi

NEW_PID="$(start_assistant)"

echo "assistant started (pid: $NEW_PID)"
echo "log: $LOG_FILE"
