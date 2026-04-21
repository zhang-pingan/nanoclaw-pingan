#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/common.sh"

cd "$ROOT_DIR"

# Stop all nanoclaw containers
containers=$(docker ps -q --filter name=nanoclaw-)
if [ -n "$containers" ]; then
  docker stop $containers
  echo "containers stopped"
fi

# Build host TypeScript
npm run build
echo "typescript compiled"

# Rebuild container image
./container/build.sh
echo "container image rebuilt"

# Restart service
restart_nanoclaw_service
echo "nanoclaw restarted"
