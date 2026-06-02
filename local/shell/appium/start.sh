#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir
resolve_appium_bin

start_appium_service
echo "log: $LOG_FILE"
