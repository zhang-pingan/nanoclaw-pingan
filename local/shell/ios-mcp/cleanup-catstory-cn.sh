#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

repo_dir="$(ios_repo_dir)"
state_dir="$(ios_mcp_state_root)/catstory-cn"
lock_snapshot_dir="$state_dir/lockfiles"

if [ ! -d "$repo_dir" ]; then
  echo "iOS repo missing: $repo_dir"
  exit 1
fi

restore_lockfiles() {
  if [ ! -f "$lock_snapshot_dir/.complete" ]; then
    echo "no catstory lockfile snapshot found"
    return 0
  fi

  local relative
  local key
  local target
  for relative in pubspec.lock ios/Podfile.lock; do
    key="${relative//\//__}"
    target="$repo_dir/$relative"
    if [ "$(cat "$lock_snapshot_dir/$key.state")" = "present" ]; then
      mkdir -p "$(dirname "$target")"
      cp "$lock_snapshot_dir/$key" "$target"
    else
      rm -f "$target"
    fi
  done

  rm -rf "$lock_snapshot_dir"
  echo "catstory generated lockfiles restored"
}

restore_lockfiles

if [ -d "$repo_dir/DerivedData" ]; then
  rm -rf "$repo_dir/DerivedData"
  echo "removed catstory in-repo DerivedData"
fi

echo "catstory cn iOS cleanup complete"
