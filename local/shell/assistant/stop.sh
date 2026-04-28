#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir

if stop_running_assistant; then
  echo "assistant stopped"
else
  echo "assistant not running"
fi
