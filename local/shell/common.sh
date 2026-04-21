#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHD_LABEL="com.nanoclaw"
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCHD_TARGET="$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_TEMPLATE="$ROOT_DIR/launchd/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_PLIST_CHANGED=0

ensure_logs_dir() {
  mkdir -p "$ROOT_DIR/logs"
}

get_web_port() {
  if [ -n "${WEB_PORT:-}" ]; then
    printf '%s\n' "$WEB_PORT"
    return 0
  fi

  local env_file="$ROOT_DIR/.env"
  if [ -f "$env_file" ]; then
    local configured
    configured="$(grep -E '^[[:space:]]*WEB_PORT=' "$env_file" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)"
    if [ -n "$configured" ]; then
      printf '%s\n' "$configured"
      return 0
    fi
  fi

  printf '3000\n'
}

ensure_node_bin() {
  if [ -n "${NODE_BIN:-}" ]; then
    return 0
  fi

  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "node binary not found in PATH"
    return 1
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&\\]/\\&/g'
}

install_launch_agent_plist() {
  local node_escaped
  local root_escaped
  local home_escaped
  local rendered

  ensure_logs_dir
  ensure_node_bin
  mkdir -p "$LAUNCH_AGENT_DIR"

  node_escaped="$(escape_sed_replacement "$NODE_BIN")"
  root_escaped="$(escape_sed_replacement "$ROOT_DIR")"
  home_escaped="$(escape_sed_replacement "$HOME")"
  rendered="$(mktemp)"

  sed \
    -e "s/{{NODE_PATH}}/$node_escaped/g" \
    -e "s/{{PROJECT_ROOT}}/$root_escaped/g" \
    -e "s/{{HOME}}/$home_escaped/g" \
    "$LAUNCH_AGENT_TEMPLATE" > "$rendered"

  if [ ! -f "$LAUNCH_AGENT_PLIST" ] || ! cmp -s "$rendered" "$LAUNCH_AGENT_PLIST"; then
    cp "$rendered" "$LAUNCH_AGENT_PLIST"
    LAUNCH_AGENT_PLIST_CHANGED=1
    echo "launch agent plist updated"
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

print_nanoclaw_logs_tail() {
  local stdout_log="$ROOT_DIR/logs/nanoclaw.log"
  local stderr_log="$ROOT_DIR/logs/nanoclaw.error.log"

  if [ -f "$stdout_log" ]; then
    echo "--- tail $stdout_log ---"
    tail -n 40 "$stdout_log"
  fi
  if [ -f "$stderr_log" ]; then
    echo "--- tail $stderr_log ---"
    tail -n 40 "$stderr_log"
  fi
}

wait_for_nanoclaw_service() {
  local port
  port="$(get_web_port)"
  local url="http://127.0.0.1:${port}/"
  local attempt

  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "nanoclaw is healthy at $url"
      return 0
    fi
    sleep 1
  done

  echo "nanoclaw failed health check at $url"
  launchctl print "$LAUNCHD_TARGET" || true
  print_nanoclaw_logs_tail
  return 1
}

start_nanoclaw_service() {
  install_launch_agent_plist

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "launch agent reloaded"
      wait_for_nanoclaw_service
    else
      echo "launch agent already loaded"
      wait_for_nanoclaw_service
    fi
    return 0
  fi

  bootstrap_launch_agent
  echo "launch agent loaded"
  wait_for_nanoclaw_service
}

restart_nanoclaw_service() {
  install_launch_agent_plist

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "launch agent reloaded"
    else
      launchctl kickstart -k "$LAUNCHD_TARGET"
      echo "launch agent restarted"
    fi
    wait_for_nanoclaw_service
    return 0
  fi

  bootstrap_launch_agent
  echo "launch agent loaded"
  wait_for_nanoclaw_service
}

stop_nanoclaw_service() {
  if ! is_launch_agent_loaded; then
    echo "launch agent not loaded"
    return 1
  fi

  bootout_launch_agent
  echo "launch agent stopped"
}
