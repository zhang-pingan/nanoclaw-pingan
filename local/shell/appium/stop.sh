#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir

if stop_appium_service; then
  echo "appium stopped"
else
  echo "appium not running"
fi
