#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/.runtime"
PID_FILE="${RUNTIME_DIR}/cloudflared.pid"
LOG_FILE="${RUNTIME_DIR}/cloudflared.log"
MODE="${1:-named}"
ORIGIN_URL="${2:-http://localhost:3002}"
CONFIG_FILE="${CLOUDFLARED_CONFIG:-${HOME}/.cloudflared/config.yml}"
TUNNEL_NAME="${CLOUDFLARED_TUNNEL:-icarus}"
PUBLIC_HOSTNAME="${CLOUDFLARED_HOSTNAME:-webhook.zwqbb.com}"
DEEP_RESEARCH_HOSTNAME="${CLOUDFLARED_DEEP_RESEARCH_HOSTNAME:-deep-research.zwqbb.com}"

mkdir -p "${RUNTIME_DIR}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found in PATH"
  exit 1
fi

if [ -f "${PID_FILE}" ]; then
  old_pid="$(cat "${PID_FILE}")"
  if kill -0 "${old_pid}" >/dev/null 2>&1; then
    echo "cloudflared already running (pid=${old_pid})"
    if [ -f "${RUNTIME_DIR}/cloudflared.url" ]; then
      url="$(cat "${RUNTIME_DIR}/cloudflared.url")"
      echo "tunnel url: ${url}"
      echo "feishu webhook url: ${url}/webhook/feishu"
      echo "wecom webhook url: ${url}/webhook/wecom/app"
      if [ "${MODE}" != "temp" ]; then
        echo "deep research url: https://${DEEP_RESEARCH_HOSTNAME}"
      fi
    else
      echo "log file: ${LOG_FILE}"
    fi
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

if [ "${MODE}" = "temp" ]; then
  nohup cloudflared tunnel --pidfile "${PID_FILE}" --url "${ORIGIN_URL}" >"${LOG_FILE}" 2>&1 &
  url_pattern='https://[a-z0-9-]+\.trycloudflare\.com'
  echo "origin: ${ORIGIN_URL}"
else
  if [ ! -f "${CONFIG_FILE}" ]; then
    echo "cloudflared config not found: ${CONFIG_FILE}"
    exit 1
  fi
  nohup cloudflared tunnel --pidfile "${PID_FILE}" --config "${CONFIG_FILE}" run "${TUNNEL_NAME}" >"${LOG_FILE}" 2>&1 &
  url_pattern=''
  echo "config: ${CONFIG_FILE}"
  echo "tunnel: ${TUNNEL_NAME}"
fi

launcher_pid="$!"

echo "starting cloudflared (launcher pid=${launcher_pid}) ..."

pid="${launcher_pid}"
url=""
for _ in $(seq 1 30); do
  if [ -f "${PID_FILE}" ]; then
    managed_pid="$(cat "${PID_FILE}")"
    if [ -n "${managed_pid}" ]; then
      pid="${managed_pid}"
    fi
  fi
  if ! kill -0 "${pid}" >/dev/null 2>&1; then
    echo "cloudflared exited unexpectedly"
    tail -n 40 "${LOG_FILE}" || true
    rm -f "${PID_FILE}"
    exit 1
  fi
  if [ "${MODE}" = "temp" ]; then
    url="$(grep -Eo "${url_pattern}" "${LOG_FILE}" | tail -n 1 || true)"
  else
    if grep -q 'Registered tunnel connection' "${LOG_FILE}"; then
      url="https://${PUBLIC_HOSTNAME}"
    fi
  fi
  if [ -n "${url}" ]; then
    break
  fi
  sleep 1
done

if [ -n "${url}" ]; then
  echo "${url}" >"${RUNTIME_DIR}/cloudflared.url"
  echo "tunnel ready: ${url}"
  echo "feishu webhook url: ${url}/webhook/feishu"
  echo "wecom webhook url: ${url}/webhook/wecom/app"
  if [ "${MODE}" != "temp" ]; then
    echo "deep research url: https://${DEEP_RESEARCH_HOSTNAME}"
  fi
else
  echo "tunnel started but url is not available yet"
  echo "check logs: ${LOG_FILE}"
fi
