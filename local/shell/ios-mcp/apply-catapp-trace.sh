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

if [ ! -f "$patch_file" ]; then
  echo "patch file missing: $patch_file"
  exit 1
fi

(
  cd "$repo_dir"
  if git apply --recount --reverse --check "$patch_file" >/dev/null 2>&1; then
    echo "catapp Icarus trace patch already applied"
    exit 0
  fi

  if ! git apply --recount --check "$patch_file"; then
    echo "catapp Icarus trace patch cannot be applied cleanly"
    echo "check catapp working tree and patch drift"
    exit 1
  fi

  git apply --recount "$patch_file"
)

echo "catapp Icarus trace patch applied"
