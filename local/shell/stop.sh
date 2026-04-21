#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Stop all nanoclaw containers
containers=$(docker ps -q --filter name=nanoclaw-)
if [ -n "$containers" ]; then
  docker stop $containers
  echo "containers stopped"
fi

if stop_nanoclaw_service; then
  echo "nanoclaw stopped"
else
  echo "nanoclaw already stopped"
fi
