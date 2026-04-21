#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/.runtime"
PID_FILE="${RUNTIME_DIR}/cloudflared.pid"
LOG_FILE="${RUNTIME_DIR}/cloudflared.log"
ORIGIN_URL="${1:-http://localhost:3002}"

mkdir -p "${RUNTIME_DIR}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found in PATH"
  exit 1
fi

if [ -f "${PID_FILE}" ]; then
  old_pid="$(cat "${PID_FILE}")"
  if kill -0 "${old_pid}" >/dev/null 2>&1; then
    echo "cloudflared already running (pid=${old_pid})"
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${LOG_FILE}" | tail -n 1 || true)"
    if [ -n "${url}" ]; then
      echo "tunnel url: ${url}"
      echo "webhook url: ${url}/webhook/feishu"
    else
      echo "log file: ${LOG_FILE}"
    fi
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

nohup cloudflared tunnel --url "${ORIGIN_URL}" >"${LOG_FILE}" 2>&1 &
pid="$!"
echo "${pid}" >"${PID_FILE}"

echo "starting cloudflared (pid=${pid}) ..."
echo "origin: ${ORIGIN_URL}"

url=""
for _ in $(seq 1 30); do
  if ! kill -0 "${pid}" >/dev/null 2>&1; then
    echo "cloudflared exited unexpectedly"
    tail -n 40 "${LOG_FILE}" || true
    rm -f "${PID_FILE}"
    exit 1
  fi
  url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${LOG_FILE}" | tail -n 1 || true)"
  if [ -n "${url}" ]; then
    break
  fi
  sleep 1
done

if [ -n "${url}" ]; then
  echo "tunnel ready: ${url}"
  echo "webhook url: ${url}/webhook/feishu"
else
  echo "tunnel started but url is not available yet"
  echo "check logs: ${LOG_FILE}"
fi

