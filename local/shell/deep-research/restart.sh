#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

restart_service
echo "url: http://$HOST:$PORT"
echo "log: $LOG_FILE"
