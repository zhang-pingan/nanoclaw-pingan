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

# --- System identity snapshot ---

capture_system_identity() {
  SYSTEM_NODE_PATH_BEFORE="$(command -v node 2>/dev/null || true)"
  SYSTEM_NODE_VERSION_BEFORE="$(node --version 2>/dev/null || true)"
  SYSTEM_NPM_PATH_BEFORE="$(command -v npm 2>/dev/null || true)"
  SYSTEM_NPM_VERSION_BEFORE="$(npm --version 2>/dev/null || true)"
  log "System Node before: ${SYSTEM_NODE_PATH_BEFORE:-not_found} ${SYSTEM_NODE_VERSION_BEFORE:-not_found}"
  log "System npm before: ${SYSTEM_NPM_PATH_BEFORE:-not_found} ${SYSTEM_NPM_VERSION_BEFORE:-not_found}"
}

# --- Managed runtime and npm install ---

install_managed_runtime_and_deps() {
  MANAGED_OK="false"
  DEPS_OK="false"
  NATIVE_OK="false"

  cd "$PROJECT_ROOT"

  log "Installing and verifying managed Node distribution"
  if ! "$PROJECT_ROOT/scripts/runtime-toolchain.sh" install >> "$LOG_FILE" 2>&1; then
    log "Managed Node install failed"
    return
  fi
  if ! "$PROJECT_ROOT/scripts/runtime-toolchain.sh" verify >> "$LOG_FILE" 2>&1; then
    log "Managed Node verification failed"
    return
  fi
  MANAGED_OK="true"

  MANAGED_NODE_PATH="$("$PROJECT_ROOT/scripts/runtime-toolchain.sh" active-path)/bin/node"
  MANAGED_NODE_VERSION="$("$PROJECT_ROOT/scripts/runtime-toolchain.sh" exec -- node --version)"
  MANAGED_NPM_VERSION="$("$PROJECT_ROOT/scripts/runtime-toolchain.sh" exec -- npm --version)"

  log "Running npm ci through managed runtime"
  if "$PROJECT_ROOT/scripts/runtime-toolchain.sh" exec -- npm ci >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "Managed npm ci succeeded"
  else
    log "Managed npm ci failed"
    return
  fi

  # Verify native module (better-sqlite3)
  log "Verifying native modules"
  if "$PROJECT_ROOT/scripts/runtime-toolchain.sh" exec -- node -e "require('better-sqlite3')" >> "$LOG_FILE" 2>&1; then
    NATIVE_OK="true"
    log "better-sqlite3 loads OK"
  else
    log "better-sqlite3 failed to load"
  fi
}

verify_system_identity_unchanged() {
  SYSTEM_NODE_PATH_AFTER="$(command -v node 2>/dev/null || true)"
  SYSTEM_NODE_VERSION_AFTER="$(node --version 2>/dev/null || true)"
  SYSTEM_NPM_PATH_AFTER="$(command -v npm 2>/dev/null || true)"
  SYSTEM_NPM_VERSION_AFTER="$(npm --version 2>/dev/null || true)"
  SYSTEM_IDENTITY_UNCHANGED="false"

  if [ "$SYSTEM_NODE_PATH_BEFORE" = "$SYSTEM_NODE_PATH_AFTER" ] && \
     [ "$SYSTEM_NODE_VERSION_BEFORE" = "$SYSTEM_NODE_VERSION_AFTER" ] && \
     [ "$SYSTEM_NPM_PATH_BEFORE" = "$SYSTEM_NPM_PATH_AFTER" ] && \
     [ "$SYSTEM_NPM_VERSION_BEFORE" = "$SYSTEM_NPM_VERSION_AFTER" ]; then
    SYSTEM_IDENTITY_UNCHANGED="true"
  fi
  log "System runtime identity unchanged: $SYSTEM_IDENTITY_UNCHANGED"
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
capture_system_identity
install_managed_runtime_and_deps
verify_system_identity_unchanged
check_build_tools

# Emit status block
STATUS="success"
if [ "$MANAGED_OK" = "false" ]; then
  STATUS="managed_runtime_failed"
elif [ "$SYSTEM_IDENTITY_UNCHANGED" = "false" ]; then
  STATUS="system_identity_changed"
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
SYSTEM_NODE_PATH: ${SYSTEM_NODE_PATH_BEFORE:-not_found}
SYSTEM_NODE_VERSION: ${SYSTEM_NODE_VERSION_BEFORE:-not_found}
SYSTEM_NPM_PATH: ${SYSTEM_NPM_PATH_BEFORE:-not_found}
SYSTEM_NPM_VERSION: ${SYSTEM_NPM_VERSION_BEFORE:-not_found}
SYSTEM_IDENTITY_UNCHANGED: $SYSTEM_IDENTITY_UNCHANGED
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
if [ "$SYSTEM_IDENTITY_UNCHANGED" = "false" ]; then
  exit 4
fi
if [ "$DEPS_OK" = "false" ] || [ "$NATIVE_OK" = "false" ]; then
  exit 1
fi
