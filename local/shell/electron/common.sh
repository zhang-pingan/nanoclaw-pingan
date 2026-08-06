#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/local/shell/electron/.runtime"
PID_FILE="$RUNTIME_DIR/electron.pid"
LOG_FILE="$RUNTIME_DIR/electron.log"
ELECTRON_ENTRY="$ROOT_DIR/dist-electron/main.cjs"
ELECTRON_BIN="$ROOT_DIR/node_modules/.bin/electron"
ELECTRON_PACKAGE_DIR="$ROOT_DIR/node_modules/electron"
ELECTRON_RUNTIME_PATH_FILE="$ELECTRON_PACKAGE_DIR/path.txt"
ELECTRON_APP="$ELECTRON_PACKAGE_DIR/dist/Electron.app"

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

ensure_electron_bin() {
  local runtime_relative_path
  local runtime_bin

  if [ ! -x "$ELECTRON_BIN" ]; then
    echo "electron launcher not found: $ELECTRON_BIN"
    echo "run npm install first"
    return 1
  fi

  if [ ! -f "$ELECTRON_RUNTIME_PATH_FILE" ]; then
    echo "electron runtime is incomplete: $ELECTRON_RUNTIME_PATH_FILE is missing"
    echo "run npm rebuild electron first"
    return 1
  fi

  runtime_relative_path="$(cat "$ELECTRON_RUNTIME_PATH_FILE")"
  runtime_bin="$ELECTRON_PACKAGE_DIR/dist/$runtime_relative_path"
  if [ ! -x "$runtime_bin" ]; then
    echo "electron runtime binary not found: $runtime_bin"
    echo "run npm rebuild electron first"
    return 1
  fi
}

build_electron() {
  (
    cd "$ROOT_DIR"
    npm run build:electron
  )
  echo "electron compiled"
}

is_target_pid() {
  local pid="$1"
  local command

  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$command" ] && [[ "$command" == *"$ELECTRON_ENTRY"* ]]
}

find_running_electron_pid() {
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
  done < <(pgrep -f "$ELECTRON_ENTRY" 2>/dev/null || true)

  return 1
}

wait_for_exit() {
  local pid="$1"
  local retries=30

  while kill -0 "$pid" 2>/dev/null; do
    retries=$((retries - 1))
    if [ "$retries" -le 0 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done
}

stop_running_electron() {
  local stopped=1
  local pid

  while pid="$(find_running_electron_pid)"; do
    kill "$pid" 2>/dev/null || true
    wait_for_exit "$pid"
    rm -f "$PID_FILE"
    stopped=0
  done

  return "$stopped"
}

start_electron() {
  local attempt
  local pid

  if [ "$(uname -s)" = "Darwin" ]; then
    /usr/bin/open -n "$ELECTRON_APP" --args "$ELECTRON_ENTRY"
  else
    (
      cd "$ROOT_DIR"
      nohup "$ELECTRON_BIN" "$ELECTRON_ENTRY" >> "$LOG_FILE" 2>&1 &
    )
  fi

  for attempt in $(seq 1 40); do
    if pid="$(find_running_electron_pid)"; then
      echo "$pid" > "$PID_FILE"
      echo "$pid"
      return 0
    fi
    sleep 0.25
  done

  echo "electron failed to stay running" >&2
  echo "log: $LOG_FILE" >&2
  return 1
}
