#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

parse_host_mode "$@"
prepare_host_mode "$HOST_MODE"
start_icarus_service "$HOST_MODE"
echo "icarus started"
