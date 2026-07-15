#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/common.sh"

cd "$ROOT_DIR"

# Stop all Icarus containers
containers=$(docker ps -q --filter name=icarus-)
if [ -n "$containers" ]; then
  docker stop $containers
  echo "containers stopped"
fi

# Build host TypeScript with the managed Core toolchain
"$RUNTIME_TOOLCHAIN" install
"$RUNTIME_TOOLCHAIN" exec -- npm run build
echo "typescript compiled"

# Rebuild container image
./container/build.sh
echo "container image rebuilt"

# Restart service
restart_icarus_service
echo "icarus restarted"
