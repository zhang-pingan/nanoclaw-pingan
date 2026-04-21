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

service_stopped=1
direct_stopped=1

if stop_nanoclaw_service; then
  service_stopped=0
fi

if stop_running_direct_nanoclaw; then
  echo "direct nanoclaw process stopped"
  direct_stopped=0
fi

if [ "$service_stopped" -eq 0 ] || [ "$direct_stopped" -eq 0 ]; then
  echo "nanoclaw stopped"
else
  echo "nanoclaw already stopped"
fi
