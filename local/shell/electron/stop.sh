#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir

if stop_running_electron; then
  echo "electron stopped"
else
  echo "electron not running"
fi
