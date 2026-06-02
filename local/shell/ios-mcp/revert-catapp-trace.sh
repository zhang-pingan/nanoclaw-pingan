#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

repo_dir="$(ios_repo_dir)"
patch_file="$ROOT_DIR/local/ios-mcp/patches/catapp-icarus-trace.patch"

if [ ! -d "$repo_dir/.git" ]; then
  echo "catapp git repo missing: $repo_dir"
  exit 1
fi

(
  cd "$repo_dir"
  if git apply --recount --reverse --check "$patch_file" >/dev/null 2>&1; then
    git apply --recount --reverse "$patch_file"
    echo "catapp Icarus trace patch reverted"
  else
    echo "catapp Icarus trace patch is not applied"
  fi
)
