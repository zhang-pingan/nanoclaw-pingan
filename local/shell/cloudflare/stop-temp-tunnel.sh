#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/.runtime"
PID_FILE="${RUNTIME_DIR}/cloudflared.pid"
URL_FILE="${RUNTIME_DIR}/cloudflared.url"

if [ ! -f "${PID_FILE}" ]; then
  rm -f "${URL_FILE}"
  echo "no managed cloudflared process found"
  exit 0
fi

pid="$(cat "${PID_FILE}")"

if ! kill -0 "${pid}" >/dev/null 2>&1; then
  echo "stale pid file removed (pid=${pid})"
  rm -f "${PID_FILE}"
  rm -f "${URL_FILE}"
  exit 0
fi

kill "${pid}" >/dev/null 2>&1 || true

for _ in $(seq 1 10); do
  if ! kill -0 "${pid}" >/dev/null 2>&1; then
    rm -f "${PID_FILE}"
    rm -f "${URL_FILE}"
    echo "cloudflared stopped (pid=${pid})"
    exit 0
  fi
  sleep 1
done

kill -9 "${pid}" >/dev/null 2>&1 || true
rm -f "${PID_FILE}"
rm -f "${URL_FILE}"
echo "cloudflared force stopped (pid=${pid})"
