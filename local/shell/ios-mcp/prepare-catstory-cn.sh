#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

export PUB_HOSTED_URL="${PUB_HOSTED_URL:-https://pub.flutter-io.cn}"
export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"

plist_rubylib="$(find /opt/homebrew/Library/Homebrew/vendor/bundle/ruby -path '*/gems/plist-*/lib' -type d 2>/dev/null | sort | tail -n 1 || true)"
if [ -n "$plist_rubylib" ]; then
  export RUBYLIB="$plist_rubylib${RUBYLIB:+:$RUBYLIB}"
fi

repo_dir="$(ios_repo_dir)"
state_dir="$(ios_mcp_state_root)/catstory-cn"
lock_snapshot_dir="$state_dir/lockfiles"

snapshot_lockfiles() {
  if [ -f "$lock_snapshot_dir/.complete" ]; then
    return 0
  fi

  local tmp_dir
  tmp_dir="$lock_snapshot_dir.tmp"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"

  local relative
  local key
  for relative in pubspec.lock ios/Podfile.lock; do
    key="${relative//\//__}"
    if [ -f "$repo_dir/$relative" ]; then
      cp "$repo_dir/$relative" "$tmp_dir/$key"
      printf 'present\n' >"$tmp_dir/$key.state"
    else
      printf 'absent\n' >"$tmp_dir/$key.state"
    fi
  done
  printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$tmp_dir/.complete"
  rm -rf "$lock_snapshot_dir"
  mv "$tmp_dir" "$lock_snapshot_dir"
}

restore_lockfiles() {
  if [ ! -f "$lock_snapshot_dir/.complete" ]; then
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
}

restore_lockfiles_on_failure() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    restore_lockfiles || true
  fi
  return "$exit_code"
}

trap restore_lockfiles_on_failure EXIT

if [ ! -d "$repo_dir" ]; then
  echo "iOS repo missing: $repo_dir"
  exit 1
fi

snapshot_lockfiles

if ! command -v flutter >/dev/null 2>&1; then
  echo "flutter not found in PATH"
  exit 1
fi

if ! command -v pod >/dev/null 2>&1; then
  echo "pod not found in PATH"
  exit 1
fi

flutter config --no-enable-swift-package-manager >/dev/null

(
  cd "$repo_dir"
  if [ -f tool/switch_pubspec.dart ]; then
    dart tool/switch_pubspec.dart cn
  elif [ -f pubspec.cn.yaml ]; then
    cp pubspec.cn.yaml pubspec.yaml
  fi

  flutter pub get

  if [ -f tools/pod_install.sh ]; then
    bash tools/pod_install.sh cn
  else
    cd ios
    pod install
  fi
)

echo "catstory cn iOS dependencies prepared"
echo "catstory lockfile snapshot saved for cleanup: $lock_snapshot_dir"
echo "restore after build/run with: local/shell/ios-mcp/cleanup-catstory-cn.sh"
