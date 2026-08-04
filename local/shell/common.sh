#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHD_LABEL="com.icarus"
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCHD_TARGET="$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_TEMPLATE="$ROOT_DIR/launchd/$LAUNCHD_LABEL.plist"
LAUNCH_AGENT_PLIST_CHANGED=0
BACKEND_ENTRY="$ROOT_DIR/dist/index.js"
RUNTIME_TOOLCHAIN="$ROOT_DIR/scripts/runtime-toolchain.sh"
RUNTIME_HOME="${ICARUS_RUNTIME_HOME:-$HOME/Library/Application Support/Icarus}"
RUNTIME_LAUNCHER="$RUNTIME_HOME/bin/icarus-runtime"
HOST_LAUNCHER="$ROOT_DIR/local/shell/launch-host.sh"
HOST_CORE_RELEASE_CLI="$ROOT_DIR/src/host-core/host-core-release-cli.ts"

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

parse_host_mode() {
  if [ "$#" -ne 2 ] || [ "$1" != "--mode" ]; then
    echo "Usage: $0 --mode <current|active>" >&2
    return 64
  fi
  case "$2" in
    current|active) HOST_MODE="$2" ;;
    *)
      echo "Usage: $0 --mode <current|active>" >&2
      return 64
      ;;
  esac
}

prepare_host_mode() {
  local mode="$1"

  case "$mode" in
    current)
      "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" install
      "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" verify
      "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- npm run build
      echo "typescript compiled"
      ;;
    active)
      "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" verify
      "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" exec -- npx tsx "$HOST_CORE_RELEASE_CLI" \
        verify-active \
        --runtime-home "$RUNTIME_HOME"
      ;;
    *) return 64 ;;
  esac
}

ensure_core_runtime() {
  "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" install
  "$RUNTIME_TOOLCHAIN" --runtime-home "$RUNTIME_HOME" verify
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&\\]/\\&/g'
}

install_launch_agent_plist() {
  local mode="$1"
  local host_launcher_escaped
  local host_mode_escaped
  local launcher_escaped
  local root_escaped
  local home_escaped
  local rendered

  ensure_logs_dir
  mkdir -p "$LAUNCH_AGENT_DIR"

  host_launcher_escaped="$(escape_sed_replacement "$HOST_LAUNCHER")"
  host_mode_escaped="$(escape_sed_replacement "$mode")"
  launcher_escaped="$(escape_sed_replacement "$RUNTIME_LAUNCHER")"
  root_escaped="$(escape_sed_replacement "$ROOT_DIR")"
  home_escaped="$(escape_sed_replacement "$HOME")"
  rendered="$(mktemp)"

  sed \
    -e "s/{{HOST_LAUNCHER}}/$host_launcher_escaped/g" \
    -e "s/{{HOST_MODE}}/$host_mode_escaped/g" \
    -e "s/{{RUNTIME_LAUNCHER}}/$launcher_escaped/g" \
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

print_icarus_logs_tail() {
  local stdout_log="$ROOT_DIR/logs/icarus.log"
  local stderr_log="$ROOT_DIR/logs/icarus.error.log"

  if [ -f "$stdout_log" ]; then
    echo "--- tail $stdout_log ---"
    tail -n 40 "$stdout_log"
  fi
  if [ -f "$stderr_log" ]; then
    echo "--- tail $stderr_log ---"
    tail -n 40 "$stderr_log"
  fi
}

wait_for_icarus_service() {
  local port
  port="$(get_web_port)"
  local url="http://127.0.0.1:${port}/"
  local attempt

  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "icarus is healthy at $url"
      return 0
    fi
    sleep 1
  done

  echo "icarus failed health check at $url"
  launchctl print "$LAUNCHD_TARGET" || true
  print_icarus_logs_tail
  return 1
}

start_icarus_service() {
  local mode="$1"
  install_launch_agent_plist "$mode"

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "launch agent reloaded"
      wait_for_icarus_service
    else
      echo "launch agent already loaded"
      wait_for_icarus_service
    fi
    return 0
  fi

  bootstrap_launch_agent
  echo "launch agent loaded"
  wait_for_icarus_service
}

restart_icarus_service() {
  local mode="$1"
  install_launch_agent_plist "$mode"

  if stop_running_direct_icarus; then
    echo "direct icarus process stopped"
  fi

  if is_launch_agent_loaded; then
    if [ "$LAUNCH_AGENT_PLIST_CHANGED" -eq 1 ]; then
      bootout_launch_agent
      bootstrap_launch_agent
      echo "launch agent reloaded"
    else
      launchctl kickstart -k "$LAUNCHD_TARGET"
      echo "launch agent restarted"
    fi
    wait_for_icarus_service
    return 0
  fi

  bootstrap_launch_agent
  echo "launch agent loaded"
  wait_for_icarus_service
}

stop_icarus_service() {
  if ! is_launch_agent_loaded; then
    echo "launch agent not loaded"
    return 1
  fi

  bootout_launch_agent
  echo "launch agent stopped"
}

is_direct_icarus_pid() {
  local pid="$1"
  local command

  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$command" ] && [[ "$command" == *"$BACKEND_ENTRY"* ]]
}

find_running_direct_icarus_pid() {
  local pid

  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    if is_direct_icarus_pid "$pid"; then
      echo "$pid"
      return 0
    fi
  done < <(pgrep -f "$BACKEND_ENTRY" 2>/dev/null || true)

  return 1
}

wait_for_icarus_process_exit() {
  local pid="$1"
  local retries=10

  while kill -0 "$pid" 2>/dev/null; do
    retries=$((retries - 1))
    if [ "$retries" -le 0 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done
}

stop_running_direct_icarus() {
  local stopped=1
  local pid

  while pid="$(find_running_direct_icarus_pid)"; do
    kill "$pid" 2>/dev/null || true
    wait_for_icarus_process_exit "$pid"
    stopped=0
  done

  return "$stopped"
}
