#!/bin/bash
set -euo pipefail

# setup.sh — Bootstrap script for Icarus
# Installs the managed Node.js/npm runtime without changing the system runtime.
# This is the only bash script in the setup flow.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bootstrap] $*" >> "$LOG_FILE"; }

# --- Platform detection ---

detect_platform() {
  local uname_s
  uname_s=$(uname -s)
  case "$uname_s" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac

  IS_WSL="false"
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL="true"
    fi
  fi

  IS_ROOT="false"
  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT="true"
  fi

  log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT"
}

# --- Managed runtime and npm install ---

install_managed_runtime_and_deps() {
  MANAGED_OK="false"
  DEPS_OK="false"
  NATIVE_OK="false"

  cd "$PROJECT_ROOT"

  log "Configuring a supported Node runtime"
  CURRENT_NODE_PATH="$(node -p 'process.execPath' 2>/dev/null || true)"
  if [ -n "$CURRENT_NODE_PATH" ] && \
     "$PROJECT_ROOT/scripts/runtime-toolchain.sh" configure --node "$CURRENT_NODE_PATH" >> "$LOG_FILE" 2>&1; then
    log "Using the current supported Node runtime"
  elif "$PROJECT_ROOT/scripts/runtime-toolchain.sh" install >> "$LOG_FILE" 2>&1; then
    log "Managed Node install succeeded"
  else
    log "Node runtime configuration and managed install failed"
    return
  fi
  MANAGED_OK="true"

  log "Running npm ci through the configured runtime"
  if "$PROJECT_ROOT/scripts/runtime-toolchain.sh" npm-ci >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "Configured npm ci succeeded"
  else
    log "Configured npm ci failed"
    return
  fi

  log "Verifying configured Node and native modules"
  if ! RUNTIME_DETAILS="$("$PROJECT_ROOT/scripts/runtime-toolchain.sh" verify 2>> "$LOG_FILE")"; then
    log "Configured Node or native module verification failed"
    return
  fi
  printf '%s\n' "$RUNTIME_DETAILS" >> "$LOG_FILE"
  NATIVE_OK="true"
  MANAGED_NODE_PATH="$(printf '%s\n' "$RUNTIME_DETAILS" | sed -n 's/^node_path=//p')"
  MANAGED_NODE_VERSION="$("$PROJECT_ROOT/scripts/runtime-toolchain.sh" exec -- node --version)"
  MANAGED_NPM_VERSION="$("$PROJECT_ROOT/scripts/runtime-toolchain.sh" exec -- npm --version)"
  log "better-sqlite3 query smoke passed"
}

# --- Build tools check ---

check_build_tools() {
  HAS_BUILD_TOOLS="false"

  if [ "$PLATFORM" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    if command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  fi

  log "Build tools: $HAS_BUILD_TOOLS"
}

# --- Main ---

log "=== Bootstrap started ==="

detect_platform
install_managed_runtime_and_deps
check_build_tools

# Emit status block
STATUS="success"
if [ "$MANAGED_OK" = "false" ]; then
  STATUS="managed_runtime_failed"
elif [ "$DEPS_OK" = "false" ]; then
  STATUS="deps_failed"
elif [ "$NATIVE_OK" = "false" ]; then
  STATUS="native_failed"
fi

cat <<EOF
=== Icarus SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
MANAGED_NODE_PATH: ${MANAGED_NODE_PATH:-not_found}
MANAGED_NODE_VERSION: ${MANAGED_NODE_VERSION:-not_found}
MANAGED_NPM_VERSION: ${MANAGED_NPM_VERSION:-not_found}
MANAGED_OK: $MANAGED_OK
DEPS_OK: $DEPS_OK
NATIVE_OK: $NATIVE_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

log "=== Bootstrap completed: $STATUS ==="

if [ "$MANAGED_OK" = "false" ]; then
  exit 2
fi
if [ "$DEPS_OK" = "false" ] || [ "$NATIVE_OK" = "false" ]; then
  exit 1
fi
