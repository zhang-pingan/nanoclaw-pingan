#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_DIR="$ROOT_DIR/deep-research"
APP_ENTRY="$APP_DIR/server.mjs"
RUNNER_SCRIPT="$SCRIPT_DIR/run.sh"
RUNTIME_DIR="$SCRIPT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/deep-research.pid"
LOG_FILE="$RUNTIME_DIR/deep-research.log"
LAUNCHD_LABEL="com.icarus.deep-research"
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCHD_TARGET="$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_TEMPLATE="$ROOT_DIR/launchd/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_PLIST_CHANGED=0

parse_env_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

load_env_file() {
  local env_file="$APP_DIR/.env"
  local line key value

  [ -f "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [ -z "${!key+x}" ]; then
      export "$key=$(parse_env_value "$value")"
    fi
  done < "$env_file"
}

load_env_file

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
CONFIG_URL="http://$HOST:$PORT/api/config"

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

ensure_app_ready() {
  if [ ! -f "$APP_ENTRY" ]; then
    echo "deep research app not found: $APP_ENTRY"
    return 1
  fi
  if [ ! -f "$RUNNER_SCRIPT" ]; then
    echo "deep research runner not found: $RUNNER_SCRIPT"
    return 1
  fi
  ensure_node_bin
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
  local node_bin_dir_escaped
  local root_escaped
  local app_dir_escaped
  local runner_escaped
  local home_escaped
  local log_escaped
  local rendered

  ensure_runtime_dir
  ensure_app_ready
  mkdir -p "$LAUNCH_AGENT_DIR"

  node_escaped="$(escape_sed_replacement "$NODE_BIN")"
  node_bin_dir_escaped="$(escape_sed_replacement "$(dirname "$NODE_BIN")")"
  root_escaped="$(escape_sed_replacement "$ROOT_DIR")"
  app_dir_escaped="$(escape_sed_replacement "$APP_DIR")"
  runner_escaped="$(escape_sed_replacement "$RUNNER_SCRIPT")"
  home_escaped="$(escape_sed_replacement "$HOME")"
  log_escaped="$(escape_sed_replacement "$LOG_FILE")"
  rendered="$(mktemp)"

  sed \
    -e "s/{{NODE_PATH}}/$node_escaped/g" \
    -e "s/{{NODE_BIN_DIR}}/$node_bin_dir_escaped/g" \
    -e "s/{{PROJECT_ROOT}}/$root_escaped/g" \
    -e "s/{{APP_DIR}}/$app_dir_escaped/g" \
    -e "s/{{RUNNER_SCRIPT}}/$runner_escaped/g" \
    -e "s/{{HOME}}/$home_escaped/g" \
    -e "s/{{LOG_FILE}}/$log_escaped/g" \
    "$LAUNCH_AGENT_TEMPLATE" > "$rendered"

  if [ ! -f "$LAUNCH_AGENT_PLIST" ] || ! cmp -s "$rendered" "$LAUNCH_AGENT_PLIST"; then
    cp "$rendered" "$LAUNCH_AGENT_PLIST"
    LAUNCH_AGENT_PLIST_CHANGED=1
    echo "deep research launch agent plist updated"
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

kickstart_launch_agent() {
  launchctl kickstart -k "$LAUNCHD_TARGET"
}

is_service_healthy() {
  local response
  response="$(curl -fsS --max-time 2 "$CONFIG_URL" 2>/dev/null || true)"
  [[ "$response" == *'"providers"'* ]]
}

print_service_logs_tail() {
  if [ -f "$LOG_FILE" ]; then
    echo "--- tail $LOG_FILE ---"
    tail -n 40 "$LOG_FILE"
  fi
}

wait_for_service() {
  local attempt

  for attempt in $(seq 1 20); do
    if is_service_healthy; then
      echo "deep research is healthy at http://$HOST:$PORT"
      return 0
    fi
    sleep 1
  done

  echo "deep research failed health check at $CONFIG_URL"
  if is_launch_agent_loaded; then
    launchctl print "$LAUNCHD_TARGET" || true
  fi
  print_service_logs_tail
  return 1
}

is_target_pid() {
  local pid="$1"
  local command

  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$command" ] && [[ "$command" == *"$APP_ENTRY"* ]]
}

find_running_direct_pid() {
  local pid

  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE")"
    if [ -n "$pid" ] && is_target_pid "$pid"; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    if is_target_pid "$pid"; then
      echo "$pid"
      return 0
    fi
  done < <(pgrep -f "$APP_ENTRY" 2>/dev/null || true)

  return 1
}

wait_for_exit() {
  local pid="$1"
  local retries=15

  while kill -0 "$pid" 2>/dev/null; do
    retries=$((retries - 1))
    if [ "$retries" -le 0 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done

  ! kill -0 "$pid" 2>/dev/null
}

stop_running_direct_service() {
  local stopped=1
  local pid

  while pid="$(find_running_direct_pid)"; do
    kill "$pid" 2>/dev/null || true
    wait_for_exit "$pid" || true
    rm -f "$PID_FILE"
    echo "deep research direct process stopped (pid: $pid)"
    stopped=0
  done

  return "$stopped"
}

start_service() {
  install_launch_agent_plist
  stop_running_direct_service || true

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "deep research launch agent reloaded"
    else
      echo "deep research launch agent already loaded"
      if ! is_service_healthy; then
        kickstart_launch_agent
        echo "deep research launch agent restarted"
      fi
    fi
    wait_for_service
    return 0
  fi

  bootstrap_launch_agent
  echo "deep research launch agent loaded"
  wait_for_service
}

restart_service() {
  install_launch_agent_plist
  stop_running_direct_service || true

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "deep research launch agent reloaded"
    else
      kickstart_launch_agent
      echo "deep research launch agent restarted"
    fi
    wait_for_service
    return 0
  fi

  bootstrap_launch_agent
  echo "deep research launch agent loaded"
  wait_for_service
}

stop_service() {
  local stopped=1

  if is_launch_agent_loaded; then
    bootout_launch_agent
    echo "deep research launch agent stopped"
    stopped=0
  fi

  if stop_running_direct_service; then
    stopped=0
  fi

  if [ "$stopped" -eq 1 ]; then
    echo "deep research not running"
  fi
}
