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

# Prepare the selected Host Core without changing formal activation pointers
prepare_host_mode "$HOST_MODE"

# Rebuild container image
./container/build.sh
echo "container image rebuilt"

# Restart service
restart_icarus_service "$HOST_MODE"
echo "icarus restarted"
