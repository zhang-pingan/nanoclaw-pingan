#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICES_JSON="$ROOT_DIR/groups/global/services.json"
DEFAULT_SERVICE="${IOS_MCP_SERVICE:-catstory}"

export PATH="/opt/homebrew/opt/ruby/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

json_value() {
  local expression="$1"
  node -e "
const fs = require('fs');
const services = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const service = process.argv[2];
const cfg = services[service];
if (!cfg) process.exit(2);
const ios = cfg.clients && cfg.clients.ios;
if (!ios) process.exit(3);
const value = $expression;
if (value !== undefined && value !== null) console.log(String(value));
" "$SERVICES_JSON" "$DEFAULT_SERVICE"
}

repos_dir() {
  if [ -n "${REPOS_DIR:-}" ]; then
    printf '%s\n' "$REPOS_DIR"
    return 0
  fi

  local env_file="$ROOT_DIR/.env"
  if [ -f "$env_file" ]; then
    local configured
    configured="$(grep -E '^[[:space:]]*REPOS_DIR=' "$env_file" | tail -n 1 | cut -d= -f2- || true)"
    if [ -n "$configured" ]; then
      configured="${configured/#\~/$HOME}"
      printf '%s\n' "$configured"
      return 0
    fi
  fi

  printf '%s\n' "$HOME/IdeaProjects"
}

ios_repo_dir() {
  local repo_root
  local repo_path

  repo_root="$(repos_dir)"
  repo_path="$(json_value 'ios.repo_path || ""')"
  printf '%s\n' "$repo_root/$repo_path"
}

ios_mcp_state_root() {
  if [ -n "${IOS_MCP_STATE_DIR:-}" ]; then
    printf '%s\n' "${IOS_MCP_STATE_DIR/#\~/$HOME}"
    return 0
  fi

  printf '%s\n' "$HOME/.cache/icarus/ios-mcp"
}

print_check() {
  printf '[OK] %s\n' "$1"
}

print_warn() {
  printf '[WARN] %s\n' "$1"
}

print_fail() {
  printf '[FAIL] %s\n' "$1"
}
