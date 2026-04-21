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

# Prune builder cache so COPY steps are not stale
docker builder prune -f
echo "builder cache pruned"

# Rebuild container image without cache
SCRIPT_DIR="$(pwd)/container"
docker build --no-cache -t nanoclaw-agent:latest "$SCRIPT_DIR"
echo "container image rebuilt (no cache)"

# Restart service
restart_nanoclaw_service
echo "nanoclaw restarted"
