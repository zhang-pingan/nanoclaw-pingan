#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/common.sh"

cd "$ROOT_DIR"
parse_host_mode "$@"

# Stop all Icarus containers
containers=$(docker ps -q --filter name=icarus-)
if [ -n "$containers" ]; then
  docker stop $containers
  echo "containers stopped"
fi

# Prepare the selected Host Core without changing active-core
prepare_host_mode "$HOST_MODE"

# Prune builder cache so COPY steps are not stale
docker builder prune -f
echo "builder cache pruned"

# Rebuild container image without cache
SCRIPT_DIR="$(pwd)/container"
docker build --no-cache -t icarus-agent:latest "$SCRIPT_DIR"
echo "container image rebuilt (no cache)"

# Restart service
restart_icarus_service "$HOST_MODE"
echo "icarus restarted"
