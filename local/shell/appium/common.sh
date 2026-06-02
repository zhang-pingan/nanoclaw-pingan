#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/local/shell/appium/.runtime"
LOG_FILE="$RUNTIME_DIR/appium.log"
APPIUM_HOST="${APPIUM_HOST:-127.0.0.1}"
APPIUM_PORT="${APPIUM_PORT:-4723}"
APPIUM_URL="http://$APPIUM_HOST:$APPIUM_PORT"
LAUNCHD_LABEL="com.icarus.appium"
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCHD_TARGET="$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_TEMPLATE="$ROOT_DIR/launchd/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_PLIST_CHANGED=0

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

resolve_appium_bin() {
  if [ -n "${APPIUM_BIN:-}" ]; then
    if [ -x "$APPIUM_BIN" ]; then
      return 0
    fi
    echo "appium binary not executable: $APPIUM_BIN"
    return 1
  fi

  APPIUM_BIN="$(command -v appium 2>/dev/null || true)"
  if [ -n "$APPIUM_BIN" ]; then
    return 0
  fi

  echo "appium binary not found in PATH"
  echo "install Appium first, for example: npm install -g appium"
  return 1
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&\\]/\\&/g'
}

install_launch_agent_plist() {
  local appium_escaped
  local appium_bin_dir_escaped
  local root_escaped
  local home_escaped
  local host_escaped
  local port_escaped
  local rendered

  ensure_runtime_dir
  resolve_appium_bin
  mkdir -p "$LAUNCH_AGENT_DIR"

  appium_escaped="$(escape_sed_replacement "$APPIUM_BIN")"
  appium_bin_dir_escaped="$(escape_sed_replacement "$(dirname "$APPIUM_BIN")")"
  root_escaped="$(escape_sed_replacement "$ROOT_DIR")"
  home_escaped="$(escape_sed_replacement "$HOME")"
  host_escaped="$(escape_sed_replacement "$APPIUM_HOST")"
  port_escaped="$(escape_sed_replacement "$APPIUM_PORT")"
  rendered="$(mktemp)"

  sed \
    -e "s/{{APPIUM_PATH}}/$appium_escaped/g" \
    -e "s/{{APPIUM_BIN_DIR}}/$appium_bin_dir_escaped/g" \
    -e "s/{{PROJECT_ROOT}}/$root_escaped/g" \
    -e "s/{{HOME}}/$home_escaped/g" \
    -e "s/{{APPIUM_HOST}}/$host_escaped/g" \
    -e "s/{{APPIUM_PORT}}/$port_escaped/g" \
    "$LAUNCH_AGENT_TEMPLATE" > "$rendered"

  if [ ! -f "$LAUNCH_AGENT_PLIST" ] || ! cmp -s "$rendered" "$LAUNCH_AGENT_PLIST"; then
    cp "$rendered" "$LAUNCH_AGENT_PLIST"
    LAUNCH_AGENT_PLIST_CHANGED=1
    echo "appium launch agent plist updated"
  else
    LAUNCH_AGENT_PLIST_CHANGED=0
  fi

  rm -f "$rendered"
}

is_launch_agent_loaded() {
  launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1
}

bootstrap_launch_agent() {
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCH_AGENT_PLIST"
}

bootout_launch_agent() {
  launchctl bootout "$LAUNCHD_TARGET"
}

wait_for_appium() {
  local attempt

  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 2 "$APPIUM_URL/status" >/dev/null 2>&1; then
      echo "appium is healthy at $APPIUM_URL"
      return 0
    fi
    sleep 1
  done

  echo "appium failed health check at $APPIUM_URL"
  if is_launch_agent_loaded; then
    launchctl print "$LAUNCHD_TARGET" || true
  fi
  if [ -f "$LOG_FILE" ]; then
    echo "--- tail $LOG_FILE ---"
    tail -n 40 "$LOG_FILE"
  fi
  return 1
}

start_appium_service() {
  install_launch_agent_plist

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "appium launch agent reloaded"
    else
      echo "appium launch agent already loaded"
    fi
    wait_for_appium
    return 0
  fi

  bootstrap_launch_agent
  echo "appium launch agent loaded"
  wait_for_appium
}

restart_appium_service() {
  install_launch_agent_plist

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "appium launch agent reloaded"
    else
      launchctl kickstart -k "$LAUNCHD_TARGET"
      echo "appium launch agent restarted"
    fi
    wait_for_appium
    return 0
  fi

  bootstrap_launch_agent
  echo "appium launch agent loaded"
  wait_for_appium
}

stop_appium_service() {
  if ! is_launch_agent_loaded; then
    echo "appium launch agent not loaded"
    return 1
  fi

  bootout_launch_agent
  echo "appium launch agent stopped"
}

print_appium_status() {
  if is_launch_agent_loaded; then
    echo "appium launch agent loaded"
  else
    echo "appium launch agent not loaded"
  fi

  if curl -fsS --max-time 2 "$APPIUM_URL/status" >/dev/null 2>&1; then
    echo "status endpoint healthy: $APPIUM_URL/status"
  else
    echo "status endpoint unavailable: $APPIUM_URL/status"
  fi

  echo "log: $LOG_FILE"
}
